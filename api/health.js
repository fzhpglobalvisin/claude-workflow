// GET /api/health — deployment check: database connection, schema, seed status, runtime.
// Open https://<your-app>.vercel.app/api/health after deploying.
import { health } from '../server/app.js';

export default async function handler(req, res) {
  const h = await health();
  res.statusCode = h.ok ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(h));
}
