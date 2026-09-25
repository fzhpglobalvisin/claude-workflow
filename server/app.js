// Workflow Hub — shared API application.
// One request handler used by BOTH runtimes:
//   • local machine  → server/index.js (Node http server, SQLite or Postgres, SSE, static files)
//   • Vercel         → api/index.js    (serverless function, Postgres, polling real-time)
// It handles auth, RBAC context, offline-sync idempotency, rate limiting and routing to the
// service modules (auth, org, boards, tasks, chat, search, reports, ai, ops, admin).
import { URL } from 'node:url';
import * as db from './db/index.js';
import { Router, HttpError, readBody, sendJSON } from './lib/http.js';
import { verifyToken } from './lib/security.js';
import { loadUser } from './lib/access.js';
import { MODE, flushPending, pollEvents } from './lib/realtime.js';
import * as auth from './services/auth.js';
import * as org from './services/org.js';
import * as boards from './services/boards.js';
import * as tasks from './services/tasks.js';
import * as chat from './services/chat.js';
import * as search from './services/search.js';
import * as reports from './services/reports.js';
import * as ai from './services/ai.js';
import * as ops from './services/ops.js';
import * as admin from './services/admin.js';
import * as mdm from './services/mdm.js';
import * as covers from './services/covers.js';
import { checkEnvironment, APP_ENV, IS_PRODUCTION } from './lib/environment.js';
import { maybeApplyEffectiveDates } from './lib/mdm.js';

export const SERVICES = { auth, org, boards, tasks, chat, search, reports, ai, ops, admin, mdm, covers };
export const router = new Router();
for (const mod of Object.values(SERVICES)) mod.register(router);

router.get('/api/events', async (ctx) => pollEvents(ctx.user, ctx.query.after), {});

// ---------------------------------------------------------------- start-up
let readyPromise = null;
let seeded = false;
let envInfo = null;
/**
 * Connect, migrate (schema + versioning triggers), check the database belongs to this
 * environment, and fill an empty database: demo data in development, a bare Superadmin
 * + roles in production (unless AUTO_SEED=1). Runs once per process.
 */
export function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.migrate();
      envInfo = await checkEnvironment();
      if (await db.isEmpty()) {
        const demo = process.env.AUTO_SEED === '1' || (process.env.AUTO_SEED !== '0' && !IS_PRODUCTION);
        if (demo) { await seedEmptyDatabase(); seeded = true; } else {
          const { bootstrapEmpty } = await import('./db/bootstrap.js');
          await bootstrapEmpty();
        }
      } else {
        const { ensureRbacCatalogue } = await import('./db/bootstrap.js');
        // adds new permissions / standard roles to existing databases (a parallel cold start may win the race — fine)
        await ensureRbacCatalogue().catch((e) => console.warn('[rbac catalogue]', e.message));
      }
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

async function seedEmptyDatabase() {
  const { seedSqliteFile } = await import('./db/seed.js');
  const a = await db.adapter();
  if (a.dialect === 'sqlite') {
    console.log('• Empty database — loading software-house seed data…');
    seedSqliteFile(a.file, { reset: false });
    return;
  }
  // Postgres: build the seed in a temp SQLite file, then bulk-copy it (one lock so parallel cold starts don't collide)
  const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
  const { createSqliteAdapter } = await import('./db/sqlite.js');
  const { transfer } = await import('./db/transfer.js');
  await a.tx(async () => {
    await a.exec('SELECT pg_advisory_xact_lock(727274002)');
    if (!(await db.isEmpty())) return;
    console.log('• Empty Postgres database — loading software-house seed data…');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-seed-')), 'seed.db');
    seedSqliteFile(file, { reset: true, quiet: true });
    const src = createSqliteAdapter(file);
    try { await transfer(src, a); } finally { await src.close(); }
  });
}

export async function health() {
  const base = { environment: APP_ENV, time: db.now(), services: Object.keys(SERVICES), realtime: MODE, runtime: process.env.VERCEL ? 'vercel' : 'node', ai_engine: ai.engineName() };
  try {
    await init();
    return { ok: true, ...base, environment: APP_ENV, database_environment: envInfo?.database || null, db: await db.describe(), seeded_now: seeded, versioning: 'enforced (triggers)' };
  } catch (e) {
    return { ok: false, ...base, error: e instanceof db.ConfigError ? e.message : `Database error: ${e.message}` };
  }
}
router.get('/api/health', async (ctx) => {
  const h = await health();
  if (!h.ok) ctx.res.statusCode = 503;
  return h;
}, { public: true, skipInit: true });

// ---------------------------------------------------------------- request handling
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length <= max;
}

/** Resolves the real API path — on Vercel the rewrite passes it as ?wfhpath=… */
export function resolvePath(url) {
  const vp = url.searchParams.get('wfhpath');
  if (vp != null) {
    url.searchParams.delete('wfhpath');
    return `/api/${vp.replace(/^\/+/, '')}`;
  }
  return url.pathname;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = resolvePath(url);
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (process.env.CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Op-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  const started = Date.now();
  try {
    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, `No route for ${req.method} ${pathname}`);
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = m;
    if (!route.opts.skipInit) await init();

    if (route.path.startsWith('/api/auth/') && req.method === 'POST' && !rateLimit(`${ip}:${route.path}`, 20, 60000)) {
      throw new HttpError(429, 'Too many attempts — wait a minute and try again');
    }

    let user = null;
    const authz = req.headers.authorization || '';
    const payload = authz.startsWith('Bearer ') ? verifyToken(authz.slice(7)) : null;
    if (payload) user = await loadUser(payload.sub);
    if (!route.opts.public) {
      if (!user) throw new HttpError(401, 'Please sign in');
      if (!user.is_active) throw new HttpError(403, 'Account deactivated');
    }

    // offline-sync idempotency: replayed mutations carry the same X-Op-Id
    const opId = req.headers['x-op-id'];
    if (opId && req.method !== 'GET' && user) {
      const seen = await db.get('SELECT status FROM az_sync_op WHERE op_id = ?', String(opId));
      if (seen) return sendJSON(res, 200, { duplicate: true, op_id: opId });
    }

    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams.entries());
    const ctx = { req, res, params, query, body, user, ip };
    // who + why for every version written during this request
    const note = (body && typeof body.change_note === 'string' && body.change_note) || query.reason || req.headers['x-change-note'] || null;
    const data = await db.withChange({ actorId: user?.id || null, note: note ? String(note).slice(0, 500) : null, requestId: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` }, async () => {
      if (user) await maybeApplyEffectiveDates().catch((e) => console.error('[effective dates]', e.message));
      return route.handler(ctx);
    });
    if (opId && req.method !== 'GET' && user) {
      await db.run('INSERT OR IGNORE INTO az_sync_op (op_id, user_id, method, path, status, applied_at) VALUES (?,?,?,?,?,?)', String(opId), user.id, req.method, pathname, 200, db.now());
    }
    await flushPending(); // real-time events must be stored before a serverless function freezes
    if (!res.writableEnded && !res.headersSent) sendJSON(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, data ?? { ok: true });
  } catch (e) {
    const config = e instanceof db.ConfigError;
    // rules enforced by the database triggers surface as 409 Conflict with a readable message
    const rule = typeof e?.message === 'string' && /WFH-(NODELETE|IMMUTABLE|RETIRED-REF)/.test(e.message);
    if (rule) e.message = e.message.replace(/^.*?WFH-[A-Z-]+:\s*/, '');
    const status = e instanceof HttpError ? e.status : config ? 503 : rule || e instanceof db.VersionConflict ? 409 : 500;
    if (status === 500) console.error(`[${req.method} ${pathname}]`, e);
    if (!res.headersSent) sendJSON(res, status, { error: status === 500 ? 'Internal server error' : e.message, ...(e.extra || {}) });
    else res.end();
  } finally {
    if (process.env.LOG_REQUESTS) console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

export { MODE };
