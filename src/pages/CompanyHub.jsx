// "Select Company" hub — matches the reference design (gradient backdrop, glass search, photo cards).
import { useMemo, useState } from 'react';
import { GET, POST, PATCH, DEL } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { navigate } from '../lib/router.jsx';
import { Modal, Field, Spinner, ErrorBox, useConfirm, Avatar, Popover } from '../components/ui.jsx';
import { PinnedChats, NetBanner } from '../components/TopBar.jsx';
import { SettingsModal } from '../components/SettingsModal.jsx';
import { ISettings, IBuilding, ISearch, IPlus, IEdit, IArchive, ILogout, IArrow, IUser } from '../components/icons.js';
import { cls } from '../lib/format.js';
import { VersionPanel, useRetirePrompt, withReason } from '../components/VersionHistory.jsx';
import { CoverButton } from '../components/CoverPicker.jsx';

export default function CompanyHub() {
  const { user, setCompanyId, can, logout, isSuper, toast } = useApp();
  const { data: companies, loading, error, reload } = useData(() => GET('/api/companies'), []);
  const [q, setQ] = useState('');
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [confirm, confirmNode] = useConfirm();
  const [askRetire, retireNode] = useRetirePrompt();
  const list = useMemo(() => (companies || []).filter((c) => `${c.name} ${c.code}`.toLowerCase().includes(q.toLowerCase())), [companies, q]);
  const enter = (c) => { setCompanyId(c.id); navigate('/home'); };
  // Company = global master data. It is never deleted — the Superadmin retires it (with a reason);
  // units, boards, tasks and history are retained and it can be reactivated in Admin → Master data.
  const retireCompany = async (c) => {
    const why = await askRetire(`Retire company ${c.code} — ${c.name}`, `${c.name} and everything under it (units, boards, tasks, chats) leave circulation. Nothing is deleted, the code ${c.code} is never reused, and the company can be reactivated from Admin → Master data.`, 'Retire company');
    if (why === null) return;
    try { await DEL(withReason(`/api/companies/${c.id}`, why), { queue: false }); toast('Company retired — kept in history', 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="hub hub-bg">
      <NetBanner />
      <header className="hub-head">
        <span className="hub-chip">COMPANY HUB</span>
        <div className="hub-actions">
          {can('company.manage') && <button className={cls('pill-btn dark', editing && 'on')} onClick={() => setEditing(!editing)}><IEdit /> <span className="hide-sm">{editing ? 'Done editing' : 'Edit mode'}</span></button>}
          <PinnedChats variant="dark" />
          <button className="pill-btn dark" onClick={() => setSettings('appearance')}><ISettings /> <span className="hide-sm">Theme &amp; Settings</span></button>
          <Popover width={240} trigger={<button className="avatar-btn"><Avatar user={user} size={32} showPresence /></button>}>
            {(close) => (
              <div className="menu">
                <div className="profile-head"><Avatar user={user} size={36} /><div><strong>{user.full_name}</strong><small>@{user.username} · {user.role}</small></div></div>
                <button className="menu-item" onClick={() => { close(); setSettings('profile'); }}><IUser /> Profile</button>
                <button className="menu-item" onClick={() => { close(); logout(); }}><ILogout /> Sign out</button>
              </div>
            )}
          </Popover>
        </div>
      </header>
      <section className="hub-hero">
        <h1>Select Company</h1>
        <p>Choose an organization below to access project boards, chat channels, and Company settings.</p>
        <label className="hub-search glass"><ISearch /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Company by name or code..." aria-label="Search company" /></label>
      </section>
      {loading && !companies && <Spinner label="Loading companies…" />}
      <ErrorBox error={error} onRetry={reload} />
      <section className="company-grid">
        {list.map((c) => (
          <article key={c.id} className="company-card" style={{ '--img': c.image_url ? `url("${c.image_url}")` : 'none', '--accent-c': c.accent || '#579dff' }}
            onClick={() => !editing && enter(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && enter(c)} role="button" aria-label={`Enter ${c.name}`}>
            <div className="cc-top">
              <span className="cc-icon"><IBuilding /></span>
              <span className="cc-code">{c.code}</span>
            </div>
            <h2>{c.name}</h2>
            <div className="cc-stats"><span>{c.unit_count} units</span><span>{c.board_count} boards</span><span>{c.open_tasks} open tasks</span></div>
            <div className="cc-foot">
              {editing ? (
                <span className="cc-edit">
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); setForm(c); }}><IEdit /> Edit</button>
                  <CoverButton entity="company" id={c.id} url={c.image_url} title={c.name} label="Cover" onSaved={reload} />
                  {isSuper && <button className="btn sm warn" title="Retire company" onClick={(e) => { e.stopPropagation(); retireCompany(c); }}><IArchive /></button>}
                </span>
              ) : <span className="cc-enter">Enter Company <IArrow /></span>}
              <i className="cc-dot" title={c.open_tasks ? `${c.open_tasks} open tasks` : 'All clear'} />
            </div>
          </article>
        ))}
        {editing && <button className="company-card add" onClick={() => setForm({})}><IPlus /><span>Add company</span></button>}
        {companies && !companies.length && (
          <div className="glass hub-empty">
            <h3>No companies yet</h3>
            <p>Your account ({user.username}) hasn’t been given access to any company or board. Ask the super admin to add you to a unit or board.</p>
          </div>
        )}
      </section>
      {form && <CompanyForm company={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {settings && <SettingsModal tab={settings} onClose={() => setSettings(null)} />}
      {confirmNode}
      {retireNode}
    </div>
  );
}

function CompanyForm({ company, onClose, onSaved }) {
  const { toast, isSuper } = useApp();
  const [f, setF] = useState({ name: company.name || '', code: company.code || '', description: company.description || '', image_url: company.image_url || '', accent: company.accent || '#579dff', change_note: '' });
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try {
      // editing master data appends a new version (base_version guards against overwriting someone else's change)
      if (company.id) await PATCH(`/api/companies/${company.id}`, { ...f, base_version: company.version_no }, { queue: false });
      else await POST('/api/companies', f, { queue: false });
      toast(company.id ? 'Company updated' : 'Company created', 'success'); onSaved();
    } catch (ex) { setErr(ex.message); }
  };
  return (
    <Modal title={company.id ? `Edit ${company.name}` : 'Add company'} onClose={onClose} width={company.id ? 860 : 560}>
      <div className={cls(company.id && 'with-history')}>
      <form className="form" onSubmit={save}>
        <div className="row2"><Field label="Name"><input required value={f.name} onChange={set('name')} /></Field>
          <Field label="Code" hint={company.id ? 'Permanent business key — cannot change' : '2–6 letters, permanent (never reused)'}><input required maxLength={6} value={f.code} onChange={set('code')} disabled={!!company.id} /></Field></div>
        <Field label="Description"><input value={f.description} onChange={set('description')} /></Field>
        <Field label="Cover image link" hint={isSuper ? 'Any public image link — Unsplash, Google Drive, Dropbox…' : 'Set by the Superadmin'}><input value={f.image_url} onChange={set('image_url')} disabled={!isSuper} /></Field>
        <Field label="Accent colour"><input type="color" value={f.accent} onChange={set('accent')} /></Field>
        {company.id && <Field label="Reason for this change" hint="Saved on the new version"><input value={f.change_note} onChange={set('change_note')} placeholder="e.g. Rebrand approved by the board" /></Field>}
        {err && <div className="error-box">{err}</div>}
        <div className="form-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary">{company.id ? 'Save as new version' : 'Save'}</button></div>
      </form>
      {company.id && <VersionPanel entity="company" id={company.id} refreshKey={company.version_no} title="Version history" className="aside" />}
      </div>
    </Modal>
  );
}
