// Global search + notifications service.
import { get, all, run, now } from '../db/index.js';
import { filterAsync } from '../lib/async.js';
import { visibleBoardIds, visibleCompanyIds, visibleWorkspaceIds, inList, canViewChannel } from '../lib/access.js';
import { shapeCard } from './boards.js';

export function register(r) {
  r.get('/api/search', async (ctx) => {
    const q = String(ctx.query.q || '').trim();
    if (q.length < 2) return { query: q, results: {} };
    const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const cid = ctx.query.company_id || null;
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    const [wSql, wp] = inList(await visibleWorkspaceIds(ctx.user));
    const [cSql, cp] = inList(await visibleCompanyIds(ctx.user));
    const cFilter = cid ? 'AND w.company_id = ?' : '';
    const cArg = cid ? [cid] : [];

    const cards = (await all(`SELECT k.id, k.doc_no, k.title, k.description, k.priority, k.due_date, k.created_at, k.board_id, b.title AS board_title,
                              l.title AS list_title, l.is_done_list, c.code AS company_code, p.full_name AS assignee_name
                         FROM az_card k JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id
                         JOIN az_list l ON l.id = k.list_id LEFT JOIN profiles p ON p.id = k.assignee_id
                        WHERE k.board_id IN ${bSql} ${cFilter} AND k.archived = 0 AND (k.title LIKE ? ESCAPE '\\' OR k.description LIKE ? ESCAPE '\\' OR k.doc_no LIKE ? ESCAPE '\\')
                        ORDER BY k.updated_at DESC LIMIT 12`, ...bp, ...cArg, like, like, like)).map(shapeCard);
    const subtasks = await all(`SELECT s.id, s.title, s.is_done, k.id AS card_id, k.title AS card_title, k.board_id
                            FROM az_subtask s JOIN az_card k ON k.id = s.card_id JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id
                           WHERE k.board_id IN ${bSql} ${cFilter} AND s.is_active = 1 AND k.is_active = 1 AND s.title LIKE ? ESCAPE '\\' LIMIT 8`, ...bp, ...cArg, like);
    const requirements = await all(`SELECT q.id, q.title, q.type, q.url, k.id AS card_id, k.title AS card_title, k.board_id
                                FROM az_task_requirement q JOIN az_card k ON k.id = q.card_id JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id
                               WHERE k.board_id IN ${bSql} ${cFilter} AND q.is_active = 1 AND k.is_active = 1 AND (q.title LIKE ? ESCAPE '\\' OR q.content LIKE ? ESCAPE '\\') LIMIT 8`, ...bp, ...cArg, like, like);
    const boards = await all(`SELECT b.id, b.title, b.description, w.name AS unit_name, c.code AS company_code FROM az_board b
                          JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id
                         WHERE b.id IN ${bSql} ${cFilter} AND (b.title LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\') LIMIT 8`, ...bp, ...cArg, like, like);
    const projects = await all(`SELECT p.id, p.doc_no, p.title, p.status, w.name AS unit_name, w.company_id FROM az_project p JOIN az_workspace w ON w.id = p.workspace_id
                           WHERE p.workspace_id IN ${wSql} ${cFilter} AND p.is_active = 1 AND (p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.doc_no LIKE ? ESCAPE '\\') LIMIT 8`, ...wp, ...cArg, like, like, like);
    const units = await all(`SELECT w.id, w.name, w.company_id, c.code AS company_code FROM az_workspace w JOIN az_company c ON c.id = w.company_id
                        WHERE w.id IN ${wSql} ${cFilter} AND w.name LIKE ? ESCAPE '\\' LIMIT 6`, ...wp, ...cArg, like);
    const companies = await all(`SELECT id, name, code FROM az_company WHERE id IN ${cSql} AND (name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\') LIMIT 6`, ...cp, like, like);
    const people = await all(`SELECT u.id, u.username, p.full_name, p.designation, p.color FROM users u JOIN profiles p ON p.id = u.id
                         WHERE u.is_active = 1 AND (u.username LIKE ? ESCAPE '\\' OR p.full_name LIKE ? ESCAPE '\\' OR p.designation LIKE ? ESCAPE '\\') LIMIT 8`, like, like, like);
    const msgRows = await all(`SELECT m.id, m.content, m.created_at, m.channel_id, m.parent_message_id, c.name AS channel_name, c.type AS channel_type, c.company_id,
                                c.workspace_id, c.is_private, c.created_by, p.full_name
                           FROM az_message m JOIN az_channel c ON c.id = m.channel_id LEFT JOIN profiles p ON p.id = m.user_id
                          WHERE m.deleted = 0 AND m.content LIKE ? ESCAPE '\\' ${cid ? 'AND c.company_id = ?' : ''}
                          ORDER BY m.created_at DESC LIMIT 60`, like, ...cArg);
    const chCache = new Map();
    const messages = (await filterAsync(msgRows, async (m) => {
      if (!chCache.has(m.channel_id)) chCache.set(m.channel_id, await canViewChannel(ctx.user, await get('SELECT * FROM az_channel WHERE id = ?', m.channel_id)));
      return chCache.get(m.channel_id);
    })).slice(0, 12);
    const channelRows = (await all(`SELECT * FROM az_channel WHERE is_active = 1 AND name LIKE ? ESCAPE '\\' AND type IN ('public','private','board_log') ${cid ? 'AND company_id = ?' : ''} LIMIT 20`, like, ...cArg));
    const channels = (await filterAsync(channelRows, (c) => canViewChannel(ctx.user, c))).slice(0, 6);
    const results = { cards, subtasks, requirements, boards, projects, units, companies, people, messages, channels };
    const total = Object.values(results).reduce((n, a) => n + a.length, 0);
    return { query: q, total, results };
  });

  // ---- notifications ----
  r.get('/api/notifications', async (ctx) => {
    const items = (await all(`SELECT n.*, p.full_name AS actor_name, p.color AS actor_color FROM az_notification n LEFT JOIN profiles p ON p.id = n.actor_id
                        WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 80`, ctx.user.id)).map((n) => ({ ...n, is_read: !!n.is_read }));
    const unread = (await get('SELECT COUNT(*) AS n FROM az_notification WHERE user_id = ? AND is_read = 0', ctx.user.id)).n;
    return { items, unread };
  });
  r.post('/api/notifications/read', async (ctx) => {
    if (Array.isArray(ctx.body.ids) && ctx.body.ids.length) {
      for (const id of ctx.body.ids) await run('UPDATE az_notification SET is_read = 1 WHERE id = ? AND user_id = ?', id, ctx.user.id);
    } else await run('UPDATE az_notification SET is_read = 1 WHERE user_id = ?', ctx.user.id);
    return { ok: true, at: now() };
  });
}
