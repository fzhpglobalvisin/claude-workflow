// Vercel Cron → GET /api/cron/ops (schedule in vercel.json).
// Samples resource metrics, evaluates "continuous" monitor pipelines (raising alerts), and
// prunes the real-time event log. Locally the same work runs every 30 s in server/index.js.
import { init } from '../../server/app.js';
import { opsTick } from '../../server/services/ops.js';
import { flushPending } from '../../server/lib/realtime.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.end('Unauthorized');
  }
  try {
    await init();
    const metrics = await opsTick();
    await flushPending();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, metrics }));
  } catch (e) {
    console.error('[cron/ops]', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
