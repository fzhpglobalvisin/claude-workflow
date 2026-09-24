// Which environment is this process? Used to keep Neon development and production apart.
//   APP_ENV=development | preview | production     (explicit wins)
//   on Vercel: VERCEL_ENV (production | preview | development)
//   otherwise: development
// The database remembers the environment it belongs to (az_meta.environment). A process
// refuses to start against a database of another environment — e.g. a laptop that points
// DATABASE_URL at the Neon *production* branch — unless ALLOW_ENV_MISMATCH=1.
import { get, run, all, ConfigError } from '../db/index.js';

const norm = (v) => ({ prod: 'production', production: 'production', preview: 'preview', staging: 'preview', dev: 'development', development: 'development', test: 'development' }[String(v || '').toLowerCase()] || null);

export const APP_ENV = norm(process.env.APP_ENV) || norm(process.env.VERCEL_ENV) || (process.env.VERCEL ? 'production' : 'development');
export const IS_PRODUCTION = APP_ENV === 'production';

const compatible = (db, app) => db === app || (db === 'development' && app === 'preview');

export async function databaseEnvironment() {
  return (await get("SELECT value FROM az_meta WHERE key = 'environment'"))?.value || null;
}
export async function tagDatabase(env) {
  const e = norm(env);
  if (!e) throw new Error('Environment must be development, preview or production');
  const cur = await all("SELECT key FROM az_meta WHERE key = 'environment'");
  if (cur.length) await run("UPDATE az_meta SET value = ? WHERE key = 'environment'", e);
  else await run("INSERT INTO az_meta (key, value) VALUES ('environment', ?)", e);
  return e;
}

/** Called once per process after migration. Claims an untagged database, rejects a foreign one. */
export async function checkEnvironment() {
  const tagged = await databaseEnvironment();
  if (!tagged) { await tagDatabase(APP_ENV); return { app: APP_ENV, database: APP_ENV, claimed: true }; }
  if (!compatible(tagged, APP_ENV) && process.env.ALLOW_ENV_MISMATCH !== '1') {
    throw new ConfigError(tagged === 'production'
      ? `This database belongs to PRODUCTION but the app is running as "${APP_ENV}". Point DATABASE_URL at your Neon development branch. `
        + '(If this database really is a development branch that was copied from production, run: npm run db:tag -- development)'
      : `This database is tagged "${tagged}" but the app is running as "${APP_ENV}". A production deployment must use the production database. `
        + '(Tag it with npm run db:tag -- production if it really is the production database.)');
  }
  return { app: APP_ENV, database: tagged, claimed: false };
}
