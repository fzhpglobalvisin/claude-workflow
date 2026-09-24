// Report builder — pick a data source, a dimension, up to 4 metrics, filters and a chart; run, save, export.
import { useEffect, useMemo, useState } from 'react';
import { GET, POST, PATCH, DEL, download } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { Spinner, ErrorBox, Field, Empty, useConfirm, TimeAgo } from '../components/ui.jsx';
import { BarChart, LineChart, DonutChart, DataTable } from '../components/Charts.jsx';
import { cls } from '../lib/format.js';
import { ITable, IChart, IPie, IActivity, IPlay, ISave, IDownload, IArchive, IPlus, IFile } from '../components/icons.js';

const foldOther = (rows, key) => {
  const top = rows.slice(0, 6).map((r) => ({ label: String(r.label), value: r[key] }));
  const rest = rows.slice(6).reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return rest ? [...top, { label: 'Other', value: rest, color: 'var(--faint)' }] : top;
};
const BLANK = { source: 'tasks', dimension: 'assignee', metrics: ['open', 'overdue'], chart: 'bar', filters: {}, limit: 50 };

export default function Reports() {
  const { can, users, toast, user, isAdmin } = useApp();
  const { data: catalog } = useData(() => GET('/api/reports/catalog'), []);
  const { data: saved, reload: reloadSaved } = useData(() => GET('/api/reports'), []);
  const { data: companies } = useData(() => GET('/api/companies'), []);
  const { data: boards } = useData(() => GET('/api/boards'), []);
  const [cfg, setCfg] = useState(BLANK);
  const [meta, setMeta] = useState({ id: null, name: '', description: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, confirmNode] = useConfirm();

  const src = catalog?.[cfg.source];
  const run = async (c = cfg) => {
    setBusy(true); setError(null);
    try { setResult(await POST('/api/reports/run', { config: c }, { queue: false })); } catch (e) { setError(e); setResult(null); } finally { setBusy(false); }
  };
  useEffect(() => { if (catalog) run(); }, [catalog]);

  const setSource = (s) => {
    const c = catalog[s];
    const next = { ...cfg, source: s, dimension: Object.keys(c.dimensions)[0], metrics: ['count'], filters: { company_id: cfg.filters.company_id, from: cfg.filters.from, to: cfg.filters.to } };
    setCfg(next); run(next);
  };
  const toggleMetric = (m) => setCfg((c) => ({ ...c, metrics: c.metrics.includes(m) ? (c.metrics.length > 1 ? c.metrics.filter((x) => x !== m) : c.metrics) : [...c.metrics, m].slice(-4) }));
  const setFilter = (k, v) => setCfg((c) => ({ ...c, filters: { ...c.filters, [k]: v || undefined } }));
  const open = (r) => { setCfg({ ...BLANK, ...r.config, filters: r.config.filters || {} }); setMeta({ id: r.id, name: r.name, description: r.description || '', created_by: r.created_by }); run({ ...BLANK, ...r.config }); };
  const save = async (asNew) => {
    const name = meta.name || prompt('Report name?');
    if (!name) return;
    try {
      if (meta.id && !asNew) await PATCH(`/api/reports/${meta.id}`, { name, description: meta.description, config: cfg }, { queue: false });
      else { const r = await POST('/api/reports', { name, description: meta.description, config: cfg }, { queue: false }); setMeta({ ...meta, id: r.id, name, created_by: user.id }); }
      toast('Report saved', 'success'); reloadSaved();
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async (r) => { if (await confirm(`Retire report “${r.name}”? It is kept with its version history and can be reactivated.`, { ok: 'Retire' })) { await DEL(`/api/reports/${r.id}`, { queue: false }); if (meta.id === r.id) setMeta({ id: null, name: '', description: '' }); reloadSaved(); } };

  const chartData = useMemo(() => result?.rows || [], [result]);
  const keys = result ? result.metrics.map((m) => ({ key: m, label: result.columns.find((c) => c.key === m)?.label })) : [];

  return (
    <div className="page reports">
      <div className="page-head">
        <div><h1><ITable /> Report builder</h1><p className="muted">Slice tasks, subtasks, chat, audit and alerts. Only data you’re allowed to see is included.</p></div>
        <div className="head-actions">
          <button className="btn" onClick={() => { setCfg(BLANK); setMeta({ id: null, name: '', description: '' }); run(BLANK); }}><IPlus /> New</button>
          {can('report.build') && <button className="btn" onClick={() => save(false)}><ISave /> {meta.id ? 'Save' : 'Save as…'}</button>}
          {can('report.build') && meta.id && <button className="btn ghost" onClick={() => { setMeta({ ...meta, id: null, name: '' }); setTimeout(() => save(true)); }}>Save copy</button>}
          <button className="btn" onClick={() => download('/api/reports/run?format=csv', `${meta.name || 'report'}.csv`, { config: cfg })}><IDownload /> CSV</button>
        </div>
      </div>
      <div className="report-layout">
        <aside className="report-saved">
          <h4>Saved reports</h4>
          {!saved && <Spinner />}
          {saved?.map((r) => (
            <div key={r.id} className={cls('saved-item', meta.id === r.id && 'on')}>
              <button onClick={() => open(r)}><IFile /><span><strong>{r.name}</strong><small className="muted">{r.author} · <TimeAgo iso={r.updated_at} /></small></span></button>
              {(r.created_by === user.id || isAdmin) && <button className="icon-btn sm" onClick={() => remove(r)} aria-label="Retire report" title="Retire (kept in history)"><IArchive /></button>}
            </div>
          ))}
        </aside>
        <section className="report-builder">
          {!catalog ? <Spinner /> : <>
            <div className="builder">
              <Field label="Report name"><input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder="Untitled report" /></Field>
              <Field label="Data source">
                <div className="seg wrap">{Object.entries(catalog).map(([k, s]) => <button key={k} className={cls(cfg.source === k && 'on')} disabled={s.needs && !can(s.needs)} onClick={() => setSource(k)} title={s.needs && !can(s.needs) ? `Needs ${s.needs}` : ''}>{s.label}</button>)}</div>
              </Field>
              <div className="row3">
                <Field label="Group by"><select value={cfg.dimension} onChange={(e) => setCfg({ ...cfg, dimension: e.target.value })}>{Object.entries(src.dimensions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
                <Field label="Chart">
                  <div className="seg">{[['bar', <IChart key="b" />], ['line', <IActivity key="l" />], ['pie', <IPie key="p" />], ['table', <ITable key="t" />]].map(([k, i]) => <button key={k} className={cls(cfg.chart === k && 'on')} onClick={() => setCfg({ ...cfg, chart: k })} aria-label={k}>{i}</button>)}</div>
                </Field>
                <Field label="Rows"><input type="number" min={1} max={200} value={cfg.limit} onChange={(e) => setCfg({ ...cfg, limit: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Metrics (up to 4)">
                <div className="chip-select">{Object.entries(src.metrics).map(([k, l]) => <button key={k} className={cls('chip', cfg.metrics.includes(k) && 'on')} onClick={() => toggleMetric(k)}>{l}</button>)}</div>
              </Field>
              <div className="filters-row">
                <Field label="Company"><select value={cfg.filters.company_id || ''} onChange={(e) => setFilter('company_id', e.target.value)}><option value="">All</option>{(companies || []).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>
                {src.filters.includes('board_id') && <Field label="Board"><select value={cfg.filters.board_id || ''} onChange={(e) => setFilter('board_id', e.target.value)}><option value="">All</option>{(boards || []).filter((b) => !cfg.filters.company_id || b.company_id === cfg.filters.company_id).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></Field>}
                {src.filters.includes('assignee_id') && <Field label="Assignee"><select value={cfg.filters.assignee_id || ''} onChange={(e) => setFilter('assignee_id', e.target.value)}><option value="">Anyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>}
                {src.filters.includes('priority') && <Field label="Priority"><select value={cfg.filters.priority || ''} onChange={(e) => setFilter('priority', e.target.value)}><option value="">Any</option>{['urgent', 'high', 'medium', 'low'].map((p) => <option key={p}>{p}</option>)}</select></Field>}
                {src.filters.includes('state') && <Field label="State"><select value={cfg.filters.state || ''} onChange={(e) => setFilter('state', e.target.value)}><option value="">Any</option><option value="open">Open</option><option value="done">Done</option></select></Field>}
                <Field label="From"><input type="date" value={cfg.filters.from || ''} onChange={(e) => setFilter('from', e.target.value)} /></Field>
                <Field label="To"><input type="date" value={cfg.filters.to || ''} onChange={(e) => setFilter('to', e.target.value)} /></Field>
              </div>
              <div className="form-actions"><button className="btn primary" onClick={() => run()} disabled={busy}><IPlay /> {busy ? 'Running…' : 'Run report'}</button></div>
            </div>
            <div className="card-panel result">
              <ErrorBox error={error} />
              {result && <>
                <h3>{meta.name || `${src.label} by ${src.dimensions[result.dimension]}`} <small className="muted">· {result.rows.length} rows · generated <TimeAgo iso={result.generated_at} /></small></h3>
                {!result.rows.length ? <Empty title="No data for these filters" /> : <>
                  {cfg.chart === 'bar' && <BarChart data={chartData} keys={keys} horizontal={chartData.length > 8} height={280} />}
                  {cfg.chart === 'line' && <LineChart data={chartData} keys={keys} height={280} />}
                  {cfg.chart === 'pie' && <DonutChart data={foldOther(chartData, result.metrics[0])} size={220} centerLabel={keys[0]?.label} />}
                  <DataTable columns={result.columns} rows={result.rows} />
                </>}
              </>}
            </div>
          </>}
        </section>
      </div>
      {confirmNode}
    </div>
  );
}
