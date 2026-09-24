// Real-time client.
//  • Local server  → Server-Sent Events (instant push, auto-reconnect).
//  • Vercel        → short polling of /api/events (serverless functions can't hold a stream open).
// The server tells us which one via /api/health → { realtime: 'sse' | 'poll' }.
import { auth } from './api.js';

const listeners = new Map(); // event -> Set<fn>
const EVENTS = ['hello', 'presence', 'notification', 'board:changed', 'message:new', 'message:updated', 'channel:changed', 'typing', 'ops:changed', 'metrics', 'force-logout'];
const POLL_MS = 2500;
const POLL_HIDDEN_MS = 12000;

let es = null;
let status = 'idle';
let mode = null;
let generation = 0; // bumps on every connect/disconnect so stale loops stop
let pollTimer = null;
let pollNow = null;

function dispatch(type, data) {
  (listeners.get(type) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
}
function setStatus(s) { if (s !== status) { status = s; dispatch('status', s); } }

async function detectMode() {
  if (mode) return mode;
  try {
    const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
    mode = h.realtime === 'sse' ? 'sse' : 'poll';
  } catch { mode = 'poll'; }
  return mode;
}

export async function connect() {
  disconnect();
  const gen = generation;
  if (!auth.token) return;
  const m = await detectMode();
  if (gen !== generation) return; // disconnected while detecting
  if (m === 'sse' && typeof EventSource !== 'undefined') startSSE();
  else startPolling(gen);
}

function startSSE() {
  es = new EventSource(`/api/stream?token=${encodeURIComponent(auth.token)}`);
  setStatus('connecting');
  es.onopen = () => setStatus('open');
  es.onerror = () => setStatus(es && es.readyState === 2 ? 'closed' : 'reconnecting');
  for (const ev of EVENTS) es.addEventListener(ev, (e) => { let d = null; try { d = JSON.parse(e.data); } catch {} dispatch(ev, d); });
}

function startPolling(gen) {
  let after = null;
  let failures = 0;
  setStatus('connecting');
  const tick = async () => {
    if (gen !== generation || !auth.token) return;
    try {
      const r = await fetch(`/api/events${after != null ? `?after=${after}` : ''}`, { headers: { Authorization: `Bearer ${auth.token}` }, cache: 'no-store' });
      if (r.status === 401 || r.status === 403) return; // the app's API layer handles sign-out
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      if (gen !== generation) return;
      if (after != null) for (const e of d.events) dispatch(e.event, e.data);
      after = d.last;
      dispatch('hello', { online: d.online });
      failures = 0;
      setStatus('open');
    } catch {
      failures++;
      setStatus('reconnecting');
    }
    if (gen !== generation) return;
    const delay = document.hidden ? POLL_HIDDEN_MS : Math.min(30000, POLL_MS * 2 ** Math.min(failures, 4));
    pollTimer = setTimeout(tick, delay);
  };
  pollNow = () => { clearTimeout(pollTimer); tick(); };
  tick();
}

export function disconnect() {
  generation++;
  if (es) { es.close(); es = null; }
  clearTimeout(pollTimer); pollTimer = null; pollNow = null;
  setStatus('idle');
}
export const rtStatus = () => status;
export const rtMode = () => mode;

if (typeof document !== 'undefined') {
  // poll immediately when the tab becomes visible again
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollNow) pollNow(); });
}

/** subscribe('message:new', fn) → unsubscribe() */
export function subscribe(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
