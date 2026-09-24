// Admin service — super admin manages users (auth), roles/permissions, board access rights,
// audit trail, and a guarded SQLite table editor ("edit mode").
import { get, all, run, insert, update, uuid, now, j, tableNames, tableColumns, rowKey, dialect, stamp } from '../db/index.js';
import { mapAsync } from '../lib/async.js';
import { bad, notFound, forbidden, str, oneOf, toCSV, HttpError } from '../lib/http.js';
import { requireSuper, requirePerm, isAdmin, isSuper } from '../lib/access.js';
import { hashPassword } from '../lib/security.js';
import { audit, notify } from '../lib/events.js';
import { onlineUserIds, sendTo } from '../lib/realtime.js';
import { retire, reactivate, upsertMembership } from '../lib/mdm.js';
import { BY_TABLE, LOG_TABLES } from '../db/versioning.js';

const USER_SELECT = `SELECT u.id, u.username, u.email, u.is_super_admin, u.is_active, u.last_login_at, u.created_at,
    p.full_name, p.role, p.designation, p.department, p.whatsapp_number, p.color, p.is_guest, p.status,
    u.version_no, u.retired_at,
    (SELECT COUNT(*) FROM az_board_member m WHERE m.user_id = u.id AND m.is_active = 1) AS board_count,
    (SELECT COUNT(*) FROM az_workspace_member m WHERE m.user_id = u.id AND m.is_active = 1) AS unit_count
  FROM users u JOIN profiles p ON p.id = u.id`;
const shapeUser = (u) => ({ ...u, is_super_admin: !!u.is_super_admin, is_active: !!u.is_active, is_guest: !!u.is_guest });

export function register(r) {
  // ---------------- Users ----------------
  r.get('/api/admin/users', async (ctx) => {
    if (!isAdmin(ctx.user)) throw forbidden('Admins only');
    const online = new Set(await onlineUserIds());
    return (await all(`${USER_SELECT} ORDER BY p.full_name`)).map((u) => ({ ...shapeUser(u), online: online.has(u.id) }));
  });
  r.post('/api/admin/users', async (ctx) => {
    requirePerm(ctx.user, 'admin.users');
    const b = ctx.body;
    const username = str(b.username, 'Username', { min: 3, max: 32 }).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(username)) throw bad('Invalid username');
    if (await get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Username already exists');
    const roles = (await all('SELECT name FROM az_role WHERE is_active = 1')).map((x) => x.name);
    const role = oneOf(b.role, 'role', roles, 'developer');
    if (role === 'super_admin' && !isSuper(ctx.user)) throw forbidden('Only a super admin can create super admins');
    const id = uuid(); const t = now();
    await insert('users', { id, username, email: b.email || null, password_hash: hashPassword(str(b.password, 'Password', { min: 6 })), is_super_admin: role === 'super_admin' ? 1 : 0, is_active: 1, created_at: t, updated_at: t });
    await insert('profiles', { id, full_name: str(b.full_name || username, 'Full name', { max: 120 }), email: b.email || null, role, designation: b.designation || null, department: b.department || null, whatsapp_number: b.whatsapp_number || null, is_guest: role === 'guest' ? 1 : 0, color: b.color || '#6366f1', status: 'offline', created_at: t, updated_at: t });
    await audit({ actor: ctx.user, type: 'admin.user_created', entityType: 'user', entityId: id, details: { username, role }, ip: ctx.ip });
    return shapeUser(await get(`${USER_SELECT} WHERE u.id = ?`, id));
  });
  r.patch('/api/admin/users/:id', async (ctx) => {
    requirePerm(ctx.user, 'admin.users');
    const target = await get(`${USER_SELECT} WHERE u.id = ?`, ctx.params.id);
    if (!target) throw notFound('User not found');
    const b = ctx.body; const changes = {};
    if ((target.is_super_admin || b.role === 'super_admin' || b.is_super_admin !== undefined) && !isSuper(ctx.user)) throw forbidden('Only a super admin can change super admin accounts');
    if (b.role !== undefined) {
      const roles = (await all('SELECT name FROM az_role WHERE is_active = 1')).map((x) => x.name);
      const role = oneOf(b.role, 'role', roles);
      await update('profiles', target.id, { role, is_guest: role === 'guest' ? 1 : 0, updated_at: now() });
      await update('users', target.id, { is_super_admin: role === 'super_admin' ? 1 : 0 });
      changes.role = role;
    }
    if (b.is_active !== undefined) {
      if (target.id === ctx.user.id && !b.is_active) throw bad('You cannot deactivate yourself');
      if (b.is_active) await reactivate('user', target.id, { reason: b.change_note || 'Account reactivated' });
      else await retire('user', target.id, { reason: b.change_note || 'Account deactivated' });
      changes.is_active = !!b.is_active;
      if (!b.is_active) sendTo([target.id], 'force-logout', { reason: 'Account deactivated' });
    }
    if (b.password) { await update('users', target.id, { password_hash: hashPassword(str(b.password, 'Password', { min: 6 })), updated_at: now() }); changes.password = 'reset'; }
    const prof = {};
    for (const k of ['full_name', 'designation', 'department', 'whatsapp_number', 'color']) if (b[k] !== undefined) prof[k] = b[k] || null;
    if (Object.keys(prof).length) { await update('profiles', target.id, { ...prof, updated_at: now() }); Object.assign(changes, prof); }
    if (b.email !== undefined) { await update('users', target.id, { email: b.email || null }); await update('profiles', target.id, { email: b.email || null }); changes.email = b.email; }
    await audit({ actor: ctx.user, type: 'admin.user_updated', entityType: 'user', entityId: target.id, details: { username: target.username, ...changes }, ip: ctx.ip });
    if (changes.role) await notify([target.id], { type: 'access', title: `Your role was changed to ${changes.role}`, actorId: ctx.user.id });
    return shapeUser(await get(`${USER_SELECT} WHERE u.id = ?`, target.id));
  });
  // Users are never deleted: every task, message and version still points at them. "Delete" retires
  // the account (cannot sign in, disappears from pickers); the Superadmin can reactivate it.
  r.delete('/api/admin/users/:id', async (ctx) => {
    requireSuper(ctx.user);
    if (ctx.params.id === ctx.user.id) throw bad('You cannot retire yourself');
    const u = await get('SELECT username FROM users WHERE id = ?', ctx.params.id);
    if (!u) throw notFound();
    await retire('user', ctx.params.id, { reason: ctx.query.reason || 'Account retired' });
    sendTo([ctx.params.id], 'force-logout', { reason: 'Account retired' });
    await audit({ actor: ctx.user, type: 'admin.user_retired', entityType: 'user', entityId: ctx.params.id, details: { ...u, reason: ctx.query.reason || null }, ip: ctx.ip });
    return { ok: true, retired: true };
  });

  // ---------------- Roles & permissions ----------------
  r.get('/api/admin/roles', async (ctx) => {
    if (!isAdmin(ctx.user)) throw forbidden('Admins only');
    const roles = await all(`SELECT r.*, (SELECT COUNT(*) FROM profiles p WHERE p.role = r.name) AS user_count FROM az_role r WHERE r.is_active = 1 ORDER BY r.created_at`);
    const permissions = await all('SELECT * FROM az_permission WHERE is_active = 1 ORDER BY key');
    const grants = await all('SELECT role_id, permission_id FROM az_role_permission WHERE is_active = 1');
    return { roles: roles.map((ro) => ({ ...ro, permissions: grants.filter((g) => g.role_id === ro.id).map((g) => permissions.find((p) => p.id === g.permission_id)?.key).filter(Boolean) })), permissions };
  });
  r.post('/api/admin/roles', async (ctx) => {
    requirePerm(ctx.user, 'admin.roles');
    const name = str(ctx.body.name, 'Role name', { max: 40 }).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (await get('SELECT 1 FROM az_role WHERE name = ?', name)) throw new HttpError(409, 'Role exists (role names are permanent keys — reactivate a retired role instead)');
    const ro = await insert('az_role', { id: uuid(), name, description: ctx.body.description || null, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'admin.role_created', entityType: 'role', entityId: ro.id, details: { name }, ip: ctx.ip });
    return ro;
  });
  r.put('/api/admin/roles/:id/permissions', async (ctx) => {
    requirePerm(ctx.user, 'admin.roles');
    const ro = await get('SELECT * FROM az_role WHERE id = ?', ctx.params.id);
    if (!ro) throw notFound('Role not found');
    if (ro.name === 'super_admin') throw bad('super_admin always has every permission');
    const keys = Array.isArray(ctx.body.keys) ? ctx.body.keys : [];
    const perms = await all('SELECT id, key FROM az_permission WHERE is_active = 1');
    // grants are versioned rows: granted → is_active 1, revoked → is_active 0 (never deleted/re-inserted)
    const existing = Object.fromEntries((await all('SELECT permission_id, is_active FROM az_role_permission WHERE role_id = ?', ro.id)).map((g) => [g.permission_id, g.is_active]));
    for (const p of perms) {
      const want = keys.includes(p.key) ? 1 : 0;
      if (!(p.id in existing)) { if (want) await insert('az_role_permission', { role_id: ro.id, permission_id: p.id }); continue; }
      if (existing[p.id] === want) continue;
      if (want) await reactivate('role_permission', `${ro.id}:${p.id}`, { reason: ctx.body.change_note || 'Permission granted' });
      else await retire('role_permission', `${ro.id}:${p.id}`, { reason: ctx.body.change_note || 'Permission revoked' });
    }
    await audit({ actor: ctx.user, type: 'admin.role_permissions_set', entityType: 'role', entityId: ro.id, details: { role: ro.name, keys }, ip: ctx.ip });
    return { ok: true };
  });

  // ---------------- Board access matrix ----------------
  r.get('/api/admin/access', async (ctx) => {
    if (!isAdmin(ctx.user)) throw forbidden('Admins only');
    const boards = await all(`SELECT b.id, b.title, w.name AS unit_name, c.code AS company_code, c.name AS company_name FROM az_board b
                          JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id
                          WHERE b.is_active = 1 AND w.is_active = 1 AND c.is_active = 1 ORDER BY c.code, w.name, b.title`);
    const users = await all(`SELECT u.id, u.username, p.full_name, p.role, p.color FROM users u JOIN profiles p ON p.id = u.id WHERE u.is_active = 1 ORDER BY p.full_name`);
    const grants = await all('SELECT board_id, user_id, role FROM az_board_member WHERE is_active = 1');
    return { boards, users, grants };
  });

  // ---------------- Audit trail ----------------
  r.get('/api/admin/audit', async (ctx) => {
    requirePerm(ctx.user, 'audit.view');
    const q = ctx.query; const where = ['1 = 1']; const params = [];
    if (q.type) { where.push('a.type LIKE ?'); params.push(`${q.type}%`); }
    if (q.actor_id) { where.push('a.actor_id = ?'); params.push(q.actor_id); }
    if (q.company_id) { where.push('a.company_id = ?'); params.push(q.company_id); }
    if (q.board_id) { where.push('a.board_id = ?'); params.push(q.board_id); }
    if (q.from) { where.push('a.created_at >= ?'); params.push(new Date(q.from).toISOString()); }
    if (q.to) { where.push('a.created_at <= ?'); params.push(new Date(new Date(q.to).getTime() + 864e5).toISOString()); }
    if (q.q) { where.push('(a.details LIKE ? OR a.entity_id LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    const limit = Math.min(q.format === 'csv' ? 10000 : 500, Number(q.limit) || 200);
    const rows = await all(`SELECT a.id, a.created_at, a.type, a.entity_type, a.entity_id, a.details, a.ip, a.actor_id, u.username AS actor_username, p.full_name AS actor_name,
                             b.title AS board_title, c.code AS company_code
                        FROM az_activity_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN profiles p ON p.id = a.actor_id
                        LEFT JOIN az_board b ON b.id = a.board_id LEFT JOIN az_company c ON c.id = a.company_id
                       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ${limit}`, ...params);
    if (q.format === 'csv') {
      ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"' });
      ctx.res.end(toCSV(rows));
      return;
    }
    const types = (await all('SELECT DISTINCT type FROM az_activity_log ORDER BY type')).map((x) => x.type);
    return { rows: rows.map((x) => ({ ...x, details: j(x.details) })), types };
  });

  // ---------------- DB editor (super admin "edit mode") ----------------
  const HIDDEN = new Set(['password_hash']);
  // versioned tables: every edit here becomes a new version; control columns belong to the triggers
  const TRIGGER_OWNED = new Set(['version_no', 'retired_at', 'change_id', 'changed_by', 'doc_no']);
  const protection = (t) => (BY_TABLE[t] ? { kind: 'versioned', entity: BY_TABLE[t].entity } : LOG_TABLES[t] ? { kind: LOG_TABLES[t] } : { kind: 'technical' });
  const tableInfo = (t) => tableColumns(t);
  async function assertTable(t) { if (!(await tableNames()).includes(t)) throw notFound('Unknown table'); return t; }

  r.get('/api/admin/db/tables', async (ctx) => {
    requireSuper(ctx.user);
    return mapAsync(await tableNames(), async (t) => ({ name: t, rows: (await get(`SELECT COUNT(*) AS n FROM ${t}`)).n, columns: (await tableInfo(t)).map((c) => c.name), protection: protection(t) }));
  });
  r.get('/api/admin/db/:table', async (ctx) => {
    requireSuper(ctx.user);
    const t = await assertTable(ctx.params.table);
    const cols = await tableInfo(t);
    const page = Math.max(0, Number(ctx.query.page) || 0); const size = Math.min(200, Number(ctx.query.size) || 50);
    let where = ''; const params = [];
    if (ctx.query.q) {
      const text = cols.filter((c) => !HIDDEN.has(c.name)).map((c) => `CAST(${c.name} AS TEXT) LIKE ?`);
      where = `WHERE ${text.join(' OR ')}`; text.forEach(() => params.push(`%${ctx.query.q}%`));
    }
    const total = (await get(`SELECT COUNT(*) AS n FROM ${t} ${where}`, ...params)).n;
    const rk = await rowKey();
    const rows = (await all(`SELECT ${rk.select} AS __rowid, * FROM ${t} ${where} ORDER BY ${rk.order} DESC LIMIT ${size} OFFSET ${page * size}`, ...params))
      .map((row) => { for (const h of HIDDEN) if (h in row) row[h] = '••••••'; return row; });
    return { engine: await dialect(), table: t, protection: protection(t), columns: cols.map((c) => ({ name: c.name, type: c.type, pk: !!c.pk, notnull: !!c.notnull, hidden: HIDDEN.has(c.name) })), rows, total, page, size };
  });
  r.patch('/api/admin/db/:table/:rowid', async (ctx) => {
    requireSuper(ctx.user);
    const t = await assertTable(ctx.params.table);
    const cols = new Set((await tableInfo(t)).map((c) => c.name));
    const patch = {};
    for (const [k, v] of Object.entries(ctx.body || {})) {
      if (!cols.has(k)) throw bad(`Unknown column ${k}`);
      if (HIDDEN.has(k)) throw bad(`${k} cannot be edited here — use password reset`);
      if (BY_TABLE[t] && TRIGGER_OWNED.has(k)) throw bad(`${k} is maintained by the versioning engine`);
      patch[k] = v === '' ? null : v;
    }
    if (!Object.keys(patch).length) throw bad('Nothing to update');
    const rk = await rowKey();
    const stamped = BY_TABLE[t] ? stamp(t, patch) : patch; // attributed to you → shows up in the record's history
    const keys = Object.keys(stamped);
    try { await run(`UPDATE ${t} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${rk.where}`, ...keys.map((k) => stamped[k]), rk.parse(ctx.params.rowid)); } catch (e) { throw bad(`The database rejected the change: ${e.message}`); }
    await audit({ actor: ctx.user, type: 'admin.db_row_updated', entityType: t, entityId: ctx.params.rowid, details: patch, ip: ctx.ip });
    return { ok: true };
  });
  r.post('/api/admin/db/:table', async (ctx) => {
    requireSuper(ctx.user);
    const t = await assertTable(ctx.params.table);
    const info = await tableInfo(t);
    const row = {};
    for (const c of info) {
      const v = ctx.body?.[c.name];
      if (v !== undefined && v !== '') row[c.name] = v;
      else if (c.name === 'id' && /text/i.test(c.type)) row.id = uuid();
      else if (/_at$/.test(c.name) && c.name === 'created_at') row.created_at = now();
    }
    if (row.password_hash) row.password_hash = hashPassword(row.password_hash);
    try { await insert(t, row); } catch (e) { throw bad(`The database rejected the row: ${e.message}`); }
    await audit({ actor: ctx.user, type: 'admin.db_row_inserted', entityType: t, entityId: row.id || null, details: { ...row, password_hash: undefined }, ip: ctx.ip });
    return { ok: true, row };
  });
  r.delete('/api/admin/db/:table/:rowid', async (ctx) => {
    requireSuper(ctx.user);
    const t = await assertTable(ctx.params.table);
    const p = protection(t);
    if (p.kind !== 'technical') {
      throw new HttpError(409, p.kind === 'versioned'
        ? `${t} holds business data and is never physically deleted. Retire the record instead (set is_active = 0), or use Master data → Purge for an exceptional correction.`
        : `${t} is a retained log — rows are kept permanently.`);
    }
    const rk = await rowKey();
    const before = await get(`SELECT * FROM ${t} WHERE ${rk.where}`, rk.parse(ctx.params.rowid));
    if (!before) throw notFound('Row not found');
    try { await run(`DELETE FROM ${t} WHERE ${rk.where}`, rk.parse(ctx.params.rowid)); } catch (e) { throw bad(`The database rejected the delete: ${e.message}`); }
    delete before.password_hash;
    await audit({ actor: ctx.user, type: 'admin.db_row_deleted', entityType: t, entityId: ctx.params.rowid, details: before, ip: ctx.ip });
    return { ok: true };
  });
  r.get('/api/admin/db-export', async (ctx) => {
    requireSuper(ctx.user);
    const t = await assertTable(ctx.query.table || '');
    const rows = (await all(`SELECT * FROM ${t}`)).map((row) => { delete row.password_hash; return row; });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${t}.csv"` });
    ctx.res.end(toCSV(rows));
  });
}

