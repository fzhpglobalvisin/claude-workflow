// Database command line.
//   npm run db:migrate   create / update tables on the configured database
//   npm run db:seed      wipe + load the software-house demo data
//   npm run db:push      copy your local SQLite data (data/workflow.db) → DATABASE_URL (Postgres)
//   npm run db:pull      copy DATABASE_URL (Postgres) → local SQLite data/workflow.db
//   npm run db:status    environment tag, schema, versioning statistics
//   npm run db:tag -- development|preview|production   set which environment this database belongs to
// The target is DATABASE_URL when set, otherwise the local SQLite file.
// Destructive commands (seed, push) refuse to touch a database tagged "production"
// unless you add --allow-production (Neon: never seed/push into the production branch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB_PATH, DATABASE_URL, describe, adapter, close, get, all } from './index.js';
import { createSqliteAdapter } from './sqlite.js';
import { seedSqliteFile } from './seed.js';
import { transfer } from './transfer.js';

const cmd = process.argv[2];
const isPg = /^postgres(ql)?:\/\//i.test(DATABASE_URL);
const allowProd = process.argv.includes('--allow-production');

async function guardProduction(action) {
  if (!isPg && !fs.existsSync(DB_PATH)) return;
  const a = await adapter();
  await a.migrate();
  const tag = (await get("SELECT value FROM az_meta WHERE key = 'environment'"))?.value;
  if (tag === 'production' && !allowProd) {
    throw new Error(`Refusing to ${action}: ${await describe()} is tagged PRODUCTION. Point DATABASE_URL at your Neon development branch (or pass --allow-production if you really mean it).`);
  }
}

async function main() {
  if (cmd === 'migrate') {
    const a = await adapter();
    await a.migrate();
    const { checkEnvironment } = await import('../lib/environment.js');
    const env = await checkEnvironment(); // claims an untagged database for APP_ENV, refuses a foreign one
    console.log(`✓ Schema + versioning triggers are up to date on ${await describe()} (environment: ${env.database})`);
  } else if (cmd === 'status') {
    const a = await adapter();
    await a.migrate();
    const { APP_ENV } = await import('../lib/environment.js');
    const tag = (await get("SELECT value FROM az_meta WHERE key = 'environment'"))?.value || '(untagged)';
    const v = await get('SELECT COUNT(*) AS n, MAX(recorded_at) AS last FROM az_version');
    const retired = await all("SELECT entity_type, COUNT(*) AS n FROM az_version WHERE operation = 'retire' GROUP BY entity_type ORDER BY n DESC");
    console.log(`Database     ${await describe()}\nTagged as    ${tag}\nThis app is  ${APP_ENV}\nVersions     ${v.n} (last change ${v.last || '—'})`);
    if (retired.length) console.log(`Retirements  ${retired.map((r) => `${r.entity_type} ${r.n}`).join(', ')}`);
  } else if (cmd === 'tag') {
    const env = process.argv[3];
    const a = await adapter();
    await a.migrate();
    const { tagDatabase } = await import('../lib/environment.js');
    const e = await tagDatabase(env);
    console.log(`✓ ${await describe()} is now tagged "${e}"`);
  } else if (cmd === 'seed') {
    await guardProduction('wipe and seed demo data');
    if (!isPg) {
      await close();
      for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(f, { force: true });
      seedSqliteFile(DB_PATH, { reset: true });
      console.log(`✓ Seeded ${DB_PATH}`);
    } else {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-seed-')), 'seed.db');
      seedSqliteFile(tmp, { reset: true });
      const src = createSqliteAdapter(tmp);
      await transfer(src, await adapter());
      await src.close();
      console.log(`✓ Seeded ${await describe()}`);
    }
  } else if (cmd === 'push') {
    if (!isPg) throw new Error('Set DATABASE_URL to your Postgres connection string first (e.g. in .env).');
    if (!fs.existsSync(DB_PATH)) throw new Error(`No local database at ${DB_PATH}. Run the app locally once or run: npm run db:seed (without DATABASE_URL).`);
    await guardProduction('overwrite it with your local data');
    const src = createSqliteAdapter(DB_PATH);
    await transfer(src, await adapter());
    await src.close();
    console.log(`✓ Pushed ${DB_PATH} → ${await describe()}  (the target's previous data was replaced)`);
  } else if (cmd === 'pull') {
    if (!isPg) throw new Error('Set DATABASE_URL to the Postgres database you want to download.');
    const target = createSqliteAdapter(DB_PATH);
    await transfer(await adapter(), target);
    await target.close();
    console.log(`✓ Pulled ${await describe()} → ${DB_PATH}`);
  } else {
    console.log('Usage: node server/db/cli.js <migrate|seed|push|pull|status|tag <env>> [--allow-production]');
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`✖ ${e.message}`); process.exitCode = 1; }).finally(() => close());
