// Vercel serverless entry — every /api/* request (except /api/health and /api/cron/*) is
// rewritten here by vercel.json. The real path arrives as ?wfhpath=… and is restored in
// server/app.js, so the same handler runs locally (server/index.js) and on Vercel.
import { handle } from '../server/app.js';

export default function handler(req, res) {
  return handle(req, res);
}
