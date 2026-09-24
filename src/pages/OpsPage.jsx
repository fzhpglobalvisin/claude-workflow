// Pipelines & alerts — deployment/monitoring pipelines, live resource metrics, alert triage, AI incident filing.
import { useEffect, useState } from 'react';
import { GET, POST, PATCH, DEL } from '../lib/api.js';
import { subscribe } from '../lib/realtime.js';
import { useApp, useData } from '../lib/store.jsx';
import { Link } from '../lib/router.jsx';
import { Spinner, ErrorBox, Modal, Field, TimeAgo, AgeChip, Pill, useConfirm, Empty } from '../components/ui.jsx';
import { LineChart, Sparkline } from '../components/Charts.jsx';
import { cls } from '../lib/format.js';
import { IServer, IPlay, IPlus, IAlert, IOk, IFlame, IRocket, ICpu, IGauge, IDatabase, IArchive, IBoard, IRefresh } from '../components/icons.js';

const STATUS_TONE = { success: 'ok', failed: 'bad', running: 'info', idle: 'default' };
const SEV_TONE = { critical: 'bad', warning: 'warn', info: 'info' };

export default function OpsPage() {
  const { can, toast } = useApp();
  const { data: pipelines, reload: reloadP, setData: setPipelines } = useData(() => GET('/api/ops/pipelines'), []);
  const { data: alerts, reload: reloadA } = useData(() => GET('/api/ops/alerts'), []);
  const { data: metrics, error, setData: setMetrics } = useData(() => GET('/api/ops/metrics?limit=120'), []);
  const [logs, setLogs] = useState({}); // pipelineId -> {runId, lines}
  const [openRuns, setOpenRuns] = useState(null);
  const [create, setCreate] = useState(false);
  const [alertForm, setAlertForm] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  useEffect(() => {
    const offs = [
      subscribe('ops:changed', (e) => {
        if (e.kind === 'run' && e.line) setLogs((l) => ({ ...l, [e.pipelineId]: { runId: e.runId, lines: [...(l[e.pipelineId]?.runId === e.runId ? l[e.pipelineId].lines : []), e.line] } }));
        if (e.kind === 'pipeline') reloadP();
        if (e.kind === 'alert') reloadA();
      }),
      subscribe('metrics', (m) => setMetrics((d) => d && { ...d, current: m, samples: [...d.samples.slice(-119), m] })),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  const runPipeline = async (p) => {
    setPipelines((l) => l.map((x) => (x.id === p.id ? { ...x, status: 'running' } : x)));
    setLogs((l) => ({ ...l, [p.id]: { runId: null, lines: [] } }));
    try { await POST(`/api/ops/pipelines/${p.id}/run`, {}, { queue: false }); } catch (e) { toast(e.message, 'error'); reloadP(); }
  };
  const setAlert = async (a, status) => { try { await PATCH(`/api/ops/alerts/${a.id}`, { status }, { queue: false }); reloadA(); } catch (e) { toast(e.message, 'error'); } };
  const incident = async (a) => {
    try { const r = await POST('/api/ai/incident', { alert_id: a.id }, { queue: false }); toast(`🔥 Blaze: ${r.output}`, 'success'); reloadA(); } catch (e) { toast(e.message, 'error'); }
  };

  const series = (metrics?.samples || []).map((s) => ({ label: new Date(s.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), cpu: s.cpu_load, mem: s.mem_used_pct, heap: s.heap_mb, lag: s.event_loop_ms }));
  const cur = metrics?.current;
  const openAlerts = (alerts || []).filter((a) => a.status !== 'resolved');

  return (
    <div className="page ops">
      <div className="page-head">
        <div><h1><IServer /> Pipelines &amp; alerts</h1><p className="muted">Automated deployments, resource monitoring and incident response. Failures raise alerts for administrators; Blaze turns alerts into incident tasks.</p></div>
        <div className="head-actions">
          {can('alert.manage') && <button className="btn" onClick={() => setAlertForm(true)}><IAlert /> Raise alert</button>}
          {can('ops.manage') && <button className="btn primary" onClick={() => setCreate(true)}><IPlus /> New pipeline</button>}
        </div>
      </div>
      <ErrorBox error={error} />

      {cur && (
        <div className="kpis">
          <div className="kpi"><span><ICpu /> Process CPU</span><strong>{cur.cpu_load}<em>%</em></strong><Sparkline values={series.map((s) => s.cpu)} max={100} /></div>
          <div className="kpi"><span><IGauge /> Host memory</span><strong>{cur.mem_used_pct}<em>%</em></strong><Sparkline values={series.map((s) => s.mem)} max={100} color="var(--series-2)" /></div>
          <div className="kpi"><span>Heap</span><strong>{cur.heap_mb}<em>MB</em></strong><Sparkline values={series.map((s) => s.heap)} color="var(--series-3)" /></div>
          <div className="kpi"><span>Event-loop lag</span><strong>{cur.event_loop_ms}<em>ms</em></strong><Sparkline values={series.map((s) => s.lag)} color="var(--series-4)" /></div>
          <div className="kpi"><span><IDatabase /> Database</span><strong>{Math.round(cur.db_size_kb / 1024 * 10) / 10}<em>MB</em></strong><small>{cur.active_clients} live clients</small></div>
          <div className="kpi"><span>Open alerts</span><strong className={openAlerts.some((a) => a.severity === 'critical') ? 'bad' : openAlerts.length ? 'warn' : 'ok'}>{openAlerts.length}</strong><small>{metrics.host.platform} · {metrics.host.cpus} CPU · Node {metrics.host.node}</small></div>
        </div>
      )}

      <div className="dash-grid">
        <div className="card-panel span2">
          <h3>Resource monitor <small className="muted">(sampled every 30 s from the API gateway)</small></h3>
          {series.length < 2 ? <p className="muted">Collecting samples — the first points appear within a minute of the server starting.</p> : <LineChart data={series} keys={[{ key: 'cpu', label: 'CPU %' }, { key: 'mem', label: 'Memory %' }]} height={220} />}
        </div>
        <div className="card-panel">
          <h3><IAlert /> Alerts <small className="muted">{openAlerts.length} open</small></h3>
          {!alerts && <Spinner />}
          <ul className="alert-list">
            {(alerts || []).slice(0, 14).map((a) => (
              <li key={a.id} className={cls('alert-item', a.status)}>
                <div className="alert-top"><Pill tone={SEV_TONE[a.severity]}>{a.severity === 'critical' ? '🚨' : a.severity === 'warning' ? '⚠️' : 'ℹ️'} {a.severity}</Pill><strong>{a.title}</strong></div>
                <small className="muted">{a.company_code} · {a.pipeline_name || a.source} · <TimeAgo iso={a.created_at} /> · {a.status}{a.acknowledged_by_name ? ` by ${a.acknowledged_by_name}` : ''}</small>
                {a.status !== 'resolved' && <AgeChip iso={a.created_at} label="Open for" />}
                {a.message && <p className="small">{a.message}</p>}
                <div className="row-inline">
                  {a.card_id ? <Link className="chip" to={`/board/${a.card_board_id}?card=${a.card_id}`}><IBoard /> {a.card_title}</Link>
                    : can('ai.run') && a.status !== 'resolved' && <button className="btn xs" onClick={() => incident(a)}><IFlame /> File incident (Blaze)</button>}
                  {can('alert.manage') && a.status === 'open' && <button className="btn xs" onClick={() => setAlert(a, 'acknowledged')}>Acknowledge</button>}
                  {can('alert.manage') && a.status !== 'resolved' && <button className="btn xs" onClick={() => setAlert(a, 'resolved')}><IOk /> Resolve</button>}
                  {can('alert.manage') && a.status === 'resolved' && <button className="btn xs ghost" onClick={() => setAlert(a, 'open')}>Reopen</button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card-panel">
        <h3><IRocket /> Pipelines</h3>
        {!pipelines && <Spinner />}
        {pipelines && !pipelines.length && <Empty title="No pipelines yet" />}
        <div className="table-wrap">
          <table className="table pipelines">
            <thead><tr><th>Pipeline</th><th>Type</th><th>Target</th><th>Schedule</th><th>Status</th><th className="num">Success</th><th className="num">Avg</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {(pipelines || []).map((p) => (
                <tr key={p.id} className={cls(logs[p.id] && 'has-log')}>
                  <td><button className="link" onClick={() => setOpenRuns(p)}><strong>{p.name}</strong></button><br /><small className="muted">{p.company_code}{p.board_title ? ` · posts to ${p.board_title}` : ''}{p.config?.auto_incident ? ' · auto-incident' : ''}</small>
                    {logs[p.id] && <pre className="live-log">{logs[p.id].lines.slice(-8).join('\n') || 'Starting…'}</pre>}</td>
                  <td><Pill>{p.type}</Pill></td>
                  <td className="small">{p.target}{p.type === 'monitor' && p.config?.metric && <><br /><span className="muted">{p.config.metric} &gt; {p.config.threshold}</span></>}</td>
                  <td className="small">{p.schedule}</td>
                  <td><Pill tone={STATUS_TONE[p.status]}>{p.status === 'running' ? <><IRefresh className="spin" /> running</> : p.status}</Pill></td>
                  <td className="num">{p.success_rate != null ? `${p.success_rate}%` : '—'}</td>
                  <td className="num">{p.avg_ms ? `${(p.avg_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="small"><TimeAgo iso={p.last_run_at} /></td>
                  <td className="nowrap">
                    {can('ops.run') && <button className="btn xs primary" disabled={p.status === 'running'} onClick={() => runPipeline(p)}><IPlay /> Run</button>}
                    {can('ops.manage') && <button className="icon-btn sm" onClick={async () => { if (await confirm(`Retire pipeline “${p.name}”? Its run history is kept and it can be reactivated.`, { ok: 'Retire' })) { await DEL(`/api/ops/pipelines/${p.id}`); reloadP(); } }} aria-label="Retire pipeline" title="Retire (kept in history)"><IArchive /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {openRuns && <RunsModal pipeline={openRuns} onClose={() => setOpenRuns(null)} />}
      {create && <PipelineForm onClose={() => { setCreate(false); reloadP(); }} />}
      {alertForm && <AlertForm onClose={() => { setAlertForm(false); reloadA(); }} />}
      {confirmNode}
    </div>
  );
}

function RunsModal({ pipeline, onClose }) {
  const { data } = useData(() => GET(`/api/ops/pipelines/${pipeline.id}/runs`), [pipeline.id]);
  const [open, setOpen] = useState(null);
  return (
    <Modal title={`${pipeline.name} — run history`} onClose={onClose} width={760}>
      {!data ? <Spinner /> : (
        <ul className="runs">{data.map((r) => (
          <li key={r.id}>
            <button className="run-row" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill><span>{new Date(r.started_at).toLocaleString()}</span>
              <span className="muted">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : ''}</span><span className="muted grow">{r.triggered_by_name || r.triggered_by}</span>
            </button>
            {open === r.id && <pre className="live-log">{r.logs}</pre>}
          </li>
        ))}</ul>
      )}
    </Modal>
  );
}

function PipelineForm({ onClose }) {
  const { toast, companyId } = useApp();
  const { data: companies } = useData(() => GET('/api/companies'), []);
  const { data: boards } = useData(() => GET('/api/boards'), []);
  const [f, setF] = useState({ name: '', type: 'deploy', company_id: companyId || '', board_id: '', target: '', schedule: 'manual', fail_rate: 0.15, auto_incident: false, metric: 'mem_used_pct', threshold: 90, severity: 'warning' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    const config = f.type === 'monitor' ? { metric: f.metric, threshold: Number(f.threshold), severity: f.severity, auto_resolve: true, auto_incident: f.auto_incident } : { fail_rate: Number(f.fail_rate), auto_incident: f.auto_incident };
    try { await POST('/api/ops/pipelines', { name: f.name, type: f.type, company_id: f.company_id || null, board_id: f.board_id || null, target: f.target, schedule: f.schedule, config }, { queue: false }); toast('Pipeline created', 'success'); onClose(); } catch (ex) { toast(ex.message, 'error'); }
  };
  return (
    <Modal title="New pipeline" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Name"><input required value={f.name} onChange={set('name')} placeholder="e.g. Deploy web → staging" /></Field>
        <div className="row3">
          <Field label="Type"><select value={f.type} onChange={set('type')}><option value="deploy">Deploy</option><option value="monitor">Monitor</option><option value="backup">Backup</option></select></Field>
          <Field label="Company"><select value={f.company_id} onChange={set('company_id')}>{(companies || []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>
          <Field label="Post results to board"><select value={f.board_id} onChange={set('board_id')}><option value="">—</option>{(boards || []).filter((b) => !f.company_id || b.company_id === f.company_id).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></Field>
        </div>
        <div className="row2"><Field label="Target"><input value={f.target} onChange={set('target')} placeholder="staging-api.example.com" /></Field>
          <Field label="Schedule"><select value={f.schedule} onChange={set('schedule')}><option value="manual">manual</option><option value="continuous">continuous (every 30 s)</option><option value="hourly">hourly</option><option value="nightly">nightly</option><option value="on push to main">on push to main</option></select></Field></div>
        {f.type === 'monitor' ? (
          <div className="row3">
            <Field label="Metric"><select value={f.metric} onChange={set('metric')}>{['cpu_load', 'mem_used_pct', 'heap_mb', 'rss_mb', 'event_loop_ms', 'db_size_kb', 'active_clients'].map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Alert above"><input type="number" value={f.threshold} onChange={set('threshold')} /></Field>
            <Field label="Severity"><select value={f.severity} onChange={set('severity')}>{['info', 'warning', 'critical'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          </div>
        ) : <Field label="Simulated failure rate" hint="Demo pipelines simulate their steps; set 0 for always-green"><input type="number" min="0" max="1" step="0.05" value={f.fail_rate} onChange={set('fail_rate')} /></Field>}
        <label className="check"><input type="checkbox" checked={f.auto_incident} onChange={set('auto_incident')} /> Let Blaze auto-file an incident task when this fails</label>
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">Create</button></div>
      </form>
    </Modal>
  );
}

function AlertForm({ onClose }) {
  const { toast, companyId } = useApp();
  const [f, setF] = useState({ title: '', message: '', severity: 'warning', company_id: companyId });
  const save = async (e) => { e.preventDefault(); try { await POST('/api/ops/alerts', f, { queue: false }); toast('Alert raised — admins notified', 'success'); onClose(); } catch (ex) { toast(ex.message, 'error'); } };
  return (
    <Modal title="Raise an alert" onClose={onClose} width={480}>
      <form className="form" onSubmit={save}>
        <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Details"><textarea rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <Field label="Severity"><select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['info', 'warning', 'critical'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">Raise</button></div>
      </form>
    </Modal>
  );
}
