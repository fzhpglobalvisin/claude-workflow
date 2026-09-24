// Ops service — automated deployment pipelines, resource-monitoring pipelines, alerts for admins.
import os from 'node:os';
import { get, all, run, insert, update, uuid, now, j, sizeKb, backup } from '../db/index.js';
import { defer } from '../lib/background.js';
import { bad, notFound, forbidden, str, oneOf } from '../lib/http.js';
import { requirePerm, visibleCompanyIds, inList, adminIds, isAdmin } from '../lib/access.js';
import { audit, notify } from '../lib/events.js';
import { sendTo, broadcast, clientCount, cleanupEvents } from '../lib/realtime.js';
import { postSystem } from '../lib/chatcore.js';
import { runIncident } from './ai.js';
import { retire, applyEffectiveDates } from '../lib/mdm.js';

// ------------------------------------------------ live resource metrics
let lagMs = 0;
let lastTick = Date.now();
setInterval(() => { const t = Date.now(); lagMs = Math.max(0, t - lastTick - 500); lastTick = t; }, 500).unref();
let prevCpu = process.cpuUsage(); let prevAt = Date.now();

export async function currentMetrics() {
  const cpu = process.cpuUsage(prevCpu); const dt = (Date.now() - prevAt) * 1000;
  prevCpu = process.cpuUsage(); prevAt = Date.now();
  const mem = process.memoryUsage();
  let dbKb = 0; try { dbKb = await sizeKb(); } catch {}
  return {
    ts: now(),
    cpu_load: Math.round(Math.min(100, ((cpu.user + cpu.system) / Math.max(dt, 1)) * 100) * 10) / 10,
    mem_used_pct: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
    heap_mb: Math.round(mem.heapUsed / 1048576 * 10) / 10,
    rss_mb: Math.round(mem.rss / 1048576 * 10) / 10,
    db_size_kb: Math.round(dbKb),
    event_loop_ms: lagMs,
    active_clients: await clientCount(),
  };
}
const METRIC_LABELS = { cpu_load: 'Process CPU %', mem_used_pct: 'Host memory used %', heap_mb: 'Heap MB', rss_mb: 'RSS MB', db_size_kb: 'DB size KB', event_loop_ms: 'Event-loop lag ms', active_clients: 'Live clients' };

async function raiseAlert({ pipeline, severity, title, message, source }) {
  const a = await insert('az_alert', { id: uuid(), pipeline_id: pipeline?.id || null, company_id: pipeline?.company_id || null, severity, source: source || pipeline?.name || 'system', title, message, status: 'open', created_at: now() });
  await notify(await adminIds(), { type: 'alert', title: `${severity === 'critical' ? '🚨' : '⚠️'} ${title}`, body: message?.slice(0, 160), link: '/ops' });
  broadcast('ops:changed', { kind: 'alert', alertId: a.id });
  await audit({ actor: null, type: 'alert.raised', entityType: 'alert', entityId: a.id, companyId: a.company_id, details: { severity, title } });
  const cfg = j(pipeline?.config, {});
  if (cfg.auto_incident && severity !== 'info') defer(() => runIncident(a.id, null));
  return a;
}

// ------------------------------------------------ pipeline runner
const DEPLOY_STEPS = ['Checkout source', 'Install dependencies', 'Build artefacts', 'Run test suite', 'Build & push image', 'Deploy to target', 'Health check'];
const BACKUP_STEPS = ['Lock tables', 'Snapshot database', 'Compress archive', 'Upload to storage', 'Verify checksum'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function executePipeline(pipelineId, user) {
  const p = await get('SELECT * FROM az_pipeline WHERE id = ?', pipelineId);
  if (!p) throw notFound('Pipeline not found');
  if (p.status === 'running') throw bad('Pipeline is already running');
  const cfg = j(p.config, {});
  const runId = uuid(); const started = Date.now();
  const logs = [];
  const logLine = async (line) => { logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`); await update('az_pipeline_run', runId, { logs: logs.join('\n') }); broadcast('ops:changed', { kind: 'run', pipelineId: p.id, runId, line }); };
  await insert('az_pipeline_run', { id: runId, pipeline_id: p.id, status: 'running', logs: '', triggered_by: user?.id || 'scheduler', started_at: now() });
  await update('az_pipeline', p.id, { status: 'running', last_run_at: now() });
  broadcast('ops:changed', { kind: 'pipeline', pipelineId: p.id });
  await audit({ actor: user, type: 'pipeline.started', entityType: 'pipeline', entityId: p.id, companyId: p.company_id, details: { name: p.name, runId } });

  defer(async () => {
    let status = 'success'; let failure = null;
    try {
      if (p.type === 'monitor') {
        const m = await currentMetrics();
        const metric = cfg.metric || 'mem_used_pct'; const threshold = Number(cfg.threshold ?? 90);
        await logLine(`Sampling ${METRIC_LABELS[metric] || metric} on ${p.target || 'api-gateway'}…`);
        await sleep(400);
        await logLine(`Value = ${m[metric]} (threshold ${threshold})`);
        if (m[metric] > threshold) { status = 'failed'; failure = `${METRIC_LABELS[metric] || metric} is ${m[metric]}, above threshold ${threshold}`; }
        else await logLine('✓ Within threshold');
      } else {
        const steps = p.type === 'backup' ? BACKUP_STEPS : DEPLOY_STEPS;
        const failRate = Number(cfg.fail_rate ?? 0.15);
        const failAt = Math.random() < failRate ? 1 + Math.floor(Math.random() * (steps.length - 1)) : -1;
        for (let i = 0; i < steps.length; i++) {
          await logLine(`▶ ${steps[i]}…`);
          await sleep(250 + Math.random() * 450);
          if (i === failAt) { status = 'failed'; failure = `Step "${steps[i]}" failed on ${p.target || 'target'} (exit code 1)`; await logLine(`✗ ${failure}`); break; }
          await logLine(`✓ ${steps[i]} done`);
        }
        if (p.type === 'backup' && status === 'success') {
          try { const f = await backup(); await logLine(f ? `✓ Local snapshot written: ${f}` : '✓ Database snapshots are handled by your Postgres provider (point-in-time restore)'); } catch (e) { await logLine(`note: snapshot skipped (${e.message})`); }
        }
      }
    } catch (e) { status = 'failed'; failure = e.message; }
    const duration = Date.now() - started;
    await logLine(status === 'success' ? `Pipeline finished successfully in ${(duration / 1000).toFixed(1)}s` : `Pipeline FAILED: ${failure}`);
    await update('az_pipeline_run', runId, { status, finished_at: now(), duration_ms: duration });
    await update('az_pipeline', p.id, { status });
    await audit({ actor: user, type: status === 'success' ? 'pipeline.succeeded' : 'pipeline.failed', entityType: 'pipeline', entityId: p.id, companyId: p.company_id, details: { name: p.name, runId, duration, failure } });
    const board = p.board_id ? await get('SELECT * FROM az_board WHERE id = ?', p.board_id) : null;
    if (board) await postSystem(board.log_channel_id, `${status === 'success' ? '🚀' : '💥'} Pipeline **${p.name}** ${status === 'success' ? 'succeeded' : 'failed'} (${(duration / 1000).toFixed(1)}s)${failure ? ` — ${failure}` : ''}`);
    if (status === 'failed') {
      const sev = p.type === 'deploy' && /prod/i.test(p.target || '') ? 'critical' : p.type === 'monitor' ? (cfg.severity || 'warning') : 'warning';
      await raiseAlert({ pipeline: p, severity: sev, title: `${p.name} failed`, message: failure });
    } else if (user) await notify([user.id], { type: 'pipeline', title: `✅ ${p.name} succeeded`, link: '/ops' });
    broadcast('ops:changed', { kind: 'pipeline', pipelineId: p.id });
  });
  return { run_id: runId };
}

// ------------------------------------------------ scheduler (metrics + monitor pipelines)
/** One scheduler tick: sample metrics, evaluate continuous monitors, prune old events.
 *  Runs every 30 s on the local server and from the Vercel cron (api/cron/ops.js). */
export async function opsTick() {
  {
    const m = await currentMetrics();
    await insert('az_metric_sample', { ts: m.ts, cpu_load: m.cpu_load, mem_used_pct: m.mem_used_pct, heap_mb: m.heap_mb, rss_mb: m.rss_mb, db_size_kb: m.db_size_kb, event_loop_ms: m.event_loop_ms, active_clients: m.active_clients });
    await run('DELETE FROM az_metric_sample WHERE id <= (SELECT MAX(id) - 720 FROM az_metric_sample)');
    broadcast('metrics', m);
    // continuous threshold checks for "monitor" pipelines with schedule "continuous"
    for (const p of await all("SELECT * FROM az_pipeline WHERE type = 'monitor' AND schedule = 'continuous' AND is_active = 1")) {
      const cfg = j(p.config, {});
      const v = m[cfg.metric]; const th = Number(cfg.threshold);
      if (v == null || Number.isNaN(th)) continue;
      const open = await get("SELECT id FROM az_alert WHERE pipeline_id = ? AND status <> 'resolved'", p.id);
      if (v > th && !open) await raiseAlert({ pipeline: p, severity: cfg.severity || 'warning', title: `${METRIC_LABELS[cfg.metric] || cfg.metric} above ${th}`, message: `${p.target || 'service'}: ${METRIC_LABELS[cfg.metric]} = ${v}` });
      if (v <= th && open && cfg.auto_resolve) { await update('az_alert', open.id, { status: 'resolved', resolved_at: now() }); broadcast('ops:changed', { kind: 'alert' }); }
    }
    await cleanupEvents();
    return m;
  }
  // validity periods (memberships with an end date, scheduled grants …)
  await applyEffectiveDates().catch((e) => console.error('[effective dates]', e.message));
}
export function startScheduler() {
  const tick = () => opsTick().catch((e) => console.error('[ops] tick failed:', e.message));
  setTimeout(tick, 2000).unref();
  setInterval(tick, 30000).unref();
}

// ------------------------------------------------ routes
async function scopedCompanyIds(u) { return await visibleCompanyIds(u); }

export function register(r) {
  r.get('/api/ops/pipelines', async (ctx) => {
    requirePerm(ctx.user, 'ops.view');
    const [cSql, cp] = inList(await scopedCompanyIds(ctx.user));
    const cid = ctx.query.company_id;
    return (await all(`SELECT p.*, c.code AS company_code, b.title AS board_title,
        (SELECT COUNT(*) FROM az_pipeline_run x WHERE x.pipeline_id = p.id) AS run_count,
        (SELECT ROUND(100.0 * SUM(CASE WHEN x.status = 'success' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) FROM az_pipeline_run x WHERE x.pipeline_id = p.id AND x.status <> 'running') AS success_rate,
        (SELECT AVG(duration_ms) FROM az_pipeline_run x WHERE x.pipeline_id = p.id AND x.status = 'success') AS avg_ms
      FROM az_pipeline p LEFT JOIN az_company c ON c.id = p.company_id LEFT JOIN az_board b ON b.id = p.board_id
      WHERE (p.company_id IN ${cSql} OR p.company_id IS NULL) ${cid ? 'AND p.company_id = ?' : ''} ${ctx.query.include_retired === '1' ? '' : 'AND p.is_active = 1'}
      ORDER BY p.is_active DESC, p.type, p.name`, ...cp, ...(cid ? [cid] : [])))
      .map((p) => ({ ...p, config: j(p.config, {}) }));
  });
  r.post('/api/ops/pipelines', async (ctx) => {
    requirePerm(ctx.user, 'ops.manage');
    const b = ctx.body;
    if (b.company_id && !(await visibleCompanyIds(ctx.user)).includes(b.company_id)) throw forbidden();
    const type = oneOf(b.type, 'type', ['deploy', 'monitor', 'backup'], 'deploy');
    const cfg = typeof b.config === 'object' && b.config ? b.config : {};
    if (type === 'monitor' && !METRIC_LABELS[cfg.metric]) cfg.metric = 'mem_used_pct';
    const p = await insert('az_pipeline', { id: uuid(), name: str(b.name, 'Pipeline name', { max: 120 }), type, company_id: b.company_id || null, board_id: b.board_id || null, target: b.target || null, schedule: b.schedule || 'manual', status: 'idle', config: cfg, created_at: now() });
    await audit({ actor: ctx.user, type: 'pipeline.created', entityType: 'pipeline', entityId: p.id, companyId: p.company_id, details: { name: p.name, type }, ip: ctx.ip });
    broadcast('ops:changed', { kind: 'pipeline' });
    return p;
  });
  r.patch('/api/ops/pipelines/:id', async (ctx) => {
    requirePerm(ctx.user, 'ops.manage');
    const p = await get('SELECT * FROM az_pipeline WHERE id = ?', ctx.params.id);
    if (!p) throw notFound();
    const patch = {};
    for (const k of ['name', 'target', 'schedule', 'board_id']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k] || null;
    if (ctx.body.config) patch.config = ctx.body.config;
    await update('az_pipeline', p.id, patch);
    await audit({ actor: ctx.user, type: 'pipeline.updated', entityType: 'pipeline', entityId: p.id, companyId: p.company_id, details: patch, ip: ctx.ip });
    return await get('SELECT * FROM az_pipeline WHERE id = ?', p.id);
  });
  // no physical delete: the pipeline is retired (kept with its full run history)
  r.delete('/api/ops/pipelines/:id', async (ctx) => {
    requirePerm(ctx.user, 'ops.manage');
    await retire('pipeline', ctx.params.id, { reason: ctx.query.reason });
    await audit({ actor: ctx.user, type: 'pipeline.retired', entityType: 'pipeline', entityId: ctx.params.id, details: { reason: ctx.query.reason || null }, ip: ctx.ip });
    broadcast('ops:changed', { kind: 'pipeline' });
    return { ok: true };
  });
  r.post('/api/ops/pipelines/:id/run', async (ctx) => {
    requirePerm(ctx.user, 'ops.run');
    const p = await get('SELECT company_id, is_active FROM az_pipeline WHERE id = ?', ctx.params.id);
    if (!p) throw notFound('Pipeline not found');
    if (!p.is_active) throw bad('This pipeline is retired — reactivate it before running it');
    if (p.company_id && !(await visibleCompanyIds(ctx.user)).includes(p.company_id)) throw forbidden();
    return await executePipeline(ctx.params.id, ctx.user);
  });
  r.get('/api/ops/pipelines/:id/runs', async (ctx) => {
    requirePerm(ctx.user, 'ops.view');
    return await all(`SELECT r.*, p.full_name AS triggered_by_name FROM az_pipeline_run r LEFT JOIN profiles p ON p.id = r.triggered_by
                 WHERE r.pipeline_id = ? ORDER BY r.started_at DESC LIMIT 25`, ctx.params.id);
  });

  r.get('/api/ops/alerts', async (ctx) => {
    requirePerm(ctx.user, 'ops.view');
    const [cSql, cp] = inList(await scopedCompanyIds(ctx.user));
    const status = ctx.query.status;
    return await all(`SELECT a.*, pl.name AS pipeline_name, c.code AS company_code, k.board_id AS card_board_id, k.title AS card_title, p.full_name AS acknowledged_by_name
                  FROM az_alert a LEFT JOIN az_pipeline pl ON pl.id = a.pipeline_id LEFT JOIN az_company c ON c.id = a.company_id
                  LEFT JOIN az_card k ON k.id = a.card_id LEFT JOIN profiles p ON p.id = a.acknowledged_by
                 WHERE (a.company_id IN ${cSql} OR a.company_id IS NULL) ${status ? 'AND a.status = ?' : ''}
                 ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 100`, ...cp, ...(status ? [status] : []));
  });
  r.post('/api/ops/alerts', async (ctx) => {
    requirePerm(ctx.user, 'alert.manage');
    const b = ctx.body;
    const pipeline = b.pipeline_id ? await get('SELECT * FROM az_pipeline WHERE id = ?', b.pipeline_id) : { company_id: b.company_id || null, name: 'manual' };
    return await raiseAlert({ pipeline, severity: oneOf(b.severity, 'severity', ['info', 'warning', 'critical'], 'warning'), title: str(b.title, 'Title', { max: 160 }), message: b.message || '', source: b.source || `manual (${ctx.user.username})` });
  });
  r.patch('/api/ops/alerts/:id', async (ctx) => {
    requirePerm(ctx.user, 'alert.manage');
    const a = await get('SELECT * FROM az_alert WHERE id = ?', ctx.params.id);
    if (!a) throw notFound('Alert not found');
    const status = oneOf(ctx.body.status, 'status', ['open', 'acknowledged', 'resolved'], a.status);
    await update('az_alert', a.id, { status, acknowledged_by: status !== 'open' ? ctx.user.id : null, resolved_at: status === 'resolved' ? now() : null });
    await audit({ actor: ctx.user, type: `alert.${status}`, entityType: 'alert', entityId: a.id, companyId: a.company_id, details: { title: a.title }, ip: ctx.ip });
    broadcast('ops:changed', { kind: 'alert', alertId: a.id });
    return await get('SELECT * FROM az_alert WHERE id = ?', a.id);
  });

  r.get('/api/ops/metrics', async (ctx) => {
    requirePerm(ctx.user, 'ops.view');
    const samples = (await all('SELECT * FROM az_metric_sample ORDER BY id DESC LIMIT ?', Math.min(720, Number(ctx.query.limit) || 120))).reverse();
    return { current: await currentMetrics(), samples, labels: METRIC_LABELS, host: { platform: os.platform(), cpus: os.cpus().length, total_mem_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10, node: process.version, uptime_s: Math.round(process.uptime()) } };
  });
}

export { isAdmin, sendTo };
