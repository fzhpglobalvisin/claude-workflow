// Board service — boards, members (access rights), lists, cards (tasks), inbox, planner.
import { get, all, run, insert, update, uuid, now, tx, j } from '../db/index.js';
import { bad, notFound, forbidden, str, oneOf } from '../lib/http.js';
import {
  requirePerm, assertBoard, boardAccess, boardCtx, visibleBoardIds, inList, isAdmin, isSuper, boardAudience, loadUser, can,
} from '../lib/access.js';
import { audit, notify } from '../lib/events.js';
import { sendTo } from '../lib/realtime.js';
import { postSystem } from '../lib/chatcore.js';
import { assertUnit } from './org.js';
import { retire, upsertMembership, endMembership } from '../lib/mdm.js';

/** Strip version-control columns before re-using a row as the template for a NEW record. */
const fresh = ({ version_no, doc_no, retired_at, change_id, changed_by, change_note, owner_id, effective_from, effective_to, is_active, ...rest }) => rest;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const CARD_SELECT = `SELECT k.*, u.username AS assignee_username, p.full_name AS assignee_name, p.color AS assignee_color,
    p.avatar_url AS assignee_avatar, l.title AS list_title, l.is_done_list,
    (SELECT COUNT(*) FROM az_subtask s WHERE s.card_id = k.id AND s.is_active = 1) AS subtask_total,
    (SELECT COUNT(*) FROM az_subtask s WHERE s.card_id = k.id AND s.is_done = 1 AND s.is_active = 1) AS subtask_done,
    (SELECT COUNT(*) FROM az_card_comments c WHERE c.card_id = k.id AND c.is_active = 1) AS comment_count,
    (SELECT COUNT(*) FROM az_attachment a WHERE a.card_id = k.id AND a.is_active = 1) AS attachment_count,
    (SELECT COUNT(*) FROM az_task_requirement q WHERE q.card_id = k.id AND q.is_active = 1) AS requirement_count,
    (SELECT COUNT(*) FROM az_message m WHERE m.card_id = k.id AND m.deleted = 0 AND m.type <> 'system') AS message_count
  FROM az_card k LEFT JOIN users u ON u.id = k.assignee_id LEFT JOIN profiles p ON p.id = k.assignee_id
  LEFT JOIN az_list l ON l.id = k.list_id`;

export const shapeCard = (c) => c && ({ ...c, labels: j(c.labels, []), is_template: !!c.is_template, archived: !!c.archived, is_done_list: !!c.is_done_list, is_active: c.is_active !== 0 });

export async function boardChanged(boardId, kind, payload = {}) {
  if (!boardId) return;
  sendTo(await boardAudience(boardId), 'board:changed', { boardId, kind, ...payload });
}

/** Load a card and check the viewer's access on its board (or ownership for inbox cards). */
export async function assertCard(u, cardId, need = 'view') {
  const card = await get('SELECT * FROM az_card WHERE id = ?', cardId);
  if (!card) throw notFound('Task not found');
  if (!card.board_id) {
    if (card.created_by !== u.id && !isSuper(u)) throw forbidden('This inbox card belongs to someone else');
    return { card, ctx: null, access: { canView: true, canEdit: true, canCreate: true, canDelete: true, role: 'owner' } };
  }
  const { ctx, access } = await assertBoard(u, card.board_id, need);
  return { card, ctx, access };
}

async function reindex(listId, orderedIds) {
  for (const [i, id] of orderedIds.entries()) await run('UPDATE az_card SET position = ? WHERE id = ?', i, id);
}

async function logCard(user, type, card, ctx, details) {
  await audit({ actor: user, type, entityType: 'card', entityId: card.id, boardId: card.board_id, workspaceId: ctx?.workspace_id, companyId: ctx?.company_id, details });
}

export async function createBoardWithDefaults({ user, workspace, title, description, projectId, background, lists }) {
  const t = now();
  const boardId = uuid();
  const channelId = uuid();
  await insert('az_channel', {
    id: channelId, name: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-log`, type: 'board_log',
    workspace_id: workspace.id, company_id: workspace.company_id, description: `Activity & discussion for board "${title}"`,
    created_by: user.id, created_at: t, updated_at: t,
  });
  await insert('az_board', {
    id: boardId, title, description: description || null, workspace_id: workspace.id, project_id: projectId || null,
    log_channel_id: channelId, background: background || null, created_by: user.id, created_at: t, updated_at: t,
  });
  await insert('az_board_member', { id: uuid(), board_id: boardId, user_id: user.id, role: 'admin', created_at: t });
  const defs = lists || [['To Do', 0], ['In Progress', 0], ['On Review', 0], ['Completed', 1]];
  for (const [i, [name, done]] of defs.entries()) await insert('az_list', { id: uuid(), title: name, position: i, board_id: boardId, is_done_list: done, created_at: t, updated_at: t });
  return boardId;
}

export function register(r) {
  // ---------------- Boards ----------------
  r.get('/api/boards', async (ctx) => {
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    const cid = ctx.query.company_id;
    return await all(
      `SELECT b.id, b.title, b.description, b.background, b.cover_url, b.workspace_id, b.project_id, w.name AS unit_name, w.company_id,
              c.code AS company_code, c.name AS company_name, pr.title AS project_title,
              (SELECT COUNT(*) FROM az_card k WHERE k.board_id = b.id AND k.archived = 0 AND k.list_id IS NOT NULL) AS card_count
         FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id
         LEFT JOIN az_project pr ON pr.id = b.project_id
        WHERE b.id IN ${bSql} ${cid ? 'AND w.company_id = ?' : ''} ORDER BY c.name, b.title`, ...bp, ...(cid ? [cid] : []));
  });

  r.post('/api/boards', async (ctx) => {
    requirePerm(ctx.user, 'board.create');
    const b = ctx.body;
    const w = await assertUnit(ctx.user, b.workspace_id);
    if (b.project_id) {
      const p = await get('SELECT workspace_id FROM az_project WHERE id = ?', b.project_id);
      if (!p || p.workspace_id !== w.id) throw bad('Project does not belong to this unit');
    }
    const title = str(b.title, 'Board title', { max: 120 });
    const id = await tx(async () => await createBoardWithDefaults({ user: ctx.user, workspace: w, title, description: b.description, projectId: b.project_id, background: b.background }));
    await audit({ actor: ctx.user, type: 'board.created', entityType: 'board', entityId: id, boardId: id, workspaceId: w.id, companyId: w.company_id, details: { title }, ip: ctx.ip });
    return await get('SELECT * FROM az_board WHERE id = ?', id);
  });

  r.get('/api/boards/:id', async (ctx) => {
    const { ctx: b, access } = await assertBoard(ctx.user, ctx.params.id, 'view');
    const lists = (await all('SELECT * FROM az_list WHERE board_id = ? AND is_active = 1 ORDER BY position', b.id)).map((l) => ({ ...l, is_done_list: !!l.is_done_list }));
    const cards = (await all(`${CARD_SELECT} WHERE k.board_id = ? AND k.archived = 0 AND k.list_id IS NOT NULL ORDER BY k.position`, b.id)).map(shapeCard);
    const members = await all(
      `SELECT m.user_id AS id, m.role, m.effective_to, u.username, p.full_name, p.color, p.avatar_url, p.designation
         FROM az_board_member m JOIN users u ON u.id = m.user_id JOIN profiles p ON p.id = u.id
        WHERE m.board_id = ? AND m.is_active = 1 ORDER BY m.created_at`, b.id);
    const project = b.project_id ? await get('SELECT id, title, status, doc_no, is_active FROM az_project WHERE id = ?', b.project_id) : null;
    return { board: b, lists, cards, members, project, access };
  });

  r.patch('/api/boards/:id', async (ctx) => {
    const { ctx: b } = await assertBoard(ctx.user, ctx.params.id, 'manage');
    const patch = { updated_at: now() };
    for (const k of ['title', 'description', 'background', 'project_id']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k] || null;
    if (patch.title === null) throw bad('Title required');
    await update('az_board', b.id, { ...patch, _expect_version: ctx.body.base_version });
    await audit({ actor: ctx.user, type: 'board.updated', entityType: 'board', entityId: b.id, boardId: b.id, workspaceId: b.workspace_id, companyId: b.company_id, details: patch, ip: ctx.ip });
    await boardChanged(b.id, 'board');
    return await get('SELECT * FROM az_board WHERE id = ?', b.id);
  });

  r.delete('/api/boards/:id', async (ctx) => {
    const { ctx: b } = await assertBoard(ctx.user, ctx.params.id, 'manage');
    const audience = await boardAudience(b.id);
    // retire (never delete): board + its log channel in one change group, so reactivating the
    // board brings the channel back too. Lists, tasks and history stay exactly as they were.
    await tx(async () => {
      await retire('board', b.id, { reason: ctx.query.reason });
      if (b.log_channel_id) await retire('channel', b.log_channel_id, { reason: 'Retired with its board' });
    });
    await audit({ actor: ctx.user, type: 'board.retired', entityType: 'board', entityId: b.id, workspaceId: b.workspace_id, companyId: b.company_id, details: { title: b.title, reason: ctx.query.reason || null }, ip: ctx.ip });
    sendTo(audience, 'board:changed', { boardId: b.id, kind: 'deleted' });
    return { ok: true, retired: true };
  });

  // ---- board access rights (super admin / board admin) ----
  r.get('/api/boards/:id/members', async (ctx) => {
    const { ctx: b } = await assertBoard(ctx.user, ctx.params.id, 'view');
    return await all(`SELECT m.id, m.user_id, m.role, m.created_at, m.effective_from, m.effective_to, m.version_no, u.username, p.full_name, p.color, p.designation
                  FROM az_board_member m JOIN users u ON u.id = m.user_id JOIN profiles p ON p.id = u.id WHERE m.board_id = ? AND m.is_active = 1`, b.id);
  });
  r.put('/api/boards/:id/members/:userId', async (ctx) => {
    const b = await boardCtx(ctx.params.id);
    if (!b) throw notFound('Board not found');
    const a = await boardAccess(ctx.user, b.id);
    if (!isSuper(ctx.user) && !(a.canManage && ctx.user.permissions.includes('board.members'))) throw forbidden('Only the super admin or a board admin can change board access');
    const role = oneOf(ctx.body.role, 'role', ['admin', 'member', 'viewer'], 'member');
    const target = await get('SELECT id, is_active FROM users WHERE id = ?', ctx.params.userId);
    if (!target) throw notFound('User not found');
    if (!target.is_active) throw bad('This user account is retired');
    // effective-dated access: optional valid-from / valid-to (the scheduler starts and ends it)
    const res = await upsertMembership('board_member', { board_id: b.id, user_id: target.id }, {
      role, effective_from: ctx.body.effective_from || undefined, effective_to: ctx.body.effective_to === undefined ? undefined : ctx.body.effective_to || null,
    });
    await audit({ actor: ctx.user, type: 'board.access_granted', entityType: 'board', entityId: b.id, boardId: b.id, workspaceId: b.workspace_id, companyId: b.company_id, details: { userId: target.id, role, pending: res.pending, effective_to: ctx.body.effective_to || null }, ip: ctx.ip });
    await notify([target.id], { type: 'access', title: `You now have ${role} access to board "${b.title}"`, link: `/board/${b.id}`, actorId: ctx.user.id });
    await boardChanged(b.id, 'members');
    return { ok: true };
  });
  r.delete('/api/boards/:id/members/:userId', async (ctx) => {
    const b = await boardCtx(ctx.params.id);
    if (!b) throw notFound('Board not found');
    const a = await boardAccess(ctx.user, b.id);
    if (!isSuper(ctx.user) && !(a.canManage && ctx.user.permissions.includes('board.members'))) throw forbidden('Only the super admin or a board admin can change board access');
    const audience = await boardAudience(b.id);
    await endMembership('board_member', { board_id: b.id, user_id: ctx.params.userId }, ctx.query.reason || 'Board access revoked');
    await audit({ actor: ctx.user, type: 'board.access_revoked', entityType: 'board', entityId: b.id, boardId: b.id, workspaceId: b.workspace_id, companyId: b.company_id, details: { userId: ctx.params.userId }, ip: ctx.ip });
    sendTo(audience, 'board:changed', { boardId: b.id, kind: 'members' });
    return { ok: true };
  });

  // ---------------- Lists ----------------
  r.post('/api/boards/:id/lists', async (ctx) => {
    const { ctx: b } = await assertBoard(ctx.user, ctx.params.id, 'edit');
    const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_list WHERE board_id = ? AND is_active = 1', b.id)).p;
    const l = await insert('az_list', { id: ctx.body.id || uuid(), title: str(ctx.body.title, 'List title', { max: 80 }), position: pos, board_id: b.id, is_done_list: ctx.body.is_done_list ? 1 : 0, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'list.created', entityType: 'list', entityId: l.id, boardId: b.id, companyId: b.company_id, details: { title: l.title }, ip: ctx.ip });
    await boardChanged(b.id, 'lists');
    return l;
  });
  r.patch('/api/lists/:id', async (ctx) => {
    const l = await get('SELECT * FROM az_list WHERE id = ?', ctx.params.id);
    if (!l) throw notFound('List not found');
    const { ctx: b } = await assertBoard(ctx.user, l.board_id, 'edit');
    const patch = { updated_at: now() };
    if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'List title', { max: 80 });
    if (ctx.body.is_done_list !== undefined) patch.is_done_list = ctx.body.is_done_list ? 1 : 0;
    await update('az_list', l.id, { ...patch, _expect_version: ctx.body.base_version });
    await audit({ actor: ctx.user, type: 'list.updated', entityType: 'list', entityId: l.id, boardId: b.id, companyId: b.company_id, details: patch, ip: ctx.ip });
    await boardChanged(b.id, 'lists');
    return await get('SELECT * FROM az_list WHERE id = ?', l.id);
  });
  r.post('/api/boards/:id/lists/reorder', async (ctx) => {
    const { ctx: b } = await assertBoard(ctx.user, ctx.params.id, 'edit');
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
    await tx(async () => { for (const [i, id] of ids.entries()) await run('UPDATE az_list SET position = ? WHERE id = ? AND board_id = ?', i, id, b.id); });
    await boardChanged(b.id, 'lists');
    return { ok: true };
  });
  r.delete('/api/lists/:id', async (ctx) => {
    const l = await get('SELECT * FROM az_list WHERE id = ?', ctx.params.id);
    if (!l) throw notFound('List not found');
    const { ctx: b } = await assertBoard(ctx.user, l.board_id, 'delete');
    // retire the list and archive its active tasks in the same change group (reactivation restores both)
    const out = await retire('list', l.id, { reason: ctx.query.reason });
    await audit({ actor: ctx.user, type: 'list.retired', entityType: 'list', entityId: l.id, boardId: b.id, companyId: b.company_id, details: { title: l.title, tasks: out.cascaded, reason: ctx.query.reason || null }, ip: ctx.ip });
    await boardChanged(b.id, 'lists');
    return { ok: true, retired: true, tasks_archived: out.cascaded };
  });

  // ---------------- Cards (tasks) ----------------
  r.post('/api/lists/:id/cards', async (ctx) => {
    const l = await get('SELECT * FROM az_list WHERE id = ?', ctx.params.id);
    if (!l) throw notFound('List not found');
    if (!l.is_active) throw bad(`List “${l.title}” is retired`);
    const { ctx: b } = await assertBoard(ctx.user, l.board_id, 'create');
    const body = ctx.body;
    const id = body.id || uuid();
    if (await get('SELECT 1 FROM az_card WHERE id = ?', id)) return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, id)); // idempotent (offline replay)
    const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_card WHERE list_id = ?', l.id)).p;
    const t = now();
    await insert('az_card', {
      id, title: str(body.title, 'Task title', { max: 300 }), description: body.description || null, position: pos,
      due_date: body.due_date || null, start_date: body.start_date || null, list_id: l.id, board_id: b.id, project_id: b.project_id || null,
      assignee_id: body.assignee_id || null, created_by: ctx.user.id, priority: oneOf(body.priority, 'priority', PRIORITIES, 'medium'),
      labels: Array.isArray(body.labels) ? body.labels : [], cover_url: can(ctx.user, 'cover.manage') ? body.cover_url || null : null, is_template: body.is_template ? 1 : 0,
      estimate_hours: body.estimate_hours ?? null, completed_at: l.is_done_list ? t : null, archived: 0, created_at: t, updated_at: t,
    });
    const card = await get('SELECT * FROM az_card WHERE id = ?', id);
    await logCard(ctx.user, 'card.created', card, b, { title: card.title, list: l.title });
    await postSystem(b.log_channel_id, `🆕 **${ctx.user.full_name}** created task “${card.title}” in *${l.title}*`, { cardId: id, actorId: ctx.user.id });
    if (card.assignee_id) await notify([card.assignee_id], { type: 'assign', title: `${ctx.user.full_name} assigned you “${card.title}”`, body: `${b.title} › ${l.title}`, link: `/board/${b.id}?card=${id}`, actorId: ctx.user.id });
    await boardChanged(b.id, 'card', { cardId: id });
    return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, id));
  });

  r.get('/api/cards/:id', async (ctx) => {
    const { card, ctx: b, access } = await assertCard(ctx.user, ctx.params.id, 'view');
    const full = shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, card.id));
    const subtasks = (await all(`SELECT s.*, p.full_name AS assignee_name, p.color AS assignee_color FROM az_subtask s LEFT JOIN profiles p ON p.id = s.assignee_id
                           WHERE s.card_id = ? AND s.is_active = 1 ORDER BY s.position, s.created_at`, card.id)).map((s) => ({ ...s, is_done: !!s.is_done, is_ai_generated: !!s.is_ai_generated }));
    const requirements = await all(`SELECT q.*, p.full_name AS author FROM az_task_requirement q LEFT JOIN profiles p ON p.id = q.created_by WHERE q.card_id = ? AND q.is_active = 1 ORDER BY q.created_at`, card.id);
    const attachments = await all(`SELECT a.*, p.full_name AS uploader FROM az_attachment a LEFT JOIN profiles p ON p.id = a.uploader_id WHERE a.card_id = ? AND a.is_active = 1 ORDER BY a.created_at DESC`, card.id);
    const comments = (await all(`SELECT c.*, u.username, p.full_name, p.color, p.avatar_url FROM az_card_comments c LEFT JOIN users u ON u.id = c.profile_id
                           LEFT JOIN profiles p ON p.id = c.profile_id WHERE c.card_id = ? AND c.is_active = 1 ORDER BY c.created_at`, card.id))
      .map((c) => ({ ...c, is_pinned: !!c.is_pinned, reply_to: j(c.reply_to) }));
    const activity = (await all(`SELECT a.*, p.full_name AS actor_name FROM az_activity_log a LEFT JOIN profiles p ON p.id = a.actor_id
                           WHERE a.entity_id = ? OR (a.entity_type <> 'card' AND json_extract(a.details, '$.card_id') = ?) ORDER BY a.created_at DESC LIMIT 60`, card.id, card.id)).map((a) => ({ ...a, details: j(a.details) }));
    const aiRuns = await all(`SELECT r.id, r.status, r.output, r.engine, r.created_at, g.name AS agent_name, g.role AS agent_role, g.avatar
                          FROM az_ai_run r LEFT JOIN az_ai_agent g ON g.id = r.agent_id WHERE r.card_id = ? ORDER BY r.created_at DESC LIMIT 20`, card.id);
    const lists = b ? await all('SELECT id, title, is_done_list FROM az_list WHERE board_id = ? AND is_active = 1 ORDER BY position', b.id) : [];
    return {
      card: full, subtasks, requirements, attachments, comments, activity, aiRuns, lists, access,
      board: b ? { id: b.id, title: b.title, log_channel_id: b.log_channel_id, company_id: b.company_id, company_code: b.company_code, workspace_name: b.workspace_name } : null,
    };
  });

  r.patch('/api/cards/:id', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'edit');
    const body = ctx.body; const patch = {};
    if (body.title !== undefined) patch.title = str(body.title, 'Task title', { max: 300 });
    for (const k of ['description', 'due_date', 'start_date']) if (body[k] !== undefined) patch[k] = body[k] || null;
    if (body.cover_url !== undefined) {
      if (!can(ctx.user, 'cover.manage')) throw forbidden('Task covers need the "cover.manage" permission (e.g. the sales_marketing role)');
      patch.cover_url = body.cover_url || null;
    }
    if (body.assignee_id !== undefined) patch.assignee_id = body.assignee_id || null;
    if (body.priority !== undefined) patch.priority = oneOf(body.priority, 'priority', PRIORITIES, 'medium');
    if (body.labels !== undefined) patch.labels = Array.isArray(body.labels) ? body.labels : [];
    if (body.estimate_hours !== undefined) patch.estimate_hours = body.estimate_hours === '' || body.estimate_hours == null ? null : Number(body.estimate_hours);
    if (body.is_template !== undefined) patch.is_template = body.is_template ? 1 : 0;
    if (body.archived !== undefined) patch.archived = body.archived ? 1 : 0;
    if (body.project_id !== undefined) patch.project_id = body.project_id || null;
    patch.updated_at = now();
    await update('az_card', card.id, { ...patch, _expect_version: body.base_version });
    const changed = Object.keys(patch).filter((k) => k !== 'updated_at');
    await logCard(ctx.user, patch.archived ? 'card.archived' : 'card.updated', card, b, { fields: changed, ...(patch.title ? { title: patch.title } : {}) });
    if (patch.assignee_id && patch.assignee_id !== card.assignee_id) {
      const who = await get('SELECT full_name FROM profiles WHERE id = ?', patch.assignee_id);
      await notify([patch.assignee_id], { type: 'assign', title: `${ctx.user.full_name} assigned you “${patch.title || card.title}”`, link: b ? `/board/${b.id}?card=${card.id}` : '/', actorId: ctx.user.id });
      if (b) await postSystem(b.log_channel_id, `👤 **${ctx.user.full_name}** assigned “${card.title}” to @${(await get('SELECT username FROM users WHERE id = ?', patch.assignee_id))?.username} (${who?.full_name})`, { cardId: card.id, actorId: ctx.user.id });
    }
    if (patch.due_date && patch.due_date !== card.due_date && card.assignee_id) {
      await notify([card.assignee_id], { type: 'due', title: `Due date set on “${card.title}”`, body: new Date(patch.due_date).toDateString(), link: b ? `/board/${b.id}?card=${card.id}` : '/', actorId: ctx.user.id });
    }
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, card.id));
  });

  // Move a card between lists / from the inbox onto a board, preserving order.
  r.post('/api/cards/:id/move', async (ctx) => {
    const { card, ctx: fromBoard } = await assertCard(ctx.user, ctx.params.id, 'edit');
    const toListId = ctx.body.list_id;
    const index = Math.max(0, Number(ctx.body.index ?? 0));
    let toList = null; let toBoard = null;
    if (toListId) {
      toList = await get('SELECT * FROM az_list WHERE id = ?', toListId);
      if (!toList) throw notFound('Target list not found');
      if (!toList.is_active) throw bad(`List “${toList.title}” is retired`);
      toBoard = (await assertBoard(ctx.user, toList.board_id, 'edit')).ctx;
    } else if (card.board_id) {
      throw bad('Board tasks cannot be moved back into a personal inbox');
    }
    const t = now();
    await tx(async () => {
      const siblings = toList
        ? (await all('SELECT id FROM az_card WHERE list_id = ? AND id <> ? AND archived = 0 ORDER BY position', toList.id, card.id)).map((r) => r.id)
        : (await all('SELECT id FROM az_card WHERE list_id IS NULL AND board_id IS NULL AND created_by = ? AND id <> ? ORDER BY position', ctx.user.id, card.id)).map((r) => r.id);
      siblings.splice(Math.min(index, siblings.length), 0, card.id);
      const patch = { list_id: toList?.id || null, board_id: toBoard?.id || null, updated_at: t };
      if (toBoard && toBoard.id !== card.board_id) patch.project_id = toBoard.project_id || card.project_id || null;
      if (toList) patch.completed_at = toList.is_done_list ? (card.completed_at || t) : null;
      await update('az_card', card.id, patch);
      await reindex(toList?.id, siblings);
      if (card.list_id && card.list_id !== toList?.id) {
        await reindex(card.list_id, (await all('SELECT id FROM az_card WHERE list_id = ? AND archived = 0 ORDER BY position', card.list_id)).map((r) => r.id));
      }
    });
    const fromList = card.list_id ? await get('SELECT title FROM az_list WHERE id = ?', card.list_id) : { title: 'Inbox' };
    if (card.list_id !== toList?.id) {
      await logCard(ctx.user, 'card.moved', { ...card, board_id: toBoard?.id }, toBoard, { from: fromList?.title, to: toList?.title, title: card.title });
      if (toBoard) {
        const done = toList.is_done_list;
        await postSystem(toBoard.log_channel_id, `${done ? '✅' : '➡️'} **${ctx.user.full_name}** moved “${card.title}” from *${fromList?.title}* to *${toList.title}*`, { cardId: card.id, actorId: ctx.user.id });
        const watchers = [card.assignee_id, card.created_by].filter(Boolean);
        if (done) await notify(watchers, { type: 'done', title: `“${card.title}” was completed`, body: `${toBoard.title} › ${toList.title}`, link: `/board/${toBoard.id}?card=${card.id}`, actorId: ctx.user.id });
      }
    }
    if (fromBoard && fromBoard.id !== toBoard?.id) await boardChanged(fromBoard.id, 'card', { cardId: card.id });
    if (toBoard) await boardChanged(toBoard.id, 'card', { cardId: card.id });
    return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, card.id));
  });

  r.post('/api/cards/:id/copy', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'view');
    const listId = ctx.body.list_id || card.list_id;
    const l = await get('SELECT * FROM az_list WHERE id = ?', listId);
    if (!l) throw bad('Target list required');
    const tb = (await assertBoard(ctx.user, l.board_id, 'create')).ctx;
    const id = uuid(); const t = now();
    await tx(async () => {
      const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_card WHERE list_id = ?', l.id)).p;
      await insert('az_card', { ...fresh(card), archived: 0, id, title: ctx.body.title || (card.is_template ? card.title : `${card.title} (copy)`), list_id: l.id, board_id: tb.id, position: pos, is_template: 0, created_by: ctx.user.id, completed_at: null, created_at: t, updated_at: t });
      for (const s of await all('SELECT * FROM az_subtask WHERE card_id = ? AND is_active = 1', card.id)) await insert('az_subtask', { ...fresh(s), id: uuid(), card_id: id, is_done: 0, completed_at: null, created_at: t, updated_at: t });
      for (const q of await all('SELECT * FROM az_task_requirement WHERE card_id = ? AND is_active = 1', card.id)) await insert('az_task_requirement', { ...fresh(q), id: uuid(), card_id: id, created_at: t, updated_at: t });
    });
    await logCard(ctx.user, 'card.copied', { id, board_id: tb.id }, tb, { from: card.id, title: card.title });
    await boardChanged(tb.id, 'card', { cardId: id });
    return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, id));
  });

  r.delete('/api/cards/:id', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'delete');
    // retire (never delete): the task, its subtasks, requirements, comments and history are kept
    await retire('card', card.id, { reason: ctx.query.reason });
    await logCard(ctx.user, 'card.retired', card, b, { title: card.title, doc_no: card.doc_no, reason: ctx.query.reason || null });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id, deleted: true });
    return { ok: true };
  });

  // ---------------- Personal inbox (Trello-style) ----------------
  r.get('/api/inbox', async (ctx) => (await all(`${CARD_SELECT} WHERE k.list_id IS NULL AND k.board_id IS NULL AND k.created_by = ? AND k.archived = 0 ORDER BY k.position`, ctx.user.id)).map(shapeCard));
  r.post('/api/inbox', async (ctx) => {
    const id = ctx.body.id || uuid();
    if (await get('SELECT 1 FROM az_card WHERE id = ?', id)) return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, id));
    const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_card WHERE list_id IS NULL AND board_id IS NULL AND created_by = ?', ctx.user.id)).p;
    await insert('az_card', { id, title: str(ctx.body.title, 'Title', { max: 300 }), position: pos, created_by: ctx.user.id, priority: 'medium', labels: [], due_date: ctx.body.due_date || null, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'inbox.created', entityType: 'card', entityId: id, details: { title: ctx.body.title }, ip: ctx.ip });
    return shapeCard(await get(`${CARD_SELECT} WHERE k.id = ?`, id));
  });

  // ---------------- Planner / my tasks ----------------
  r.get('/api/planner', async (ctx) => {
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    const mine = ctx.query.mine === '1';
    const from = ctx.query.from || new Date(Date.now() - 14 * 864e5).toISOString();
    const to = ctx.query.to || new Date(Date.now() + 45 * 864e5).toISOString();
    return (await all(`${CARD_SELECT.replace('FROM az_card k', ', b.title AS board_title FROM az_card k JOIN az_board b ON b.id = k.board_id')}
                WHERE k.board_id IN ${bSql} AND k.archived = 0 AND k.due_date IS NOT NULL AND k.due_date BETWEEN ? AND ?
                ${mine ? 'AND k.assignee_id = ?' : ''} ORDER BY k.due_date`, ...bp, from, to, ...(mine ? [ctx.user.id] : []))).map(shapeCard);
  });

  r.get('/api/my/tasks', async (ctx) => {
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    return (await all(`${CARD_SELECT.replace('FROM az_card k', ', b.title AS board_title FROM az_card k JOIN az_board b ON b.id = k.board_id')}
                WHERE k.board_id IN ${bSql} AND k.archived = 0 AND k.assignee_id = ? AND l.is_done_list = 0 ORDER BY COALESCE(k.due_date, '9999'), k.priority`, ...bp, ctx.user.id)).map(shapeCard);
  });
}

export { loadUser, isAdmin };
