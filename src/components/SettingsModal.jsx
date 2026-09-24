// Theme & Settings: appearance, profile (user detail table), password, offline sync.
import { useState } from 'react';
import { PATCH, POST, outbox, flushOutbox, clearCache } from '../lib/api.js';
import { useApp, BACKGROUNDS, ACCENTS } from '../lib/store.jsx';
import { Modal, Tabs, Field, Avatar } from './ui.jsx';
import { cls } from '../lib/format.js';
import { IPalette, IUser, IKey, IOffline, IMoon, ISun, IRefresh } from './icons.js';

export function SettingsModal({ tab: initial = 'appearance', onClose }) {
  const [tab, setTab] = useState(initial);
  return (
    <Modal title="Theme & Settings" onClose={onClose} width={640}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'appearance', label: 'Appearance', icon: <IPalette /> },
        { value: 'profile', label: 'Profile', icon: <IUser /> },
        { value: 'password', label: 'Password', icon: <IKey /> },
        { value: 'offline', label: 'Offline & sync', icon: <IOffline /> },
      ]} />
      <div className="settings-body">
        {tab === 'appearance' && <Appearance />}
        {tab === 'profile' && <Profile />}
        {tab === 'password' && <Password />}
        {tab === 'offline' && <Offline />}
      </div>
    </Modal>
  );
}

function Appearance() {
  const { settings, setSettings } = useApp();
  return (
    <div className="form">
      <Field label="Mode">
        <div className="seg">
          {[['dark', <IMoon key="m" />, 'Dark'], ['light', <ISun key="s" />, 'Light'], ['system', null, 'System']].map(([v, i, l]) => (
            <button key={v} className={cls(settings.mode === v && 'on')} onClick={() => setSettings({ mode: v })}>{i}{l}</button>
          ))}
        </div>
      </Field>
      <Field label="Company hub background">
        <div className="bg-picker">{Object.entries(BACKGROUNDS).map(([k, v]) => <button key={k} title={k} className={cls('bg-swatch lg', settings.bg === k && 'on')} style={{ background: v }} onClick={() => setSettings({ bg: k })}><span>{k}</span></button>)}</div>
      </Field>
      <Field label="Accent colour">
        <div className="accent-picker">{ACCENTS.map((a) => <button key={a} aria-label={a} className={cls('accent', settings.accent === a && 'on')} style={{ background: a }} onClick={() => setSettings({ accent: a })} />)}</div>
      </Field>
      <label className="check"><input type="checkbox" checked={settings.compact} onChange={(e) => setSettings({ compact: e.target.checked })} /> Compact cards & lists</label>
      <label className="check"><input type="checkbox" checked={settings.showAging} onChange={(e) => setSettings({ showAging: e.target.checked })} /> Show aging chips on tasks and chats</label>
    </div>
  );
}

function Profile() {
  const { user, setUser, toast } = useApp();
  const [f, setF] = useState({ full_name: user.full_name || '', email: user.email || '', designation: user.designation || '', department: user.department || '', whatsapp_number: user.whatsapp_number || '', avatar_url: user.avatar_url || '', bio: user.bio || '', status: user.status || 'online', color: user.color || '#579dff' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await PATCH('/api/auth/me', f, { queue: false }); setUser(r.user); toast('Profile saved', 'success'); } catch (ex) { toast(ex.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="form" onSubmit={save}>
      <div className="profile-preview"><Avatar user={{ ...user, ...f }} size={56} /><div><strong>{f.full_name}</strong><small>@{user.username} · role: {user.role}</small></div></div>
      <div className="row2"><Field label="Full name"><input required value={f.full_name} onChange={set('full_name')} /></Field><Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field></div>
      <div className="row2"><Field label="Designation"><input value={f.designation} onChange={set('designation')} /></Field><Field label="Department"><input value={f.department} onChange={set('department')} /></Field></div>
      <div className="row2"><Field label="WhatsApp number"><input value={f.whatsapp_number} onChange={set('whatsapp_number')} /></Field>
        <Field label="Status"><select value={f.status} onChange={set('status')}>{['online', 'away', 'busy', 'offline'].map((s) => <option key={s}>{s}</option>)}</select></Field></div>
      <div className="row2"><Field label="Avatar URL" hint="Paste a Google Drive / image link"><input value={f.avatar_url} onChange={set('avatar_url')} /></Field><Field label="Colour"><input type="color" value={f.color} onChange={set('color')} /></Field></div>
      <Field label="Bio"><textarea rows={2} value={f.bio} onChange={set('bio')} /></Field>
      <div className="form-actions"><button className="btn primary" disabled={busy}>Save profile</button></div>
    </form>
  );
}

function Password() {
  const { toast } = useApp();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const save = async (e) => {
    e.preventDefault();
    if (f.next !== f.confirm) return toast('New passwords do not match', 'error');
    try { await POST('/api/auth/password', { current: f.current, next: f.next }, { queue: false }); toast('Password changed', 'success'); setF({ current: '', next: '', confirm: '' }); } catch (ex) { toast(ex.message, 'error'); }
    return null;
  };
  return (
    <form className="form" onSubmit={save}>
      <Field label="Current password"><input type="password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" /></Field>
      <Field label="New password" hint="At least 6 characters"><input type="password" required minLength={6} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" /></Field>
      <Field label="Confirm new password"><input type="password" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" /></Field>
      <div className="form-actions"><button className="btn primary">Change password</button></div>
    </form>
  );
}

function Offline() {
  const { net, toast } = useApp();
  const items = outbox.list();
  return (
    <div className="form">
      <p>Field teams can keep working without a connection: every page you open is cached on this device, and changes you make offline (new tasks, moves, comments, chat messages, subtasks) are queued and replayed in order when you reconnect. Each change carries an idempotency key, so a replay never duplicates data.</p>
      <div className="stat-row">
        <div className="stat"><span>Connection</span><strong className={net.online ? 'ok' : 'bad'}>{net.online ? 'Online' : 'Offline'}</strong></div>
        <div className="stat"><span>Queued changes</span><strong>{items.length}</strong></div>
      </div>
      {items.length > 0 && <ul className="outbox">{items.map((o) => <li key={o.opId}><code>{o.method}</code> {o.url} <small className="muted">{new Date(o.at).toLocaleTimeString()}</small></li>)}</ul>}
      <div className="form-actions">
        <button className="btn" onClick={() => { flushOutbox(); toast('Sync started'); }}><IRefresh /> Sync now</button>
        <button className="btn ghost" onClick={() => { clearCache(); toast('Offline cache cleared'); }}>Clear offline cache</button>
      </div>
    </div>
  );
}
