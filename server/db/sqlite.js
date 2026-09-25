// SQLite adapter (local development) — Node's built-in node:sqlite, no native build.
// Exposes the same async API as postgres.js so services never care which one runs.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { ENTITIES, LOG_TABLES, requiredColumns, sqliteTriggerSql, sqliteLogTriggerSql, backfill } from './versioning.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// node:sqlite only binds null/number/bigint/string/Uint8Array
export function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** Adds the MDM control columns and (re)creates every versioning / no-delete trigger. Idempotent. */
function applyVersioning(db, has) {
  db.exec('DELETE FROM az_ctl'); // flags only live inside a transaction — clear anything stale
  for (const def of Object.values(ENTITIES)) {
    for (const [c, type] of requiredColumns(def)) if (!has(def.table, c)) db.exec(`ALTER TABLE ${def.table} ADD COLUMN ${c} ${type}`);
    if (def.docNo) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${def.table}_doc_no ON ${def.table}(doc_no)`);
    const cols = db.prepare(`PRAGMA table_info(${def.table})`).all().map((c) => c.name);
    db.exec('BEGIN');
    try { for (const stmt of sqliteTriggerSql(def, cols)) db.exec(stmt); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  for (const [table, mode] of Object.entries(LOG_TABLES)) for (const stmt of sqliteLogTriggerSql(table, mode)) db.exec(stmt);
}

/** Synchronous handle — used by the async adapter below and by the seed script. */
export function openSync(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const api = {
    db,
    all: (sql, ...p) => stmt(sql).all(...p.map(norm)).map((r) => ({ ...r })),
    get: (sql, ...p) => { const r = stmt(sql).get(...p.map(norm)); return r ? { ...r } : undefined; },
    run: (sql, ...p) => stmt(sql).run(...p.map(norm)),
    exec: (sql) => db.exec(sql),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    migrate() {
      db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
      // additive column migrations for databases created by older versions
      const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
      if (!has('users', 'last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
      if (!has('az_workspace', 'cover_url')) db.exec('ALTER TABLE az_workspace ADD COLUMN cover_url TEXT');
      if (!has('az_board', 'cover_url')) db.exec('ALTER TABLE az_board ADD COLUMN cover_url TEXT');
      applyVersioning(db, has);
    },
    /** column list per versioned table (used by the baseline step) */
    versionedColumns() {
      return Object.fromEntries(Object.values(ENTITIES).map((d) => [d.table, db.prepare(`PRAGMA table_info(${d.table})`).all().map((c) => c.name)]));
    },
    close: () => db.close(),
  };
  return api;
}

/** Async adapter. Statements run synchronously; transactions are serialised with a lock
 *  so two concurrent requests never try to BEGIN on the same connection. */
export function createSqliteAdapter(file) {
  const s = openSync(file);
  const als = new AsyncLocalStorage();
  let lock = Promise.resolve();
  return {
    dialect: 'sqlite',
    file,
    all: async (sql, ...p) => s.all(sql, ...p),
    get: async (sql, ...p) => s.get(sql, ...p),
    run: async (sql, ...p) => { const r = s.run(sql, ...p); return { changes: Number(r.changes) }; },
    exec: async (sql) => s.exec(sql),
    async tx(fn) {
      if (als.getStore()) return fn(); // nested → join the outer transaction
      const prev = lock; let release;
      lock = new Promise((r) => { release = r; });
      await prev;
      try {
        return await als.run(true, async () => {
          s.exec('BEGIN');
          try { const r = await fn(); s.exec('COMMIT'); return r; } catch (e) { s.exec('ROLLBACK'); throw e; }
        });
      } finally { release(); }
    },
    async migrate() {
      s.migrate();
      const cols = s.versionedColumns();
      return this.withFlags({ bulk: 1 }, async () => backfill({ dialect: 'sqlite', all: this.all, get: this.get, run: this.run }, cols));
    },
    /** Sets trigger control flags (bulk / purge / actor / note) for the duration of fn, inside one transaction. */
    async withFlags(flags, fn) {
      return this.tx(async () => {
        const before = s.all('SELECT k, v FROM az_ctl');
        for (const [k, v] of Object.entries(flags)) if (v != null) s.run('INSERT OR REPLACE INTO az_ctl (k, v) VALUES (?, ?)', k, String(v));
        try { return await fn(); } finally {
          s.run('DELETE FROM az_ctl');
          for (const r of before) s.run('INSERT INTO az_ctl (k, v) VALUES (?, ?)', r.k, r.v);
        }
      });
    },
    async tableNames() { return s.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name); },
    async tableColumns(t) { return s.all(`PRAGMA table_info(${t})`).map((c) => ({ name: c.name, type: c.type, pk: !!c.pk, notnull: !!c.notnull })); },
    rowKey: { select: 'rowid', where: 'rowid = ?', order: 'rowid', parse: (v) => Number(v) },
    async sizeKb() { try { return fs.statSync(file).size / 1024; } catch { return 0; } },
    async backup() { fs.copyFileSync(file, `${file}.bak`); return `${file}.bak`; },
    async close() { s.close(); },
    sync: s,
  };
}
