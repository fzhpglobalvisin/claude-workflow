// Reporting service — management dashboard + a whitelisted, SQL-safe report builder.
import { get, all, run, insert, update, uuid, now, j } from '../db/index.js';
import { filterAsync } from '../lib/async.js';
import { bad, notFound, forbidden, str, toCSV } from '../lib/http.js';
import { requirePerm, visibleBoardIds, visibleCompanyIds, inList, canViewChannel, isAdmin, can } from '../lib/access.js';
import { audit } from '../lib/events.js';
import { retire } from '../lib/mdm.js';

const AGE = (col) => `julianday('now') - julianday(${col})`;
const AGE_BUCKET = (col) => `CASE WHEN ${AGE(col)} < 3 THEN '0–2 days' WHEN ${AGE(col)} < 7 THEN '3–6 days' WHEN ${AGE(col)} < 14 THEN '7–13 days' WHEN ${AGE(col)} < 30 THEN '14–29 days' ELSE '30+ days' END`;

// Every identifier that can reach SQL comes from these maps — user input only selects keys.
export const SOURCES = {
  tasks: {
    label: 'Tasks',
    from: `FROM az_card k JOIN az_list l ON l.id = k.list_id JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id
           JOIN az_company c ON c.id = w.company_id LEFT JOIN az_project pr ON pr.id = k.project_id LEFT JOIN profiles ap ON ap.id = k.assignee_id`,
    base: 'k.archived = 0', board: 'k.board_id', company: 'w.company_id', date: 'k.created_at',
    dims: {
      status: ['Status (list)', 'l.title'], state: ['Open / Done', "CASE WHEN l.is_done_list = 1 THEN 'Done' ELSE 'Open' END"],
      assignee: ['Assignee', "COALESCE(ap.full_name, 'Unassigned')"], priority: ['Priority', 'k.priority'], board: ['Board', 'b.title'],
      project: ['Project', "COALESCE(pr.title, 'No project')"], unit: ['Unit', 'w.name'], company: ['Company', 'c.code'],
      created_week: ['Created (week)', "strftime('%Y-W%W', k.created_at)"], created_month: ['Created (month)', 'substr(k.created_at, 1, 7)'],
      due_week: ['Due (week)', "COALESCE(strftime('%Y-W%W', k.due_date), 'No due date')"], age: ['Age bucket', AGE_BUCKET('k.created_at')],
    },
    metrics: {
      count: ['Tasks', 'COUNT(*)'], open: ['Open', 'SUM(CASE WHEN l.is_done_list = 0 THEN 1 ELSE 0 END)'],
      completed: ['Completed', 'SUM(CASE WHEN l.is_done_list = 1 THEN 1 ELSE 0 END)'],
      overdue: ['Overdue', "SUM(CASE WHEN l.is_done_list = 0 AND k.due_date < strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END)"],
      avg_age_days: ['Avg age (days)', `ROUND(AVG(CASE WHEN l.is_done_list = 0 THEN ${AGE('k.created_at')} END), 1)`],
      avg_cycle_days: ['Avg cycle time (days)', 'ROUND(AVG(CASE WHEN k.completed_at IS NOT NULL THEN julianday(k.completed_at) - julianday(k.created_at) END), 1)'],
      estimate_hours: ['Estimated hours', 'ROUND(COALESCE(SUM(k.estimate_hours), 0), 1)'],
      subtasks: ['Subtasks', 'SUM((SELECT COUNT(*) FROM az_subtask s WHERE s.card_id = k.id))'],
    },
    filters: { assignee_id: 'k.assignee_id', priority: 'k.priority', board_id: 'k.board_id', state: "CASE WHEN l.is_done_list = 1 THEN 'done' ELSE 'open' END" },
  },
  subtasks: {
    label: 'Subtasks',
    from: `FROM az_subtask s JOIN az_card k ON k.id = s.card_id JOIN az_board b ON b.id = k.board_id JOIN az_workspace w ON w.id = b.workspace_id
           JOIN az_company c ON c.id = w.company_id LEFT JOIN profiles ap ON ap.id = COALESCE(s.assignee_id, k.assignee_id)`,
    base: 'k.archived = 0', board: 'k.board_id', company: 'w.company_id', date: 's.created_at',
    dims: {
      task: ['Parent task', 'k.title'], state: ['Open / Done', "CASE WHEN s.is_done = 1 THEN 'Done' ELSE 'Open' END"],
      assignee: ['Assignee', "COALESCE(ap.full_name, 'Unassigned')"], board: ['Board', 'b.title'], company: ['Company', 'c.code'],
      origin: ['Origin', "CASE WHEN s.is_ai_generated = 1 THEN 'AI crew' ELSE 'Human' END"], created_week: ['Created (week)', "strftime('%Y-W%W', s.created_at)"],
    },
    metrics: {
      count: ['Subtasks', 'COUNT(*)'], completed: ['Completed', 'SUM(s.is_done)'], open: ['Open', 'SUM(1 - s.is_done)'],
      completion_pct: ['Completion %', 'ROUND(100.0 * SUM(s.is_done) / COUNT(*), 1)'], ai_generated: ['AI-generated', 'SUM(s.is_ai_generated)'],
    },
    filters: { assignee_id: 's.assignee_id', board_id: 'k.board_id', state: "CASE WHEN s.is_done = 1 THEN 'done' ELSE 'open' END" },
  },
  messages: {
    label: 'Chat messages',
    from: 'FROM az_message m JOIN az_channel ch ON ch.id = m.channel_id LEFT JOIN profiles p ON p.id = m.user_id LEFT JOIN az_company c ON c.id = ch.company_id',
    base: 'm.deleted = 0', channel: 'm.channel_id', company: 'ch.company_id', date: 'm.created_at',
    dims: {
      channel: ['Channel', "CASE WHEN ch.type = 'dm' THEN 'Direct messages' ELSE '#' || ch.name END"], user: ['Author', "COALESCE(p.full_name, 'AI / System')"],
      type: ['Message type', 'm.type'], day: ['Day', 'substr(m.created_at, 1, 10)'], week: ['Week', "strftime('%Y-W%W', m.created_at)"],
      company: ['Company', "COALESCE(c.code, '—')"], hour: ['Hour of day', "strftime('%H:00', m.created_at)"],
    },
    metrics: {
      count: ['Messages', 'COUNT(*)'], threads: ['Thread replies', 'SUM(CASE WHEN m.parent_message_id IS NOT NULL THEN 1 ELSE 0 END)'],
      ai: ['AI messages', 'SUM(m.is_ai_generated)'], people: ['Active people', 'COUNT(DISTINCT m.user_id)'],
      mentions: ['Mentions', 'SUM((SELECT COUNT(*) FROM az_mention x WHERE x.message_id = m.id))'],
    },
    filters: {},
  },
  activity: {
    label: 'Audit / activity log',
    from: 'FROM az_activity_log a LEFT JOIN profiles p ON p.id = a.actor_id LEFT JOIN az_company c ON c.id = a.company_id',
    base: '1 = 1', company: 'a.company_id', date: 'a.created_at', needs: 'audit.view',
    dims: {
      type: ['Event type', 'a.type'], area: ['Area', "substr(a.type, 1, instr(a.type || '.', '.') - 1)"], actor: ['Actor', "COALESCE(p.full_name, 'System / AI')"],
      day: ['Day', 'substr(a.created_at, 1, 10)'], week: ['Week', "strftime('%Y-W%W', a.created_at)"], company: ['Company', "COALESCE(c.code, 'Global')"],
    },
    metrics: { count: ['Events', 'COUNT(*)'], actors: ['Distinct actors', 'COUNT(DISTINCT a.actor_id)'] },
    filters: {},
  },
  alerts: {
    label: 'Alerts & incidents',
    from: 'FROM az_alert al LEFT JOIN az_pipeline pl ON pl.id = al.pipeline_id LEFT JOIN az_company c ON c.id = al.company_id',
    base: '1 = 1', company: 'al.company_id', date: 'al.created_at', needs: 'ops.view',
    dims: {
      severity: ['Severity', 'al.severity'], status: ['Status', 'al.status'], source: ['Source', "COALESCE(pl.name, al.source, '—')"],
      day: ['Day', 'substr(al.created_at, 1, 10)'], week: ['Week', "strftime('%Y-W%W', al.created_at)"], company: ['Company', "COALESCE(c.code, '—')"],
    },
    metrics: {
      count: ['Alerts', 'COUNT(*)'], open: ['Open', "SUM(CASE WHEN al.status <> 'resolved' THEN 1 ELSE 0 END)"],
      with_incident: ['Incident tasks filed', 'SUM(CASE WHEN al.card_id IS NOT NULL THEN 1 ELSE 0 END)'],
      mttr_hours: ['MTTR (hours)', 'ROUND(AVG(CASE WHEN al.resolved_at IS NOT NULL THEN (julianday(al.resolved_at) - julianday(al.created_at)) * 24 END), 2)'],
    },
    filters: {},
  },
};

export async function runReport(user, cfg) {
  const src = SOURCES[cfg.source];
  if (!src) throw bad('Unknown data source');
  if (src.needs && !can(user, src.needs)) throw forbidden(`Your role cannot report on ${src.label.toLowerCase()}`);
  const dimKey = src.dims[cfg.dimension] ? cfg.dimension : Object.keys(src.dims)[0];
  const metricKeys = (Array.isArray(cfg.metrics) && cfg.metrics.length ? cfg.metrics : ['count']).filter((m) => src.metrics[m]).slice(0, 4);
  if (!metricKeys.length) metricKeys.push('count');
  const where = [src.base]; const params = [];
  // tenant scoping
  if (src.board) { const [s, p] = inList(await visibleBoardIds(user)); where.push(`${src.board} IN ${s}`); params.push(...p); }
  if (src.channel) {
    const ids = (await filterAsync(await all('SELECT * FROM az_channel'), (c) => canViewChannel(user, c))).map((c) => c.id);
    const [s, p] = inList(ids); where.push(`${src.channel} IN ${s}`); params.push(...p);
  }
  if (!src.board && !src.channel && !isAdmin(user)) {
    const [s, p] = inList(await visibleCompanyIds(user)); where.push(`(${src.company} IN ${s} OR ${src.company} IS NULL)`); params.push(...p);
  }
  const f = cfg.filters || {};
  if (f.company_id) { where.push(`${src.company} = ?`); params.push(f.company_id); }
  if (f.from) { where.push(`${src.date} >= ?`); params.push(new Date(f.from).toISOString()); }
  if (f.to) { where.push(`${src.date} <= ?`); params.push(new Date(new Date(f.to).getTime() + 864e5 - 1).toISOString()); }
  for (const [k, col] of Object.entries(src.filters)) if (f[k]) { where.push(`${col} = ?`); params.push(f[k]); }
  const dimSql = src.dims[dimKey][1];
  const select = metricKeys.map((m) => `${src.metrics[m][1]} AS "${m}"`).join(', ');
  const order = cfg.sort === 'label' || /week|month|day|hour/.test(dimKey) ? 'label ASC' : `"${metricKeys[0]}" DESC`;
  const limit = Math.min(200, Math.max(1, Number(cfg.limit) || 50));
  const sql = `SELECT ${dimSql} AS label, ${select} ${src.from} WHERE ${where.join(' AND ')} GROUP BY label ORDER BY ${order} LIMIT ${limit}`;
  const rows = (await all(sql, ...params)).map((r) => { for (const m of metricKeys) r[m] = r[m] == null ? 0 : Number(r[m]); return r; });
  return {
    source: cfg.source, dimension: dimKey, metrics: metricKeys,
    columns: [{ key: 'label', label: src.dims[dimKey][0] }, ...metricKeys.map((m) => ({ key: m, label: src.metrics[m][0] }))],
    rows, generated_at: now(),
  };
}

export function register(r) {
  r.get('/api/reports/catalog', () => Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, {
    label: s.label, needs: s.needs || null,
    dimensions: Object.fromEntries(Object.entries(s.dims).map(([dk, d]) => [dk, d[0]])),
    metrics: Object.fromEntries(Object.entries(s.metrics).map(([mk, m]) => [mk, m[0]])),
    filters: Object.keys(s.filters),
  }])));

  r.post('/api/reports/run', async (ctx) => {
    requirePerm(ctx.user, 'report.view');
    const result = await runReport(ctx.user, ctx.body.config || ctx.body);
    if (ctx.query.format === 'csv') {
      const csv = toCSV(result.rows.map((row) => Object.fromEntries(result.columns.map((c) => [c.label, row[c.key]]))));
      ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.csv"' });
      ctx.res.end(csv);
      return;
    }
    return result;
  });

  r.get('/api/reports', async (ctx) => (await all(`SELECT r.*, p.full_name AS author FROM az_report r LEFT JOIN profiles p ON p.id = r.created_by
                                     WHERE (r.is_shared = 1 OR r.created_by = ?) AND r.is_active = 1 ORDER BY r.updated_at DESC`, ctx.user.id)).map((x) => ({ ...x, config: j(x.config, {}), is_shared: !!x.is_shared })));
  r.post('/api/reports', async (ctx) => {
    requirePerm(ctx.user, 'report.build');
    const cfg = ctx.body.config || {};
    await runReport(ctx.user, cfg); // validate
    const rep = await insert('az_report', { id: uuid(), name: str(ctx.body.name, 'Report name', { max: 120 }), description: ctx.body.description || null, config: cfg, company_id: cfg.filters?.company_id || null, is_shared: ctx.body.is_shared === false ? 0 : 1, created_by: ctx.user.id, created_at: now(), updated_at: now() });
    await audit({ actor: ctx.user, type: 'report.saved', entityType: 'report', entityId: rep.id, details: { name: rep.name }, ip: ctx.ip });
    return { ...rep, config: cfg };
  });
  r.patch('/api/reports/:id', async (ctx) => {
    requirePerm(ctx.user, 'report.build');
    const rep = await get('SELECT * FROM az_report WHERE id = ?', ctx.params.id);
    if (!rep) throw notFound('Report not found');
    if (rep.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('Only the author can edit this report');
    const patch = { updated_at: now() };
    if (ctx.body.name) patch.name = str(ctx.body.name, 'Report name', { max: 120 });
    if (ctx.body.description !== undefined) patch.description = ctx.body.description;
    if (ctx.body.config) { await runReport(ctx.user, ctx.body.config); patch.config = ctx.body.config; }
    if (ctx.body.is_shared !== undefined) patch.is_shared = ctx.body.is_shared ? 1 : 0;
    await update('az_report', rep.id, patch);
    return { ...await get('SELECT * FROM az_report WHERE id = ?', rep.id), config: j((await get('SELECT config FROM az_report WHERE id = ?', rep.id)).config) };
  });
  r.delete('/api/reports/:id', async (ctx) => {
    const rep = await get('SELECT * FROM az_report WHERE id = ?', ctx.params.id);
    if (!rep) throw notFound('Report not found');
    if (rep.created_by !== ctx.user.id && !isAdmin(ctx.user)) throw forbidden('Only the author can retire this report');
    await retire('report', rep.id, { reason: ctx.query.reason }); // kept (with its versions) — never physically deleted
    await audit({ actor: ctx.user, type: 'report.retired', entityType: 'report', entityId: rep.id, details: { name: rep.name, reason: ctx.query.reason || null }, ip: ctx.ip });
    return { ok: true };
  });

  // --------------- Management dashboard ---------------
  r.get('/api/dashboard', async (ctx) => {
    requirePerm(ctx.user, 'report.view');
    const cid = ctx.query.company_id || null;
    let boards = await visibleBoardIds(ctx.user);
    if (cid) boards = (await all(`SELECT b.id FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = ?`, cid)).map((x) => x.id).filter((id) => boards.includes(id));
    const [bSql, bp] = inList(boards);
    const T = `FROM az_card k JOIN az_list l ON l.id = k.list_id WHERE k.board_id IN ${bSql} AND k.archived = 0`;
    const nowIso = now();
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const kpi = await get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN l.is_done_list = 0 THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN l.is_done_list = 0 AND k.due_date < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN k.completed_at >= ? THEN 1 ELSE 0 END) AS completed_week,
        SUM(CASE WHEN k.created_at >= ? THEN 1 ELSE 0 END) AS created_week,
        ROUND(AVG(CASE WHEN k.completed_at IS NOT NULL THEN julianday(k.completed_at) - julianday(k.created_at) END), 1) AS cycle_days,
        SUM(CASE WHEN l.is_done_list = 0 AND ${AGE('k.updated_at')} > 14 THEN 1 ELSE 0 END) AS stale
      ${T}`, nowIso, weekAgo, weekAgo, ...bp);
    for (const k of Object.keys(kpi)) kpi[k] = kpi[k] ?? 0;
    const byStatus = await all(`SELECT CASE WHEN l.is_done_list = 1 THEN 'Done' WHEN l.position = 0 THEN 'To do / backlog' ELSE 'In progress / review' END AS label,
        COUNT(*) AS value ${T} GROUP BY label`, ...bp);
    const stOrder = ['To do / backlog', 'In progress / review', 'Done'];
    byStatus.sort((a, b) => stOrder.indexOf(a.label) - stOrder.indexOf(b.label));
    const byPriority = await all(`SELECT k.priority AS label, COUNT(*) AS value ${T} AND l.is_done_list = 0 GROUP BY k.priority`, ...bp);
    const workload = await all(`SELECT COALESCE(p.full_name, 'Unassigned') AS label, COUNT(*) AS open,
        SUM(CASE WHEN k.due_date < ? THEN 1 ELSE 0 END) AS overdue
        FROM az_card k JOIN az_list l ON l.id = k.list_id LEFT JOIN profiles p ON p.id = k.assignee_id
        WHERE k.board_id IN ${bSql} AND k.archived = 0 AND l.is_done_list = 0 GROUP BY label ORDER BY open DESC LIMIT 10`, nowIso, ...bp);
    const aging = await all(`SELECT ${AGE_BUCKET('k.created_at')} AS label, COUNT(*) AS value ${T} AND l.is_done_list = 0 GROUP BY label`, ...bp);
    const order = ['0–2 days', '3–6 days', '7–13 days', '14–29 days', '30+ days'];
    aging.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    const days = [...Array(30)].map((_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10));
    const created = Object.fromEntries((await all(`SELECT substr(k.created_at,1,10) AS d, COUNT(*) AS n FROM az_card k WHERE k.board_id IN ${bSql} AND k.created_at >= ? GROUP BY d`, ...bp, days[0])).map((x) => [x.d, x.n]));
    const completed = Object.fromEntries((await all(`SELECT substr(k.completed_at,1,10) AS d, COUNT(*) AS n FROM az_card k WHERE k.board_id IN ${bSql} AND k.completed_at >= ? GROUP BY d`, ...bp, days[0])).map((x) => [x.d, x.n]));
    const trend = days.map((d) => ({ label: d.slice(5), created: created[d] || 0, completed: completed[d] || 0 }));
    const boardsHealth = await all(`SELECT b.id, b.title, COUNT(k.id) AS total,
        SUM(CASE WHEN l.is_done_list = 1 THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN l.is_done_list = 0 AND k.due_date < ? THEN 1 ELSE 0 END) AS overdue
        FROM az_board b LEFT JOIN az_card k ON k.board_id = b.id AND k.archived = 0 LEFT JOIN az_list l ON l.id = k.list_id
        WHERE b.id IN ${bSql} GROUP BY b.id ORDER BY total DESC LIMIT 12`, nowIso, ...bp);
    const [cSql, cp] = inList(cid ? [cid] : await visibleCompanyIds(ctx.user));
    const alerts = can(ctx.user, 'ops.view') ? await get(`SELECT COUNT(*) AS open, SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical FROM az_alert WHERE status <> 'resolved' AND (company_id IN ${cSql} OR company_id IS NULL)`, ...cp) : { open: 0, critical: 0 };
    const messagesToday = (await get(`SELECT COUNT(*) AS n FROM az_message m JOIN az_channel c ON c.id = m.channel_id WHERE m.created_at >= ? AND (c.company_id IN ${cSql})`, new Date(Date.now() - 864e5).toISOString(), ...cp)).n;
    const aiRuns = (await get(`SELECT COUNT(*) AS n FROM az_ai_run WHERE created_at >= ?`, weekAgo)).n;
    const activity = (await all(`SELECT a.id, a.type, a.details, a.created_at, a.entity_id, a.board_id, p.full_name AS actor_name, p.color AS actor_color
        FROM az_activity_log a LEFT JOIN profiles p ON p.id = a.actor_id
       WHERE a.board_id IN ${bSql} ORDER BY a.created_at DESC LIMIT 15`, ...bp)).map((a) => ({ ...a, details: j(a.details) }));
    const oldest = await all(`SELECT k.id, k.title, k.board_id, k.created_at, k.updated_at, k.due_date, k.priority, p.full_name AS assignee_name, l.title AS list_title
        ${T.replace('WHERE', 'LEFT JOIN profiles p ON p.id = k.assignee_id WHERE')} AND l.is_done_list = 0 ORDER BY k.created_at LIMIT 8`, ...bp);
    return { kpi: { ...kpi, open_alerts: alerts.open || 0, critical_alerts: alerts.critical || 0, messages_today: messagesToday, ai_runs_week: aiRuns },
      byStatus, byPriority, workload, aging, trend, boardsHealth, activity, oldest };
  });
}
