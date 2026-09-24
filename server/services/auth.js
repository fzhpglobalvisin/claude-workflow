// Auth service — sign up / sign in with username + password, profile (user detail) management.
import { get, all, run, insert, update, uuid, now, tx } from '../db/index.js';
import { hashPassword, verifyPassword, signToken } from '../lib/security.js';
import { HttpError, bad, str } from '../lib/http.js';
import { loadUser } from '../lib/access.js';
import { audit } from '../lib/events.js';
import { onlineUserIds } from '../lib/realtime.js';

const COLORS = ['#0ea5e9', '#8b5cf6', '#f97316', '#10b981', '#ef4444', '#eab308', '#ec4899', '#14b8a6', '#6366f1', '#84cc16'];
const USERNAME = /^[a-z0-9._-]{3,32}$/i;

export function publicUser(u) {
  if (!u) return null;
  const { permissions, ...rest } = u;
  return { ...rest, permissions };
}

export function register(r) {
  r.post('/api/auth/signup', async (ctx) => {
    const b = ctx.body;
    const username = str(b.username, 'Username', { min: 3, max: 32 }).toLowerCase();
    if (!USERNAME.test(username)) throw bad('Username may contain letters, numbers, dot, dash and underscore only');
    const password = str(b.password, 'Password', { min: 6, max: 200 });
    const email = b.email ? str(b.email, 'Email', { max: 200 }).toLowerCase() : null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Email looks invalid');
    if (await get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is already taken');
    if (email && await get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists');
    const id = uuid(); const t = now();
    await tx(async () => {
      // self-service sign-up: the new user is the author (and data owner) of version 1
      await insert('users', { id, username, email, password_hash: hashPassword(password), is_super_admin: 0, is_active: 1, created_at: t, updated_at: t, changed_by: id, owner_id: id, change_note: 'Self sign-up' });
      await insert('profiles', {
        id, full_name: str(b.full_name || username, 'Full name', { max: 120 }), email,
        role: 'developer', designation: b.designation || null, department: b.department || null,
        whatsapp_number: b.whatsapp_number || null, color: COLORS[Math.floor(Math.random() * COLORS.length)],
        status: 'online', is_guest: 0, created_at: t, updated_at: t, changed_by: id, owner_id: id,
      });
      await audit({ actor: id, type: 'auth.signup', entityType: 'user', entityId: id, details: { username }, ip: ctx.ip });
    });
    const user = await loadUser(id);
    return { token: signToken({ sub: id }), user: publicUser(user) };
  }, { public: true });

  r.post('/api/auth/login', async (ctx) => {
    const login = str(ctx.body.username, 'Username').toLowerCase();
    const password = str(ctx.body.password, 'Password');
    const row = await get('SELECT id, password_hash, is_active FROM users WHERE username = ? OR email = ?', login, login);
    if (!row || !verifyPassword(password, row.password_hash)) {
      await audit({ actor: row?.id || null, type: 'auth.failed', entityType: 'user', details: { login }, ip: ctx.ip });
      throw new HttpError(401, 'Invalid username or password');
    }
    if (!row.is_active) throw new HttpError(403, 'This account has been deactivated by the super admin');
    await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), row.id);
    await run("UPDATE profiles SET status = 'online' WHERE id = ?", row.id);
    await audit({ actor: row.id, type: 'auth.login', entityType: 'user', entityId: row.id, ip: ctx.ip });
    return { token: signToken({ sub: row.id }), user: publicUser(await loadUser(row.id)) };
  }, { public: true });

  r.post('/api/auth/logout', async (ctx) => {
    await audit({ actor: ctx.user, type: 'auth.logout', entityType: 'user', entityId: ctx.user.id, ip: ctx.ip });
    return { ok: true };
  });

  r.get('/api/auth/me', (ctx) => ({ user: publicUser(ctx.user) }));

  r.patch('/api/auth/me', async (ctx) => {
    const b = ctx.body; const allowed = {};
    for (const k of ['full_name', 'avatar_url', 'whatsapp_number', 'designation', 'department', 'bio', 'status', 'color']) {
      if (b[k] !== undefined) allowed[k] = b[k] === '' ? null : String(b[k]).slice(0, 500);
    }
    if (allowed.full_name === null) throw bad('Full name cannot be empty');
    allowed.updated_at = now();
    await update('profiles', ctx.user.id, allowed);
    if (b.email !== undefined) {
      const email = b.email ? String(b.email).toLowerCase().trim() : null;
      if (email && await get('SELECT 1 FROM users WHERE email = ? AND id <> ?', email, ctx.user.id)) throw new HttpError(409, 'Email already in use');
      await update('users', ctx.user.id, { email, updated_at: now() }); // versioned + attributed
      await update('profiles', ctx.user.id, { email });
    }
    await audit({ actor: ctx.user, type: 'profile.updated', entityType: 'user', entityId: ctx.user.id, details: Object.keys(allowed), ip: ctx.ip });
    return { user: publicUser(await loadUser(ctx.user.id)) };
  });

  r.post('/api/auth/password', async (ctx) => {
    const cur = str(ctx.body.current, 'Current password');
    const next = str(ctx.body.next, 'New password', { min: 6 });
    const row = await get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!verifyPassword(cur, row.password_hash)) throw bad('Current password is incorrect');
    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(next), now(), ctx.user.id);
    await audit({ actor: ctx.user, type: 'auth.password_changed', entityType: 'user', entityId: ctx.user.id, ip: ctx.ip });
    return { ok: true };
  });

  // People directory (for @mentions, assignees, DMs)
  r.get('/api/users', async () => {
    const online = new Set(await onlineUserIds());
    return (await all(
      `SELECT u.id, u.username, p.full_name, p.avatar_url, p.designation, p.department, p.role, p.color, p.status, p.is_guest
         FROM users u JOIN profiles p ON p.id = u.id WHERE u.is_active = 1 ORDER BY p.full_name`
    )).map((u) => ({ ...u, online: online.has(u.id) }));
  });
}
