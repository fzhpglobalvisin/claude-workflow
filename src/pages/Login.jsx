// Sign in / sign up with a simple user ID + password.
import { useState } from 'react';
import { POST } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { navigate } from '../lib/router.jsx';
import { Field } from '../components/ui.jsx';
import { cls } from '../lib/format.js';

const DEMO = [['admin', 'admin123', 'Super admin'], ['azam', 'password123', 'Manager'], ['fatima', 'password123', 'Eng. manager'], ['maria', 'password123', 'Designer'], ['nate', 'password123', 'Client guest']];

export default function Login({ mode: initial }) {
  const { signIn } = useApp();
  const [mode, setMode] = useState(initial);
  const [f, setF] = useState({ username: '', password: '', full_name: '', email: '', designation: '', department: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = await POST(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', f, { queue: false });
      signIn(r.token, r.user);
      navigate('/', { replace: true });
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const switchMode = (m) => { setMode(m); setErr(null); history.replaceState({}, '', m === 'login' ? '/login' : '/signup'); };
  return (
    <div className="auth-page hub-bg">
      <div className="auth-card glass">
        <div className="auth-brand"><img src="/icon.svg" alt="" width="40" height="40" /><div><h1>Workflow Hub</h1><p>Boards · chat · AI crew · pipelines · reports</p></div></div>
        <div className="seg full">
          <button className={cls(mode === 'login' && 'on')} onClick={() => switchMode('login')}>Sign in</button>
          <button className={cls(mode === 'signup' && 'on')} onClick={() => switchMode('signup')}>Create account</button>
        </div>
        <form className="form" onSubmit={submit}>
          {mode === 'signup' && <Field label="Full name"><input required value={f.full_name} onChange={set('full_name')} autoComplete="name" /></Field>}
          <Field label={mode === 'login' ? 'User ID or email' : 'User ID'} hint={mode === 'signup' ? 'Letters, numbers, dot, dash, underscore — this is your @mention handle' : null}>
            <input required autoFocus value={f.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" />
          </Field>
          <Field label="Password"><input type="password" required minLength={mode === 'signup' ? 6 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
          {mode === 'signup' && <>
            <Field label="Email (optional)"><input type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
            <div className="row2"><Field label="Designation"><input value={f.designation} onChange={set('designation')} /></Field><Field label="Department"><input value={f.department} onChange={set('department')} /></Field></div>
            <p className="muted small">New accounts start with no board access — the super admin grants access to companies and boards.</p>
          </>}
          {err && <div className="error-box">{err}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        {mode === 'login' && (
          <div className="demo-users">
            <span className="muted small">Demo accounts (seed data):</span>
            <div>{DEMO.map(([u, p, r]) => <button key={u} className="chip" onClick={() => setF((s) => ({ ...s, username: u, password: p }))}><strong>{u}</strong> <em>{r}</em></button>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
