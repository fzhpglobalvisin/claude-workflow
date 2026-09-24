// "Create" flow for tasks, boards, projects, units and channels.
import { useEffect, useState } from 'react';
import { GET, POST, uid } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { navigate } from '../lib/router.jsx';
import { Modal, Field, Avatar } from './ui.jsx';
import { fromInputDate, cls } from '../lib/format.js';

export const BOARD_BACKGROUNDS = [
  ['AI', 'https://images.unsplash.com/photo-1535223289827-42f1e9919769?auto=format&fit=crop&w=1920&q=70'],
  ['Code', 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=1920&q=70'],
  ['Mountains', 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1920&q=70'],
  ['City', 'https://images.unsplash.com/photo-1486406146926-c627a4ad1ab0?auto=format&fit=crop&w=1920&q=70'],
  ['Abstract', 'https://images.unsplash.com/photo-1541701494587-cb58502866ab?auto=format&fit=crop&w=1920&q=70'],
  ['Gradient', 'linear-gradient(135deg,#0c66e4,#6e5dc6)'],
  ['Sunset', 'linear-gradient(135deg,#f97316,#be185d)'],
  ['Forest', 'linear-gradient(135deg,#065f46,#0f172a)'],
];
export const bgStyle = (bg) => (!bg ? { background: 'linear-gradient(135deg,#0c66e4,#6e5dc6)' } : bg.startsWith('http') ? { backgroundImage: `url("${bg}"), linear-gradient(135deg,#1e3a8a,#312e81)` } : { background: bg });

const TITLES = { task: 'Create task', board: 'Create board', project: 'Create project', unit: 'Create unit', channel: 'Create channel' };

export function CreateModal({ kind, onClose, preset = {} }) {
  const { companyId, setCompanyId, users, toast, user } = useApp();
  const [companies, setCompanies] = useState([]);
  const [cid, setCid] = useState(preset.company_id || companyId || '');
  const [home, setHome] = useState(null);
  const [boards, setBoards] = useState([]);
  const [lists, setLists] = useState([]);
  const [f, setF] = useState({ title: '', name: '', description: '', type: kind === 'channel' ? 'public' : 'unit', priority: 'medium', status: 'active', background: BOARD_BACKGROUNDS[0][1], member_ids: [], ...preset });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));

  useEffect(() => { GET('/api/companies').then((cs) => { setCompanies(cs); if (!cid && cs[0]) setCid(cs[0].id); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!cid) return;
    GET(`/api/companies/${cid}`).then((h) => { setHome(h); setF((s) => ({ ...s, workspace_id: preset.workspace_id && h.units.some((u) => u.id === preset.workspace_id) ? preset.workspace_id : h.units[0]?.id || '' })); }).catch(() => setHome(null));
    if (kind === 'task') GET(`/api/boards?company_id=${cid}`).then((b) => { setBoards(b); setF((s) => ({ ...s, board_id: preset.board_id && b.some((x) => x.id === preset.board_id) ? preset.board_id : b[0]?.id || '' })); }).catch(() => {});
  }, [cid]);
  useEffect(() => {
    if (kind !== 'task' || !f.board_id) return;
    GET(`/api/boards/${f.board_id}`).then((b) => { setLists(b.lists); setF((s) => ({ ...s, list_id: preset.list_id && b.lists.some((l) => l.id === preset.list_id) ? preset.list_id : b.lists[0]?.id })); }).catch(() => setLists([]));
  }, [f.board_id]);

  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      if (kind === 'task') {
        const id = uid();
        await POST(`/api/lists/${f.list_id}/cards`, { id, title: f.title, description: f.description, priority: f.priority, assignee_id: f.assignee_id || null, due_date: fromInputDate(f.due) });
        toast('Task created', 'success'); navigate(`/board/${f.board_id}?card=${id}`);
      } else if (kind === 'board') {
        const b = await POST('/api/boards', { workspace_id: f.workspace_id, project_id: f.project_id || null, title: f.title, description: f.description, background: f.background }, { queue: false });
        setCompanyId(cid); toast('Board created', 'success'); navigate(`/board/${b.id}`);
      } else if (kind === 'project') {
        await POST('/api/projects', { workspace_id: f.workspace_id, title: f.title, description: f.description, status: f.status, start_date: fromInputDate(f.start), end_date: fromInputDate(f.end) }, { queue: false });
        setCompanyId(cid); toast('Project created', 'success'); navigate('/home');
      } else if (kind === 'unit') {
        await POST('/api/units', { company_id: cid, name: f.name, type: f.type, description: f.description }, { queue: false });
        setCompanyId(cid); toast('Unit created', 'success'); navigate('/home');
      } else if (kind === 'channel') {
        const c = await POST('/api/channels', { company_id: cid, workspace_id: f.workspace_id || null, name: f.name, type: f.type, description: f.description, member_ids: f.member_ids }, { queue: false });
        setCompanyId(cid); toast('Channel created', 'success'); navigate(`/chat/${c.id}`);
      }
      preset.onDone?.();
      onClose();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const unitProjects = home?.projects.filter((p) => p.workspace_id === f.workspace_id) || [];
  return (
    <Modal title={TITLES[kind]} onClose={onClose} width={560}>
      <form onSubmit={submit} className="form">
        <Field label="Company">
          <select value={cid} onChange={(e) => setCid(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
        </Field>
        {kind === 'task' && <>
          <div className="row2">
            <Field label="Board"><select value={f.board_id || ''} onChange={set('board_id')} required>{boards.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></Field>
            <Field label="List"><select value={f.list_id || ''} onChange={set('list_id')} required>{lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select></Field>
          </div>
          <Field label="Title"><input autoFocus required value={f.title} onChange={set('title')} placeholder="e.g. Integrate Stripe checkout" /></Field>
          <Field label="Description"><textarea rows={3} value={f.description} onChange={set('description')} placeholder="Add details, or bullet lines — the AI planner turns bullets into subtasks" /></Field>
          <div className="row3">
            <Field label="Assignee"><select value={f.assignee_id || ''} onChange={set('assignee_id')}><option value="">Unassigned</option>{users.filter((u) => !u.is_guest).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field>
            <Field label="Priority"><select value={f.priority} onChange={set('priority')}>{['low', 'medium', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select></Field>
            <Field label="Due"><input type="date" value={f.due || ''} onChange={set('due')} /></Field>
          </div>
          {!boards.length && <p className="muted">You don’t have edit access to any board in this company yet — ask the super admin.</p>}
        </>}
        {(kind === 'board' || kind === 'project' || kind === 'channel') && home && (
          <Field label={kind === 'channel' ? 'Unit (optional)' : 'Unit'}>
            <select value={f.workspace_id || ''} onChange={set('workspace_id')} required={kind !== 'channel'}>
              {kind === 'channel' && <option value="">Company-wide</option>}
              {home.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        )}
        {kind === 'board' && <>
          <Field label="Project (optional)"><select value={f.project_id || ''} onChange={set('project_id')}><option value="">No project</option>{unitProjects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
          <Field label="Board title"><input autoFocus required value={f.title} onChange={set('title')} placeholder="e.g. Sprint board" /></Field>
          <Field label="Background">
            <div className="bg-picker">{BOARD_BACKGROUNDS.map(([n, bg]) => <button type="button" key={n} title={n} className={cls('bg-swatch', f.background === bg && 'on')} style={bgStyle(bg)} onClick={() => set('background')(bg)} />)}</div>
          </Field>
        </>}
        {kind === 'project' && <>
          <Field label="Project title"><input autoFocus required value={f.title} onChange={set('title')} /></Field>
          <Field label="Description"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
          <div className="row3">
            <Field label="Status"><select value={f.status} onChange={set('status')}>{['planning', 'active', 'on_hold', 'done'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Start"><input type="date" value={f.start || ''} onChange={set('start')} /></Field>
            <Field label="End"><input type="date" value={f.end || ''} onChange={set('end')} /></Field>
          </div>
        </>}
        {kind === 'unit' && <>
          <Field label="Unit name"><input autoFocus required value={f.name} onChange={set('name')} placeholder="e.g. Mobile Team" /></Field>
          <Field label="Type"><select value={f.type} onChange={set('type')}><option value="unit">Unit</option><option value="department">Department</option><option value="client">Client</option></select></Field>
          <Field label="Description"><input value={f.description} onChange={set('description')} /></Field>
        </>}
        {kind === 'channel' && <>
          <Field label="Channel name"><input autoFocus required value={f.name} onChange={set('name')} placeholder="e.g. release-planning" /></Field>
          <Field label="Visibility"><select value={f.type} onChange={set('type')}><option value="public">Public — anyone in the unit/company</option><option value="private">Private — invited members only</option></select></Field>
          <Field label="Description"><input value={f.description} onChange={set('description')} /></Field>
          <Field label="Members">
            <div className="chip-select">{users.filter((u) => u.id !== user.id).map((u) => {
              const on = f.member_ids.includes(u.id);
              return <button type="button" key={u.id} className={cls('chip', on && 'on')} onClick={() => setF((s) => ({ ...s, member_ids: on ? s.member_ids.filter((x) => x !== u.id) : [...s.member_ids, u.id] }))}><Avatar user={u} size={18} />{u.full_name}</button>;
            })}</div>
          </Field>
        </>}
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Create'}</button></div>
      </form>
    </Modal>
  );
}
