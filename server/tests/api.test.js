// End-to-end API tests. Spins up the server on a temp database, runs through auth, RBAC,
// hierarchy, kanban, chat, search, reports, AI crew, ops and admin flows.
//   npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4600 + Math.floor(Math.random() * 300);
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-')), 'test.db');
const BASE = `http://127.0.0.1:${PORT}`;

// Optional: TEST_DATABASE_URL=postgres://… runs the whole suite against Postgres (the database is wiped!)
//           TEST_REALTIME=poll exercises the serverless polling transport instead of SSE.
const PG_URL = process.env.TEST_DATABASE_URL || '';
if (PG_URL) {
  const { createPostgresAdapter } = await import('../db/postgres.js');
  const a = await createPostgresAdapter(PG_URL);
  await a.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await a.close();
}
const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, ANTHROPIC_API_KEY: '', DATABASE_URL: PG_URL, REALTIME: process.env.TEST_REALTIME || '' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start\n' + serverLog);
}
async function api(method, url, body, token, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([name, false]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

try {
  await waitUp();
  console.log(`\nWorkflow Hub API tests  (${BASE})\n`);
  const login = async (u, p = 'password123') => (await api('POST', '/api/auth/login', { username: u, password: p })).data.token;
  let admin, azam, maria, nate, newbie;

  await test('health is public', async () => { const r = await api('GET', '/api/health'); assert.equal(r.status, 200); assert.match(r.data.db, /^(sqlite|postgres)/); assert.equal(r.data.ok, true); });
  await test('protected routes require auth', async () => { assert.equal((await api('GET', '/api/companies')).status, 401); });
  await test('login: wrong password rejected', async () => { assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401); });
  await test('login: seeded users sign in', async () => {
    admin = await login('admin', 'admin123'); azam = await login('azam'); maria = await login('maria'); nate = await login('nate');
    assert.ok(admin && azam && maria && nate);
    const me = await api('GET', '/api/auth/me', null, admin);
    assert.equal(me.data.user.is_super_admin, true);
  });
  await test('signup creates user + detail profile', async () => {
    const r = await api('POST', '/api/auth/signup', { username: 'newdev', password: 'secret12', full_name: 'New Dev', designation: 'Intern' });
    assert.equal(r.status, 200); newbie = r.data.token;
    assert.equal(r.data.user.role, 'developer');
    assert.equal((await api('POST', '/api/auth/signup', { username: 'newdev', password: 'secret12' })).status, 409);
  });
  await test('new user sees no companies until granted access', async () => {
    assert.equal((await api('GET', '/api/companies', null, newbie)).data.length, 0);
  });

  let zvl, aiBoard, lists;
  await test('hierarchy: companies → units → projects → boards', async () => {
    const cs = (await api('GET', '/api/companies', null, admin)).data;
    assert.equal(cs.length, 5);
    zvl = cs.find((c) => c.code === 'ZVL');
    const home = (await api('GET', `/api/companies/${zvl.id}`, null, admin)).data;
    assert.ok(home.units.length >= 4 && home.projects.length >= 5 && home.boards.length >= 5);
    aiBoard = home.boards.find((b) => b.title === 'AI Board Development');
    assert.ok(aiBoard.project_id);
  });
  await test('guest only sees the board he was granted', async () => {
    const boards = (await api('GET', '/api/boards', null, nate)).data;
    assert.deepEqual(boards.map((b) => b.title), ['Zenara Mobile App']);
    assert.equal((await api('GET', `/api/boards/${aiBoard.id}`, null, nate)).status, 403);
  });
  await test('board loads lists and cards like the reference design', async () => {
    const b = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data;
    lists = b.lists;
    assert.deepEqual(lists.map((l) => l.title), ['AZAM UNCLE TASKS', 'PROGRESS 🖌️', 'ON REVIEW 😵', 'COMPLETED 👍']);
    assert.equal(b.cards.filter((c) => c.list_id === lists[2].id).length, 2);
    assert.ok(b.access.canEdit);
  });

  let card;
  await test('create task → subtasks → requirement → Drive attachment → comment', async () => {
    card = (await api('POST', `/api/lists/${lists[0].id}/cards`, { title: 'Build WooCommerce checkout for mobile app', priority: 'high' }, azam)).data;
    assert.ok(card.id);
    const st = (await api('POST', `/api/cards/${card.id}/subtasks`, { title: 'Stripe integration' }, azam)).data;
    assert.equal((await api('PATCH', `/api/subtasks/${st.id}`, { is_done: true }, azam)).data.is_done, 1);
    const rq = await api('POST', `/api/cards/${card.id}/requirements`, { type: 'pdf', title: 'Spec', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view' }, azam);
    assert.equal(rq.data.drive_file_id, '1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    assert.equal((await api('POST', `/api/cards/${card.id}/requirements`, { type: 'text', title: 'Notes' }, azam)).status, 400);
    const at = (await api('POST', `/api/cards/${card.id}/attachments`, { name: 'wire.png', url: 'https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765/view' }, azam)).data;
    assert.ok(at.drive_thumbnail_link.includes('thumbnail?id=1ZyXw'));
    await api('POST', `/api/cards/${card.id}/comments`, { text: 'Please review @maria' }, azam);
    const full = (await api('GET', `/api/cards/${card.id}`, null, azam)).data;
    assert.equal(full.subtasks.length, 1); assert.equal(full.requirements.length, 1); assert.equal(full.attachments.length, 1); assert.equal(full.comments.length, 1);
    assert.ok(full.activity.length >= 4);
  });
  await test('comment @mention notifies the user', async () => {
    const n = (await api('GET', '/api/notifications', null, maria)).data;
    assert.ok(n.items.some((x) => x.type === 'mention' && x.title.includes('Azam')));
  });
  await test('move card to done list sets completed_at and posts to board log', async () => {
    const moved = (await api('POST', `/api/cards/${card.id}/move`, { list_id: lists[3].id, index: 0 }, azam)).data;
    assert.ok(moved.completed_at); assert.equal(moved.list_id, lists[3].id);
    const back = (await api('POST', `/api/cards/${card.id}/move`, { list_id: lists[1].id, index: 0 }, azam)).data;
    assert.equal(back.completed_at, null);
    const b = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data;
    assert.equal(b.cards.filter((c) => c.list_id === lists[1].id)[0].id, card.id);
    const msgs = (await api('GET', `/api/channels/${b.board.log_channel_id}/messages`, null, azam)).data.messages;
    assert.ok(msgs.some((m) => m.type === 'system' && m.content.includes('COMPLETED')));
  });
  await test('viewer role cannot edit; super admin grants access', async () => {
    const zen = (await api('GET', '/api/boards', null, nate)).data[0];
    const zb = (await api('GET', `/api/boards/${zen.id}`, null, nate)).data;
    assert.equal(zb.access.canEdit, false);
    assert.equal((await api('POST', `/api/lists/${zb.lists[0].id}/cards`, { title: 'x' }, nate)).status, 403);
    const me = (await api('GET', '/api/auth/me', null, newbie)).data.user;
    assert.equal((await api('PUT', `/api/boards/${aiBoard.id}/members/${me.id}`, { role: 'member' }, maria)).status, 403);
    assert.equal((await api('PUT', `/api/boards/${aiBoard.id}/members/${me.id}`, { role: 'member' }, admin)).status, 200);
    assert.equal((await api('GET', '/api/boards', null, newbie)).data.length, 1);
  });
  await test('offline replay: same X-Op-Id is applied once', async () => {
    const id = crypto.randomUUID();
    const h = { 'x-op-id': 'op-' + id };
    const a = await api('POST', `/api/lists/${lists[0].id}/cards`, { id, title: 'Queued offline' }, azam, h);
    const b = await api('POST', `/api/lists/${lists[0].id}/cards`, { id, title: 'Queued offline' }, azam, h);
    assert.equal(a.status, 200); assert.equal(b.data.duplicate, true);
    const cards = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data.cards.filter((c) => c.title === 'Queued offline');
    assert.equal(cards.length, 1);
  });

  let eng;
  await test('chat: channels, messages, @mention, thread, reaction, pin', async () => {
    const chs = (await api('GET', `/api/channels?company_id=${zvl.id}`, null, azam)).data;
    eng = chs.find((c) => c.name === 'engineering');
    assert.ok(eng && chs.some((c) => c.type === 'dm'));
    const m = (await api('POST', `/api/channels/${eng.id}/messages`, { content: '@maria awaiting the project design files' }, azam)).data;
    const reply = (await api('POST', `/api/channels/${eng.id}/messages`, { content: 'Uploading now', parent_message_id: m.id }, maria)).data;
    assert.equal(reply.parent_message_id, m.id);
    const r = (await api('POST', `/api/messages/${m.id}/reactions`, { emoji: '👍' }, maria)).data;
    assert.equal(r.reactions[0].count, 1);
    const th = (await api('GET', `/api/messages/${m.id}/thread`, null, azam)).data;
    assert.equal(th.replies.length, 1); assert.equal(th.parent.reply_count, 1);
    const mentions = (await api('GET', '/api/mentions', null, maria)).data;
    assert.ok(mentions.find((x) => x.id === m.id));
    await api('POST', '/api/pins', { message_id: m.id }, azam);
    assert.ok((await api('GET', '/api/pins', null, azam)).data.some((p) => p.message_id === m.id));
  });
  await test('private channel hidden from non-members', async () => {
    const chs = (await api('GET', `/api/channels?company_id=${zvl.id}`, null, maria)).data;
    assert.ok(!chs.some((c) => c.name === 'leadership'));
  });
  await test('@ai in a channel gets an AI reply in-thread', async () => {
    const m = (await api('POST', `/api/channels/${eng.id}/messages`, { content: '@ai status' }, azam)).data;
    await new Promise((r) => setTimeout(r, 400));
    const th = (await api('GET', `/api/messages/${m.id}/thread`, null, azam)).data;
    assert.ok(th.replies.some((x) => x.is_ai_generated && /Status/.test(x.content)));
  });
  await test('global search spans tasks, messages, people', async () => {
    const r = (await api('GET', '/api/search?q=zenara', null, azam)).data;
    assert.ok(r.results.cards.length > 0 && r.results.messages.length > 0);
    const p = (await api('GET', '/api/search?q=azam', null, azam)).data;
    assert.ok(p.results.people.some((x) => x.username === 'azam'));
    const g = (await api('GET', '/api/search?q=leadership', null, maria)).data;
    assert.equal(g.results.channels.length, 0);
  });
  await test('AI crew: triage + plan + QA on a task', async () => {
    const r = (await api('POST', '/api/ai/crew', { card_id: card.id }, azam)).data;
    assert.equal(r.steps.length, 3);
    const full = (await api('GET', `/api/cards/${card.id}`, null, azam)).data;
    assert.ok(full.subtasks.length > 3);
    assert.ok(full.requirements.some((q) => q.title.includes('Acceptance')));
    assert.ok(full.card.assignee_id);
  });
  await test('dashboard + report builder (+ CSV)', async () => {
    const d = (await api('GET', '/api/dashboard', null, azam)).data;
    assert.ok(d.kpi.total > 10 && d.trend.length === 30);
    const st = (await api('POST', '/api/reports/run', { config: { source: 'tasks', dimension: 'state', metrics: ['count'] } }, azam)).data;
    assert.equal(d.kpi.open, st.rows.find((r) => r.label === 'Open').count, 'dashboard open KPI matches report');
    assert.ok(d.kpi.messages_today > 0, 'messages in last 24h counted');
    const r = (await api('POST', '/api/reports/run', { config: { source: 'tasks', dimension: 'assignee', metrics: ['open', 'overdue', 'avg_age_days'] } }, azam)).data;
    assert.ok(r.rows.length > 0 && 'overdue' in r.rows[0]);
    const csv = await fetch(`${BASE}/api/reports/run?format=csv`, { method: 'POST', headers: { authorization: `Bearer ${azam}`, 'content-type': 'application/json' }, body: JSON.stringify({ config: { source: 'messages', dimension: 'channel' } }) });
    assert.match(await csv.text(), /^Channel,Messages/);
    const bad = await api('POST', '/api/reports/run', { config: { source: 'tasks', dimension: 'x; DROP TABLE users', metrics: ['count); --'] } }, azam);
    assert.equal(bad.status, 200); // unknown keys fall back to whitelisted defaults
    assert.equal((await api('POST', '/api/reports/run', { config: { source: 'activity' } }, maria)).status, 403);
    const saved = await api('POST', '/api/reports', { name: 'Test', config: { source: 'tasks', dimension: 'priority' } }, azam);
    assert.equal(saved.status, 200);
    assert.equal((await api('POST', '/api/reports', { name: 'nope', config: { source: 'tasks' } }, maria)).status, 403);
  });
  await test('ops: run pipeline, raise alert, Blaze files incident', async () => {
    const pl = (await api('GET', '/api/ops/pipelines', null, admin)).data;
    const staging = pl.find((p) => p.name.includes('staging'));
    const run = await api('POST', `/api/ops/pipelines/${staging.id}/run`, null, admin);
    assert.ok(run.data.run_id);
    const a = (await api('POST', '/api/ops/alerts', { title: 'Test outage', severity: 'critical', company_id: zvl.id }, admin)).data;
    const inc = (await api('POST', '/api/ai/incident', { alert_id: a.id }, admin)).data;
    assert.ok(inc.card_id);
    const al = (await api('GET', '/api/ops/alerts', null, admin)).data.find((x) => x.id === a.id);
    assert.equal(al.card_id, inc.card_id);
    assert.equal((await api('POST', '/api/ops/alerts', { title: 'x' }, maria)).status, 403);
    const m = (await api('GET', '/api/ops/metrics', null, admin)).data;
    assert.ok(m.current.rss_mb > 0);
  });
  await test('admin: RBAC — only super admin edits roles/db; audit trail records actions', async () => {
    assert.equal((await api('GET', '/api/admin/db/tables', null, azam)).status, 403);
    const tables = (await api('GET', '/api/admin/db/tables', null, admin)).data;
    assert.ok(tables.some((t) => t.name === 'az_task_requirement'));
    const users = (await api('GET', '/api/admin/db/users', null, admin)).data;
    assert.ok(users.rows.every((r) => r.password_hash === '••••••'));
    const audit = (await api('GET', '/api/admin/audit?type=board.access', null, admin)).data;
    assert.ok(audit.rows.some((r) => r.type === 'board.access_granted'));
    const roles = (await api('GET', '/api/admin/roles', null, admin)).data;
    const dev = roles.roles.find((r) => r.name === 'developer');
    await api('PUT', `/api/admin/roles/${dev.id}/permissions`, { keys: [...dev.permissions, 'report.build'] }, admin);
    assert.equal((await api('POST', '/api/reports', { name: 'Maria report', config: { source: 'tasks' } }, maria)).status, 200);
  });
  await test('real-time event log: /api/events delivers new messages (serverless transport)', async () => {
    const h = (await api('GET', '/api/health')).data;
    const first = (await api('GET', '/api/events', null, maria)).data;
    assert.ok('last' in first && Array.isArray(first.online));
    if (h.realtime !== 'poll') return; // SSE mode: events are pushed, nothing stored
    await api('POST', `/api/channels/${eng.id}/messages`, { content: 'poll check @maria' }, azam);
    const next = (await api('GET', `/api/events?after=${first.last}`, null, maria)).data;
    assert.ok(next.events.some((e) => e.event === 'message:new' && e.data.message.content === 'poll check @maria'));
    assert.ok(next.events.some((e) => e.event === 'notification'));
  });
  await test('deactivated user cannot sign in', async () => {
    const list = (await api('GET', '/api/admin/users', null, admin)).data;
    const nd = list.find((u) => u.username === 'newdev');
    await api('PATCH', `/api/admin/users/${nd.id}`, { is_active: false }, admin);
    assert.equal((await api('POST', '/api/auth/login', { username: 'newdev', password: 'secret12' })).status, 403);
    assert.equal((await api('GET', '/api/companies', null, newbie)).status, 403);
  });
} finally {
  srv.kill();
  const passed = results.filter((r) => r[1]).length;
  console.log(`\n${passed}/${results.length} passed\n`);
  if (passed !== results.length) { console.log('--- server log ---\n' + serverLog.slice(-3000)); process.exitCode = 1; }
}
