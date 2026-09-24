// Management dashboard — KPIs, throughput trend, status, workload, priority mix, aging, board health, activity.
import { useState } from 'react';
import { GET } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { Link } from '../lib/router.jsx';
import { Spinner, ErrorBox, Avatar, TimeAgo, AgeChip, PriorityPill } from '../components/ui.jsx';
import { BarChart, LineChart, DonutChart, DataTable } from '../components/Charts.jsx';
import { fmtDate } from '../lib/format.js';
import { IChart, ITable, IActivity, IHourglass, IRefresh } from '../components/icons.js';

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];

export default function Dashboard() {
  const { companyId } = useApp();
  const [scope, setScope] = useState(companyId || '');
  const [asTable, setAsTable] = useState(false);
  const { data: companies } = useData(() => GET('/api/companies'), []);
  const { data: d, loading, error, reload } = useData(() => GET(`/api/dashboard${scope ? `?company_id=${scope}` : ''}`), [scope]);

  return (
    <div className="page dashboard">
      <div className="page-head">
        <div><h1><IChart /> Dashboard</h1><p className="muted">Live delivery health across the boards you can see.</p></div>
        <div className="head-actions">
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Company filter"><option value="">All companies</option>{(companies || []).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
          <button className="btn" onClick={() => setAsTable(!asTable)}><ITable /> {asTable ? 'Charts' : 'Tables'}</button>
          <button className="btn" onClick={reload}><IRefresh /></button>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !d && <Spinner />}
      {d && <>
        <div className="kpis">
          <div className="kpi"><span>Open tasks</span><strong>{d.kpi.open}</strong><small>{d.kpi.total} total</small></div>
          <div className="kpi"><span>Overdue</span><strong className={d.kpi.overdue ? 'bad' : ''}>{d.kpi.overdue}</strong><small>{d.kpi.open ? Math.round((d.kpi.overdue / d.kpi.open) * 100) : 0}% of open</small></div>
          <div className="kpi"><span>Completed · 7 days</span><strong>{d.kpi.completed_week}</strong><small>{d.kpi.created_week} created</small></div>
          <div className="kpi"><span>Avg cycle time</span><strong>{d.kpi.cycle_days ?? '—'}<em>d</em></strong><small>create → done</small></div>
          <div className="kpi"><span>Aging (idle 14d+)</span><strong className={d.kpi.stale ? 'warn' : ''}>{d.kpi.stale}</strong><small>open & untouched</small></div>
          <div className="kpi"><span>Open alerts</span><strong className={d.kpi.critical_alerts ? 'bad' : ''}>{d.kpi.open_alerts}</strong><small>{d.kpi.critical_alerts} critical</small></div>
          <div className="kpi"><span>Messages · 24h</span><strong>{d.kpi.messages_today}</strong><small>{d.kpi.ai_runs_week} AI runs this week</small></div>
        </div>

        <div className="dash-grid">
          <div className="card-panel span2">
            <h3>Throughput — last 30 days</h3>
            {asTable ? <DataTable columns={[{ key: 'label', label: 'Day' }, { key: 'created', label: 'Created' }, { key: 'completed', label: 'Completed' }]} rows={d.trend} />
              : <LineChart data={d.trend} keys={[{ key: 'created', label: 'Created' }, { key: 'completed', label: 'Completed' }]} height={240} />}
          </div>
          <div className="card-panel">
            <h3>Open work by priority</h3>
            <DonutChart data={PRIORITY_ORDER.map((p) => ({ label: p, value: d.byPriority.find((x) => x.label === p)?.value || 0 })).filter((x) => x.value)} centerLabel="open tasks" />
          </div>
          <div className="card-panel">
            <h3>Tasks by stage</h3>
            {asTable ? <DataTable columns={[{ key: 'label', label: 'Stage' }, { key: 'value', label: 'Tasks' }]} rows={d.byStatus} />
              : <DonutChart data={d.byStatus} centerLabel="tasks" />}
          </div>
          <div className="card-panel">
            <h3>Workload — open vs overdue</h3>
            {asTable ? <DataTable columns={[{ key: 'label', label: 'Assignee' }, { key: 'open', label: 'Open' }, { key: 'overdue', label: 'Overdue' }]} rows={d.workload} />
              : <BarChart data={d.workload} keys={[{ key: 'open', label: 'Open' }, { key: 'overdue', label: 'Overdue' }]} horizontal />}
          </div>
          <div className="card-panel">
            <h3><IHourglass /> Aging of open tasks</h3>
            {asTable ? <DataTable columns={[{ key: 'label', label: 'Age' }, { key: 'value', label: 'Open tasks' }]} rows={d.aging} />
              : <BarChart data={d.aging} keys={[{ key: 'value', label: 'Open tasks' }]} height={220} />}
          </div>
          <div className="card-panel span2">
            <h3>Board health</h3>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Board</th><th className="num">Tasks</th><th className="num">Done</th><th className="num">Overdue</th><th>Progress</th></tr></thead>
              <tbody>{d.boardsHealth.map((b) => {
                const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
                return <tr key={b.id}><td><Link to={`/board/${b.id}`}>{b.title}</Link></td><td className="num">{b.total}</td><td className="num">{b.done}</td><td className={`num ${b.overdue ? 'bad' : ''}`}>{b.overdue}</td><td><div className="progress sm" title={`${pct}%`}><i style={{ width: `${pct}%` }} /></div></td></tr>;
              })}</tbody>
            </table></div>
          </div>
          <div className="card-panel">
            <h3><IHourglass /> Oldest open tasks</h3>
            <ul className="plain-list">{d.oldest.map((t) => (
              <li key={t.id}><Link to={`/board/${t.board_id}?card=${t.id}`}><strong>{t.title}</strong></Link>
                <span className="mini-meta"><AgeChip iso={t.created_at} /><PriorityPill p={t.priority} /><small className="muted">{t.list_title}{t.assignee_name ? ` · ${t.assignee_name}` : ''}{t.due_date ? ` · due ${fmtDate(t.due_date)}` : ''}</small></span></li>
            ))}</ul>
          </div>
          <div className="card-panel span2">
            <h3><IActivity /> Recent activity</h3>
            <ul className="activity">{d.activity.map((a) => (
              <li key={a.id}><Avatar user={{ full_name: a.actor_name || 'System', color: a.actor_color || '#626f86' }} size={24} />
                <span><strong>{a.actor_name || 'System / AI'}</strong> <code>{a.type}</code> {a.details?.title && <>“{a.details.title}”</>}{a.details?.to && <> → <b>{a.details.to}</b></>} <small className="muted"><TimeAgo iso={a.created_at} /></small></span></li>
            ))}</ul>
          </div>
        </div>
      </>}
    </div>
  );
}
