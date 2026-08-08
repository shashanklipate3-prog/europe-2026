/**
 * Shared state for the Europe 2026 page.
 *
 * Two things live here:
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
 * GET  /state?rev=N   -> {rev, doc, feed}, or {rev, unchanged:true}
 * POST /ops           -> {ops:[{k,v}]} applied to the tracker
 * POST /posts         -> {author, target, title, body}
 * POST /comments      -> {post, author, body}
 * POST /votes         -> {post, author}   (toggles)
 * POST /moderate      -> {post, status}   admin only, Bearer token
 * POST /admin/check   -> validates an admin key
 */

const ALLOWED_ORIGINS = [
  'https://shashanklipate3-prog.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const MEMBERS = ['Shashank', 'Chetan', 'Ajay', 'Pramod', 'Ashish', 'Anand'];
const TARGETS = ['Amsterdam', 'Berlin', 'Budapest', 'Prague', 'Trains', 'Nightlife', 'Money', 'Visa', 'General'];
const STATUSES = ['open', 'approved', 'rejected'];

const MAX_OPS = 200;
const MAX_BODY = 32 * 1024;
const MAX_TITLE = 120;
const MAX_TEXT = 1200;
const MAX_POSTS = 300;
const MAX_COMMENTS = 3000;
const FEED_LIMIT = 200;

const KEY_PERSONAL = /^p:[a-z]{2,3}:[0-5]$/;
const KEY_GROUP = /^g:[a-z0-9]{3}$/;
const KEY_OWNER = /^o:[a-z0-9]{3}$/;
const KEY_PACK = /^k:[a-z0-9]{2,4}:[0-5]$/;   // packing list

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

function text(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function validOp(op) {
  if (!op || typeof op.k !== 'string' || !Number.isInteger(op.v)) return false;
  if (KEY_PERSONAL.test(op.k) || KEY_GROUP.test(op.k) || KEY_PACK.test(op.k)) return op.v === 0 || op.v === 1;
  if (KEY_OWNER.test(op.k)) return op.v >= 0 && op.v <= 5;
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
    db.prepare(
      'CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, payer TEXT NOT NULL, ' +
        'cents INTEGER NOT NULL, cur TEXT NOT NULL, orig INTEGER NOT NULL, city TEXT NOT NULL, ' +
        'what TEXT NOT NULL, split TEXT NOT NULL, created INTEGER NOT NULL)'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ' +
        'title TEXT NOT NULL, ref TEXT NOT NULL, holder TEXT NOT NULL, notes TEXT NOT NULL, created INTEGER NOT NULL)'
    ),
  ]);
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

async function fullState(db) {
  const [rev, doc, feed, spend, vault] = await Promise.all([
    readRev(db), readDoc(db), readFeed(db), readExpenses(db), readBookings(db),
  ]);
  return { rev, doc, feed, spend, vault };
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
        return reply({ ok: true, rev: await readRev(env.DB), moderation: !!env.ADMIN_KEY }, 200);
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
        const author = MEMBERS.includes(body.author) ? body.author : null;
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
        const author = MEMBERS.includes(body.author) ? body.author : null;
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
        const author = MEMBERS.includes(body.author) ? body.author : null;
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
        const payer = MEMBERS.includes(body.payer) ? body.payer : null;
        const what = text(body.what, MAX_TITLE);
        const city = TARGETS.includes(body.city) ? body.city : null;
        const cur = ['EUR', 'HUF', 'CZK', 'INR'].includes(body.cur) ? body.cur : null;
        const orig = Math.round(Number(body.orig));
        const cents = Math.round(Number(body.cents));
        const split = Array.isArray(body.split)
          ? body.split.filter((i) => Number.isInteger(i) && i >= 0 && i < MEMBERS.length)
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
        const holder = MEMBERS.includes(body.holder) ? body.holder : null;
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
};
