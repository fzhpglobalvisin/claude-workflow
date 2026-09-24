// Simulates the Vercel runtime in-process: VERCEL=1, Postgres, the rewritten URL form
// (/api/index?wfhpath=…), Vercel's pre-parsed req.body, the health function and the cron.
//   TEST_DATABASE_URL=postgres://… npm run test:vercel      (the database is wiped!)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PG_URL = process.env.TEST_DATABASE_URL;
if (!PG_URL) { console.log('Set TEST_DATABASE_URL=postgres://… (a throwaway database) to run this test.'); process.exit(0); }

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ')}`); }
}

console.log('\nVercel runtime simulation\n');
await test('missing DATABASE_URL on Vercel → clear 503 from /api/health', async () => {
  const code = `const m = await import('${ROOT}/api/health.js'); const res = { setHeader(){}, end(b){ console.log(this.statusCode, b); } }; await m.default({ headers: {} }, res);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, VERCEL: '1', DATABASE_URL: '', POSTGRES_URL: '', JWT_SECRET: 'x' }, encoding: 'utf8' });
  assert.match(r.stdout, /^503 .*DATABASE_URL is not set/);
});

// fresh database, then load the functions exactly as Vercel would
const { createPostgresAdapter } = await import('../db/postgres.js');
const a = await createPostgresAdapter(PG_URL);
await a.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await a.close();
Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'preview', DATABASE_URL: PG_URL, JWT_SECRET: 'test-secret-'.padEnd(64, 'x'), CRON_SECRET: 'cron-secret', ANTHROPIC_API_KEY: '' });
const api = (await import('../../api/index.js')).default;
const healthFn = (await import('../../api/health.js')).default;
const cronFn = (await import('../../api/cron/ops.js')).default;

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: '', headersSent: false, writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(s, h = {}) { this.statusCode = s; Object.entries(h).forEach(([k, v]) => this.setHeader(k, v)); this.headersSent = true; return this; },
    write(c) { this.body += c; this.headersSent = true; }, end(c = '') { this.body += c; this.headersSent = true; this.writableEnded = true; } };
  return res;
}
async function call(fn, method, apiPath, { body, token, headers = {} } = {}) {
  const [p, qs] = apiPath.split('?');
  const url = `/api/index?wfhpath=${encodeURIComponent(p.replace(/^\/api\//, ''))}${qs ? `&${qs}` : ''}`;
  const req = { method, url, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, socket: { remoteAddress: '1.2.3.4' } };
  Object.defineProperty(req, 'body', { get: () => (body === undefined ? undefined : body) }); // Vercel helper: lazy parsed body
  const res = mockRes();
  await fn(req, res);
  let data; try { data = JSON.parse(res.body); } catch { data = res.body; }
  return { status: res.statusCode, data };
}

await test('api/health.js seeds an empty Postgres on first call', async () => {
  const res = mockRes();
  await healthFn({ method: 'GET', url: '/api/health', headers: {} }, res);
  const h = JSON.parse(res.body);
  assert.equal(res.statusCode, 200); assert.equal(h.ok, true); assert.equal(h.runtime, 'vercel'); assert.equal(h.realtime, 'poll');
  assert.match(h.db, /^postgres/);
});
let token; let zvl; let eng;
await test('rewritten URL form + pre-parsed body: login', async () => {
  const r = await call(api, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(r.status, 200); token = r.data.token; assert.ok(token);
});
await test('query strings survive the rewrite (company-scoped channels)', async () => {
  zvl = (await call(api, 'GET', '/api/companies', { token })).data.find((c) => c.code === 'ZVL');
  const chs = (await call(api, 'GET', `/api/channels?company_id=${zvl.id}`, { token })).data;
  eng = chs.find((c) => c.name === 'engineering'); assert.ok(eng);
});
await test('message → stored event → /api/events poll', async () => {
  const start = (await call(api, 'GET', '/api/events', { token })).data;
  const azam = (await call(api, 'POST', '/api/auth/login', { body: { username: 'azam', password: 'password123' } })).data.token;
  await call(api, 'POST', `/api/channels/${eng.id}/messages`, { token: azam, body: { content: 'hello from serverless @admin' } });
  const next = (await call(api, 'GET', `/api/events?after=${start.last}`, { token })).data;
  assert.ok(next.events.some((e) => e.event === 'message:new'));
  assert.ok(next.events.some((e) => e.event === 'notification' && /mentioned you/.test(e.data.title)));
});
await test('@ai reply completes inside the request lifecycle (no waitUntil available here)', async () => {
  const azam = (await call(api, 'POST', '/api/auth/login', { body: { username: 'azam', password: 'password123' } })).data.token;
  const m = (await call(api, 'POST', `/api/channels/${eng.id}/messages`, { token: azam, body: { content: '@ai status' } })).data;
  const th = (await call(api, 'GET', `/api/messages/${m.id}/thread`, { token: azam })).data;
  assert.ok(th.replies.some((x) => x.is_ai_generated));
});
await test('pipeline run finishes and records its log (background job)', async () => {
  const pl = (await call(api, 'GET', '/api/ops/pipelines', { token })).data.find((p) => p.type === 'monitor');
  const r = (await call(api, 'POST', `/api/ops/pipelines/${pl.id}/run`, { token, body: {} })).data;
  const runs = (await call(api, 'GET', `/api/ops/pipelines/${pl.id}/runs`, { token })).data;
  const run = runs.find((x) => x.id === r.run_id);
  assert.ok(run && run.status !== 'running' && /Value =/.test(run.logs));
});
await test('DB editor works on Postgres (ctid row keys)', async () => {
  const t = (await call(api, 'GET', '/api/admin/db/az_group', { token })).data;
  const row = t.rows[0];
  const up = await call(api, 'PATCH', `/api/admin/db/az_group/${encodeURIComponent(row.__rowid)}`, { token, body: { description: 'edited on vercel' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await call(api, 'GET', '/api/admin/db/az_group', { token })).data.rows[0].description, 'edited on vercel');
});
await test('cron requires CRON_SECRET and samples metrics', async () => {
  const r1 = mockRes(); await cronFn({ headers: {} }, r1); assert.equal(r1.statusCode, 401);
  const r2 = mockRes(); await cronFn({ headers: { authorization: 'Bearer cron-secret' } }, r2);
  assert.equal(JSON.parse(r2.body).ok, true);
  const m = (await call(api, 'GET', '/api/ops/metrics', { token })).data;
  assert.ok(m.samples.length >= 1 && m.current.db_size_kb > 0);
});
await test('vercel.json rewrite pattern routes the right paths to api/index', async () => {
  const vj = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const src = vj.rewrites[0].source; // /api/:wfhpath(<regex>)
  const re = new RegExp(`^/api/${src.match(/\((.*)\)$/)[1]}$`);
  for (const p of ['/api/boards/1', '/api/auth/login', '/api/healthz', '/api/admin/db/users']) assert.ok(re.test(p), p);
  for (const p of ['/api/health', '/api/index', '/api/cron/ops']) assert.ok(!re.test(p), p);
});

const { close } = await import('../db/index.js');
await close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
if (passed !== results.length) process.exitCode = 1;
