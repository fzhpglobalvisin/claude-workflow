// API client with offline support:
//  • GET responses are cached (localStorage) and served when the network is down.
//  • Mutations made while offline are queued in an outbox with an idempotency key (X-Op-Id)
//    and replayed in order when the connection returns.
export const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

const TOKEN_KEY = 'wfh.token';
const OUTBOX_KEY = 'wfh.outbox';
const CACHE_INDEX = 'wfh.cache.index';
const CACHE_PREFIX = 'wfh.cache:';
const MAX_CACHE = 120;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export function uid() {
  if (globalThis.crypto?.randomUUID) { try { return crypto.randomUUID(); } catch {} }
  const b = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; }));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const auth = {
  get token() { return ls.get(TOKEN_KEY); },
  set(t) { ls.set(TOKEN_KEY, t); },
  clear() { ls.del(TOKEN_KEY); },
};

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ---------------- read cache ----------------
function cacheSet(url, data) {
  const idx = JSON.parse(ls.get(CACHE_INDEX) || '[]').filter((u) => u !== url);
  idx.unshift(url);
  while (idx.length > MAX_CACHE) ls.del(CACHE_PREFIX + idx.pop());
  if (!ls.set(CACHE_PREFIX + url, JSON.stringify(data))) { // quota — drop half the cache and retry once
    idx.splice(MAX_CACHE / 2).forEach((u) => ls.del(CACHE_PREFIX + u));
    ls.set(CACHE_PREFIX + url, JSON.stringify(data));
  }
  ls.set(CACHE_INDEX, JSON.stringify(idx));
}
function cacheGet(url) { const v = ls.get(CACHE_PREFIX + url); return v == null ? undefined : JSON.parse(v); }
export function clearCache() {
  JSON.parse(ls.get(CACHE_INDEX) || '[]').forEach((u) => ls.del(CACHE_PREFIX + u));
  ls.del(CACHE_INDEX);
}

// ---------------- connectivity ----------------
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
export const isOnline = () => online;
function setOnline(v) { if (online !== v) { online = v; emit('online', v); if (v) flushOutbox(); } }

// ---------------- outbox ----------------
export const outbox = {
  list() { try { return JSON.parse(ls.get(OUTBOX_KEY) || '[]'); } catch { return []; } },
  save(items) { ls.set(OUTBOX_KEY, JSON.stringify(items)); emit('outbox', items.length); },
  push(item) { const items = outbox.list(); items.push(item); outbox.save(items); },
};
let flushing = false;
export async function flushOutbox() {
  if (flushing || !auth.token) return;
  flushing = true;
  let items = outbox.list();
  const failed = [];
  try {
    while (items.length) {
      const op = items[0];
      let res;
      try {
        res = await fetch(op.url, { method: op.method, headers: headers(op.opId), body: op.body ? JSON.stringify(op.body) : undefined });
      } catch { setOnline(false); break; } // still offline, keep the queue
      setOnline(true);
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        failed.push({ ...op, error: data.error || res.statusText });
      }
      items = items.slice(1);
      outbox.save(items);
    }
  } finally {
    flushing = false;
    if (failed.length) emit('sync-failed', failed);
    emit('synced', { remaining: items.length });
  }
}

function headers(opId) {
  const h = { 'Content-Type': 'application/json' };
  if (auth.token) h.Authorization = `Bearer ${auth.token}`;
  if (opId) h['X-Op-Id'] = opId;
  return h;
}

/**
 * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
 * @param {string} url
 * @param {object} [body]
 * @param {{queue?: boolean}} [opts] queue=false: fail instead of queueing when offline
 */
export async function api(method, url, body, { queue = true } = {}) {
  const opId = method === 'GET' ? null : `op-${uid()}`;
  let res;
  try {
    res = await fetch(url, { method, headers: headers(opId), body: body ? JSON.stringify(body) : undefined });
  } catch {
    setOnline(false);
    if (method === 'GET') {
      const cached = cacheGet(url);
      if (cached !== undefined) return cached;
      throw new ApiError('You are offline and this view has not been cached yet.', 0);
    }
    if (!queue) throw new ApiError('You are offline — try again when connected.', 0);
    outbox.push({ opId, method, url, body, at: new Date().toISOString() });
    return { ...(body || {}), queued: true };
  }
  setOnline(true);
  if (res.status === 401 && auth.token && !url.startsWith('/api/auth/login')) { emit('unauthorized'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(data?.error || `${res.status} ${res.statusText}`, res.status);
  if (method === 'GET') cacheSet(url, data);
  return data;
}
export const GET = (u) => api('GET', u);
export const POST = (u, b, o) => api('POST', u, b, o);
export const PUT = (u, b, o) => api('PUT', u, b, o);
export const PATCH = (u, b, o) => api('PATCH', u, b, o);
export const DEL = (u, o) => api('DELETE', u, undefined, o);

export async function download(url, filename, body) {
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: headers(), body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new ApiError('Download failed', res.status);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { setOnline(true); flushOutbox(); });
  window.addEventListener('offline', () => setOnline(false));
  setInterval(() => { if (outbox.list().length) flushOutbox(); }, 15000);
}
