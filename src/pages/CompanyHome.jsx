// Company home: units → projects → boards, plus my tasks and mentions awaiting reply.
import { useEffect, useMemo, useState } from 'react';
import { GET, PATCH, DEL, POST } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { navigate, Link } from '../lib/router.jsx';
import { Spinner, ErrorBox, Avatar, AvatarStack, AgeChip, TimeAgo, PriorityPill, Pill, InlineEdit, useConfirm, Empty, Modal, Field } from '../components/ui.jsx';
import { CreateModal, bgStyle } from '../components/CreateModal.jsx';
import { RichText } from '../components/RichText.jsx';
import { IBoard, IProject, IPlus, IChat, IChart, ILayers, IUsers, IX, IAt, ITodo, IBuilding, IClock, IArchive } from '../components/icons.js';
import { cls, fmtDate, dueStatus, ageDays } from '../lib/format.js';
import { HistoryModal, useRetirePrompt, withReason, docDate } from '../components/VersionHistory.jsx';
import { CoverButton, coverStyle } from '../components/CoverPicker.jsx';

export default function CompanyHome({ query }) {
  const { companyId, setCompanyId, can, isAdmin, toast } = useApp();
  const [unit, setUnit] = useState('all');
  const [create, setCreate] = useState(null);
  const [members, setMembers] = useState(null);
  const [confirm, confirmNode] = useConfirm();
  const [askRetire, retireNode] = useRetirePrompt();
  const [history, setHistory] = useState(null); // { entity, id }
  const { data: companies } = useData(() => GET('/api/companies'), []);
  useEffect(() => { if (companies && (!companyId || !companies.some((c) => c.id === companyId))) { if (companies[0]) setCompanyId(companies[0].id); else navigate('/'); } }, [companies, companyId]);
  const { data, loading, error, reload } = useData(() => (companyId ? GET(`/api/companies/${companyId}`) : null), [companyId]);
  const { data: myTasks } = useData(() => GET('/api/my/tasks'), []);
  const { data: mentions } = useData(() => GET('/api/mentions'), []);
  const { data: dash } = useData(() => (companyId && can('report.view') ? GET(`/api/dashboard?company_id=${companyId}`) : null), [companyId]);

  useEffect(() => { if (query.project && data) { const p = data.projects.find((x) => x.id === query.project); if (p) setUnit(p.workspace_id); } }, [query.project, data]);

  const units = data?.units || [];
  const projects = useMemo(() => (data?.projects || []).filter((p) => unit === 'all' || p.workspace_id === unit), [data, unit]);
  const boards = useMemo(() => (data?.boards || []).filter((b) => unit === 'all' || b.workspace_id === unit), [data, unit]);
  const companyTasks = (myTasks || []).filter((t) => (data?.boards || []).some((b) => b.id === t.board_id));
  const awaiting = (mentions || []).filter((m) => m.awaiting);

  if (!companyId || (loading && !data)) return <Spinner label="Loading company…" />;
  if (error) return <div className="page"><ErrorBox error={error} onRetry={reload} /></div>;
  const c = data.company;
  const unitName = (id) => units.find((u) => u.id === id)?.name;
  const selUnit = unit !== 'all' ? units.find((u) => u.id === unit) : null;
  const boardsIn = (uid) => (data.boards || []).filter((b) => b.workspace_id === uid).length;

  const saveProject = async (p, patch) => { try { await PATCH(`/api/projects/${p.id}`, { ...patch, base_version: p.version_no }); reload(); } catch (e) { toast(e.message, 'error'); reload(); } };
  const retireProject = async (p) => {
    const why = await askRetire(`Retire project ${p.doc_no || ''} “${p.title}”`, 'The project leaves the company home. Its boards and tasks keep their (historical) link to it, every version is kept, and it can be reactivated.', 'Retire project');
    if (why === null) return;
    try { await DEL(withReason(`/api/projects/${p.id}`, why), { queue: false }); toast('Project retired — kept in history', 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const retireUnit = async (u) => {
    const why = await askRetire(`Retire unit “${u.name}”`, 'The unit and its boards leave circulation for everyone. Nothing is deleted; it can be reactivated with everything in it.', 'Retire unit');
    if (why === null) return;
    try { await DEL(withReason(`/api/units/${u.id}`, why), { queue: false }); toast('Unit retired — kept in history', 'success'); setUnit('all'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const renameUnit = async (u, name) => { try { await PATCH(`/api/units/${u.id}`, { name, base_version: u.version_no }); reload(); } catch (e) { toast(e.message, 'error'); reload(); } };

  return (
    <div className="company-home">
      <aside className="side">
        <div className="side-company" style={{ '--img': c.image_url ? `url("${c.image_url}")` : 'none' }}>
          <span className="cc-code">{c.code}</span><strong>{c.name}</strong>
          <select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setUnit('all'); }} aria-label="Switch company">
            {(companies || []).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}
          </select>
        </div>
        <nav className="side-nav">
          <div className="side-title">Units <span className="muted">{units.length}</span>{can('unit.manage') && <button className="icon-btn sm" onClick={() => setCreate({ kind: 'unit' })} aria-label="Add unit"><IPlus /></button>}</div>
          <button className={cls('side-item', unit === 'all' && 'on')} onClick={() => setUnit('all')}><ILayers /> All units</button>
          {units.map((u) => (
            <button key={u.id} className={cls('side-item', unit === u.id && 'on')} onClick={() => setUnit(u.id)}>
              <IBuilding /><span className="grow">{u.name}</span><small className="muted">{u.member_count}</small>
            </button>
          ))}
          <div className="side-title">Go to</div>
          <Link to="/chat" className="side-item"><IChat /> Chat channels</Link>
          {can('report.view') && <Link to="/dashboard" className="side-item"><IChart /> Dashboard</Link>}
        </nav>
      </aside>

      <div className="home-main">
        {selUnit?.cover_url && (
          <div className="unit-banner" style={coverStyle(selUnit.cover_url)}>
            <CoverButton entity="unit" id={selUnit.id} url={selUnit.cover_url} title={selUnit.name} label="Change cover" onSaved={reload} />
          </div>
        )}
        <div className="page-head">
          <div>
            <div className="crumbs"><Link to="/">Companies</Link> / {c.code}{unit !== 'all' && <> / {unitName(unit)}</>}</div>
            <h1>{unit === 'all' ? c.name : <InlineEdit value={unitName(unit)} onSave={(v) => renameUnit(units.find((u) => u.id === unit), v)} disabled={!can('unit.manage')} />}</h1>
            <p className="muted">{unit === 'all' ? c.description : units.find((u) => u.id === unit)?.description}</p>
          </div>
          <div className="head-actions">
            <button className="btn" onClick={() => setHistory(unit === 'all' ? { entity: 'company', id: c.id } : { entity: 'unit', id: unit })} title="Version history"><IClock /> v{unit === 'all' ? c.version_no : units.find((u) => u.id === unit)?.version_no}</button>
            {selUnit && !selUnit.cover_url && <CoverButton entity="unit" id={selUnit.id} url={null} title={selUnit.name} label="Unit cover" className="plain" onSaved={reload} />}
            {unit !== 'all' && isAdmin && <button className="btn" onClick={() => setMembers(units.find((u) => u.id === unit))}><IUsers /> Unit members</button>}
            {unit !== 'all' && isAdmin && can('unit.manage') && <button className="btn warn" onClick={() => retireUnit(units.find((u) => u.id === unit))} title="Retire unit"><IArchive /></button>}
            {can('project.manage') && <button className="btn" onClick={() => setCreate({ kind: 'project', preset: { workspace_id: unit !== 'all' ? unit : undefined } })}><IProject /> New project</button>}
            {can('board.create') && <button className="btn primary" onClick={() => setCreate({ kind: 'board', preset: { workspace_id: unit !== 'all' ? unit : undefined } })}><IPlus /> New board</button>}
          </div>
        </div>

        {dash && (
          <div className="kpis">
            <div className="kpi"><span>Open tasks</span><strong>{dash.kpi.open}</strong></div>
            <div className="kpi"><span>Overdue</span><strong className={dash.kpi.overdue ? 'bad' : ''}>{dash.kpi.overdue}</strong></div>
            <div className="kpi"><span>Completed · 7d</span><strong>{dash.kpi.completed_week}</strong></div>
            <div className="kpi"><span>Aging (idle 14d+)</span><strong className={dash.kpi.stale ? 'warn' : ''}>{dash.kpi.stale}</strong></div>
            <div className="kpi"><span>Open alerts</span><strong className={dash.kpi.critical_alerts ? 'bad' : ''}>{dash.kpi.open_alerts}</strong></div>
          </div>
        )}

        {unit === 'all' && units.length > 0 && (
          <section>
            <h2 className="sec-title"><IBuilding /> Units <span className="muted">{units.length}</span></h2>
            <div className="unit-tiles">
              {units.map((u) => (
                <div key={u.id} className="unit-tile" role="button" tabIndex={0} style={coverStyle(u.cover_url)}
                  onClick={() => setUnit(u.id)} onKeyDown={(e) => e.key === 'Enter' && setUnit(u.id)}>
                  <span className="ut-type">{u.type}</span>
                  <CoverButton entity="unit" id={u.id} url={u.cover_url} title={u.name} className="corner" onSaved={reload} />
                  <span className="ut-name">{u.name}</span>
                  <span className="ut-meta">{boardsIn(u.id)} boards · {u.member_count} members</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="sec-title"><IBoard /> Boards <span className="muted">{boards.length}</span></h2>
          <div className="board-tiles">
            {boards.map((b) => (
              <Link key={b.id} to={`/board/${b.id}`} className="board-tile" style={bgStyle(b.cover_url || b.background)}>
                <CoverButton entity="board" id={b.id} url={b.cover_url} title={b.title} className="corner" onSaved={reload} />
                <span className="bt-title">{b.title}</span>
                <span className="bt-meta">{unitName(b.workspace_id)} · {b.card_count} tasks · {b.member_count} members</span>
              </Link>
            ))}
            {can('board.create') && <button className="board-tile add" onClick={() => setCreate({ kind: 'board', preset: { workspace_id: unit !== 'all' ? unit : undefined } })}><IPlus /> Create new board</button>}
          </div>
        </section>

        <section>
          <h2 className="sec-title"><IProject /> Projects <span className="muted">{projects.length}</span></h2>
          {!projects.length && <Empty title="No projects in this unit yet" />}
          <div className="project-list">
            {projects.map((p) => {
              const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
              const pBoards = (data.boards || []).filter((b) => b.project_id === p.id);
              return (
                <article key={p.id} className={cls('project-card', query.project === p.id && 'highlight')}>
                  <div className="pc-head">
                    <h3>{p.doc_no && <span className="doc-no">{p.doc_no}</span>}<InlineEdit value={p.title} onSave={(v) => saveProject(p, { title: v })} disabled={!can('project.manage')} /></h3>
                    {can('project.manage') ? (
                      <select className={cls('status-select', p.status)} value={p.status} onChange={(e) => saveProject(p, { status: e.target.value })}>{['planning', 'active', 'on_hold', 'done'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select>
                    ) : <Pill>{p.status}</Pill>}
                  </div>
                  <div className="muted small">{unitName(p.workspace_id)} · {fmtDate(p.start_date)} → {fmtDate(p.end_date)}</div>
                  {p.description && <RichText text={p.description} className="small" />}
                  <div className="progress" title={`${p.done_count}/${p.task_count} tasks done`}><i style={{ width: `${pct}%` }} /></div>
                  <div className="pc-foot">
                    <span className="small">{p.done_count}/{p.task_count} done · {pct}%</span>
                    <span className="pc-boards">{pBoards.map((b) => <Link key={b.id} to={`/board/${b.id}`} className="chip"><IBoard />{b.title}</Link>)}</span>
                    <button className="vp-v link" onClick={() => setHistory({ entity: 'project', id: p.id })} title={`Version ${p.version_no} — view history`}>v{p.version_no}</button>
                    {can('project.manage') && <button className="icon-btn sm" onClick={() => retireProject(p)} aria-label="Retire project" title="Retire project (kept in history)"><IArchive /></button>}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <aside className="home-right">
        <div className="panel">
          <h3><ITodo /> My open tasks <span className="muted">{companyTasks.length}</span></h3>
          {!companyTasks.length && <p className="muted small">Nothing assigned to you here 🎉</p>}
          {companyTasks.slice(0, 12).map((t) => {
            const ds = dueStatus(t.due_date, false);
            return (
              <Link key={t.id} to={`/board/${t.board_id}?card=${t.id}`} className="mini-task">
                <strong>{t.title}</strong>
                <span className="mini-meta"><PriorityPill p={t.priority} />{t.due_date && <span className={cls('due', ds)}><IClock />{fmtDate(t.due_date)}</span>}<AgeChip iso={t.created_at} compact /></span>
                <small className="muted">{t.board_title} › {t.list_title}</small>
              </Link>
            );
          })}
        </div>
        <div className="panel">
          <h3><IAt /> Awaiting your reply <span className="muted">{awaiting.length}</span></h3>
          {!awaiting.length && <p className="muted small">No unanswered mentions.</p>}
          {awaiting.slice(0, 8).map((m) => (
            <Link key={m.id} to={`/chat/${m.channel_id}?m=${m.parent_message_id || m.id}`} className={cls('mini-mention', `age-${ageDays(m.created_at) >= 2 ? 'old' : 'new'}`)}>
              <Avatar user={m} size={24} />
              <span><strong>{m.full_name}</strong> <small className="muted">in {m.channel_type === 'dm' ? 'DM' : `#${m.channel_name}`} · <TimeAgo iso={m.created_at} /></small><span className="clamp2">{m.content}</span></span>
              <AgeChip iso={m.created_at} compact label="Waiting" />
            </Link>
          ))}
        </div>
      </aside>

      {create && <CreateModal kind={create.kind} preset={{ ...create.preset, company_id: companyId, onDone: reload }} onClose={() => setCreate(null)} />}
      {members && <UnitMembers unit={members} onClose={() => { setMembers(null); reload(); }} />}
      {history && <HistoryModal entity={history.entity} id={history.id} onClose={() => setHistory(null)} />}
      {retireNode}
      {confirmNode}
    </div>
  );
}

function UnitMembers({ unit, onClose }) {
  const { users, toast } = useApp();
  const { data, reload } = useData(() => GET(`/api/units/${unit.id}/members`), [unit.id]);
  const [add, setAdd] = useState({ user_id: '', role: 'member' });
  const setRole = async (userId, role) => { try { await POST(`/api/units/${unit.id}/members`, { user_id: userId, role }, { queue: false }); reload(); } catch (e) { toast(e.message, 'error'); } };
  const remove = async (userId) => { await DEL(`/api/units/${unit.id}/members/${userId}`, { queue: false }); reload(); };
  const ids = new Set((data || []).map((m) => m.user_id));
  return (
    <Modal title={`${unit.name} — members`} onClose={onClose}>
      <p className="muted small">Unit members can see the unit’s public channels. Unit admins get admin rights on every board in the unit. Board-level access is managed per board (Share) or in Admin → Board access.</p>
      <ul className="member-list">
        {(data || []).map((m) => (
          <li key={m.id}><Avatar user={m} size={28} /><span className="grow"><strong>{m.full_name}</strong><small className="muted"> @{m.username} · {m.designation}</small></span>
            <select value={m.role} onChange={(e) => setRole(m.user_id, e.target.value)}>{['admin', 'member', 'guest'].map((r) => <option key={r}>{r}</option>)}</select>
            {m.effective_to && <span className="pill">until {docDate(m.effective_to)}</span>}
            <button className="icon-btn sm" onClick={() => remove(m.user_id)} aria-label="End membership" title="End membership (kept in history)"><IX /></button></li>
        ))}
      </ul>
      <div className="row-inline">
        <select value={add.user_id} onChange={(e) => setAdd({ ...add, user_id: e.target.value })}><option value="">Add a person…</option>{users.filter((u) => !ids.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{['member', 'admin', 'guest'].map((r) => <option key={r}>{r}</option>)}</select>
        <button className="btn primary" disabled={!add.user_id} onClick={() => { setRole(add.user_id, add.role); setAdd({ user_id: '', role: 'member' }); }}>Add</button>
      </div>
    </Modal>
  );
}

export { AvatarStack, Field };
