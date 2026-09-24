// Environment separation tests (Neon development vs production branches), run against SQLite files:
//   • an empty PRODUCTION database gets roles + one Superadmin — never demo data
//   • a development process refuses to start against a production-tagged database
//   • db:tag re-labels a branch copied from production; seed/push refuse production targets
//   npm run test:env
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-env-'));
const DB = path.join(DIR, 'prod.db');
const base = { ...process.env, DB_PATH: DB, DATABASE_URL: '', POSTGRES_URL: '', VERCEL: '', VERCEL_ENV: '', ALLOW_ENV_MISMATCH: '', AUTO_SEED: '', JWT_SECRET: 'x'.repeat(40) };

function initApp(env) {
  const code = `const { init, health } = await import('./server/app.js');
    try { await init(); const db = await import('./server/db/index.js');
      const c = await db.get('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM az_company) AS companies, (SELECT COUNT(*) FROM az_role) AS roles');
      console.log(JSON.stringify({ ok: true, ...c, env: (await health()).environment })); await db.close();
    } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(line); } catch { throw new Error(r.stdout + r.stderr); }
}
const cli = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', 'server/db/cli.js', ...args], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); } catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log('\nWorkflow Hub environment tests\n');
await test('empty production database → roles + Superadmin only (no demo data)', async () => {
  const r = initApp({ APP_ENV: 'production' });
  assert.equal(r.ok, true, r.error); assert.equal(r.users, 1); assert.equal(r.companies, 0); assert.equal(r.roles, 5); assert.equal(r.env, 'production');
});
await test('development process refuses a production-tagged database', async () => {
  const r = initApp({ APP_ENV: 'development' });
  assert.equal(r.ok, false); assert.match(r.error, /belongs to PRODUCTION/);
});
await test('ALLOW_ENV_MISMATCH=1 overrides (explicit, for emergencies)', async () => {
  assert.equal(initApp({ APP_ENV: 'development', ALLOW_ENV_MISMATCH: '1' }).ok, true);
});
await test('seed refuses to wipe a production database', async () => {
  const r = cli(['seed'], { APP_ENV: 'development' });
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /tagged PRODUCTION/);
  assert.ok(fs.existsSync(DB));
});
await test('db:tag relabels a branch copied from production → development works', async () => {
  const t = cli(['tag', 'development']);
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /tagged "development"/);
  const r = initApp({ APP_ENV: 'development' });
  assert.equal(r.ok, true, r.error);
});
await test('production app refuses a development database', async () => {
  const r = initApp({ APP_ENV: 'production' });
  assert.equal(r.ok, false); assert.match(r.error, /must use the production database/);
});
await test('a Vercel preview deployment may use the development database', async () => {
  const r = initApp({ APP_ENV: 'preview' });
  assert.equal(r.ok, true, r.error); assert.equal(r.env, 'preview');
});
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
if (passed !== results.length) process.exitCode = 1;
