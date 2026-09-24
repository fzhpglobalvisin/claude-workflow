// Password hashing (scrypt) and JWT (HS256) using node:crypto only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../db/index.js';

import { ConfigError } from '../db/index.js';

let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  if (process.env.JWT_SECRET) return (SECRET = process.env.JWT_SECRET);
  if (process.env.VERCEL) throw new ConfigError('JWT_SECRET is not set. Add a long random JWT_SECRET in Vercel → Project → Settings → Environment Variables (every instance must share it).');
  // local development: generate once and keep it in data/.jwt_secret (git-ignored)
  const f = path.join(ROOT, 'data', '.jwt_secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
  return (SECRET = s);
}
const TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS || 60 * 60 * 24 * 7);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const test = crypto.scryptSync(String(pw), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
export function signToken(payload) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + TTL_SECONDS }));
  const sig = crypto.createHmac('sha256', secret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(`${h}.${b}`).digest('base64url');
  const a = Buffer.from(s); const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (p.exp && p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}
