// Shared messaging core used by the chat, board, ops and AI services.
import { get, all, insert, uuid, now, j } from '../db/index.js';
import { filterAsync } from './async.js';
import { sendTo } from './realtime.js';
import { channelAudience, canViewChannel, loadUser } from './access.js';
import { notify } from './events.js';

export const AI_HANDLES = ['ai', 'assistant', 'atlas', 'sentinel', 'quill', 'blaze', 'echo'];

export function parseMentions(content = '') {
  const out = new Set();
  const re = /(^|[^\w@])@([a-z0-9._-]{2,32})/gi;
  let m;
  while ((m = re.exec(content))) out.add(m[2].toLowerCase().replace(/[.]+$/, ''));
  return [...out];
}

export function parseDrive(url = '') {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || url.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  const id = m?.[1] || null;
  const isDrive = /(drive|docs)\.google\.com/.test(url);
  let fileType = null;
  if (/document\//.test(url)) fileType = 'gdoc';
  else if (/spreadsheets\//.test(url)) fileType = 'gsheet';
  else if (/presentation\//.test(url)) fileType = 'gslides';
  else if (/folders\//.test(url)) fileType = 'folder';
  return {
    is_drive: isDrive,
    drive_file_id: isDrive ? id : null,
    drive_web_view_link: isDrive && id && !fileType ? `https://drive.google.com/file/d/${id}/view` : url,
    drive_thumbnail_link: isDrive && id && fileType !== 'folder' ? `https://drive.google.com/thumbnail?id=${id}&sz=w480` : null,
    file_type: fileType,
  };
}
export function guessType(name = '', url = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (['zip', 'rar', '7z'].includes(ext)) return 'archive';
  return parseDrive(url).file_type || 'file';
}

export async function hydrateMessages(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const reactions = await all(`SELECT r.message_id, r.emoji, r.user_id, p.full_name FROM az_reaction r LEFT JOIN profiles p ON p.id = r.user_id WHERE r.message_id IN (${ph})`, ...ids);
  const replies = await all(`SELECT parent_message_id AS id, COUNT(*) AS n, MAX(created_at) AS last_at FROM az_message WHERE parent_message_id IN (${ph}) AND deleted = 0 GROUP BY parent_message_id`, ...ids);
  const atts = await all(`SELECT * FROM az_attachment WHERE message_id IN (${ph})`, ...ids);
  const pins = viewerId ? await all(`SELECT message_id, id FROM az_pinned_item WHERE user_id = ? AND message_id IN (${ph})`, viewerId, ...ids) : [];
  const rep = Object.fromEntries(replies.map((r) => [r.id, r]));
  const pinMap = Object.fromEntries(pins.map((p) => [p.message_id, p.id]));
  return rows.map((m) => {
    const grouped = {};
    for (const r of reactions.filter((x) => x.message_id === m.id)) {
      grouped[r.emoji] ||= { emoji: r.emoji, count: 0, users: [], mine: false };
      grouped[r.emoji].count++; grouped[r.emoji].users.push(r.full_name);
      if (r.user_id === viewerId) grouped[r.emoji].mine = true;
    }
    return {
      ...m,
      content: m.deleted ? '' : m.content,
      deleted: !!m.deleted, is_ai_generated: !!m.is_ai_generated,
      metadata: j(m.metadata, {}),
      reactions: Object.values(grouped),
      reply_count: rep[m.id]?.n || 0, last_reply_at: rep[m.id]?.last_at || null,
      attachments: atts.filter((a) => a.message_id === m.id),
      pin_id: pinMap[m.id] || null,
    };
  });
}

export const MESSAGE_SELECT = `SELECT m.*, u.username, p.full_name, p.avatar_url, p.color, p.designation,
    k.title AS card_title, k.board_id AS card_board_id
  FROM az_message m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN profiles p ON p.id = m.user_id
  LEFT JOIN az_card k ON k.id = m.card_id`;

export async function getMessage(id, viewerId) {
  const row = await get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
  return row ? (await hydrateMessages([row], viewerId))[0] : null;
}

/** Create a message, record mentions, notify, and fan out in real time. */
export async function createMessage({ id, user, channel, content, parentId = null, cardId = null, type = 'text', isAi = false, metadata = null, attachments = [] }) {
  const t = now();
  const msg = {
    id: id || uuid(), content, type, user_id: user?.id || null, channel_id: channel.id, card_id: cardId,
    parent_message_id: parentId, deleted: 0, is_ai_generated: isAi ? 1 : 0, metadata, created_at: t, updated_at: t,
  };
  await insert('az_message', msg);
  for (const a of attachments || []) {
    if (!a?.url) continue;
    const d = parseDrive(a.url);
    await insert('az_attachment', {
      id: uuid(), name: a.name || a.url, url: a.url, message_id: msg.id, uploader_id: user?.id || null,
      file_type: a.file_type || guessType(a.name, a.url), drive_file_id: d.drive_file_id,
      drive_web_view_link: d.drive_web_view_link, drive_thumbnail_link: d.drive_thumbnail_link, created_at: t, updated_at: t,
    });
  }
  // mentions
  const handles = parseMentions(content);
  let aiMentioned = false;
  const mentionedUsers = [];
  for (const h of handles) {
    if (AI_HANDLES.includes(h)) {
      aiMentioned = true;
      await insert('az_mention', { id: uuid(), message_id: msg.id, mentioned_user_id: null, is_ai: 1, has_image_crop: 0, created_at: t });
      continue;
    }
    if (h === 'channel' || h === 'here' || h === 'everyone') continue;
    const target = await get('SELECT id FROM users WHERE username = ? AND is_active = 1', h);
    if (!target) continue;
    await insert('az_mention', { id: uuid(), message_id: msg.id, mentioned_user_id: target.id, is_ai: 0, has_image_crop: 0, created_at: t });
    mentionedUsers.push(target.id);
  }
  const hydrated = await getMessage(msg.id);
  const audience = await channelAudience(channel);
  sendTo(audience, 'message:new', { channelId: channel.id, message: hydrated });

  if (user && !isAi && type !== 'system') {
    const who = user.full_name || user.username;
    const link = `/chat/${channel.id}?m=${parentId || msg.id}`;
    const preview = String(content || '').slice(0, 140);
    const valid = await filterAsync(mentionedUsers, async (uid) => { const u = await loadUser(uid); return u && await canViewChannel(u, channel); });
    await notify(valid, { type: 'mention', title: `${who} mentioned you in #${channel.name}`, body: preview, link, actorId: user.id });
    if (handles.some((h) => h === 'channel' || h === 'here' || h === 'everyone')) {
      await notify(audience.filter((x) => !valid.includes(x)), { type: 'channel', title: `${who} notified #${channel.name}`, body: preview, link, actorId: user.id });
    }
    if (channel.type === 'dm') {
      await notify(audience.filter((x) => x !== user.id && !valid.includes(x)), { type: 'dm', title: `New message from ${who}`, body: preview, link, actorId: user.id });
    }
    if (parentId) {
      const participants = (await all('SELECT DISTINCT user_id FROM az_message WHERE (id = ? OR parent_message_id = ?) AND user_id IS NOT NULL', parentId, parentId))
        .map((r) => r.user_id).filter((x) => !valid.includes(x));
      await notify(participants, { type: 'thread', title: `${who} replied in a thread in #${channel.name}`, body: preview, link, actorId: user.id });
    }
  }
  return { message: hydrated, aiMentioned, mentionedUsers };
}

export async function postSystem(channelId, content, { cardId = null, actorId = null, metadata = null } = {}) {
  if (!channelId) return null;
  const channel = await get('SELECT * FROM az_channel WHERE id = ?', channelId);
  if (!channel || !channel.is_active) return null; // retired channels receive no new messages
  const actor = actorId ? { id: actorId } : null;
  return (await createMessage({ user: actor, channel, content, cardId, type: 'system', metadata, isAi: false })).message;
}
