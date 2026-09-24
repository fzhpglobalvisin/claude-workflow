// Workflow Hub — local server (your machine).
//   npm run dev    → this API on :4000 + Vite on :5173
//   npm start      → this server also serves the built React app from dist/ on :4000
// Uses SQLite (data/workflow.db) unless DATABASE_URL points at Postgres.
// On Vercel this file is NOT used — api/index.js wraps the same handler from server/app.js.
const [maj, min] = process.versions.node.split('.').map(Number);
if (!process.env.DATABASE_URL && (maj < 22 || (maj === 22 && min < 13))) {
  console.error(`\n✖ Local SQLite mode needs Node.js 22.13+ (built-in node:sqlite). You have ${process.version}.\n  Install the current LTS from https://nodejs.org, or set DATABASE_URL to use Postgres.\n`);
  process.exit(1);
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const db = await import('./db/index.js');
const { handle, init, MODE } = await import('./app.js');
const { HttpError, sendJSON } = await import('./lib/http.js');
const { verifyToken } = await import('./lib/security.js');
const { loadUser } = await import('./lib/access.js');
const { addClient, onlineUserIds } = await import('./lib/realtime.js');
const { startScheduler } = await import('./services/ops.js');
const { engineName } = await import('./services/ai.js');

try { await init(); } catch (e) {
  console.error(`\n✖ Could not start the database: ${e.message}\n`);
  process.exit(1);
}

const DIST = path.join(db.ROOT, 'dist');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain', '.csv': 'text/csv' };

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h2>API is running.</h2><p>In development open the Vite dev server (<code>npm run dev</code> → http://localhost:5173). For production run <code>npm run build</code> first.</p>');
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html'); // SPA fallback
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  return fs.createReadStream(file).pipe(res);
}

/** Server-Sent Events stream — instant real-time on a long-lived server. */
async function stream(req, res, url) {
  try {
    if (MODE !== 'sse') throw new HttpError(404, 'SSE disabled (REALTIME=poll) — use /api/events');
    const payload = verifyToken(url.searchParams.get('token'));
    const user = payload && await loadUser(payload.sub);
    if (!user || !user.is_active) throw new HttpError(401, 'Not signed in');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ userId: user.id, online: await onlineUserIds() })}\n\n`);
    const remove = addClient(user.id, res);
    await db.run("UPDATE profiles SET status = 'online' WHERE id = ? AND status = 'offline'", user.id);
    req.on('close', async () => {
      remove();
      if (!(await onlineUserIds()).includes(user.id)) await db.run("UPDATE profiles SET status = 'offline' WHERE id = ? AND status = 'online'", user.id).catch(() => {});
    });
  } catch (e) {
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  if (url.pathname === '/api/stream') return stream(req, res, url);
  return handle(req, res);
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, async () => {
  startScheduler();
  console.log(`\n  ▲ Workflow Hub API  http://localhost:${PORT}   (db: ${await db.describe()}, realtime: ${MODE}, AI engine: ${engineName()})`);
  if (fs.existsSync(DIST)) console.log(`  ▲ App              http://localhost:${PORT}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { try { await db.close(); } catch {} process.exit(0); });
