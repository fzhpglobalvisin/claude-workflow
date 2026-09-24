// Real-time events.
//  • 'sse'  (local server): events are pushed instantly over Server-Sent Events.
//  • 'poll' (Vercel / serverless): functions can't hold connections open or share memory,
//           so events are written to az_event and browsers poll /api/events every few seconds.
// Events are addressed to user ids ('*' = everyone); the browser filters by topic.
import { IS_SERVERLESS, run, all, get, now } from '../db/index.js';

export const MODE = process.env.REALTIME === 'poll' || IS_SERVERLESS ? 'poll' : 'sse';

// ---------- work that must finish before a serverless function returns ----------
const pending = new Set();
export function track(p) {
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}
export async function flushPending(skip) {
  for (;;) {
    const list = [...pending].filter((p) => p !== skip);
    if (!list.length) return;
    await Promise.allSettled(list);
  }
}

// ---------- SSE clients (local server only) ----------
const clients = new Map(); // userId -> Set<res>
let seq = 0;
function write(res, event, data) {
  try { res.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  if (clients.get(userId).size === 1) broadcast('presence', { userId, online: true });
  return () => {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) { clients.delete(userId); broadcast('presence', { userId, online: false }); }
  };
}

// ---------- event log (poll mode) ----------
function store(userIds, event, data) {
  if (MODE !== 'poll' || !userIds.length) return;
  const t = now();
  const payload = JSON.stringify(data);
  track((async () => {
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      await run(`INSERT INTO az_event (user_id, event, data, created_at) VALUES ${chunk.map(() => '(?,?,?,?)').join(',')}`,
        ...chunk.flatMap((u) => [u, event, payload, t]));
    }
  })().catch((e) => console.error('[realtime] store failed:', e.message)));
}

export function sendTo(userIds, event, data) {
  const ids = [...new Set(userIds.filter(Boolean))];
  for (const id of ids) {
    const set = clients.get(id);
    if (set) for (const res of set) write(res, event, data);
  }
  store(ids, event, data);
}
export function broadcast(event, data) {
  for (const set of clients.values()) for (const res of set) write(res, event, data);
  store(['*'], event, data);
}

const ONLINE_WINDOW_MS = 45000;
export async function onlineUserIds() {
  if (MODE === 'sse') return [...clients.keys()];
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  return (await all('SELECT id FROM users WHERE last_seen_at > ?', since)).map((r) => r.id);
}
export async function clientCount() {
  if (MODE === 'sse') return [...clients.values()].reduce((n, s) => n + s.size, 0);
  return (await onlineUserIds()).length;
}

/** GET /api/events?after=<id> — the polling endpoint. */
export async function pollEvents(user, after) {
  await run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
  const online = await onlineUserIds();
  if (!after) {
    const last = (await get('SELECT MAX(id) AS m FROM az_event'))?.m || 0;
    return { last, events: [], online };
  }
  const rows = await all(`SELECT id, event, data FROM az_event WHERE id > ? AND (user_id = ? OR user_id = '*')
                           ORDER BY id LIMIT 300`, Number(after), user.id);
  if (Math.random() < 0.02) await cleanupEvents();
  const last = rows.length ? rows[rows.length - 1].id : Number(after);
  return { last, events: rows.map((r) => ({ id: r.id, event: r.event, data: JSON.parse(r.data || 'null') })), online };
}
export async function cleanupEvents() {
  await run('DELETE FROM az_event WHERE created_at < ?', new Date(Date.now() - 15 * 60e3).toISOString());
}

// keep-alive ping so proxies don't close idle SSE streams
if (MODE === 'sse') {
  setInterval(() => {
    for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch {} }
  }, 25000).unref();
}
