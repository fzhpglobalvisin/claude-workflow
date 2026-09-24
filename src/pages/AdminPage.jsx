// Admin console — the super admin manages auth (users), board access rights, roles/permissions,
// the audit trail and raw database rows ("edit mode") — SQLite locally, PostgreSQL on Vercel.
import { useEffect, useMemo, useState } from 'react';
import { GET, POST, PATCH, PUT, DEL, download } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { Tabs, Spinner, Avatar, Modal, Field, TimeAgo, Pill, useConfirm, ErrorBox, Empty } from '../components/ui.jsx';
import { cls, fmtDateTime } from '../lib/format.js';
import { HistoryModal, VersionPanel, useRetirePrompt, withReason, docDate } from '../components/VersionHistory.jsx';
import MdmConsole from './MdmConsole.jsx';
import { IShield, IUsers, IKey, IActivity, IDatabase, IPlus, ITrash, IDownload, ISearch, IBoard, ILeft, IRight, ISave, IArchive, IClock, ILayers, IRefresh, ILock } from '../components/icons.js';

export default function AdminPage() {
  const { isAdmin, isSuper, can } = useApp();
  const [tab, setTab] = useState('users');
  if (!isAdmin) return <div className="page"><Empty icon={<IShield />} title="Admins only">Ask the super admin for access.</Empty></div>;
  return (
    <div className="page admin">
      <div className="page-head"><div><h1><IShield /> Admin console</h1><p className="muted">Authentication, board access rights, roles &amp; permissions, audit trail and data.</p></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'users', label: 'Users', icon: <IUsers /> },
        { value: 'access', label: 'Board access', icon: <IBoard /> },
        { value: 'roles', label: 'Roles & permissions', icon: <IKey /> },
        ...(can('audit.view') ? [{ value: 'audit', label: 'Audit log', icon: <IActivity /> }] : []),
        ...(isSuper ? [{ value: 'mdm', label: 'Master data (MDM)', icon: <ILayers /> }] : []),
        ...(isSuper ? [{ value: 'db', label: 'Database (edit mode)', icon: <IDatabase /> }] : []),
      ]} />
      <div className="admin-body">
        {tab === 'users' && <Users />}
        {tab === 'access' && <Access />}
        {tab === 'roles' && <Roles />}
        {tab === 'audit' && <Audit />}
        {tab === 'mdm' && <MdmConsole />}
        {tab === 'db' && <DbEditor />}
      </div>
    </div>
  );
}

function Users() {
  const { toast, user: me, isSuper, can, refreshUsers } = useApp();
  const { data, reload, error } = useData(() => GET('/api/admin/users'), []);
  const { data: roles } = useData(() => GET('/api/admin/roles'), []);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [confirm, confirmNode] = useConfirm();
  const [askRetire, retireNode] = useRetirePrompt();
  const [history, setHistory] = useState(null);
  const patch = async (u, body) => { try { await PATCH(`/api/admin/users/${u.id}`, body, { queue: false }); toast('Saved', 'success'); reload(); refreshUsers(); } catch (e) { toast(e.message, 'error'); } };
  const resetPw = async (u) => { const pw = prompt(`New password for @${u.username} (min 6 chars)`); if (pw) patch(u, { password: pw }); };
  // users are never deleted — every task, message and version still references them
  const retireUser = async (u) => {
    const why = await askRetire(`Retire @${u.username}`, `${u.full_name} can no longer sign in and disappears from people pickers. Their tasks, messages and history stay intact (still attributed to them). The account can be reactivated at any time.`, 'Retire user');
    if (why === null) return;
    try { await DEL(withReason(`/api/admin/users/${u.id}`, why), { queue: false }); toast('User retired', 'success'); reload(); refreshUsers(); } catch (e) { toast(e.message, 'error'); }
  };
  const list = (data || []).filter((u) => `${u.full_name} ${u.username} ${u.designation} ${u.role}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="toolbar">
        <label className="search-input"><ISearch /><input placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <span className="grow" />
        {can('admin.users') && <button className="btn primary" onClick={() => setForm({})}><IPlus /> New user</button>}
      </div>
      <ErrorBox error={error} />
      {!data ? <Spinner /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>User</th><th>Role</th><th>Designation</th><th className="num">Units</th><th className="num">Boards</th><th>Last login</th><th>Active</th><th>Version</th><th /></tr></thead>
          <tbody>{list.map((u) => (
            <tr key={u.id} className={cls(!u.is_active && 'muted-row')}>
              <td><span className="user-cell"><Avatar user={u} size={28} showPresence /><span><strong>{u.full_name}</strong><small className="muted"> @{u.username}{u.email ? ` · ${u.email}` : ''}</small></span></span></td>
              <td>{can('admin.users') && (isSuper || !u.is_super_admin) ? (
                <select value={u.role} onChange={(e) => patch(u, { role: e.target.value })} disabled={u.id === me.id}>
                  {(roles?.roles || []).filter((r) => isSuper || r.name !== 'super_admin').map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                </select>) : <Pill>{u.role}</Pill>}</td>
              <td className="small">{u.designation}<br /><span className="muted">{u.department}</span></td>
              <td className="num">{u.unit_count}</td><td className="num">{u.board_count}</td>
              <td className="small">{u.last_login_at ? <TimeAgo iso={u.last_login_at} /> : '—'}</td>
              <td><label className="switch" title={u.is_active ? 'Active' : `Retired ${docDate(u.retired_at)}`}><input type="checkbox" checked={u.is_active} disabled={u.id === me.id || !can('admin.users')} onChange={() => patch(u, { is_active: !u.is_active })} /><i /></label></td>
              <td><button className="vp-v link" onClick={() => setHistory(u)} title="Version history">v{u.version_no}</button></td>
              <td className="nowrap">
                {can('admin.users') && <button className="btn xs" onClick={() => setForm(u)}>Edit</button>}
                {can('admin.users') && <button className="btn xs" onClick={() => resetPw(u)}>Reset password</button>}
                {isSuper && u.id !== me.id && u.is_active && <button className="icon-btn sm" onClick={() => retireUser(u)} aria-label="Retire user" title="Retire user (never deleted)"><IArchive /></button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {form && <UserForm u={form} roles={roles?.roles || []} onClose={() => { setForm(null); reload(); refreshUsers(); }} />}
      {history && <HistoryModal entity="user" id={history.id} title={`User history — @${history.username}`} onClose={() => setHistory(null)} />}
      {confirmNode}
      {retireNode}
    </div>
  );
}

function UserForm({ u, roles, onClose }) {
  const { toast, isSuper } = useApp();
  const [f, setF] = useState({ username: u.username || '', password: '', full_name: u.full_name || '', email: u.email || '', role: u.role || 'developer', designation: u.designation || '', department: u.department || '', whatsapp_number: u.whatsapp_number || '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try {
      if (u.id) { const { username, password, ...rest } = f; await PATCH(`/api/admin/users/${u.id}`, { ...rest, ...(password ? { password } : {}) }, { queue: false }); }
      else await POST('/api/admin/users', f, { queue: false });
      toast('User saved', 'success'); onClose();
    } catch (ex) { toast(ex.message, 'error'); }
  };
  return (
    <Modal title={u.id ? `Edit @${u.username}` : 'New user'} onClose={onClose} width={u.id ? 900 : 560}>
      <div className={cls(u.id && 'with-history')}>
      <form className="form" onSubmit={save}>
        <div className="row2"><Field label="User ID"><input required disabled={!!u.id} value={f.username} onChange={set('username')} /></Field>
          <Field label={u.id ? 'New password (optional)' : 'Password'}><input type="password" required={!u.id} minLength={6} value={f.password} onChange={set('password')} /></Field></div>
        <div className="row2"><Field label="Full name"><input required value={f.full_name} onChange={set('full_name')} /></Field><Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field></div>
        <div className="row3"><Field label="Role"><select value={f.role} onChange={set('role')}>{roles.filter((r) => isSuper || r.name !== 'super_admin').map((r) => <option key={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Designation"><input value={f.designation} onChange={set('designation')} /></Field><Field label="Department"><input value={f.department} onChange={set('department')} /></Field></div>
        <Field label="WhatsApp number"><input value={f.whatsapp_number} onChange={set('whatsapp_number')} /></Field>
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
      {u.id && <div className="aside"><VersionPanel entity="profile" id={u.id} title="Profile versions" /><VersionPanel entity="user" id={u.id} title="Account versions" recent={2} /></div>}
      </div>
    </Modal>
  );
}

function Access() {
  const { toast, isSuper } = useApp();
  const { data, reload } = useData(() => GET('/api/admin/access'), []);
  const [company, setCompany] = useState('');
  const [q, setQ] = useState('');
  if (!data) return <Spinner />;
  const grant = Object.fromEntries(data.grants.map((g) => [`${g.board_id}:${g.user_id}`, g.role]));
  const boards = data.boards.filter((b) => !company || b.company_code === company);
  const users = data.users.filter((u) => `${u.full_name} ${u.username}`.toLowerCase().includes(q.toLowerCase()));
  const set = async (b, u, role) => {
    try {
      if (role) await PUT(`/api/boards/${b.id}/members/${u.id}`, { role }, { queue: false });
      else await DEL(`/api/boards/${b.id}/members/${u.id}`, { queue: false });
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };
  const codes = [...new Set(data.boards.map((b) => b.company_code))];
  return (
    <div>
      <p className="muted small">Each cell is a user’s role on a board. A user can be a member of many boards. Global admins see every board; unit admins get admin rights on their unit’s boards automatically. {isSuper ? '' : 'Only the super admin can change cells here.'}</p>
      <div className="toolbar">
        <select value={company} onChange={(e) => setCompany(e.target.value)}><option value="">All companies</option>{codes.map((c) => <option key={c}>{c}</option>)}</select>
        <label className="search-input"><ISearch /><input placeholder="Filter people…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <span className="legend-inline"><Pill tone="ok">admin</Pill><Pill tone="info">member</Pill><Pill tone="warn">viewer</Pill></span>
      </div>
      <div className="table-wrap access-matrix">
        <table className="table">
          <thead><tr><th className="sticky">Person</th>{boards.map((b) => <th key={b.id} className="rot-th" title={`${b.company_name} · ${b.unit_name}`}><span>{b.company_code} · {b.title}</span></th>)}</tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id}>
              <td className="sticky"><span className="user-cell"><Avatar user={u} size={22} /><span>{u.full_name}<small className="muted"> {u.role}</small></span></span></td>
              {boards.map((b) => {
                const r = grant[`${b.id}:${u.id}`] || '';
                return (
                  <td key={b.id} className={cls('cell', r)}>
                    <select value={r} disabled={!isSuper} onChange={(e) => set(b, u, e.target.value)} aria-label={`${u.full_name} on ${b.title}`}>
                      <option value="">—</option><option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Roles() {
  const { toast, can } = useApp();
  const { data, reload } = useData(() => GET('/api/admin/roles'), []);
  const [draft, setDraft] = useState({});
  useEffect(() => { if (data) setDraft(Object.fromEntries(data.roles.map((r) => [r.id, new Set(r.permissions)]))); }, [data]);
  if (!data) return <Spinner />;
  const editable = can('admin.roles');
  const toggle = (roleId, key) => setDraft((d) => { const s = new Set(d[roleId]); s.has(key) ? s.delete(key) : s.add(key); return { ...d, [roleId]: s }; });
  const save = async (r) => { try { await PUT(`/api/admin/roles/${r.id}/permissions`, { keys: [...draft[r.id]] }, { queue: false }); toast(`Permissions saved for ${r.name}`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); } };
  const addRole = async () => { const name = prompt('New role name (e.g. qa_lead)'); if (!name) return; try { await POST('/api/admin/roles', { name }, { queue: false }); reload(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div>
      <div className="toolbar"><p className="muted small grow">Role-based access control: a user’s global role decides <b>what</b> they may do; board membership decides <b>where</b>. super_admin always has every permission.</p>
        {editable && <button className="btn" onClick={addRole}><IPlus /> New role</button>}</div>
      <div className="table-wrap"><table className="table perm-matrix">
        <thead><tr><th>Permission</th>{data.roles.map((r) => <th key={r.id} className="center">{r.name}<br /><small className="muted">{r.user_count} users</small></th>)}</tr></thead>
        <tbody>{data.permissions.map((p) => (
          <tr key={p.id}><td><code>{p.key}</code><br /><small className="muted">{p.description}</small></td>
            {data.roles.map((r) => <td key={r.id} className="center"><input type="checkbox" aria-label={`${r.name} ${p.key}`} disabled={!editable || r.name === 'super_admin'} checked={r.name === 'super_admin' || !!draft[r.id]?.has(p.key)} onChange={() => toggle(r.id, p.key)} /></td>)}</tr>
        ))}</tbody>
        {editable && <tfoot><tr><td /> {data.roles.map((r) => <td key={r.id} className="center">{r.name !== 'super_admin' && <button className="btn xs primary" onClick={() => save(r)}><ISave /> Save</button>}</td>)}</tr></tfoot>}
      </table></div>
    </div>
  );
}

function Audit() {
  const { users } = useApp();
  const [f, setF] = useState({ type: '', actor_id: '', from: '', to: '', q: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, loading, reload } = useData(() => GET(`/api/admin/audit?${qs}`), [qs]);
  return (
    <div>
      <div className="toolbar wrap">
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All events</option>{['auth.', 'card.', 'subtask.', 'board.', 'message.', 'admin.', 'ai.', 'pipeline.', 'alert.'].map((t) => <option key={t} value={t}>{t}*</option>)}{(data?.types || []).map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select value={f.actor_id} onChange={(e) => setF({ ...f, actor_id: e.target.value })}><option value="">Anyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From" />
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" />
        <label className="search-input"><ISearch /><input placeholder="Search details…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <button className="btn" onClick={() => download(`/api/admin/audit?${qs}&format=csv`, 'audit-log.csv')}><IDownload /> Export CSV</button>
      </div>
      {loading && !data ? <Spinner /> : (
        <div className="table-wrap"><table className="table audit">
          <thead><tr><th>When</th><th>Actor</th><th>Event</th><th>Where</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{(data?.rows || []).map((r) => (
            <tr key={r.id}><td className="nowrap small" title={r.created_at}>{fmtDateTime(r.created_at)}</td><td>{r.actor_name || <em className="muted">system / AI</em>}</td>
              <td><code>{r.type}</code></td><td className="small">{[r.company_code, r.board_title].filter(Boolean).join(' · ')}</td>
              <td className="small details">{r.details ? JSON.stringify(r.details).slice(0, 160) : ''}</td><td className="small muted">{r.ip}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="muted small">{data?.rows.length || 0} events shown (newest first). <button className="link" onClick={reload}>Refresh</button></p>
    </div>
  );
}

function DbEditor() {
  const { toast } = useApp();
  const { data: tables, reload: reloadTables } = useData(() => GET('/api/admin/db/tables'), []);
  const [t, setT] = useState('az_card');
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  const { data, reload, error } = useData(() => GET(`/api/admin/db/${t}?page=${page}&size=25${q ? `&q=${encodeURIComponent(q)}` : ''}`), [t, page, q]);
  const saveCell = async (row, col, value) => {
    if (String(row[col] ?? '') === value) return;
    try { await PATCH(`/api/admin/db/${t}/${encodeURIComponent(row.__rowid)}`, { [col]: value }, { queue: false }); toast(`${t}.${col} updated`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); reload(); }
  };
  const prot = data?.protection?.kind || 'technical';
  const TRIGGER_OWNED = ['version_no', 'retired_at', 'change_id', 'changed_by', 'doc_no'];
  const del = async (row) => { if (await confirm(`Delete row ${row.__rowid} from the technical table ${t}?`)) { try { await DEL(`/api/admin/db/${t}/${encodeURIComponent(row.__rowid)}`, { queue: false }); reload(); reloadTables(); } catch (e) { toast(e.message, 'error'); } } };
  return (
    <div className="db-editor">
      <aside className="db-tables">
        {(tables || []).map((x) => <button key={x.name} className={cls(t === x.name && 'on')} onClick={() => { setT(x.name); setPage(0); setQ(''); }} title={x.protection?.kind}>
          <span>{x.protection?.kind === 'versioned' ? '🛡 ' : x.protection?.kind === 'technical' ? '' : '🔒 '}{x.name}</span><small>{x.rows}</small></button>)}
      </aside>
      <section className="db-main">
        <div className="toolbar">
          <strong>{t}</strong><span className="muted small">{data?.total ?? '…'} rows · click a cell to edit · {data?.engine === 'pg' ? 'PostgreSQL' : 'SQLite'}</span><span className="grow" />
          {prot === 'versioned' && <span className="pill info" title="Every edit here becomes a new version attributed to you. Rows are never deleted — set is_active = 0 to retire.">🛡 versioned · no delete</span>}
          {(prot === 'immutable' || prot === 'nodelete') && <span className="pill" title="Retained log">🔒 {prot === 'immutable' ? 'append-only log' : 'retained log'}</span>}
          <label className="search-input"><ISearch /><input placeholder="Search rows…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></label>
          <button className="btn" onClick={() => setAdding(true)}><IPlus /> Insert row</button>
          <button className="btn" onClick={() => download(`/api/admin/db-export?table=${t}`, `${t}.csv`)}><IDownload /> CSV</button>
        </div>
        <ErrorBox error={error} />
        {!data ? <Spinner /> : (
          <div className="table-wrap db-grid"><table className="table">
            <thead><tr><th>{data?.engine === 'pg' ? 'ctid' : 'rowid'}</th>{data.columns.map((c) => <th key={c.name} title={c.type}>{c.name}{c.pk && ' 🔑'}</th>)}<th /></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.__rowid}><td className="muted">{r.__rowid}</td>
                {data.columns.map((c) => <td key={c.name}>{c.hidden ? <span className="muted">••••••</span> : <input className="cell-input" defaultValue={r[c.name] ?? ''} title={String(r[c.name] ?? '')} readOnly={prot === 'immutable' || (prot === 'versioned' && TRIGGER_OWNED.includes(c.name))} onBlur={(e) => saveCell(r, c.name, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />}</td>)}
                <td>{prot === 'technical' && <button className="icon-btn sm" onClick={() => del(r)} aria-label="Delete row"><ITrash /></button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {data && <div className="pager"><button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}><ILeft /></button><span>Page {page + 1} of {Math.max(1, Math.ceil(data.total / data.size))}</span><button className="btn sm" disabled={(page + 1) * data.size >= data.total} onClick={() => setPage(page + 1)}><IRight /></button></div>}
      </section>
      {adding && data && <InsertRow table={t} columns={data.columns} onClose={() => { setAdding(false); reload(); reloadTables(); }} />}
      {confirmNode}
    </div>
  );
}

function InsertRow({ table, columns, onClose }) {
  const { toast } = useApp();
  const [f, setF] = useState({});
  const save = async (e) => { e.preventDefault(); try { await POST(`/api/admin/db/${table}`, f, { queue: false }); toast('Row inserted', 'success'); onClose(); } catch (ex) { toast(ex.message, 'error'); } };
  return (
    <Modal title={`Insert into ${table}`} onClose={onClose} width={620}>
      <form className="form" onSubmit={save}>
        <p className="muted small">Leave <code>id</code> empty to auto-generate a UUID. JSON columns take raw JSON text.</p>
        <div className="grid-fields">{columns.map((c) => <Field key={c.name} label={`${c.name}${c.notnull ? ' *' : ''} (${c.type || 'any'})`}><input value={f[c.name] || ''} onChange={(e) => setF({ ...f, [c.name]: e.target.value })} placeholder={c.hidden ? 'plain password — will be hashed' : ''} /></Field>)}</div>
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">Insert</button></div>
      </form>
    </Modal>
  );
}

export { useMemo };
