// Organisation service — groups, companies, units (az_workspace), projects.
import { get, all, run, insert, update, uuid, now, tx } from '../db/index.js';
import { bad, notFound, forbidden, str, oneOf, HttpError } from '../lib/http.js';
import { requirePerm, visibleCompanyIds, visibleWorkspaceIds, visibleBoardIds, isAdmin, isSuper, inList, requireSuper } from '../lib/access.js';
import { audit } from '../lib/events.js';
import { retire, upsertMembership, endMembership } from '../lib/mdm.js';

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function assertCompany(u, id) {
  const c = await get('SELECT * FROM az_company WHERE id = ?', id);
  if (!c) throw notFound('Company not found');
  if (!c.is_active) throw new HttpError(409, `Company “${c.name}” is retired`);
  if (!(await visibleCompanyIds(u)).includes(id)) throw forbidden('You have no access to this company');
  return c;
}
async function assertUnit(u, id) {
  const w = await get('SELECT * FROM az_workspace WHERE id = ?', id);
  if (!w) throw notFound('Unit not found');
  if (!w.is_active) throw new HttpError(409, `Unit “${w.name}” is retired`);
  if (!(await visibleWorkspaceIds(u)).includes(id)) throw forbidden('You have no access to this unit');
  return w;
}

export function register(r) {
  r.get('/api/groups', async () => await all('SELECT g.*, (SELECT COUNT(*) FROM az_company c WHERE c.group_id = g.id) AS companies FROM az_group g ORDER BY name'));

  r.get('/api/companies', async (ctx) => {
    const ids = await visibleCompanyIds(ctx.user);
    const [inSql, p] = inList(ids);
    const boards = await visibleBoardIds(ctx.user);
    const [bSql, bp] = inList(boards);
    return await all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM az_workspace w WHERE w.company_id = c.id AND w.is_active = 1) AS unit_count,
         (SELECT COUNT(*) FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = c.id AND b.id IN ${bSql}) AS board_count,
         (SELECT COUNT(*) FROM az_card k JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id
            JOIN az_list l ON l.id = k.list_id
           WHERE w.company_id = c.id AND b.id IN ${bSql} AND l.is_done_list = 0 AND k.archived = 0) AS open_tasks,
         (SELECT COUNT(DISTINCT m.user_id) FROM az_workspace_member m JOIN az_workspace w ON w.id = m.workspace_id WHERE w.company_id = c.id AND m.is_active = 1 AND w.is_active = 1) AS member_count
       FROM az_company c WHERE c.id IN ${inSql} ORDER BY c.created_at`, ...bp, ...bp, ...p);
  });

  r.post('/api/companies', async (ctx) => {
    requirePerm(ctx.user, 'company.manage');
    const b = ctx.body;
    const code = str(b.code, 'Code', { min: 2, max: 6 }).toUpperCase();
    if (await get('SELECT 1 FROM az_company WHERE code = ?', code)) throw new HttpError(409, 'Company code already exists (codes are permanent and never reused, even after retirement)');
    const c = await insert('az_company', {
      id: uuid(), name: str(b.name, 'Name', { max: 120 }), code, group_id: b.group_id || (await get('SELECT id FROM az_group LIMIT 1'))?.id || null,
      description: b.description || null, image_url: b.image_url || null, accent: b.accent || null, created_at: now(), updated_at: now(),
    });
    // every company starts with a General unit + #general channel
    const w = await insert('az_workspace', { id: uuid(), name: 'General', slug: 'general', type: 'unit', company_id: c.id, invite_code: code + '-GEN', created_at: now(), updated_at: now() });
    await insert('az_workspace_member', { id: uuid(), role: 'admin', user_id: ctx.user.id, workspace_id: w.id, created_at: now() });
    await insert('az_channel', { id: uuid(), name: 'general', type: 'public', company_id: c.id, workspace_id: w.id, description: 'Company-wide announcements', created_by: ctx.user.id, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'company.created', entityType: 'company', entityId: c.id, companyId: c.id, details: { name: c.name, code }, ip: ctx.ip });
    return c;
  });

  r.patch('/api/companies/:id', async (ctx) => {
    requirePerm(ctx.user, 'company.manage');
    const c = await assertCompany(ctx.user, ctx.params.id);
    const b = ctx.body; const patch = { updated_at: now() };
    for (const k of ['name', 'description', 'image_url', 'accent']) if (b[k] !== undefined) patch[k] = b[k] || null;
    if (b.code && String(b.code).toUpperCase() !== c.code) throw new HttpError(409, 'The company code is a permanent business key — create a new company instead');
    if (patch.name === null) throw bad('Name required');
    await update('az_company', c.id, { ...patch, _expect_version: b.base_version });
    await audit({ actor: ctx.user, type: 'company.updated', entityType: 'company', entityId: c.id, companyId: c.id, details: patch, ip: ctx.ip });
    return await get('SELECT * FROM az_company WHERE id = ?', c.id);
  });

  // Company = global master data: only the Superadmin may retire it. Nothing is deleted — the
  // company, its units, boards and tasks are retained and simply leave circulation.
  r.delete('/api/companies/:id', async (ctx) => {
    requireSuper(ctx.user);
    const c = await assertCompany(ctx.user, ctx.params.id);
    const out = await retire('company', c.id, { reason: ctx.query.reason });
    await audit({ actor: ctx.user, type: 'company.retired', entityType: 'company', entityId: c.id, companyId: c.id, details: { name: c.name, reason: ctx.query.reason || null }, ip: ctx.ip });
    return { ok: true, retired: true, version_no: out.row.version_no };
  });

  // Company home: units -> projects -> boards (only what the user may see)
  r.get('/api/companies/:id', async (ctx) => {
    const c = await assertCompany(ctx.user, ctx.params.id);
    const ws = await visibleWorkspaceIds(ctx.user);
    const boards = await visibleBoardIds(ctx.user);
    const [wSql, wp] = inList(ws);
    const [bSql, bp] = inList(boards);
    const units = await all(`SELECT w.*, (SELECT COUNT(*) FROM az_workspace_member m WHERE m.workspace_id = w.id AND m.is_active = 1) AS member_count
                         FROM az_workspace w WHERE w.company_id = ? AND w.id IN ${wSql} ORDER BY w.created_at`, c.id, ...wp);
    const unitIds = units.map((u) => u.id);
    const [uSql, up] = inList(unitIds);
    const projects = await all(
      `SELECT p.*,
         (SELECT COUNT(*) FROM az_card k WHERE k.project_id = p.id AND k.archived = 0) AS task_count,
         (SELECT COUNT(*) FROM az_card k JOIN az_list l ON l.id = k.list_id WHERE k.project_id = p.id AND l.is_done_list = 1 AND k.archived = 0) AS done_count
       FROM az_project p WHERE p.workspace_id IN ${uSql} AND p.is_active = 1 ORDER BY p.created_at`, ...up);
    const boardRows = await all(
      `SELECT b.*, (SELECT COUNT(*) FROM az_card k WHERE k.board_id = b.id AND k.archived = 0 AND k.list_id IS NOT NULL) AS card_count,
              (SELECT COUNT(*) FROM az_board_member m WHERE m.board_id = b.id AND m.is_active = 1) AS member_count
         FROM az_board b WHERE b.workspace_id IN ${uSql} AND b.id IN ${bSql} ORDER BY b.created_at`, ...up, ...bp);
    const myUnitRoles = Object.fromEntries((await all('SELECT workspace_id, role FROM az_workspace_member WHERE user_id = ? AND is_active = 1', ctx.user.id)).map((r) => [r.workspace_id, r.role]));
    return { company: c, units: units.map((u) => ({ ...u, my_role: isAdmin(ctx.user) ? 'admin' : myUnitRoles[u.id] || null })), projects, boards: boardRows };
  });

  // ---------------- Units ----------------
  r.post('/api/units', async (ctx) => {
    requirePerm(ctx.user, 'unit.manage');
    const b = ctx.body;
    const c = await assertCompany(ctx.user, b.company_id);
    const name = str(b.name, 'Unit name', { max: 80 });
    const w = await insert('az_workspace', {
      id: uuid(), name, slug: slugify(name), type: oneOf(b.type, 'type', ['unit', 'department', 'client'], 'unit'),
      invite_code: `${c.code}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, company_id: c.id,
      description: b.description || null, created_at: now(), updated_at: now(),
    });
    await insert('az_workspace_member', { id: uuid(), role: 'admin', user_id: ctx.user.id, workspace_id: w.id, created_at: now() });
    await insert('az_channel', { id: uuid(), name: slugify(name) || 'unit', type: 'public', company_id: c.id, workspace_id: w.id, description: `${name} unit channel`, created_by: ctx.user.id, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'unit.created', entityType: 'unit', entityId: w.id, workspaceId: w.id, companyId: c.id, details: { name }, ip: ctx.ip });
    return w;
  });
  r.patch('/api/units/:id', async (ctx) => {
    requirePerm(ctx.user, 'unit.manage');
    const w = await assertUnit(ctx.user, ctx.params.id);
    const patch = { updated_at: now() };
    for (const k of ['name', 'description', 'type']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
    if (patch.name) patch.slug = slugify(patch.name);
    await update('az_workspace', w.id, { ...patch, _expect_version: ctx.body.base_version });
    await audit({ actor: ctx.user, type: 'unit.updated', entityType: 'unit', entityId: w.id, workspaceId: w.id, companyId: w.company_id, details: patch, ip: ctx.ip });
    return await get('SELECT * FROM az_workspace WHERE id = ?', w.id);
  });
  r.delete('/api/units/:id', async (ctx) => {
    requirePerm(ctx.user, 'unit.manage');
    const w = await assertUnit(ctx.user, ctx.params.id);
    await retire('unit', w.id, { reason: ctx.query.reason });
    await audit({ actor: ctx.user, type: 'unit.retired', entityType: 'unit', entityId: w.id, companyId: w.company_id, details: { name: w.name, reason: ctx.query.reason || null }, ip: ctx.ip });
    return { ok: true, retired: true };
  });
  r.get('/api/units/:id/members', async (ctx) => {
    await assertUnit(ctx.user, ctx.params.id);
    return await all(`SELECT m.id, m.role, m.user_id, m.created_at, m.effective_from, m.effective_to, m.version_no, u.username, p.full_name, p.color, p.designation
                  FROM az_workspace_member m JOIN users u ON u.id = m.user_id JOIN profiles p ON p.id = u.id
                 WHERE m.workspace_id = ? AND m.is_active = 1 ORDER BY p.full_name`, ctx.params.id);
  });
  r.post('/api/units/:id/members', async (ctx) => {
    if (!isAdmin(ctx.user)) throw forbidden('Only admins can manage unit membership');
    const w = await assertUnit(ctx.user, ctx.params.id);
    const role = oneOf(ctx.body.role, 'role', ['admin', 'member', 'guest'], 'member');
    const userId = str(ctx.body.user_id, 'user_id');
    const res = await upsertMembership('unit_member', { user_id: userId, workspace_id: w.id }, {
      role, effective_from: ctx.body.effective_from || undefined, effective_to: ctx.body.effective_to === undefined ? undefined : ctx.body.effective_to || null,
    });
    await audit({ actor: ctx.user, type: 'unit.member_set', entityType: 'unit', entityId: w.id, workspaceId: w.id, companyId: w.company_id, details: { userId, role, pending: res.pending, effective_to: ctx.body.effective_to || null }, ip: ctx.ip });
    return { ok: true, pending: res.pending };
  });
  r.delete('/api/units/:id/members/:userId', async (ctx) => {
    if (!isAdmin(ctx.user)) throw forbidden('Only admins can manage unit membership');
    const w = await assertUnit(ctx.user, ctx.params.id);
    await endMembership('unit_member', { workspace_id: w.id, user_id: ctx.params.userId }, ctx.query.reason || 'Removed from unit');
    await audit({ actor: ctx.user, type: 'unit.member_removed', entityType: 'unit', entityId: w.id, workspaceId: w.id, companyId: w.company_id, details: { userId: ctx.params.userId }, ip: ctx.ip });
    return { ok: true };
  });

  // ---------------- Projects ----------------
  r.post('/api/projects', async (ctx) => {
    requirePerm(ctx.user, 'project.manage');
    const b = ctx.body;
    const w = await assertUnit(ctx.user, b.workspace_id);
    const p = await insert('az_project', {
      id: uuid(), title: str(b.title, 'Project title', { max: 140 }), description: b.description || null, workspace_id: w.id,
      status: oneOf(b.status, 'status', ['planning', 'active', 'on_hold', 'done'], 'active'),
      start_date: b.start_date || null, end_date: b.end_date || null, created_by: ctx.user.id, created_at: now(), updated_at: now(),
    });
    await audit({ actor: ctx.user, type: 'project.created', entityType: 'project', entityId: p.id, workspaceId: w.id, companyId: w.company_id, details: { title: p.title }, ip: ctx.ip });
    return p;
  });
  r.get('/api/projects/:id', async (ctx) => {
    const p = await get('SELECT * FROM az_project WHERE id = ?', ctx.params.id);
    if (!p) throw notFound('Project not found');
    await assertUnit(ctx.user, p.workspace_id);
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    const boards = await all(`SELECT * FROM az_board WHERE project_id = ? AND id IN ${bSql}`, p.id, ...bp);
    const stats = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN l.is_done_list = 1 THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN l.is_done_list = 0 AND k.due_date < ? THEN 1 ELSE 0 END) AS overdue
         FROM az_card k JOIN az_list l ON l.id = k.list_id WHERE k.project_id = ? AND k.archived = 0`, now(), p.id);
    return { project: p, boards, stats };
  });
  r.patch('/api/projects/:id', async (ctx) => {
    requirePerm(ctx.user, 'project.manage');
    const p = await get('SELECT * FROM az_project WHERE id = ?', ctx.params.id);
    if (!p) throw notFound();
    const w = await assertUnit(ctx.user, p.workspace_id);
    const patch = { updated_at: now() };
    for (const k of ['title', 'description', 'status', 'start_date', 'end_date']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k] || null;
    if (patch.title === null) throw bad('Title required');
    await update('az_project', p.id, { ...patch, _expect_version: ctx.body.base_version });
    await audit({ actor: ctx.user, type: 'project.updated', entityType: 'project', entityId: p.id, workspaceId: w.id, companyId: w.company_id, details: patch, ip: ctx.ip });
    return await get('SELECT * FROM az_project WHERE id = ?', p.id);
  });
  r.delete('/api/projects/:id', async (ctx) => {
    requirePerm(ctx.user, 'project.manage');
    const p = await get('SELECT * FROM az_project WHERE id = ?', ctx.params.id);
    if (!p) throw notFound();
    const w = await assertUnit(ctx.user, p.workspace_id);
    await retire('project', p.id, { reason: ctx.query.reason }); // boards keep their (historical) project link
    await audit({ actor: ctx.user, type: 'project.retired', entityType: 'project', entityId: p.id, workspaceId: w.id, companyId: w.company_id, details: { title: p.title, reason: ctx.query.reason || null }, ip: ctx.ip });
    return { ok: true, retired: true };
  });
}

export { assertCompany, assertUnit };
