// Chat service — Slack-style channels, DMs, threads, reactions, @mentions, pinned chats, read state.
import { get, all, run, insert, update, uuid, now } from '../db/index.js';
import { filterAsync, mapAsync } from '../lib/async.js';
import { bad, notFound, forbidden, str, oneOf } from '../lib/http.js';
import { requirePerm, canViewChannel, channelAudience, visibleCompanyIds, isAdmin, loadUser, can } from '../lib/access.js';
import { audit } from '../lib/events.js';
import { sendTo } from '../lib/realtime.js';
import { createMessage, hydrateMessages, MESSAGE_SELECT, getMessage } from '../lib/chatcore.js';
import { respondInChannel } from './ai.js';
import { defer } from '../lib/background.js';
import { retire, upsertMembership, endMembership } from '../lib/mdm.js';

/** Read receipt (technical column) — creates the membership row the first time a public channel is opened. */
async function markRead(ch, userId) {
  const t = now();
  const r = await run('UPDATE az_channel_member SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', t, ch.id, userId);
  if (!r.changes) await insert('az_channel_member', { id: uuid(), channel_id: ch.id, user_id: userId, last_read_at: t, created_at: t }).catch(() => {});
}

async function assertChannel(u, id) {
  const ch = await get('SELECT * FROM az_channel WHERE id = ?', id);
  if (!ch) throw notFound('Channel not found');
  if (!await canViewChannel(u, ch)) throw forbidden('You are not a member of this channel');
  return ch;
}
async function dmTitle(ch, viewerId) {
  const other = await get(`SELECT u.id, u.username, p.full_name, p.color FROM az_channel_member m JOIN users u ON u.id = m.user_id
                      JOIN profiles p ON p.id = u.id WHERE m.channel_id = ? AND m.user_id <> ? LIMIT 1`, ch.id, viewerId);
  return other ? { name: other.full_name, dm_user: other } : { name: 'Just you', dm_user: null };
}

export async function channelSummary(u, ch) {
  const mem = await get('SELECT last_read_at FROM az_channel_member WHERE channel_id = ? AND user_id = ? AND is_active = 1', ch.id, u.id);
  const last = await get('SELECT MAX(created_at) AS t, COUNT(*) AS n FROM az_message WHERE channel_id = ? AND deleted = 0 AND parent_message_id IS NULL', ch.id);
  const unread = mem ? (await get(`SELECT COUNT(*) AS n FROM az_message WHERE channel_id = ? AND deleted = 0 AND parent_message_id IS NULL
                             AND created_at > COALESCE(?, '') AND COALESCE(user_id, '') <> ?`, ch.id, mem.last_read_at, u.id)).n : 0;
  const mentions = mem ? (await get(`SELECT COUNT(*) AS n FROM az_mention x JOIN az_message m ON m.id = x.message_id
                               WHERE m.channel_id = ? AND x.mentioned_user_id = ? AND m.created_at > COALESCE(?, '')`, ch.id, u.id, mem.last_read_at)).n : 0;
  const pinned = !!await get('SELECT 1 FROM az_pinned_item WHERE user_id = ? AND channel_id = ? AND message_id IS NULL', u.id, ch.id);
  const extra = ch.type === 'dm' ? await dmTitle(ch, u.id) : {};
  const board = ch.type === 'board_log' ? await get('SELECT id, title FROM az_board WHERE log_channel_id = ?', ch.id) : null;
  return { ...ch, ...extra, is_private: !!ch.is_private, is_member: !!mem, last_message_at: last.t, message_count: last.n, unread, mentions, pinned, board };
}

export function register(r) {
  r.get('/api/channels', async (ctx) => {
    const cid = ctx.query.company_id;
    if (cid && !(await visibleCompanyIds(ctx.user)).includes(cid)) throw forbidden('No access to this company');
    const rows = cid ? await all('SELECT * FROM az_channel WHERE company_id = ? AND is_active = 1 ORDER BY name', cid) : await all('SELECT * FROM az_channel WHERE is_active = 1 ORDER BY name');
    const list = await mapAsync(await filterAsync(rows, (c) => canViewChannel(ctx.user, c)), (c) => channelSummary(ctx.user, c));
    const units = Object.fromEntries((await all('SELECT id, name FROM az_workspace')).map((w) => [w.id, w.name]));
    return list.map((c) => ({ ...c, unit_name: units[c.workspace_id] || null }));
  });

  r.post('/api/channels', async (ctx) => {
    requirePerm(ctx.user, 'chat.channel.create');
    const b = ctx.body;
    const company = await get('SELECT * FROM az_company WHERE id = ?', b.company_id);
    if (!company || !(await visibleCompanyIds(ctx.user)).includes(company.id)) throw forbidden('No access to this company');
    const name = str(b.name, 'Channel name', { max: 60 }).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const type = oneOf(b.type, 'type', ['public', 'private'], 'public');
    const id = uuid(); const t = now();
    await insert('az_channel', { id, name, type, company_id: company.id, workspace_id: b.workspace_id || null, description: b.description || null, is_private: type === 'private' ? 1 : 0, created_by: ctx.user.id, created_at: t, updated_at: t });
    const members = [...new Set([ctx.user.id, ...(Array.isArray(b.member_ids) ? b.member_ids : [])])];
    for (const uid of members) await upsertMembership('channel_member', { channel_id: id, user_id: uid }, { last_read_at: t });
    await audit({ actor: ctx.user, type: 'channel.created', entityType: 'channel', entityId: id, companyId: company.id, workspaceId: b.workspace_id, details: { name, type }, ip: ctx.ip });
    const ch = await get('SELECT * FROM az_channel WHERE id = ?', id);
    sendTo(await channelAudience(ch), 'channel:changed', { channelId: id, companyId: company.id });
    return await channelSummary(ctx.user, ch);
  });

  r.post('/api/dm', async (ctx) => {
    const other = await loadUser(str(ctx.body.user_id, 'user_id'));
    if (!other) throw notFound('User not found');
    const companyId = ctx.body.company_id || null;
    const existing = await get(`SELECT c.* FROM az_channel c WHERE c.type = 'dm' AND c.is_active = 1 AND COALESCE(c.company_id,'') = COALESCE(?, '')
        AND EXISTS (SELECT 1 FROM az_channel_member m WHERE m.channel_id = c.id AND m.user_id = ?)
        AND EXISTS (SELECT 1 FROM az_channel_member m WHERE m.channel_id = c.id AND m.user_id = ?)
        AND (SELECT COUNT(*) FROM az_channel_member m WHERE m.channel_id = c.id) = ?`,
      companyId, ctx.user.id, other.id, other.id === ctx.user.id ? 1 : 2);
    if (existing) return await channelSummary(ctx.user, existing);
    const id = uuid(); const t = now();
    await insert('az_channel', { id, name: `dm-${ctx.user.username}-${other.username}`, type: 'dm', company_id: companyId, is_private: 1, created_by: ctx.user.id, created_at: t, updated_at: t });
    for (const uid of new Set([ctx.user.id, other.id])) await insert('az_channel_member', { id: uuid(), channel_id: id, user_id: uid, last_read_at: t, created_at: t });
    return await channelSummary(ctx.user, await get('SELECT * FROM az_channel WHERE id = ?', id));
  });

  r.get('/api/channels/:id', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    const members = await all(`SELECT u.id, u.username, p.full_name, p.color, p.designation FROM az_channel_member m JOIN users u ON u.id = m.user_id
                          JOIN profiles p ON p.id = u.id WHERE m.channel_id = ? AND m.is_active = 1 ORDER BY p.full_name`, ch.id);
    return { ...await channelSummary(ctx.user, ch), members, can_post: can(ctx.user, 'chat.post') };
  });

  r.patch('/api/channels/:id', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    if (ch.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('Only the channel creator or an admin can edit it');
    const patch = { updated_at: now() };
    if (ctx.body.name) patch.name = String(ctx.body.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 60);
    if (ctx.body.description !== undefined) patch.description = ctx.body.description || null;
    await update('az_channel', ch.id, patch);
    await audit({ actor: ctx.user, type: 'channel.updated', entityType: 'channel', entityId: ch.id, companyId: ch.company_id, details: patch, ip: ctx.ip });
    sendTo(await channelAudience(ch), 'channel:changed', { channelId: ch.id, companyId: ch.company_id });
    return await channelSummary(ctx.user, await get('SELECT * FROM az_channel WHERE id = ?', ch.id));
  });

  r.delete('/api/channels/:id', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    if (ch.type === 'board_log') throw bad('Board log channels are retired together with their board');
    if (ch.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('Only the channel creator or an admin can archive it');
    const audience = await channelAudience(ch);
    await retire('channel', ch.id, { reason: ctx.query.reason }); // messages and history are kept
    await audit({ actor: ctx.user, type: 'channel.retired', entityType: 'channel', entityId: ch.id, companyId: ch.company_id, details: { name: ch.name, reason: ctx.query.reason || null }, ip: ctx.ip });
    sendTo(audience, 'channel:changed', { channelId: ch.id, companyId: ch.company_id, deleted: true });
    return { ok: true };
  });

  r.post('/api/channels/:id/members', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    if (ch.type === 'dm') throw bad('Cannot add people to a DM');
    const ids = Array.isArray(ctx.body.user_ids) ? ctx.body.user_ids : [ctx.user.id];
    if (ids.some((x) => x !== ctx.user.id) && ch.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('Only the channel owner or an admin can add members');
    const t = now();
    for (const uid of ids) await upsertMembership('channel_member', { channel_id: ch.id, user_id: uid }, { last_read_at: t });
    sendTo(await channelAudience(ch), 'channel:changed', { channelId: ch.id, companyId: ch.company_id });
    return { ok: true };
  });
  r.delete('/api/channels/:id/members/:userId', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    if (ctx.params.userId !== ctx.user.id && ch.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden();
    await endMembership('channel_member', { channel_id: ch.id, user_id: ctx.params.userId }, ctx.params.userId === ctx.user.id ? 'Left the channel' : 'Removed from channel');
    sendTo((await channelAudience(ch)).concat(ctx.params.userId), 'channel:changed', { channelId: ch.id, companyId: ch.company_id });
    return { ok: true };
  });

  // ---------------- Messages ----------------
  r.get('/api/channels/:id/messages', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    const limit = Math.min(200, Number(ctx.query.limit) || 60);
    const before = ctx.query.before || '9999';
    const rows = (await all(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.parent_message_id IS NULL AND m.created_at < ?
                      ORDER BY m.created_at DESC LIMIT ?`, ch.id, before, limit)).reverse();
    // opening a channel marks it read (and joins public channels, Slack-style)
    await markRead(ch, ctx.user.id);
    return { messages: await hydrateMessages(rows, ctx.user.id), has_more: rows.length === limit };
  });

  r.get('/api/messages/:id/thread', async (ctx) => {
    const parent = await get('SELECT * FROM az_message WHERE id = ?', ctx.params.id);
    if (!parent) throw notFound('Message not found');
    await assertChannel(ctx.user, parent.channel_id);
    const rows = await all(`${MESSAGE_SELECT} WHERE m.parent_message_id = ? ORDER BY m.created_at`, parent.id);
    return { parent: await getMessage(parent.id, ctx.user.id), replies: await hydrateMessages(rows, ctx.user.id) };
  });

  r.post('/api/channels/:id/messages', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    requirePerm(ctx.user, 'chat.post');
    const b = ctx.body;
    if (b.id && await get('SELECT 1 FROM az_message WHERE id = ?', b.id)) return await getMessage(b.id, ctx.user.id); // offline replay
    const hasAtt = Array.isArray(b.attachments) && b.attachments.length;
    const content = hasAtt ? String(b.content || '').slice(0, 20000) : str(b.content, 'Message', { max: 20000 });
    if (b.parent_message_id) {
      const p = await get('SELECT channel_id, parent_message_id FROM az_message WHERE id = ?', b.parent_message_id);
      if (!p || p.channel_id !== ch.id) throw bad('Thread parent not in this channel');
      if (p.parent_message_id) throw bad('Replies can only be one level deep');
    }
    if (b.card_id) {
      const card = await get('SELECT board_id FROM az_card WHERE id = ?', b.card_id);
      if (!card) throw bad('Linked task not found');
    }
    const { message, aiMentioned } = await createMessage({
      id: b.id, user: ctx.user, channel: ch, content, parentId: b.parent_message_id || null, cardId: b.card_id || null,
      attachments: b.attachments, type: hasAtt && !content ? 'file' : 'text',
    });
    await run('UPDATE az_channel_member SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', now(), ch.id, ctx.user.id);
    await run('UPDATE az_channel SET updated_at = ? WHERE id = ?', now(), ch.id);
    await audit({ actor: ctx.user, type: 'message.sent', entityType: 'message', entityId: message.id, companyId: ch.company_id, workspaceId: ch.workspace_id, details: { channel: ch.name, thread: !!b.parent_message_id }, ip: ctx.ip });
    if (aiMentioned) defer(async () => await respondInChannel({ user: ctx.user, channel: ch, message }));
    return message;
  });

  r.patch('/api/messages/:id', async (ctx) => {
    const m = await get('SELECT * FROM az_message WHERE id = ?', ctx.params.id);
    if (!m || m.deleted) throw notFound('Message not found');
    const ch = await assertChannel(ctx.user, m.channel_id);
    if (m.user_id !== ctx.user.id) throw forbidden('You can only edit your own messages');
    const content = str(ctx.body.content, 'Message', { max: 20000 });
    const meta = { ...(m.metadata ? JSON.parse(m.metadata) : {}), edited: true };
    await update('az_message', m.id, { content, metadata: meta, updated_at: now() }); // previous text stays in the version history
    const msg = await getMessage(m.id);
    sendTo(await channelAudience(ch), 'message:updated', { channelId: ch.id, message: msg });
    await audit({ actor: ctx.user, type: 'message.edited', entityType: 'message', entityId: m.id, companyId: ch.company_id, ip: ctx.ip });
    return msg;
  });

  r.delete('/api/messages/:id', async (ctx) => {
    const m = await get('SELECT * FROM az_message WHERE id = ?', ctx.params.id);
    if (!m) throw notFound('Message not found');
    const ch = await assertChannel(ctx.user, m.channel_id);
    if (m.user_id !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('You can only delete your own messages');
    await retire('message', m.id, { reason: m.user_id !== ctx.user.id ? 'Removed by an admin' : null }); // sets deleted = 1, keeps the version history
    sendTo(await channelAudience(ch), 'message:updated', { channelId: ch.id, message: await getMessage(m.id) });
    await audit({ actor: ctx.user, type: 'message.deleted', entityType: 'message', entityId: m.id, companyId: ch.company_id, details: { by_admin: m.user_id !== ctx.user.id }, ip: ctx.ip });
    return { ok: true };
  });

  r.post('/api/messages/:id/reactions', async (ctx) => {
    const m = await get('SELECT * FROM az_message WHERE id = ?', ctx.params.id);
    if (!m) throw notFound('Message not found');
    const ch = await assertChannel(ctx.user, m.channel_id);
    const emoji = str(ctx.body.emoji, 'emoji', { max: 16 });
    const existing = await get('SELECT id FROM az_reaction WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, ctx.user.id, emoji);
    if (existing) await run('DELETE FROM az_reaction WHERE id = ?', existing.id);
    else await insert('az_reaction', { id: uuid(), emoji, message_id: m.id, user_id: ctx.user.id });
    const msg = await getMessage(m.id);
    sendTo(await channelAudience(ch), 'message:updated', { channelId: ch.id, message: msg });
    return await getMessage(m.id, ctx.user.id);
  });

  r.post('/api/channels/:id/read', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    await markRead(ch, ctx.user.id);
    return { ok: true };
  });

  r.post('/api/channels/:id/typing', async (ctx) => {
    const ch = await assertChannel(ctx.user, ctx.params.id);
    sendTo((await channelAudience(ch)).filter((x) => x !== ctx.user.id), 'typing', { channelId: ch.id, userId: ctx.user.id, name: ctx.user.full_name, parentId: ctx.body.parent_message_id || null });
    return { ok: true };
  });

  // ---------------- Pinned chats ----------------
  r.get('/api/pins', async (ctx) => {
    const rows = await all(`SELECT pi.id AS pin_id, pi.created_at AS pinned_at, c.id AS channel_id, pi.message_id, (pi.message_id IS NULL) AS is_channel_pin, c.name AS channel_name, c.type AS channel_type,
                             c.company_id, co.code AS company_code
                        FROM az_pinned_item pi LEFT JOIN az_channel c ON c.id = COALESCE(pi.channel_id, (SELECT channel_id FROM az_message WHERE id = pi.message_id))
                        LEFT JOIN az_company co ON co.id = c.company_id
                       WHERE pi.user_id = ? ORDER BY pi.created_at DESC`, ctx.user.id);
    return (await mapAsync(rows, async (p) => {
      const ch = await get('SELECT * FROM az_channel WHERE id = ?', p.channel_id);
      if (!ch || !await canViewChannel(ctx.user, ch)) return null;
      const title = ch.type === 'dm' ? (await dmTitle(ch, ctx.user.id)).name : `#${ch.name}`;
      const message = p.message_id ? await getMessage(p.message_id, ctx.user.id) : null;
      const summary = await channelSummary(ctx.user, ch);
      return { ...p, title, message, unread: summary.unread, last_message_at: summary.last_message_at };
    })).filter(Boolean);
  });
  r.post('/api/pins', async (ctx) => {
    const { channel_id: channelId, message_id: messageId } = ctx.body;
    if (!channelId && !messageId) throw bad('channel_id or message_id required');
    if (messageId) {
      const m = await get('SELECT channel_id FROM az_message WHERE id = ?', messageId);
      if (!m) throw notFound('Message not found');
      await assertChannel(ctx.user, m.channel_id);
      const ex = await get('SELECT id FROM az_pinned_item WHERE user_id = ? AND message_id = ?', ctx.user.id, messageId);
      if (ex) return { id: ex.id };
      return await insert('az_pinned_item', { id: uuid(), user_id: ctx.user.id, message_id: messageId, channel_id: null, created_at: now() });
    }
    await assertChannel(ctx.user, channelId);
    const ex = await get('SELECT id FROM az_pinned_item WHERE user_id = ? AND channel_id = ? AND message_id IS NULL', ctx.user.id, channelId);
    if (ex) return { id: ex.id };
    return await insert('az_pinned_item', { id: uuid(), user_id: ctx.user.id, channel_id: channelId, message_id: null, created_at: now() });
  });
  r.delete('/api/pins/:id', async (ctx) => {
    await run('DELETE FROM az_pinned_item WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
    return { ok: true };
  });
  r.post('/api/pins/unpin-channel', async (ctx) => {
    await run('DELETE FROM az_pinned_item WHERE user_id = ? AND channel_id = ? AND message_id IS NULL', ctx.user.id, ctx.body.channel_id);
    return { ok: true };
  });

  // Mentions awaiting my reply (aging)
  r.get('/api/mentions', async (ctx) => {
    const rows = await all(`${MESSAGE_SELECT} JOIN az_mention x ON x.message_id = m.id WHERE x.mentioned_user_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 60`, ctx.user.id);
    return mapAsync(await hydrateMessages(rows, ctx.user.id), async (m) => {
      const replied = await get(`SELECT 1 FROM az_message WHERE user_id = ? AND channel_id = ? AND created_at > ?
                             AND (parent_message_id = ? OR parent_message_id IS NULL OR parent_message_id = ?) LIMIT 1`,
      ctx.user.id, m.channel_id, m.created_at, m.id, m.parent_message_id);
      const ch = await get('SELECT name, type FROM az_channel WHERE id = ?', m.channel_id);
      return { ...m, channel_name: ch?.name, channel_type: ch?.type, awaiting: !replied };
    });
  });
}
