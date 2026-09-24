// Audit trail + notifications (the "notification service").
import { insert, uuid, now } from '../db/index.js';
import { sendTo } from './realtime.js';

export async function audit({ actor, type, entityType, entityId, details, boardId, workspaceId, companyId, ip }) {
  const row = {
    id: uuid(), actor_id: actor?.id || actor || null, type,
    entity_type: entityType || null, entity_id: entityId ? String(entityId) : null,
    details: details || null, board_id: boardId || null, workspace_id: workspaceId || null,
    company_id: companyId || null, ip: ip || null, created_at: now(),
  };
  await insert('az_activity_log', row);
  return row;
}

export async function notify(userIds, { type, title, body, link, actorId }) {
  const ids = [...new Set(userIds.filter(Boolean))].filter((id) => id !== actorId);
  const out = [];
  for (const userId of ids) {
    const n = { id: uuid(), user_id: userId, type, title, body: body || null, link: link || null, actor_id: actorId || null, is_read: 0, created_at: now() };
    await insert('az_notification', n);
    sendTo([userId], 'notification', n);
    out.push(n);
  }
  return out;
}
