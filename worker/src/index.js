/**
 * Shared state for the Europe 2026 page.
 *
 * Four things live here:
 *
 * 1. The tracker. One row per checkbox rather than one blob for the whole
 *    thing, so two people ticking different boxes at the same moment can
 *    never overwrite each other. Same box twice is last-write-wins.
 *
 * 2. The suggestions board — posts, replies and votes, with an admin who can
 *    approve. Approved posts are what the page promotes onto the itinerary.
 *
 * Everything shares one `rev` counter, so the page can poll a single endpoint
 * and know whether anything at all has changed.
 *
 * 3. Exchange rates, refreshed once a day by a Cron Trigger from the ECB via
 *    Frankfurter. The settle-up maths used to run on constants compiled into
 *    the page, which drift; forint and koruna move enough over eight weeks to
 *    matter when you are dividing a bar tab seven ways.
 *
 * 4. Check-ins. One row per traveller, last write wins, so "where is everyone"
 *    has an answer when the group has been split across three club doors.
 *
 * WRITES ARE GATED. Set the GROUP_KEY secret and every mutating route needs the
 * X-Group-Key header. Until it is set the Worker behaves exactly as before, so
 * deploying this is not a breaking change — but /expenses/del and /bookings/del
 * take an id with no auth at all until you do, and this URL is in public HTML.
 *
 *   wrangler secret put GROUP_KEY
 *
 * GET  /state?rev=N   -> {rev, doc, feed, spend, vault, members, rates, here}
 * GET  /health        -> {ok, rev, moderation, writeAuth, rates}
 * GET  /digest        -> the most recent daily digest, as text
 * POST /ops           -> {ops:[{k,v}]} applied to the tracker
 * POST /posts         -> {author, target, title, body}
 * POST /comments      -> {post, author, body}
 * POST /votes         -> {post, author}   (toggles)
 * POST /expenses      -> {payer, cents, cur, orig, city, what, split:[ids]}
 * POST /bookings      -> {kind, title, ref, holder, notes}
 * POST /checkin       -> {member, city, place, note}
 * POST /manifest      -> {personal:[ids], visa:[ids], deadline}
 * POST /members       -> {name}
 * POST /moderate      -> {post, status}   admin only, Bearer token
 * POST /members/del   -> {id}             admin only
 * POST /admin/check   -> validates an admin key
 *
 * Cron (see wrangler.toml): refreshes rates, then rebuilds the digest.
 */

const ALLOWED_ORIGINS = [
  'https://shashanklipate3-prog.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// Seed only. The live roster lives in the members table so people can be added
// without a deploy; ids are stable and are what every checkbox key refers to.
const SEED_MEMBERS = ['Shashank', 'Chetan', 'Ajay', 'Pramod', 'Ashish', 'Anand'];
const MAX_MEMBERS = 16;
const TARGETS = ['Amsterdam', 'Berlin', 'Budapest', 'Prague', 'Trains', 'Nightlife', 'Money', 'Visa', 'General'];
const STATUSES = ['open', 'approved', 'rejected'];

// Seeded so the rates table is never empty on a cold database: these are the
// constants the page shipped with, and they are replaced on the first cron run.
const SEED_RATES = { EUR: 1, HUF: 400, CZK: 24.5, INR: 108 };
const RATE_CURS = ['HUF', 'CZK', 'INR'];
const FX_URL = 'https://api.frankfurter.app/latest?from=EUR&to=' + RATE_CURS.join(',');

const CITIES = ['Amsterdam', 'Berlin', 'Budapest', 'Prague', 'In transit', 'Home'];
const MAX_PLACE = 80;

const MAX_OPS = 200;
const MAX_BODY = 32 * 1024;
const MAX_TITLE = 120;
const MAX_TEXT = 1200;
const MAX_POSTS = 300;
const MAX_COMMENTS = 3000;
const FEED_LIMIT = 200;

const KEY_PERSONAL = /^p:[a-z]{2,3}:\d{1,2}$/;
const KEY_GROUP = /^g:[a-z0-9]{3}$/;
const KEY_OWNER = /^o:[a-z0-9]{3}$/;
const KEY_PACK = /^k:[a-z0-9]{2,4}:\d{1,2}$/;   // packing list

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Group-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/** Compares in time independent of how much of the key matched. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(token, env.ADMIN_KEY);
}

/**
 * Shared write key. Absent secret means "not configured yet" and we stay open,
 * so this deploy cannot lock the group out of their own tracker. An admin token
 * also counts, so whoever holds ADMIN_KEY does not need both.
 */
function canWrite(request, env) {
  if (!env.GROUP_KEY) return true;
  const given = request.headers.get('X-Group-Key') || '';
  return safeEqual(given, env.GROUP_KEY) || isAdmin(request, env);
}

function text(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function validOp(op) {
  if (!op || typeof op.k !== 'string' || !Number.isInteger(op.v)) return false;
  if (KEY_PERSONAL.test(op.k) || KEY_GROUP.test(op.k) || KEY_PACK.test(op.k)) return op.v === 0 || op.v === 1;
  if (KEY_OWNER.test(op.k)) return op.v >= 0 && op.v < MAX_MEMBERS;
  return false;
}

// Created once per isolate rather than on every request — the DDL is a no-op
// after the first run, but it was still several round trips to D1 each time.
let schemaReady = null;

function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = createSchema(db).catch((err) => {
      schemaReady = null; // let the next request retry rather than wedging
      throw err;
    });
  }
  return schemaReady;
}

async function createSchema(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS cells (k TEXT PRIMARY KEY, v INTEGER NOT NULL, ts INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, rev INTEGER NOT NULL)'),
    db.prepare('INSERT OR IGNORE INTO meta (id, rev) VALUES (1, 0)'),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, ' +
        'target TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, ' +
        "status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL)"
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post INTEGER NOT NULL, ' +
        'author TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)'
    ),
    db.prepare('CREATE TABLE IF NOT EXISTS votes (post INTEGER NOT NULL, member TEXT NOT NULL, PRIMARY KEY (post, member))'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post)'),
    db.prepare('CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL)'),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, payer TEXT NOT NULL, ' +
        'cents INTEGER NOT NULL, cur TEXT NOT NULL, orig INTEGER NOT NULL, city TEXT NOT NULL, ' +
        'what TEXT NOT NULL, split TEXT NOT NULL, created INTEGER NOT NULL)'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ' +
        'title TEXT NOT NULL, ref TEXT NOT NULL, holder TEXT NOT NULL, notes TEXT NOT NULL, created INTEGER NOT NULL)'
    ),
    // one row per currency, per euro
    db.prepare('CREATE TABLE IF NOT EXISTS rates (cur TEXT PRIMARY KEY, per_eur REAL NOT NULL, asof TEXT NOT NULL, ts INTEGER NOT NULL)'),
    // one row per traveller: last known position, last write wins
    db.prepare(
      'CREATE TABLE IF NOT EXISTS checkins (member TEXT PRIMARY KEY, city TEXT NOT NULL, ' +
        'place TEXT NOT NULL, note TEXT NOT NULL, ts INTEGER NOT NULL)'
    ),
    // the page posts its own checklist ids here, so the digest can never drift
    // out of step with whatever the frontend currently lists
    db.prepare('CREATE TABLE IF NOT EXISTS manifest (id INTEGER PRIMARY KEY, json TEXT NOT NULL, ts INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS digests (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, sent INTEGER NOT NULL, created INTEGER NOT NULL)'),
  ]);
  await db.batch(
    Object.keys(SEED_RATES).map((c) =>
      db.prepare('INSERT OR IGNORE INTO rates (cur, per_eur, asof, ts) VALUES (?1, ?2, ?3, ?4)')
        .bind(c, SEED_RATES[c], 'seed', 0))
  );
  // ids 0..5 for the original six, matching the checkbox keys already stored
  await db.batch(
    SEED_MEMBERS.map((n, i) =>
      db.prepare('INSERT OR IGNORE INTO members (id, name, sort) VALUES (?1, ?2, ?3)').bind(i, n, i))
  );
}

const bumpRev = (db) => db.prepare('UPDATE meta SET rev = rev + 1 WHERE id = 1');

async function readRev(db) {
  const row = await db.prepare('SELECT rev FROM meta WHERE id = 1').first();
  return row ? row.rev : 0;
}

async function readDoc(db) {
  const { results } = await db.prepare('SELECT k, v FROM cells').all();
  const doc = {};
  for (const r of results) doc[r.k] = r.v;
  return doc;
}

async function readFeed(db) {
  const [posts, comments, votes] = await Promise.all([
    db.prepare('SELECT id, author, target, title, body, status, created FROM posts ORDER BY id DESC LIMIT ?1').bind(FEED_LIMIT).all(),
    db.prepare('SELECT id, post, author, body, created FROM comments ORDER BY id ASC').all(),
    db.prepare('SELECT post, member FROM votes').all(),
  ]);

  const byPost = new Map();
  for (const p of posts.results) byPost.set(p.id, { ...p, comments: [], votes: [] });
  for (const c of comments.results) {
    const p = byPost.get(c.post);
    if (p) p.comments.push({ id: c.id, author: c.author, body: c.body, created: c.created });
  }
  for (const v of votes.results) {
    const p = byPost.get(v.post);
    if (p) p.votes.push(v.member);
  }
  return [...byPost.values()];
}

async function readMembers(db) {
  const { results } = await db.prepare('SELECT id, name FROM members ORDER BY sort, id').all();
  return results;
}

async function readExpenses(db) {
  const { results } = await db
    .prepare('SELECT id, payer, cents, cur, orig, city, what, split, created FROM expenses ORDER BY id DESC LIMIT 500')
    .all();
  return results.map((r) => ({ ...r, split: r.split.split(',').filter((x) => x !== '').map(Number) }));
}

async function readBookings(db) {
  const { results } = await db
    .prepare('SELECT id, kind, title, ref, holder, notes, created FROM bookings ORDER BY id ASC LIMIT 200')
    .all();
  return results;
}

async function readRates(db) {
  const { results } = await db.prepare('SELECT cur, per_eur, asof FROM rates').all();
  const out = { asof: 'seed' };
  for (const r of results) {
    out[r.cur] = r.per_eur;
    // report the freshest non-seed stamp we hold
    if (r.asof !== 'seed' && (out.asof === 'seed' || r.asof > out.asof)) out.asof = r.asof;
  }
  return out;
}

async function readHere(db) {
  const { results } = await db
    .prepare('SELECT member, city, place, note, ts FROM checkins ORDER BY ts DESC')
    .all();
  return results;
}

async function fullState(db) {
  const [rev, doc, feed, spend, vault, members, rates, here] = await Promise.all([
    readRev(db), readDoc(db), readFeed(db), readExpenses(db), readBookings(db), readMembers(db),
    readRates(db), readHere(db),
  ]);
  return { rev, doc, feed, spend, vault, members, rates, here };
}

/* ---------- rates + digest, both driven by the cron ---------- */

async function refreshRates(db) {
  let payload;
  try {
    const res = await fetch(FX_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, why: 'HTTP ' + res.status };
    payload = await res.json();
  } catch (err) {
    return { ok: false, why: String((err && err.message) || err) };
  }
  const got = (payload && payload.rates) || {};
  const asof = typeof payload.date === 'string' ? payload.date : new Date().toISOString().slice(0, 10);
  const rows = RATE_CURS
    .filter((c) => Number.isFinite(Number(got[c])) && Number(got[c]) > 0)
    .map((c) => ({ cur: c, v: Number(got[c]) }));
  // a partial response is not worth writing — it would mix dates in one settle-up
  if (rows.length !== RATE_CURS.length) return { ok: false, why: 'incomplete response' };

  const stmt = db.prepare(
    'INSERT INTO rates (cur, per_eur, asof, ts) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(cur) DO UPDATE SET per_eur = ?2, asof = ?3, ts = ?4'
  );
  await db.batch([
    ...rows.map((r) => stmt.bind(r.cur, r.v, asof, Date.now())),
    db.prepare('INSERT INTO rates (cur, per_eur, asof, ts) VALUES (?1, 1, ?2, ?3) ' +
      'ON CONFLICT(cur) DO UPDATE SET asof = ?2, ts = ?3').bind('EUR', asof, Date.now()),
    bumpRev(db),
  ]);
  return { ok: true, asof, rows };
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

async function buildDigest(db) {
  const [members, doc, row] = await Promise.all([
    readMembers(db),
    readDoc(db),
    db.prepare('SELECT json FROM manifest WHERE id = 1').first(),
  ]);
  let man = null;
  try { man = row ? JSON.parse(row.json) : null; } catch { man = null; }
  if (!man || !Array.isArray(man.personal) || !man.personal.length) {
    return 'No checklist manifest yet — open the itinerary page once and it will post one.';
  }
  const visa = new Set(Array.isArray(man.visa) ? man.visa : []);
  const done = (id, mid) => doc['p:' + id + ':' + mid] === 1;

  const lines = [];
  if (man.deadline) {
    const days = Math.round((new Date(man.deadline + 'T00:00:00Z') - Date.now()) / 86400000);
    lines.push(days >= 0
      ? 'Visa target ' + man.deadline + ' — ' + plural(days, 'day') + ' left.'
      : 'Visa target ' + man.deadline + ' has passed by ' + plural(-days, 'day') + '.');
    lines.push('');
  }
  let allClear = true;
  for (const m of members) {
    const openAll = man.personal.filter((id) => !done(id, m.id));
    const openVisa = openAll.filter((id) => visa.has(id));
    if (!openAll.length) { lines.push('OK  ' + m.name + ' — all clear'); continue; }
    allClear = false;
    lines.push('--  ' + m.name + ' — ' + plural(openAll.length, 'item') + ' open'
      + (openVisa.length ? ', ' + openVisa.length + ' of them visa' : ''));
  }
  if (allClear) lines.push('', 'Everyone is clear. Nothing to chase.');
  return lines.join('\n');
}

async function sendDigest(env, body) {
  if (!env.RESEND_KEY || !env.DIGEST_TO) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.DIGEST_FROM || 'Europe 2026 <onboarding@resend.dev>',
        to: env.DIGEST_TO.split(',').map((x) => x.trim()).filter(Boolean),
        subject: 'Europe 2026 — where we are',
        text: body,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function countRows(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
  return row ? row.n : 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const reply = (b, s) => json(b, s, origin);

    try {
      await ensureSchema(env.DB);

      /* ---------- read ---------- */

      if (request.method === 'GET' && path === '/state') {
        const rev = await readRev(env.DB);
        // absent param must not read as 0, or a first-time client is told
        // "unchanged" against an empty database and never gets the state
        const raw = url.searchParams.get('rev');
        const since = raw === null || raw === '' ? null : Number(raw);
        if (since !== null && Number.isInteger(since) && since === rev) {
          return reply({ rev, unchanged: true }, 200);
        }
        return reply(await fullState(env.DB), 200);
      }

      if (request.method === 'GET' && path === '/health') {
        return reply({
          ok: true,
          rev: await readRev(env.DB),
          moderation: !!env.ADMIN_KEY,
          writeAuth: !!env.GROUP_KEY,
          email: !!(env.RESEND_KEY && env.DIGEST_TO),
          rates: await readRates(env.DB),
        }, 200);
      }

      if (request.method === 'GET' && path === '/digest') {
        const row = await env.DB
          .prepare('SELECT body, sent, created FROM digests ORDER BY id DESC LIMIT 1')
          .first();
        return reply(row ? { ok: true, ...row } : { ok: true, body: null }, 200);
      }

      /* ---------- write ---------- */

      if (request.method !== 'POST') return reply({ error: 'not found' }, 404);

      if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) {
        return reply({ error: 'too large' }, 413);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return reply({ error: 'bad json' }, 400);
      }

      const roster = await readMembers(env.DB);
      const names = roster.map((m) => m.name);
      const ids = roster.map((m) => m.id);
      const isName = (v) => names.includes(v);

      // Admin key check must stay reachable without the group key, or a locked-out
      // admin has no way back in.
      if (path !== '/admin/check' && !canWrite(request, env)) {
        return reply({ error: 'group key required', needKey: true }, 403);
      }

      if (path === '/admin/check') {
        if (!env.ADMIN_KEY) return reply({ error: 'moderation not configured' }, 503);
        // the key arrives in the header like every other admin call
        return isAdmin(request, env) ? reply({ ok: true }, 200) : reply({ error: 'wrong key' }, 403);
      }

      if (path === '/ops') {
        const ops = Array.isArray(body && body.ops) ? body.ops : null;
        if (!ops) return reply({ error: 'expected {ops:[...]}' }, 400);
        if (ops.length > MAX_OPS) return reply({ error: 'too many ops' }, 413);
        if (!ops.every(validOp)) return reply({ error: 'invalid op' }, 400);

        if (ops.length) {
          const now = Date.now();
          const stmt = env.DB.prepare(
            'INSERT INTO cells (k, v, ts) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, ts = ?3'
          );
          await env.DB.batch([...ops.map((op) => stmt.bind(op.k, op.v, now)), bumpRev(env.DB)]);
        }
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/posts') {
        const author = isName(body.author) ? body.author : null;
        const target = TARGETS.includes(body.target) ? body.target : null;
        const title = text(body.title, MAX_TITLE);
        const detail = typeof body.body === 'string' ? body.body.trim().slice(0, MAX_TEXT) : '';
        if (!author) return reply({ error: 'unknown author' }, 400);
        if (!target) return reply({ error: 'unknown target' }, 400);
        if (!title) return reply({ error: 'a title is required' }, 400);
        if (await countRows(env.DB, 'posts') >= MAX_POSTS) return reply({ error: 'board is full' }, 409);

        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO posts (author, target, title, body, status, created) VALUES (?1, ?2, ?3, ?4, 'open', ?5)"
          ).bind(author, target, title, detail, Date.now()),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/comments') {
        const author = isName(body.author) ? body.author : null;
        const post = Number(body.post);
        const msg = text(body.body, MAX_TEXT);
        if (!author) return reply({ error: 'unknown author' }, 400);
        if (!Number.isInteger(post)) return reply({ error: 'bad post' }, 400);
        if (!msg) return reply({ error: 'empty message' }, 400);
        const exists = await env.DB.prepare('SELECT id FROM posts WHERE id = ?1').bind(post).first();
        if (!exists) return reply({ error: 'no such post' }, 404);
        if (await countRows(env.DB, 'comments') >= MAX_COMMENTS) return reply({ error: 'board is full' }, 409);

        await env.DB.batch([
          env.DB.prepare('INSERT INTO comments (post, author, body, created) VALUES (?1, ?2, ?3, ?4)').bind(
            post, author, msg, Date.now()
          ),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/votes') {
        const author = isName(body.author) ? body.author : null;
        const post = Number(body.post);
        if (!author) return reply({ error: 'unknown author' }, 400);
        if (!Number.isInteger(post)) return reply({ error: 'bad post' }, 400);

        const had = await env.DB.prepare('SELECT member FROM votes WHERE post = ?1 AND member = ?2')
          .bind(post, author).first();
        await env.DB.batch([
          had
            ? env.DB.prepare('DELETE FROM votes WHERE post = ?1 AND member = ?2').bind(post, author)
            : env.DB.prepare('INSERT OR IGNORE INTO votes (post, member) VALUES (?1, ?2)').bind(post, author),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/expenses') {
        const payer = isName(body.payer) ? body.payer : null;
        const what = text(body.what, MAX_TITLE);
        const city = TARGETS.includes(body.city) ? body.city : null;
        const cur = ['EUR', 'HUF', 'CZK', 'INR'].includes(body.cur) ? body.cur : null;
        const orig = Math.round(Number(body.orig));
        const cents = Math.round(Number(body.cents));
        const split = Array.isArray(body.split)
          ? body.split.filter((i) => Number.isInteger(i) && ids.includes(i))
          : [];
        if (!payer) return reply({ error: 'unknown payer' }, 400);
        if (!what) return reply({ error: 'say what it was for' }, 400);
        if (!city) return reply({ error: 'unknown city' }, 400);
        if (!cur) return reply({ error: 'unknown currency' }, 400);
        if (!Number.isInteger(cents) || cents <= 0 || cents > 100000000) return reply({ error: 'bad amount' }, 400);
        if (!Number.isInteger(orig) || orig <= 0) return reply({ error: 'bad amount' }, 400);
        if (!split.length) return reply({ error: 'nobody to split it between' }, 400);
        if (await countRows(env.DB, 'expenses') >= 500) return reply({ error: 'expense log is full' }, 409);

        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO expenses (payer, cents, cur, orig, city, what, split, created) ' +
              'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
          ).bind(payer, cents, cur, orig, city, what, [...new Set(split)].sort().join(','), Date.now()),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/expenses/del') {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return reply({ error: 'bad id' }, 400);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM expenses WHERE id = ?1').bind(id),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/bookings') {
        const kind = ['Train', 'Stay', 'Activity', 'Flight', 'Insurance', 'Visa', 'Other'].includes(body.kind)
          ? body.kind : null;
        const title = text(body.title, MAX_TITLE);
        const holder = isName(body.holder) ? body.holder : null;
        const ref = typeof body.ref === 'string' ? body.ref.trim().slice(0, 200) : '';
        const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, MAX_TEXT) : '';
        if (!kind) return reply({ error: 'unknown kind' }, 400);
        if (!title) return reply({ error: 'a title is required' }, 400);
        if (!holder) return reply({ error: 'unknown holder' }, 400);
        if (await countRows(env.DB, 'bookings') >= 200) return reply({ error: 'vault is full' }, 409);

        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO bookings (kind, title, ref, holder, notes, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
          ).bind(kind, title, ref, holder, notes, Date.now()),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/bookings/del') {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return reply({ error: 'bad id' }, 400);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM bookings WHERE id = ?1').bind(id),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/members') {
        const name = text(body.name, 24);
        if (!name) return reply({ error: 'give them a name' }, 400);
        if (!/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(name)) return reply({ error: 'letters only' }, 400);
        if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
          return reply({ error: name + ' is already in the group' }, 409);
        }
        if (roster.length >= MAX_MEMBERS) return reply({ error: 'group is full' }, 409);

        // never reuse an id: old checkbox keys would resurrect against a new person
        const nextId = roster.length ? Math.max(...ids) + 1 : 0;
        await env.DB.batch([
          env.DB.prepare('INSERT INTO members (id, name, sort) VALUES (?1, ?2, ?3)').bind(nextId, name, nextId),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/members/del') {
        if (!env.ADMIN_KEY) return reply({ error: 'moderation not configured' }, 503);
        if (!isAdmin(request, env)) return reply({ error: 'not allowed' }, 403);
        const id = Number(body.id);
        if (!Number.isInteger(id) || !ids.includes(id)) return reply({ error: 'no such traveller' }, 400);
        if (roster.length <= 1) return reply({ error: 'somebody has to be going' }, 409);

        const gone = roster.find((m) => m.id === id);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(id),
          // their ticks go too, so a future traveller can't inherit them
          env.DB.prepare("DELETE FROM cells WHERE k LIKE 'p:%:' || ?1 OR k LIKE 'k:%:' || ?1").bind(String(id)),
          env.DB.prepare('DELETE FROM votes WHERE member = ?1').bind(gone ? gone.name : ''),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/checkin') {
        const member = isName(body.member) ? body.member : null;
        const city = CITIES.includes(body.city) ? body.city : null;
        const place = typeof body.place === 'string' ? body.place.trim().slice(0, MAX_PLACE) : '';
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
        if (!member) return reply({ error: 'unknown traveller' }, 400);
        if (!city) return reply({ error: 'unknown city' }, 400);

        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO checkins (member, city, place, note, ts) VALUES (?1, ?2, ?3, ?4, ?5) ' +
              'ON CONFLICT(member) DO UPDATE SET city = ?2, place = ?3, note = ?4, ts = ?5'
          ).bind(member, city, place, note, Date.now()),
          bumpRev(env.DB),
        ]);
        return reply(await fullState(env.DB), 200);
      }

      if (path === '/manifest') {
        const clean = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && /^[a-z0-9]{2,4}$/.test(x)) : []);
        const personal = clean(body.personal);
        const visa = clean(body.visa);
        const deadline = typeof body.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.deadline)
          ? body.deadline : null;
        if (!personal.length) return reply({ error: 'empty manifest' }, 400);

        const json = JSON.stringify({ personal, visa, deadline });
        const prev = await env.DB.prepare('SELECT json FROM manifest WHERE id = 1').first();
        // identical manifest is the common case on every page load — do not bump
        // rev for it or every client would redraw once per visitor
        if (prev && prev.json === json) return reply({ ok: true, unchanged: true }, 200);
        await env.DB.prepare(
          'INSERT INTO manifest (id, json, ts) VALUES (1, ?1, ?2) ' +
            'ON CONFLICT(id) DO UPDATE SET json = ?1, ts = ?2'
        ).bind(json, Date.now()).run();
        return reply({ ok: true }, 200);
      }

      if (path === '/moderate') {
        if (!env.ADMIN_KEY) return reply({ error: 'moderation not configured' }, 503);
        if (!isAdmin(request, env)) return reply({ error: 'not allowed' }, 403);

        const post = Number(body.post);
        if (!Number.isInteger(post)) return reply({ error: 'bad post' }, 400);

        if (body.status === 'deleted') {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM comments WHERE post = ?1').bind(post),
            env.DB.prepare('DELETE FROM votes WHERE post = ?1').bind(post),
            env.DB.prepare('DELETE FROM posts WHERE id = ?1').bind(post),
            bumpRev(env.DB),
          ]);
        } else {
          if (!STATUSES.includes(body.status)) return reply({ error: 'bad status' }, 400);
          await env.DB.batch([
            env.DB.prepare('UPDATE posts SET status = ?1 WHERE id = ?2').bind(body.status, post),
            bumpRev(env.DB),
          ]);
        }
        return reply(await fullState(env.DB), 200);
      }

      return reply({ error: 'not found' }, 404);
    } catch (err) {
      return reply({ error: 'server', detail: String((err && err.message) || err) }, 500);
    }
  },

  /**
   * Cron. Rates first, then the digest, so the digest is never built against
   * yesterday's numbers. Both are best-effort: a failed FX fetch leaves the last
   * good rates in place rather than writing a half-set, and a failed email still
   * leaves the digest readable at GET /digest.
   */
  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    const fx = await refreshRates(env.DB);
    const body = await buildDigest(env.DB);
    const sent = await sendDigest(env, body);
    await env.DB.prepare('INSERT INTO digests (body, sent, created) VALUES (?1, ?2, ?3)')
      .bind(body, sent ? 1 : 0, Date.now()).run();
    // keep the last 30 only; this table is append-only otherwise
    await env.DB.prepare(
      'DELETE FROM digests WHERE id NOT IN (SELECT id FROM digests ORDER BY id DESC LIMIT 30)'
    ).run();
    console.log('cron: fx=' + (fx.ok ? fx.asof : 'failed:' + fx.why) + ' emailed=' + sent);
  },
};
