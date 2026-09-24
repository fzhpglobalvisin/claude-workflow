// Database facade. Picks the engine at start-up:
//   DATABASE_URL=postgres://…  → PostgreSQL (required on Vercel)
//   otherwise                  → SQLite file at DB_PATH (default data/workflow.db)
// Every helper is async and identical for both engines.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BY_TABLE } from './versioning.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'workflow.db');
export const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const IS_SERVERLESS = !!process.env.VERCEL;

export class ConfigError extends Error {}
/** Optimistic-concurrency failure: the record changed since the client loaded it. */
export class VersionConflict extends Error {}

let adapterPromise = null;
export function adapter() {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      if (/^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
        const { createPostgresAdapter } = await import('./postgres.js');
        return createPostgresAdapter(DATABASE_URL);
      }
      if (IS_SERVERLESS) {
        throw new ConfigError('DATABASE_URL is not set. On Vercel, add a Postgres database (Neon / Supabase / Vercel Postgres) and set DATABASE_URL in Project → Settings → Environment Variables.');
      }
      const { createSqliteAdapter } = await import('./sqlite.js');
      return createSqliteAdapter(DB_PATH);
    })();
    adapterPromise.catch(() => { adapterPromise = null; }); // allow retry after a failed start
  }
  return adapterPromise;
}

export const uuid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

// ---------------------------------------------------------------- change context (who / why)
// Every request runs inside a context; insert()/update() stamp changed_by, change_note and a
// unique change_id on protected tables so the triggers can attribute each new version.
const changeCtx = new AsyncLocalStorage();
/** Run fn with { actorId, note, requestId } as the change context. */
export function withChange(ctx, fn) {
  const parent = changeCtx.getStore();
  const next = { ...parent, ...ctx };
  next.requestId = ctx.requestId || parent?.requestId || uuid().slice(0, 13);
  next.counter = (!ctx.requestId && parent?.counter) || { n: 0 }; // one sequence per request
  return changeCtx.run(next, fn);
}
export const changeContext = () => changeCtx.getStore() || null;
function nextChangeId() {
  const c = changeCtx.getStore();
  if (!c) return `sys-${uuid().slice(0, 13)}.1`;
  c.counter.n += 1;
  return `${c.requestId}.${c.counter.n}`;
}
/** Adds attribution to a write on a protected table (no-op for technical tables). */
export function stamp(table, obj, { insert: isInsert = false } = {}) {
  const def = BY_TABLE[table];
  if (!def) return obj;
  const o = { ...obj };
  for (const k of ['version_no', 'retired_at', 'change_id', 'doc_no']) delete o[k]; // owned by the triggers
  const c = changeCtx.getStore();
  const business = isInsert || Object.keys(o).some((k) => !def.nonBusiness.has(k) && k !== 'changed_by' && k !== 'change_note');
  if (business) {
    o.changed_by = o.changed_by || c?.actorId || 'system';
    if (o.change_note === undefined) o.change_note = c?.note || null;
    o.change_id = nextChangeId();
  } else { delete o.changed_by; delete o.change_note; }
  if (isInsert && def.hasOwner && o.owner_id === undefined) o.owner_id = c?.actorId || null;
  return o;
}
/** Trigger control flags (bulk load / controlled purge) for the duration of fn. */
export const withFlags = async (flags, fn) => (await adapter()).withFlags(flags, fn);

export const all = async (sql, ...p) => (await adapter()).all(sql, ...p);
export const get = async (sql, ...p) => (await adapter()).get(sql, ...p);
export const run = async (sql, ...p) => (await adapter()).run(sql, ...p);
export const tx = async (fn) => (await adapter()).tx(fn);
export const exec = async (sql) => (await adapter()).exec(sql);
export const migrate = async () => (await adapter()).migrate();
export const tableNames = async () => (await adapter()).tableNames();
export const tableColumns = async (t) => (await adapter()).tableColumns(t);
export const rowKey = async () => (await adapter()).rowKey;
export const dialect = async () => (await adapter()).dialect;
export const sizeKb = async () => (await adapter()).sizeKb();
export const backup = async () => (await adapter()).backup();
export async function close() { if (adapterPromise) { const a = await adapterPromise.catch(() => null); await a?.close(); adapterPromise = null; } }

const IDENT = /^[a-z_][a-z0-9_]*$/i;
export async function insert(table, input) {
  const obj = stamp(table, input, { insert: true });
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  keys.forEach((k) => { if (!IDENT.test(k)) throw new Error(`bad column ${k}`); });
  await run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => obj[k]));
  return obj;
}
/**
 * Updates one row. On protected tables the triggers turn a business change into a new version.
 * Pass `_expect_version` to enforce optimistic concurrency (throws VersionConflict).
 */
export async function update(table, id, input, idCol = 'id') {
  const expect = input._expect_version;
  const obj = stamp(table, Object.fromEntries(Object.entries(input).filter(([k]) => k !== '_expect_version')));
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) return;
  keys.forEach((k) => { if (!IDENT.test(k)) throw new Error(`bad column ${k}`); });
  const guard = expect != null && BY_TABLE[table] ? ' AND version_no = ?' : '';
  const r = await run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idCol} = ?${guard}`, ...keys.map((k) => obj[k]), id, ...(guard ? [Number(expect)] : []));
  if (guard && !r.changes) {
    const cur = await get(`SELECT version_no FROM ${table} WHERE ${idCol} = ?`, id);
    if (cur) throw new VersionConflict(`This record was changed by someone else (now version ${cur.version_no}, you edited version ${expect}). Reload and try again.`);
  }
  return r;
}

export function j(v, fallback = null) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

export async function isEmpty() {
  return !(await get('SELECT 1 AS x FROM users LIMIT 1'));
}

export async function describe() {
  const a = await adapter();
  if (a.dialect === 'pg') { let host = ''; try { host = new URL(DATABASE_URL).host; } catch {} return `postgres (${host})`; }
  return `sqlite (${path.relative(ROOT, a.file) || a.file})`;
}
