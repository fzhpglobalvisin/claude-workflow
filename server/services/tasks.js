// Task detail service — subtasks, requirements (text / PDF / media / link), Drive attachments, comments.
import { get, all, run, insert, update, uuid, now } from '../db/index.js';
import { bad, notFound, forbidden, str, oneOf } from '../lib/http.js';
import { isAdmin, can } from '../lib/access.js';
import { audit, notify } from '../lib/events.js';
import { parseDrive, guessType, parseMentions } from '../lib/chatcore.js';
import { assertCard, boardChanged } from './boards.js';
import { retire } from '../lib/mdm.js';

const logTask = async (user, type, card, ctx, entityType, entityId, details) =>
  await audit({ actor: user, type, entityType, entityId: entityId || card.id, boardId: card.board_id, workspaceId: ctx?.workspace_id, companyId: ctx?.company_id, details: { card_id: card.id, card: card.title, ...details } });

function requireUrl(u, name = 'URL') {
  const s = str(u, name, { max: 2000 });
  if (!/^https?:\/\//i.test(s)) throw bad(`${name} must start with http:// or https://`);
  return s;
}

export function register(r) {
  // ---------------- Subtasks ----------------
  r.post('/api/cards/:id/subtasks', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'edit');
    const id = ctx.body.id || uuid();
    if (await get('SELECT 1 FROM az_subtask WHERE id = ?', id)) return await get('SELECT * FROM az_subtask WHERE id = ?', id);
    const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_subtask WHERE card_id = ? AND is_active = 1', card.id)).p;
    const s = await insert('az_subtask', {
      id, card_id: card.id, title: str(ctx.body.title, 'Subtask', { max: 300 }), is_done: 0, assignee_id: ctx.body.assignee_id || null,
      due_date: ctx.body.due_date || null, position: pos, created_by: ctx.user.id, is_ai_generated: 0, created_at: now(), updated_at: now(),
    });
    await logTask(ctx.user, 'subtask.created', card, b, 'subtask', s.id, { title: s.title });
    if (s.assignee_id) await notify([s.assignee_id], { type: 'assign', title: `${ctx.user.full_name} assigned you a subtask`, body: `${s.title} — in “${card.title}”`, link: b ? `/board/${b.id}?card=${card.id}` : '/', actorId: ctx.user.id });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return s;
  });
  r.patch('/api/subtasks/:id', async (ctx) => {
    const s = await get('SELECT * FROM az_subtask WHERE id = ?', ctx.params.id);
    if (!s) throw notFound('Subtask not found');
    const { card, ctx: b } = await assertCard(ctx.user, s.card_id, 'edit');
    const patch = { updated_at: now() };
    if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Subtask', { max: 300 });
    if (ctx.body.is_done !== undefined) { patch.is_done = ctx.body.is_done ? 1 : 0; patch.completed_at = ctx.body.is_done ? now() : null; }
    if (ctx.body.assignee_id !== undefined) patch.assignee_id = ctx.body.assignee_id || null;
    if (ctx.body.due_date !== undefined) patch.due_date = ctx.body.due_date || null;
    if (ctx.body.position !== undefined) patch.position = Number(ctx.body.position) || 0;
    await update('az_subtask', s.id, { ...patch, _expect_version: ctx.body.base_version });
    await logTask(ctx.user, patch.is_done === 1 ? 'subtask.completed' : patch.is_done === 0 ? 'subtask.reopened' : 'subtask.updated', card, b, 'subtask', s.id, { title: patch.title || s.title });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return await get('SELECT * FROM az_subtask WHERE id = ?', s.id);
  });
  r.delete('/api/subtasks/:id', async (ctx) => {
    const s = await get('SELECT * FROM az_subtask WHERE id = ?', ctx.params.id);
    if (!s) throw notFound('Subtask not found');
    const { card, ctx: b } = await assertCard(ctx.user, s.card_id, 'edit');
    await retire('subtask', s.id, { reason: ctx.query.reason });
    await logTask(ctx.user, 'subtask.retired', card, b, 'subtask', s.id, { title: s.title });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return { ok: true };
  });

  // ---------------- Requirements ----------------
  r.post('/api/cards/:id/requirements', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'edit');
    const type = oneOf(ctx.body.type, 'type', ['text', 'pdf', 'media', 'link'], 'text');
    const title = str(ctx.body.title, 'Title', { max: 200 });
    let content = null; let url = null; let driveId = null;
    if (type === 'text') content = str(ctx.body.content, 'Requirement text', { max: 20000 });
    else {
      url = requireUrl(ctx.body.url);
      driveId = parseDrive(url).drive_file_id;
      content = ctx.body.content || null;
    }
    const q = await insert('az_task_requirement', {
      id: ctx.body.id || uuid(), card_id: card.id, type, title, content, url, drive_file_id: driveId,
      mime_type: type === 'pdf' ? 'application/pdf' : ctx.body.mime_type || null, created_by: ctx.user.id, created_at: now(), updated_at: now(),
    });
    await logTask(ctx.user, 'requirement.added', card, b, 'requirement', q.id, { type, title });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return q;
  });
  r.patch('/api/requirements/:id', async (ctx) => {
    const q = await get('SELECT * FROM az_task_requirement WHERE id = ?', ctx.params.id);
    if (!q) throw notFound('Requirement not found');
    const { card, ctx: b } = await assertCard(ctx.user, q.card_id, 'edit');
    const patch = { updated_at: now() };
    if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Title', { max: 200 });
    if (ctx.body.content !== undefined) patch.content = ctx.body.content || null;
    if (ctx.body.url !== undefined && q.type !== 'text') { patch.url = requireUrl(ctx.body.url); patch.drive_file_id = parseDrive(patch.url).drive_file_id; }
    await update('az_task_requirement', q.id, { ...patch, _expect_version: ctx.body.base_version });
    await logTask(ctx.user, 'requirement.updated', card, b, 'requirement', q.id, { title: patch.title || q.title });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return await get('SELECT * FROM az_task_requirement WHERE id = ?', q.id);
  });
  r.delete('/api/requirements/:id', async (ctx) => {
    const q = await get('SELECT * FROM az_task_requirement WHERE id = ?', ctx.params.id);
    if (!q) throw notFound('Requirement not found');
    const { card, ctx: b } = await assertCard(ctx.user, q.card_id, 'edit');
    await retire('requirement', q.id, { reason: ctx.query.reason });
    await logTask(ctx.user, 'requirement.retired', card, b, 'requirement', q.id, { title: q.title });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return { ok: true };
  });

  // ---------------- Attachments (Google Drive links) ----------------
  r.post('/api/cards/:id/attachments', async (ctx) => {
    const { card, ctx: b } = await assertCard(ctx.user, ctx.params.id, 'edit');
    const url = requireUrl(ctx.body.url, 'Drive link');
    const d = parseDrive(url);
    const name = ctx.body.name ? str(ctx.body.name, 'Name', { max: 200 }) : (d.drive_file_id ? `Drive file ${d.drive_file_id.slice(0, 8)}…` : url);
    const a = await insert('az_attachment', {
      id: ctx.body.id || uuid(), name, url, card_id: card.id, uploader_id: ctx.user.id,
      file_type: ctx.body.file_type || guessType(name, url), file_size: ctx.body.file_size ? Number(ctx.body.file_size) : null,
      drive_file_id: d.drive_file_id, drive_web_view_link: d.drive_web_view_link, drive_thumbnail_link: d.drive_thumbnail_link,
      created_at: now(), updated_at: now(),
    });
    await logTask(ctx.user, 'attachment.added', card, b, 'attachment', a.id, { name, drive: d.is_drive });
    if (ctx.body.make_cover && d.drive_thumbnail_link && can(ctx.user, 'cover.manage')) await update('az_card', card.id, { cover_url: d.drive_thumbnail_link });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return { ...a, is_drive: d.is_drive };
  });
  r.delete('/api/attachments/:id', async (ctx) => {
    const a = await get('SELECT * FROM az_attachment WHERE id = ?', ctx.params.id);
    if (!a) throw notFound('Attachment not found');
    if (a.card_id) {
      const { card, ctx: b } = await assertCard(ctx.user, a.card_id, 'edit');
      await retire('attachment', a.id, { reason: ctx.query.reason });
      await logTask(ctx.user, 'attachment.retired', card, b, 'attachment', a.id, { name: a.name });
      if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    } else {
      if (a.uploader_id !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden();
      await retire('attachment', a.id, { reason: ctx.query.reason });
    }
    return { ok: true };
  });

  // ---------------- Card comments ----------------
  r.post('/api/cards/:id/comments', async (ctx) => {
    const { card, ctx: b, access } = await assertCard(ctx.user, ctx.params.id, 'view');
    if (access.role === 'viewer' && !ctx.user.permissions.includes('chat.post') && ctx.user.permissions[0] !== '*') throw forbidden('Viewers cannot comment');
    const text = str(ctx.body.text, 'Comment', { max: 10000 });
    const c = await insert('az_card_comments', {
      id: ctx.body.id || uuid(), card_id: card.id, text, sender: ctx.user.full_name, reply_to: ctx.body.reply_to || null,
      profile_id: ctx.user.id, is_pinned: 0, created_at: now(),
    });
    await logTask(ctx.user, 'comment.added', card, b, 'comment', c.id, { preview: text.slice(0, 80) });
    const handles = parseMentions(text);
    if (handles.length) {
      const ids = (await all(`SELECT id FROM users WHERE username IN (${handles.map(() => '?').join(',')})`, ...handles)).map((x) => x.id);
      await notify(ids, { type: 'mention', title: `${ctx.user.full_name} mentioned you on “${card.title}”`, body: text.slice(0, 140), link: b ? `/board/${b.id}?card=${card.id}` : '/', actorId: ctx.user.id });
    }
    await notify([card.assignee_id, card.created_by].filter((x) => x && x !== ctx.user.id), { type: 'comment', title: `${ctx.user.full_name} commented on “${card.title}”`, body: text.slice(0, 140), link: b ? `/board/${b.id}?card=${card.id}` : '/', actorId: ctx.user.id });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return c;
  });
  r.patch('/api/comments/:id', async (ctx) => {
    const c = await get('SELECT * FROM az_card_comments WHERE id = ?', ctx.params.id);
    if (!c) throw notFound('Comment not found');
    const { card, ctx: b } = await assertCard(ctx.user, c.card_id, 'view');
    const patch = {};
    if (ctx.body.text !== undefined) {
      if (c.profile_id !== ctx.user.id) throw forbidden('You can only edit your own comments');
      patch.text = str(ctx.body.text, 'Comment', { max: 10000 });
    }
    if (ctx.body.is_pinned !== undefined) patch.is_pinned = ctx.body.is_pinned ? 1 : 0;
    await update('az_card_comments', c.id, { ...patch, _expect_version: ctx.body.base_version });
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return await get('SELECT * FROM az_card_comments WHERE id = ?', c.id);
  });
  r.delete('/api/comments/:id', async (ctx) => {
    const c = await get('SELECT * FROM az_card_comments WHERE id = ?', ctx.params.id);
    if (!c) throw notFound('Comment not found');
    const { card, ctx: b } = await assertCard(ctx.user, c.card_id, 'view');
    if (c.profile_id !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('You can only remove your own comments');
    await retire('comment', c.id, { reason: ctx.query.reason }); // text stays in the version history
    await logTask(ctx.user, 'comment.retired', card, b, 'comment', c.id, {});
    if (b) await boardChanged(b.id, 'card', { cardId: card.id });
    return { ok: true };
  });
}
