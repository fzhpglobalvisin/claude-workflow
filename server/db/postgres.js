// PostgreSQL adapter (Vercel / cloud) — uses the `pg` driver.
// Works with Neon, Supabase, Vercel Postgres, RDS or a local Postgres.
// The app writes SQLite-flavoured SQL; this adapter translates the few differences:
//   ?  → $1, $2 …            INSERT OR IGNORE → ON CONFLICT DO NOTHING
//   LIKE → ILIKE (SQLite LIKE is case-insensitive)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { pgVersioningSql, backfill } from './versioning.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(here, 'schema.pg.sql');

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

const cache = new Map();
export function translate(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let n = 0; let inStr = false; out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") inStr = !inStr;
    out += c === '?' && !inStr ? `$${++n}` : c;
  }
  if (/^\s*INSERT OR IGNORE INTO/i.test(out)) out = `${out.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO')} ON CONFLICT DO NOTHING`;
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  cache.set(sql, out);
  return out;
}

export async function createPostgresAdapter(url) {
  let pg;
  try { pg = (await import('pg')).default; } catch {
    throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run: npm install pg');
  }
  // COUNT/SUM return int8 and AVG/ROUND return numeric — parse them to JS numbers like SQLite does
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));

  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const local = ['', 'localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  const serverless = !!process.env.VERCEL;
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || (serverless ? 3 : 10)),
    idleTimeoutMillis: serverless ? 5000 : 30000,
    ssl: local || /sslmode=/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
  const als = new AsyncLocalStorage();
  const q = async (sql, params) => {
    const c = als.getStore()?.client || pool;
    return c.query(translate(sql), params.map(norm));
  };

  return {
    dialect: 'pg',
    all: async (sql, ...p) => (await q(sql, p)).rows,
    get: async (sql, ...p) => (await q(sql, p)).rows[0],
    run: async (sql, ...p) => ({ changes: (await q(sql, p)).rowCount }),
    exec: async (sql) => { await (als.getStore()?.client || pool).query(sql); },
    async tx(fn) {
      if (als.getStore()) return fn();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await als.run({ client }, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    },
    /** Applies schema.pg.sql when it changed (hash stored in az_meta). Safe with many cold starts. */
    async migrate() {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      const versioning = pgVersioningSql();
      const version = crypto.createHash('sha1').update(sql).update(versioning).digest('hex').slice(0, 12);
      const cur = await pool.query("SELECT to_regclass('az_meta') AS t").then(async (r) => (r.rows[0].t
        ? (await pool.query("SELECT value FROM az_meta WHERE key = 'schema_version'")).rows[0]?.value : null));
      if (cur === version) return false;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(727274001)');
        await client.query(sql);
        await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT');
        await client.query(versioning);
        // number existing documents + baseline history for existing rows (bulk mode: no new versions)
        await client.query("SELECT set_config('wfh.bulk', '1', true)");
        const cq = async (text, p) => client.query(translate(text), (p || []).map(norm));
        const stats = await backfill({
          dialect: 'pg',
          all: async (t, ...p) => (await cq(t, p)).rows,
          get: async (t, ...p) => (await cq(t, p)).rows[0],
          run: async (t, ...p) => ({ changes: (await cq(t, p)).rowCount }),
        });
        await client.query("SELECT set_config('wfh.bulk', '', true)");
        if (stats.numbered || stats.baselined) console.log(`• Versioning baseline: ${stats.baselined} records, ${stats.numbered} document numbers assigned`);
        await client.query("INSERT INTO az_meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [version]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
      return true;
    },
    /** Sets trigger control flags (wfh.bulk / wfh.purge / wfh.actor / wfh.note) for fn, transaction-local. */
    async withFlags(flags, fn) {
      return this.tx(async () => {
        const c = als.getStore().client;
        const keys = Object.keys(flags).filter((k) => flags[k] != null);
        const before = {};
        for (const k of keys) before[k] = (await c.query('SELECT current_setting($1, true) AS v', [`wfh.${k}`])).rows[0].v || '';
        for (const k of keys) await c.query('SELECT set_config($1, $2, true)', [`wfh.${k}`, String(flags[k])]);
        try { return await fn(); } finally {
          for (const k of keys) await c.query('SELECT set_config($1, $2, true)', [`wfh.${k}`, before[k]]).catch(() => {});
        }
      });
    },
    async tableNames() {
      return (await pool.query(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'az_meta' ORDER BY 1`)).rows.map((r) => r.name);
    },
    async tableColumns(t) {
      const cols = (await pool.query(`SELECT column_name AS name, data_type AS type, is_nullable = 'NO' AS notnull
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [t])).rows;
      const pk = new Set((await pool.query(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`, [t])).rows.map((r) => r.name));
      return cols.map((c) => ({ ...c, pk: pk.has(c.name) }));
    },
    rowKey: { select: 'ctid::text', where: 'ctid = ?::tid', order: 'ctid', parse: (v) => String(v) },
    async sizeKb() { return Number((await pool.query('SELECT pg_database_size(current_database()) AS s')).rows[0].s) / 1024; },
    async backup() { return null; }, // managed Postgres providers handle backups/PITR
    async close() { await pool.end(); },
    pool,
  };
}
