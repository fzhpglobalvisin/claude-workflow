// MDM service — version history on every record, retire / reactivate, ownership, and the
// Superadmin governance console (registry, change log, retired records, integrity, purge).
//
// Data scopes (who may govern a record):
//   global    — companies, users, roles & permissions, AI agents, groups: Superadmin only
//   company   — units, channels, pipelines, reports, alerts, messages: company admins (+ owners where natural)
//   workspace — projects, boards, lists, tasks and their documents: board / project permissions
import { get, now } from '../db/index.js';
import { bad, forbidden, notFound } from '../lib/http.js';
import { isSuper, isAdmin, can, assertBoard, visibleCompanyIds, visibleWorkspaceIds, canViewChannel, requireSuper } from '../lib/access.js';
import { audit } from '../lib/events.js';
import {
  entityDef, loadRecord, retire, reactivate, versions, versionAt, references, purge, summary, changes, retiredRecords,
  integrity, applyEffectiveDates, CLASSIFICATION, updateRecord, dependents,
} from '../lib/mdm.js';
import { APP_ENV } from '../lib/environment.js';

const CARD_FAMILY = new Set(['subtask', 'requirement', 'attachment', 'comment']);

async function cardBoard(cardId) {
  return cardId ? get('SELECT id, board_id, created_by FROM az_card WHERE id = ?', cardId) : null;
}
async function assertBoardOrInbox(u, card, need) {
  if (!card) throw notFound('Task not found');
  if (!card.board_id) { if (card.created_by !== u.id && !isSuper(u)) throw forbidden('This inbox card belongs to someone else'); return; }
  await assertBoard(u, card.board_id, need);
}
async function channelOf(id) { return id ? get('SELECT * FROM az_channel WHERE id = ?', id) : null; }

/** May this user read the record (and therefore its history)? */
export async function assertCanView(u, entity, row) {
  if (isSuper(u)) return;
  switch (entity) {
    case 'user': case 'profile': case 'role': case 'permission': case 'role_permission': case 'ai_agent': return;
    case 'group': case 'subscription': if (isAdmin(u)) return; break;
    case 'company': if ((await visibleCompanyIds(u)).includes(row.id)) return; break;
    case 'unit': if ((await visibleWorkspaceIds(u)).includes(row.id)) return; break;
    case 'unit_member': case 'project': if ((await visibleWorkspaceIds(u)).includes(row.workspace_id)) return; break;
    case 'board': return void await assertBoard(u, row.id, 'view');
    case 'list': case 'board_member': return void await assertBoard(u, row.board_id, 'view');
    case 'card': return assertBoardOrInbox(u, row, 'view');
    case 'channel': if (await canViewChannel(u, row)) return; break;
    case 'channel_member': case 'message': if (await canViewChannel(u, await channelOf(row.channel_id))) return; break;
    case 'voice_note': { const m = await get('SELECT channel_id FROM az_message WHERE id = ?', row.message_id); if (m && await canViewChannel(u, await channelOf(m.channel_id))) return; break; }
    case 'pipeline': case 'alert': if (can(u, 'ops.view')) return; break;
    case 'report': if (row.is_shared || row.created_by === u.id || isAdmin(u)) return; break;
    default:
      if (CARD_FAMILY.has(entity)) return assertBoardOrInbox(u, await cardBoard(row.card_id), 'view');
  }
  throw forbidden('You have no access to this record');
}

/** May this user retire / reactivate the record? (Superadmin always may — MDM authority.) */
export async function assertCanGovern(u, entity, row) {
  if (isSuper(u)) return;
  const d = entityDef(entity);
  if (d.scope === 'global') throw forbidden(`${d.label} records are global master data — governed by the Superadmin (MDM authority)`);
  switch (entity) {
    case 'unit': if (isAdmin(u) && can(u, 'unit.manage')) return; break;
    case 'unit_member': if (isAdmin(u)) return; break;
    case 'channel': if (row.created_by === u.id || isAdmin(u)) return; break;
    case 'channel_member': if (row.user_id === u.id || isAdmin(u)) return; break;
    case 'pipeline': if (can(u, 'ops.manage')) return; break;
    case 'alert': if (can(u, 'alert.manage')) return; break;
    case 'report': if (row.created_by === u.id || isAdmin(u)) return; break;
    case 'message': if (row.user_id === u.id || isAdmin(u)) return; break;
    case 'project': if (can(u, 'project.manage') && (await visibleWorkspaceIds(u)).includes(row.workspace_id)) return; break;
    case 'board': return void await assertBoard(u, row.id, 'manage');
    case 'board_member': { const { access } = await assertBoard(u, row.board_id, 'view'); if (access.canManage && can(u, 'board.members')) return; break; }
    case 'list': return void await assertBoard(u, row.board_id, 'delete');
    case 'card': return assertBoardOrInbox(u, row, 'delete');
    case 'comment': if (row.profile_id === u.id || isAdmin(u)) return assertBoardOrInbox(u, await cardBoard(row.card_id), 'view'); break;
    default:
      if (CARD_FAMILY.has(entity)) return assertBoardOrInbox(u, await cardBoard(row.card_id), 'edit');
  }
  throw forbidden(`You cannot retire or reactivate this ${d.label.toLowerCase()}`);
}

async function load(entity, id) {
  const row = await loadRecord(entity, id);
  if (!row) throw notFound(`${entityDef(entity).label} not found`);
  return row;
}

export function register(r) {
  // ---------------- history on every record (compact panel + full history) ----------------
  r.get('/api/versions/:entity/:id', async (ctx) => {
    const { entity, id } = ctx.params;
    const row = await loadRecord(entity, id);
    if (row) await assertCanView(ctx.user, entity, row);
    else requireSuper(ctx.user); // purged record: only the MDM authority sees the tombstone history
    return versions(entity, id, { limit: Number(ctx.query.limit) || 200 });
  });
  r.get('/api/versions/:entity/:id/at', async (ctx) => {
    const { entity, id } = ctx.params;
    await assertCanView(ctx.user, entity, await load(entity, id));
    return versionAt(entity, id, ctx.query.at || now());
  });
  r.get('/api/versions/:entity/:id/refs', async (ctx) => {
    const { entity, id } = ctx.params;
    await assertCanView(ctx.user, entity, await load(entity, id));
    return references(entity, id, ctx.query.version);
  });

  // ---------------- retire / reactivate (the only way records leave circulation) ----------------
  r.post('/api/mdm/:entity/:id/retire', async (ctx) => {
    const { entity, id } = ctx.params;
    const row = await load(entity, id);
    await assertCanGovern(ctx.user, entity, row);
    if (entity === 'user' && row.id === ctx.user.id) throw bad('You cannot retire yourself');
    const out = await retire(entity, id, { reason: ctx.body.reason });
    await audit({ actor: ctx.user, type: 'mdm.retired', entityType: entity, entityId: id, details: { reason: ctx.body.reason || null, cascaded: out.cascaded }, ip: ctx.ip });
    return { ok: true, ...out };
  });
  r.post('/api/mdm/:entity/:id/reactivate', async (ctx) => {
    const { entity, id } = ctx.params;
    const row = await load(entity, id);
    await assertCanGovern(ctx.user, entity, row);
    const out = await reactivate(entity, id, { reason: ctx.body.reason });
    await audit({ actor: ctx.user, type: 'mdm.reactivated', entityType: entity, entityId: id, details: { reason: ctx.body.reason || null, restored: out.restored }, ip: ctx.ip });
    return { ok: true, ...out };
  });
  // data ownership (who is accountable for a master record)
  r.put('/api/mdm/:entity/:id/owner', async (ctx) => {
    requireSuper(ctx.user);
    const { entity, id } = ctx.params;
    const d = entityDef(entity);
    if (!d.hasOwner) throw bad(`${d.label} records have no owner field`);
    await load(entity, id);
    const owner = ctx.body.owner_id ? await get('SELECT id FROM users WHERE id = ? AND is_active = 1', ctx.body.owner_id) : null;
    if (ctx.body.owner_id && !owner) throw bad('Owner must be an active user');
    await updateRecord(d, id, { owner_id: owner?.id || null, change_note: ctx.body.reason || 'Data owner changed' });
    await audit({ actor: ctx.user, type: 'mdm.owner_set', entityType: entity, entityId: id, details: { owner_id: owner?.id || null }, ip: ctx.ip });
    return versions(entity, id, { limit: 5 });
  });

  // ---------------- Superadmin governance console ----------------
  r.get('/api/mdm/registry', async (ctx) => { requireSuper(ctx.user); return { environment: APP_ENV, entities: await summary(), classification: CLASSIFICATION() }; });
  r.get('/api/mdm/changes', async (ctx) => { requireSuper(ctx.user); return changes(ctx.query); });
  r.get('/api/mdm/retired', async (ctx) => { requireSuper(ctx.user); return retiredRecords(ctx.query.entity || null); });
  r.get('/api/mdm/integrity', async (ctx) => { requireSuper(ctx.user); return integrity(); });
  r.post('/api/mdm/effective-dates', async (ctx) => { requireSuper(ctx.user); return applyEffectiveDates(); });
  r.get('/api/mdm/:entity/:id/dependents', async (ctx) => { requireSuper(ctx.user); await load(ctx.params.entity, ctx.params.id); return dependents(ctx.params.entity, ctx.params.id); });
  // Exceptional administrative correction — never a normal delete.
  r.post('/api/mdm/:entity/:id/purge', async (ctx) => {
    requireSuper(ctx.user);
    const { entity, id } = ctx.params;
    const out = await purge(entity, id, { user: ctx.user, reason: ctx.body.reason, confirm: ctx.body.confirm });
    await audit({ actor: ctx.user, type: 'mdm.purged', entityType: entity, entityId: id, details: { title: out.title, reason: ctx.body.reason, environment: APP_ENV }, ip: ctx.ip });
    return out;
  });
}
