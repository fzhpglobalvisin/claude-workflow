// Formatting + aging helpers (timestamps drive the "aging" of chats and tasks).
const DAY = 864e5;

export function timeAgo(iso, { short = false } = {}) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const future = s < 0; const a = Math.abs(s);
  let v; let u;
  if (a < 45) return future ? 'in a moment' : 'just now';
  if (a < 3600) { v = Math.round(a / 60); u = short ? 'm' : 'min'; }
  else if (a < 86400) { v = Math.round(a / 3600); u = short ? 'h' : 'hr'; }
  else if (a < 86400 * 30) { v = Math.round(a / 86400); u = short ? 'd' : 'day'; }
  else if (a < 86400 * 365) { v = Math.round(a / (86400 * 30)); u = short ? 'mo' : 'month'; }
  else { v = Math.round(a / (86400 * 365)); u = short ? 'y' : 'year'; }
  const label = short ? `${v}${u}` : `${v} ${u}${v === 1 ? '' : 's'}`;
  return future ? `in ${label}` : `${label} ago`;
}
export const fmtDate = (iso, opts = { day: 'numeric', month: 'short' }) => (iso ? new Date(iso).toLocaleDateString(undefined, opts) : '');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
export const toInputDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
export const fromInputDate = (s) => (s ? new Date(`${s}T17:00:00`).toISOString() : null);

export const ageDays = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY)) : 0);
/** fresh (<3d) · warm (<7d) · aging (<14d) · stale (14d+) */
export function agingLevel(days) {
  if (days < 3) return 'fresh';
  if (days < 7) return 'warm';
  if (days < 14) return 'aging';
  return 'stale';
}
export function dueStatus(due, done) {
  if (!due) return null;
  if (done) return 'done';
  const diff = new Date(due).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 2 * DAY) return 'soon';
  return 'later';
}
export const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
export const dayLabel = (iso) => {
  const d = new Date(iso); const t = new Date();
  const y = new Date(Date.now() - DAY);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
export const fileSize = (n) => (!n ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
export const PRIORITY_COLORS = { low: '#4bce97', medium: '#579dff', high: '#f5a623', urgent: '#f87168' };
export const cls = (...a) => a.filter(Boolean).join(' ');

export function drivePreview(url) {
  const m = (url || '').match(/\/d\/([a-zA-Z0-9_-]{10,})/) || (url || '').match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  return m ? `https://drive.google.com/file/d/${m[1]}/preview` : null;
}
