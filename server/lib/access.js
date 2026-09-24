// Role-based access control + tenant visibility rules.
// Retired records (is_active = 0) and ended memberships never grant access; retired
// companies / units / boards drop out of every visible-id list (and so out of every page).
//  - Global role (profiles.role -> az_role -> az_role_permission) decides WHAT a user may do.
//  - Board membership (az_board_member.role) decides WHERE they may do it.
//  - Super admin manages auth and board access rights for everyone.
import { all, get } from '../db/index.js';
import { forbidden, notFound, HttpError } from './http.js';

export async function loadUser(id) {
  const u = await get(
    `SELECT u.id, u.username, u.email, u.is_super_admin, u.is_active, u.last_login_at, u.created_at,
            p.full_name, p.avatar_url, p.role, p.designation, p.department, p.color, p.is_guest,
            p.status, p.whatsapp_number, p.bio
       FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.id = ?`, id);
  if (!u) return null;
  u.is_super_admin = !!u.is_super_admin;
  u.is_active = !!u.is_active;
  u.is_guest = !!u.is_guest;
  u.permissions = u.is_super_admin
    ? ['*']
    : (await all(`SELECT pm.key FROM az_role r
             JOIN az_role_permission rp ON rp.role_id = r.id
             JOIN az_permission pm ON pm.id = rp.permission_id
            WHERE r.name = ? AND r.is_active = 1 AND rp.is_active = 1 AND pm.is_active = 1`, u.role || 'guest')).map((r) => r.key);
  return u;
}

export const isSuper = (u) => !!u && (u.is_super_admin || u.role === 'super_admin');
export const isAdmin = (u) => isSuper(u) || u?.role === 'admin';
export const can = (u, perm) => isSuper(u) || (u?.permissions || []).includes(perm);
export function requirePerm(u, perm) {
  if (!can(u, perm)) throw forbidden(`Your role (${u.role}) lacks the "${perm}" permission`);
}
export function requireSuper(u) { if (!isSuper(u)) throw forbidden('Super admin only'); }

export async function boardCtx(boardId) {
  return await get(
    `SELECT b.*, w.company_id, w.name AS workspace_name, c.name AS company_name, c.code AS company_code,
            w.is_active AS unit_active, c.is_active AS company_active
       FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id
       JOIN az_company c ON c.id = w.company_id WHERE b.id = ?`, boardId);
}

export async function boardRole(u, boardId) {
  if (isAdmin(u)) return 'admin';
  const bm = await get('SELECT role FROM az_board_member WHERE board_id = ? AND user_id = ? AND is_active = 1', boardId, u.id);
  const wsAdmin = await get(
    `SELECT 1 FROM az_board b JOIN az_workspace_member m ON m.workspace_id = b.workspace_id
      WHERE b.id = ? AND m.user_id = ? AND m.role = 'admin' AND m.is_active = 1`, boardId, u.id);
  if (wsAdmin) return 'admin';
  return bm?.role || null;
}

export async function boardAccess(u, boardId) {
  const role = await boardRole(u, boardId);
  return {
    role,
    canView: !!role,
    canEdit: !!role && role !== 'viewer' && can(u, 'card.edit'),
    canCreate: !!role && role !== 'viewer' && can(u, 'card.create'),
    canDelete: !!role && role !== 'viewer' && can(u, 'card.delete'),
    canManage: role === 'admin' && can(u, 'board.manage'),
  };
}
export async function assertBoard(u, boardId, need = 'view') {
  const ctx = await boardCtx(boardId);
  if (!ctx) throw notFound('Board not found');
  const retired = !ctx.is_active || !ctx.unit_active || !ctx.company_active;
  if (retired && !(need === 'view' && isSuper(u))) {
    throw new HttpError(409, `Board “${ctx.title}” is retired${ctx.is_active ? ' (its unit or company is retired)' : ''} — reactivate it to work on it again`);
  }
  const a = await boardAccess(u, boardId);
  const ok = { view: a.canView, edit: a.canEdit, create: a.canCreate, delete: a.canDelete, manage: a.canManage }[need];
  if (!ok) throw forbidden(a.canView ? `You have ${a.role} access on this board — ${need} not allowed` : 'You are not a member of this board');
  return { ctx, access: a };
}

const LIVE_BOARD = `SELECT b.id FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id
                     WHERE b.is_active = 1 AND w.is_active = 1 AND c.is_active = 1`;
export async function visibleBoardIds(u) {
  if (isAdmin(u)) return (await all(LIVE_BOARD)).map((r) => r.id);
  return (await all(
    `${LIVE_BOARD} AND (
       b.id IN (SELECT board_id FROM az_board_member WHERE user_id = ? AND is_active = 1)
       OR b.workspace_id IN (SELECT workspace_id FROM az_workspace_member WHERE user_id = ? AND role = 'admin' AND is_active = 1))`, u.id, u.id)).map((r) => r.id);
}

const LIVE_UNIT = `SELECT w.id FROM az_workspace w JOIN az_company c ON c.id = w.company_id WHERE w.is_active = 1 AND c.is_active = 1`;
export async function visibleWorkspaceIds(u) {
  if (isAdmin(u)) return (await all(LIVE_UNIT)).map((r) => r.id);
  return (await all(
    `${LIVE_UNIT} AND (
       w.id IN (SELECT workspace_id FROM az_workspace_member WHERE user_id = ? AND is_active = 1)
       OR w.id IN (SELECT b.workspace_id FROM az_board b JOIN az_board_member bm ON bm.board_id = b.id
                    WHERE bm.user_id = ? AND bm.is_active = 1 AND b.is_active = 1))`,
    u.id, u.id)).map((r) => r.id);
}

export async function visibleCompanyIds(u) {
  if (isAdmin(u)) return (await all('SELECT id FROM az_company WHERE is_active = 1')).map((r) => r.id);
  const ws = await visibleWorkspaceIds(u);
  if (!ws.length) return [];
  return (await all(`SELECT DISTINCT company_id AS id FROM az_workspace WHERE id IN (${ws.map(() => '?').join(',')})`, ...ws)).map((r) => r.id);
}

export function inList(ids) {
  // returns [sqlFragment, params] for "IN (...)" handling empty lists safely
  if (!ids.length) return ['(NULL)', []];
  return [`(${ids.map(() => '?').join(',')})`, ids];
}

// ---------- chat visibility ----------
export async function canViewChannel(u, ch) {
  if (!ch) return false;
  if (!ch.is_active) return isSuper(u); // retired channel: read-only for the MDM authority
  const member = await get('SELECT 1 FROM az_channel_member WHERE channel_id = ? AND user_id = ? AND is_active = 1', ch.id, u.id);
  if (ch.type === 'dm' || ch.type === 'private' || ch.is_private) return !!member || (ch.type === 'private' && isSuper(u));
  if (member) return true;
  if (ch.type === 'board_log') {
    const b = await get('SELECT id FROM az_board WHERE log_channel_id = ?', ch.id);
    return b ? !!await boardRole(u, b.id) : isAdmin(u);
  }
  if (isAdmin(u)) return true;
  if (ch.workspace_id) return (await visibleWorkspaceIds(u)).includes(ch.workspace_id);
  if (ch.company_id) return (await visibleCompanyIds(u)).includes(ch.company_id);
  return false;
}

export async function channelAudience(ch) {
  if (!ch) return [];
  const members = (await all('SELECT user_id FROM az_channel_member WHERE channel_id = ? AND is_active = 1', ch.id)).map((r) => r.user_id);
  if (ch.type === 'dm' || ch.type === 'private' || ch.is_private) return members;
  const admins = (await all(`SELECT u.id FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.is_super_admin = 1 OR p.role IN ('admin','super_admin')`)).map((r) => r.id);
  let extra = [];
  if (ch.type === 'board_log') {
    const b = await get('SELECT id FROM az_board WHERE log_channel_id = ?', ch.id);
    if (b) extra = await boardAudience(b.id);
  } else if (ch.workspace_id) {
    extra = (await all(
      `SELECT user_id FROM az_workspace_member WHERE workspace_id = ? AND is_active = 1
       UNION SELECT bm.user_id FROM az_board_member bm JOIN az_board b ON b.id = bm.board_id WHERE b.workspace_id = ? AND bm.is_active = 1`,
      ch.workspace_id, ch.workspace_id)).map((r) => r.user_id);
  } else if (ch.company_id) {
    extra = (await all(
      `SELECT m.user_id FROM az_workspace_member m JOIN az_workspace w ON w.id = m.workspace_id WHERE w.company_id = ? AND m.is_active = 1
       UNION SELECT bm.user_id FROM az_board_member bm JOIN az_board b ON b.id = bm.board_id
             JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = ? AND bm.is_active = 1`,
      ch.company_id, ch.company_id)).map((r) => r.user_id);
  }
  return [...new Set([...members, ...admins, ...extra])];
}

export async function boardAudience(boardId) {
  return [...new Set([
    ...(await all('SELECT user_id FROM az_board_member WHERE board_id = ? AND is_active = 1', boardId)).map((r) => r.user_id),
    ...(await all(`SELECT u.id FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.is_super_admin = 1 OR p.role IN ('admin','super_admin')`)).map((r) => r.id),
    ...(await all(`SELECT m.user_id FROM az_board b JOIN az_workspace_member m ON m.workspace_id = b.workspace_id
             WHERE b.id = ? AND m.role = 'admin' AND m.is_active = 1`, boardId)).map((r) => r.user_id),
  ])];
}

export async function adminIds() {
  return (await all(`SELECT u.id FROM users u LEFT JOIN profiles p ON p.id = u.id
               WHERE u.is_active = 1 AND (u.is_super_admin = 1 OR p.role IN ('admin','super_admin'))`)).map((r) => r.id);
}
