// Minimal first-run data for a PRODUCTION database (no demo content):
// the permission catalogue, the five standard roles and one Superadmin account.
//   ADMIN_USERNAME (default admin) / ADMIN_PASSWORD (default admin123 — change it immediately)
import { insert, get, all, uuid, now, withChange, tx } from './index.js';
import { PERMISSIONS, ROLES } from './seed.js';
import { hashPassword } from '../lib/security.js';

export async function bootstrapEmpty() {
  return withChange({ actorId: 'system:bootstrap', note: 'Initial production bootstrap' }, () => tx(async () => {
    if (await get('SELECT 1 AS x FROM users LIMIT 1')) return false;
    const t = now();
    const permId = {};
    for (const [key, description] of Object.entries(PERMISSIONS)) {
      permId[key] = uuid();
      await insert('az_permission', { id: permId[key], key, description, created_at: t });
    }
    for (const [name, [description, keys]] of Object.entries(ROLES)) {
      const id = uuid();
      await insert('az_role', { id, name, description, created_at: t, updated_at: t });
      for (const k of keys) await insert('az_role_permission', { role_id: id, permission_id: permId[k] });
    }
    const id = uuid();
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    await insert('users', { id, username, email: process.env.ADMIN_EMAIL || null, password_hash: hashPassword(process.env.ADMIN_PASSWORD || 'admin123'), is_super_admin: 1, is_active: 1, created_at: t, updated_at: t });
    await insert('profiles', { id, full_name: 'System Administrator', email: process.env.ADMIN_EMAIL || null, role: 'super_admin', designation: 'MDM authority', department: 'Management', color: '#0ea5e9', status: 'offline', is_guest: 0, created_at: t, updated_at: t });
    console.log(`• Empty production database — created roles, permissions and the Superadmin "${username}"${process.env.ADMIN_PASSWORD ? '' : ' (password admin123 — change it now)'}`);
    return true;
  }));
}

/**
 * Keeps the permission catalogue and standard roles of an EXISTING database in step with the
 * code (e.g. `cover.manage` and the `sales_marketing` role added in v2.2). Only adds what is
 * missing — never changes grants an administrator has already configured. Idempotent.
 */
export async function ensureRbacCatalogue() {
  const perms = Object.fromEntries((await all('SELECT id, key FROM az_permission')).map((p) => [p.key, p.id]));
  const roles = Object.fromEntries((await all('SELECT id, name FROM az_role')).map((r) => [r.name, r.id]));
  const missingPerms = Object.keys(PERMISSIONS).filter((k) => !perms[k]);
  const missingRoles = Object.keys(ROLES).filter((r) => !roles[r]);
  if (!missingPerms.length && !missingRoles.length) return { permissions: 0, roles: 0 };
  await withChange({ actorId: 'system:catalogue', note: 'Permission catalogue update' }, () => tx(async () => {
    const t = now();
    for (const key of missingPerms) {
      perms[key] = uuid();
      await insert('az_permission', { id: perms[key], key, description: PERMISSIONS[key], created_at: t });
      // the super_admin role lists every permission
      if (roles.super_admin) await insert('az_role_permission', { role_id: roles.super_admin, permission_id: perms[key] });
    }
    for (const name of missingRoles) {
      const [description, keys] = ROLES[name];
      const id = uuid();
      await insert('az_role', { id, name, description, created_at: t, updated_at: t });
      for (const k of keys) if (perms[k]) await insert('az_role_permission', { role_id: id, permission_id: perms[k] });
    }
  }));
  if (missingPerms.length || missingRoles.length) console.log(`• RBAC catalogue: added ${missingPerms.join(', ') || 'no permissions'}; roles ${missingRoles.join(', ') || 'none'}`);
  return { permissions: missingPerms.length, roles: missingRoles.length };
}
