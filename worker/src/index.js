/**
 * Shared state for the Europe 2026 tracker.
 *
 * One row per checkbox rather than one blob for the whole tracker, so two
 * people ticking different boxes at the same moment can never overwrite each
 * other — they touch different rows. Same box twice is last-write-wins, which
 * is what you'd want anyway.
 *
 * GET  /state?rev=N   -> {rev, doc}, or {rev, unchanged:true} if N is current
 * POST /ops           -> {ops:[{k,v}]} applied, returns {rev, doc}
 */

const ALLOWED_ORIGINS = [
  'https://shashanklipate3-prog.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const MAX_OPS = 200;
const MAX_BODY = 32 * 1024;

// p:<taskId>:<member> = personal tick, g:<id> = group booking done, o:<id> = owner
const KEY_PERSONAL = /^p:[a-z]{2,3}:[0-5]$/;
const KEY_GROUP = /^g:[a-z0-9]{3}$/;
const KEY_OWNER = /^o:[a-z0-9]{3}$/;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

function validOp(op) {
  if (!op || typeof op.k !== 'string' || !Number.isInteger(op.v)) return false;
  if (KEY_PERSONAL.test(op.k) || KEY_GROUP.test(op.k)) return op.v === 0 || op.v === 1;
  if (KEY_OWNER.test(op.k)) return op.v >= 0 && op.v <= 5;
  return false;
}

// Created once per isolate rather than on every request — the DDL is a no-op
// after the first run, but it was still three round trips to D1 each time.
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
  ]);
}

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      await ensureSchema(env.DB);

      if (request.method === 'GET' && url.pathname === '/state') {
        const rev = await readRev(env.DB);
        // absent param must not read as 0, or a first-time client is told
        // "unchanged" against an empty database and never gets the state
        const raw = url.searchParams.get('rev');
        const since = raw === null || raw === '' ? null : Number(raw);
        if (since !== null && Number.isInteger(since) && since === rev) {
          return json({ rev, unchanged: true }, 200, origin);
        }
        return json({ rev, doc: await readDoc(env.DB) }, 200, origin);
      }

      if (request.method === 'POST' && url.pathname === '/ops') {
        const len = Number(request.headers.get('Content-Length') || 0);
        if (len > MAX_BODY) return json({ error: 'too large' }, 413, origin);

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'bad json' }, 400, origin);
        }

        const ops = Array.isArray(body && body.ops) ? body.ops : null;
        if (!ops) return json({ error: 'expected {ops:[...]}' }, 400, origin);
        if (ops.length > MAX_OPS) return json({ error: 'too many ops' }, 413, origin);
        if (!ops.every(validOp)) return json({ error: 'invalid op' }, 400, origin);

        if (ops.length) {
          const now = Date.now();
          const stmt = env.DB.prepare(
            'INSERT INTO cells (k, v, ts) VALUES (?1, ?2, ?3) ' +
              'ON CONFLICT(k) DO UPDATE SET v = ?2, ts = ?3'
          );
          await env.DB.batch([
            ...ops.map((op) => stmt.bind(op.k, op.v, now)),
            env.DB.prepare('UPDATE meta SET rev = rev + 1 WHERE id = 1'),
          ]);
        }

        return json({ rev: await readRev(env.DB), doc: await readDoc(env.DB) }, 200, origin);
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, rev: await readRev(env.DB) }, 200, origin);
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (err) {
      return json({ error: 'server', detail: String(err && err.message || err) }, 500, origin);
    }
  },
};
