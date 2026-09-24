// Background work (AI replies, pipeline runs) that should not block the HTTP response.
//  • Local server: just runs in the same long-lived process.
//  • Vercel: handed to waitUntil() so the function stays alive until the work finishes.
import { flushPending, track } from './realtime.js';

const waitUntil = process.env.VERCEL
  ? await import('@vercel/functions').then((m) => m.waitUntil).catch(() => null)
  : null;

export function defer(fn) {
  const holder = {};
  holder.p = (async () => {
    try { await fn(); } catch (e) { console.error('[background]', e); }
    await flushPending(holder.p); // make sure queued real-time events are written
  })();
  if (waitUntil) waitUntil(holder.p);
  else if (process.env.VERCEL) track(holder.p); // no waitUntil available: finish before responding
  return holder.p;
}
