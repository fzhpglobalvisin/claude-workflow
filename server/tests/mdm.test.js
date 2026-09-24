// Enterprise MDM / versioning tests: no physical delete, append-only versions, point-in-time
// views, pinned historical references, effective-dated access, controlled purge, governance.
//   npm run test:mdm                         (SQLite)
//   TEST_DATABASE_URL=postgres://… npm run test:mdm   (PostgreSQL — the database is wiped!)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4900 + Math.floor(Math.random() * 300);
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wfh-mdm-')), 'test.db');
const BASE = `http://127.0.0.1:${PORT}`;
const PG_URL = process.env.TEST_DATABASE_URL || '';
if (PG_URL) {
  const { createPostgresAdapter } = await import('../db/postgres.js');
  const a = await createPostgresAdapter(PG_URL);
  await a.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await a.close();
}
const env = { ...process.env, PORT: String(PORT), DB_PATH: DB, ANTHROPIC_API_KEY: '', DATABASE_URL: PG_URL, APP_ENV: 'development' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; });

async function waitUp() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start\n' + serverLog);
}
async function api(method, url, body, token) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  ✓ ${name}`); } catch (e) { results.push([name, false]); console.log(`  ✗ ${name}\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ')}`); }
}
/** A second, direct connection — proves the rules hold even when the app is bypassed. */
async function direct() {
  if (PG_URL) { const { createPostgresAdapter } = await import('../db/postgres.js'); return createPostgresAdapter(PG_URL); }
  const { createSqliteAdapter } = await import('../db/sqlite.js'); return createSqliteAdapter(DB);
}

try {
  await waitUp();
  console.log(`\nWorkflow Hub MDM / versioning tests  (${BASE}, ${PG_URL ? 'postgres' : 'sqlite'})\n`);
  const login = async (u, p = 'password123') => (await api('POST', '/api/auth/login', { username: u, password: p })).data.token;
  const admin = await login('admin', 'admin123'); const azam = await login('azam'); const maria = await login('maria');
  const zvl = (await api('GET', '/api/companies', null, admin)).data.find((c) => c.code === 'ZVL');
  const boards = (await api('GET', `/api/boards?company_id=${zvl.id}`, null, azam)).data;
  const aiBoard = boards.find((b) => b.title === 'AI Board Development');
  let board = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data;
  const [todo, doing] = board.lists;
  let card;

  await test('new task gets a business document number (company code) and version 1', async () => {
    const r = await api('POST', `/api/lists/${todo.id}/cards`, { title: 'Credit limit review', priority: 'medium' }, azam);
    assert.equal(r.status, 200); card = r.data;
    assert.match(card.doc_no, /^ZVL-\d+$/);
    assert.equal(card.version_no, 1);
    const h = (await api('GET', `/api/versions/card/${card.id}`, null, azam)).data;
    assert.equal(h.current_version, 1); assert.equal(h.versions[0].operation, 'create'); assert.equal(h.versions[0].changed_by_name, 'Azam Khan');
  });

  let beforeChange;
  await test('a business change appends a version — the old values are kept, not overwritten', async () => {
    await sleep(15); beforeChange = new Date().toISOString(); await sleep(15);
    const r = await api('PATCH', `/api/cards/${card.id}`, { priority: 'urgent', estimate_hours: 8, change_note: 'Customer escalation', base_version: 1 }, azam);
    assert.equal(r.status, 200); assert.equal(r.data.version_no, 2);
    const h = (await api('GET', `/api/versions/card/${card.id}`, null, maria)).data;
    const v2 = h.versions[0];
    assert.equal(v2.version_no, 2); assert.equal(v2.change_note, 'Customer escalation'); assert.equal(v2.changed_by_name, 'Azam Khan');
    assert.deepEqual(v2.changes.find((c) => c.field === 'priority'), { field: 'priority', label: 'Priority', from: 'medium', to: 'urgent', kind: 'text' });
    assert.equal(h.versions[1].data.priority, 'medium');
    assert.equal(h.versions[1].valid_to, v2.valid_from);
  });
  await test('technical changes (drag position) do NOT create versions', async () => {
    await api('POST', `/api/cards/${card.id}/move`, { list_id: todo.id, index: 3 }, azam);
    assert.equal((await api('GET', `/api/versions/card/${card.id}`, null, azam)).data.current_version, 2);
  });
  await test('optimistic concurrency: saving over a newer version is refused (409)', async () => {
    const r = await api('PATCH', `/api/cards/${card.id}`, { title: 'stale edit', base_version: 1 }, maria);
    assert.equal(r.status, 409); assert.match(r.data.error, /version 2/);
  });
  await test('point-in-time: the version effective at a past moment', async () => {
    const r = (await api('GET', `/api/versions/card/${card.id}/at?at=${encodeURIComponent(beforeChange)}`, null, azam)).data;
    assert.equal(r.version_no, 1); assert.equal(r.data.priority, 'medium');
  });

  await test('documents keep pointing at the master-data version they were posted against', async () => {
    const before = (await api('GET', `/api/versions/card/${card.id}/refs`, null, azam)).data;
    const pin = before.references.find((x) => x.field === 'list_id');
    assert.equal(pin.pinned_title, todo.title); assert.equal(pin.changed_since, false);
    await api('PATCH', `/api/lists/${todo.id}`, { title: 'BACKLOG (renamed)' }, azam);
    const after = (await api('GET', `/api/versions/card/${card.id}/refs`, null, azam)).data.references.find((x) => x.field === 'list_id');
    assert.equal(after.pinned_title, todo.title, 'the card version still shows the list as it was');
    assert.equal(after.current_title, 'BACKLOG (renamed)'); assert.equal(after.changed_since, true);
    await api('PATCH', `/api/lists/${todo.id}`, { title: todo.title }, azam);
  });

  await test('DELETE on a task retires it — the row, its subtasks and history remain', async () => {
    await api('POST', `/api/cards/${card.id}/subtasks`, { title: 'Check limits' }, azam);
    const r = await api('DELETE', `/api/cards/${card.id}?reason=${encodeURIComponent('Duplicate of ZVL-1')}`, null, azam);
    assert.equal(r.status, 200); assert.equal(r.data.ok, true);
    const b = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data;
    assert.ok(!b.cards.some((c) => c.id === card.id), 'retired task leaves the board');
    const h = (await api('GET', `/api/versions/card/${card.id}`, null, azam)).data;
    assert.equal(h.is_active, false); assert.equal(h.versions[0].operation, 'retire'); assert.equal(h.versions[0].change_note, 'Duplicate of ZVL-1');
    const d = await direct();
    const row = await d.get('SELECT is_active, archived FROM az_card WHERE id = ?', card.id);
    assert.deepEqual([row.is_active, row.archived], [0, 1]);
    assert.equal((await d.get('SELECT COUNT(*) AS n FROM az_subtask WHERE card_id = ?', card.id)).n, 1);
    await d.close();
  });
  await test('reactivate restores the task as a new version', async () => {
    const r = await api('POST', `/api/mdm/card/${card.id}/reactivate`, { reason: 'Not a duplicate after all' }, azam);
    assert.equal(r.status, 200); assert.equal(r.data.row.is_active, 1); assert.equal(r.data.row.archived, 0);
    const h = (await api('GET', `/api/versions/card/${card.id}`, null, azam)).data;
    assert.equal(h.versions[0].operation, 'reactivate'); assert.equal(h.current_version, 4);
  });

  await test('the database itself refuses physical deletes, key changes and history edits', async () => {
    const d = await direct();
    await assert.rejects(d.run('DELETE FROM az_card WHERE id = ?', card.id), /WFH-NODELETE/);
    await assert.rejects(d.run('DELETE FROM az_company WHERE id = ?', zvl.id), /WFH-NODELETE/);
    await assert.rejects(d.run("UPDATE az_card SET doc_no = 'X-1' WHERE id = ?", card.id), /WFH-IMMUTABLE/);
    await assert.rejects(d.run("UPDATE az_company SET code = 'ZZZ' WHERE id = ?", zvl.id), /WFH-IMMUTABLE/);
    await assert.rejects(d.run("UPDATE az_version SET data = '{}' WHERE entity_id = ?", card.id), /WFH-IMMUTABLE/);
    const log = await d.get('SELECT id FROM az_activity_log LIMIT 1');
    await assert.rejects(d.run('DELETE FROM az_activity_log WHERE id = ?', log.id), /WFH-NODELETE/);
    await assert.rejects(d.run("UPDATE az_activity_log SET type = 'x' WHERE id = ?", log.id), /WFH-IMMUTABLE/);
    // an UPDATE that bypasses the app is still versioned (attributed to "system")
    await d.run("UPDATE az_card SET title = 'Edited in SQL' WHERE id = ?", card.id);
    const v = await d.get('SELECT version_no, changed_by FROM az_version WHERE entity_type = ? AND entity_id = ? ORDER BY version_no DESC LIMIT 1', 'card', card.id);
    assert.deepEqual([v.version_no, v.changed_by], [5, 'system']);
    await d.close();
  });

  await test('retiring a list archives its tasks together; reactivating the list restores them', async () => {
    const l = (await api('POST', `/api/boards/${aiBoard.id}/lists`, { title: 'Parking lot' }, azam)).data;
    const c1 = (await api('POST', `/api/lists/${l.id}/cards`, { title: 'Parked A' }, azam)).data;
    const c2 = (await api('POST', `/api/lists/${l.id}/cards`, { title: 'Parked B' }, azam)).data;
    const r = await api('DELETE', `/api/lists/${l.id}?reason=Cleanup`, null, azam);
    assert.equal(r.data.tasks_archived, 2);
    assert.equal((await api('POST', `/api/lists/${l.id}/cards`, { title: 'into retired list' }, azam)).status, 400);
    const d = await direct();
    await assert.rejects(d.run("INSERT INTO az_card (id, title, position, list_id, board_id, created_at) VALUES ('x-raw-1', 'raw', 0, ?, ?, '2026-01-01')", l.id, aiBoard.id), /WFH-RETIRED-REF/);
    await d.close();
    await api('POST', `/api/mdm/list/${l.id}/reactivate`, { reason: 'Needed again' }, azam);
    const b = (await api('GET', `/api/boards/${aiBoard.id}`, null, azam)).data;
    assert.ok(b.lists.some((x) => x.id === l.id));
    assert.equal(b.cards.filter((c) => [c1.id, c2.id].includes(c.id)).length, 2);
  });

  await test('board access: revoke retires the membership, re-grant reactivates the same record', async () => {
    const users = (await api('GET', '/api/users', null, admin)).data;
    const omar = users.find((u) => u.username === 'omar');
    const omarTok = await login('omar');
    await api('PUT', `/api/boards/${aiBoard.id}/members/${omar.id}`, { role: 'member' }, admin);
    assert.equal((await api('GET', `/api/boards/${aiBoard.id}`, null, omarTok)).status, 200);
    await api('DELETE', `/api/boards/${aiBoard.id}/members/${omar.id}`, null, admin);
    assert.equal((await api('GET', `/api/boards/${aiBoard.id}`, null, omarTok)).status, 403);
    await api('PUT', `/api/boards/${aiBoard.id}/members/${omar.id}`, { role: 'viewer' }, admin);
    const d = await direct();
    const rows = await d.all('SELECT id, version_no, is_active, role FROM az_board_member WHERE board_id = ? AND user_id = ?', aiBoard.id, omar.id);
    assert.equal(rows.length, 1); assert.deepEqual([rows[0].version_no, rows[0].is_active, rows[0].role], [3, 1, 'viewer']);
    await d.close();
  });

  await test('effective dating: access with an end date expires automatically', async () => {
    const users = (await api('GET', '/api/users', null, admin)).data;
    const ayesha = users.find((u) => u.username === 'ayesha');
    const tok = await login('ayesha');
    const until = new Date(Date.now() + 1200).toISOString();
    await api('PUT', `/api/boards/${aiBoard.id}/members/${ayesha.id}`, { role: 'member', effective_to: until }, admin);
    assert.equal((await api('GET', `/api/boards/${aiBoard.id}`, null, tok)).status, 200);
    await sleep(1400);
    const r = (await api('POST', '/api/mdm/effective-dates', {}, admin)).data;
    assert.ok(r.ended >= 1);
    assert.equal((await api('GET', `/api/boards/${aiBoard.id}`, null, tok)).status, 403);
    const d = await direct();
    const m = await d.get('SELECT id FROM az_board_member WHERE board_id = ? AND user_id = ?', aiBoard.id, ayesha.id);
    const v = await d.get("SELECT change_note, changed_by FROM az_version WHERE entity_type = 'board_member' AND entity_id = ? ORDER BY version_no DESC LIMIT 1", m.id);
    assert.deepEqual([v.change_note, v.changed_by], ['Validity period ended', 'system:scheduler']);
    await d.close();
  });

  await test('company = global master data: code is permanent; only the Superadmin retires it', async () => {
    const c = (await api('POST', '/api/companies', { name: 'Temp Co', code: 'TMP' }, admin)).data;
    assert.equal((await api('PATCH', `/api/companies/${c.id}`, { code: 'TMQ' }, admin)).status, 409);
    const upd = await api('PATCH', `/api/companies/${c.id}`, { description: 'Credit limit 150,000', base_version: 1 }, admin);
    assert.equal(upd.data.version_no, 2);
    assert.equal((await api('POST', `/api/mdm/company/${c.id}/retire`, { reason: 'x' }, azam)).status, 403);
    assert.equal((await api('DELETE', `/api/companies/${c.id}?reason=Closed`, null, admin)).status, 200);
    assert.ok(!(await api('GET', '/api/companies', null, admin)).data.some((x) => x.id === c.id));
    assert.equal((await api('POST', '/api/companies', { name: 'Again', code: 'TMP' }, admin)).status, 409, 'codes are never reused');
    const retired = (await api('GET', '/api/mdm/retired?entity=company', null, admin)).data;
    assert.ok(retired.some((x) => x.id === c.id && x.reason === 'Closed'));
    assert.equal((await api('POST', `/api/mdm/company/${c.id}/reactivate`, { reason: 'Reopened' }, admin)).status, 200);
  });

  await test('role permissions are toggled as versions (no delete-and-reinsert)', async () => {
    const roles = (await api('GET', '/api/admin/roles', null, admin)).data;
    const dev = roles.roles.find((r) => r.name === 'developer');
    await api('PUT', `/api/admin/roles/${dev.id}/permissions`, { keys: dev.permissions.filter((k) => k !== 'ai.run') }, admin);
    await api('PUT', `/api/admin/roles/${dev.id}/permissions`, { keys: dev.permissions }, admin);
    const perm = (await api('GET', '/api/admin/roles', null, admin)).data.permissions.find((p) => p.key === 'ai.run');
    const h = (await api('GET', `/api/versions/role_permission/${dev.id}:${perm.id}`, null, admin)).data;
    assert.deepEqual(h.versions.map((v) => v.operation), ['reactivate', 'retire', 'create']);
  });

  await test('DB editor: protected tables cannot be deleted from; technical tables can', async () => {
    const t = (await api('GET', '/api/admin/db/az_card?size=1', null, admin)).data;
    assert.equal(t.protection.kind, 'versioned');
    assert.equal((await api('DELETE', `/api/admin/db/az_card/${encodeURIComponent(t.rows[0].__rowid)}`, null, admin)).status, 409);
    const n = (await api('GET', '/api/admin/db/az_notification?size=1', null, admin)).data;
    assert.equal((await api('DELETE', `/api/admin/db/az_notification/${encodeURIComponent(n.rows[0].__rowid)}`, null, admin)).status, 200);
  });

  await test('controlled purge: Superadmin only, retired leaf records only, reason + confirmation, tombstone kept', async () => {
    const s = (await api('POST', `/api/cards/${card.id}/subtasks`, { title: 'Typo entry' }, azam)).data;
    assert.equal((await api('POST', `/api/mdm/subtask/${s.id}/purge`, { reason: 'Created by mistake', confirm: 'Typo entry' }, azam)).status, 403);
    assert.equal((await api('POST', `/api/mdm/subtask/${s.id}/purge`, { reason: 'Created by mistake', confirm: 'Typo entry' }, admin)).status, 409, 'must be retired first');
    await api('DELETE', `/api/subtasks/${s.id}`, null, azam);
    assert.equal((await api('POST', `/api/mdm/subtask/${s.id}/purge`, { reason: 'short', confirm: 'Typo entry' }, admin)).status, 400);
    assert.equal((await api('POST', `/api/mdm/subtask/${s.id}/purge`, { reason: 'Created by mistake', confirm: 'wrong' }, admin)).status, 400);
    const ok = await api('POST', `/api/mdm/subtask/${s.id}/purge`, { reason: 'Created by mistake', confirm: 'Typo entry' }, admin);
    assert.equal(ok.status, 200);
    const h = (await api('GET', `/api/versions/subtask/${s.id}`, null, admin)).data;
    assert.equal(h.exists, false); assert.equal(h.versions[0].operation, 'purge'); assert.equal(h.versions[0].change_note, 'Created by mistake');
    // a record that is still referenced cannot be purged
    await api('DELETE', `/api/cards/${card.id}`, null, azam);
    const blocked = await api('POST', `/api/mdm/card/${card.id}/purge`, { reason: 'Test purge of parent', confirm: card.doc_no }, admin);
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /subtask/);
  });

  await test('governance console: Superadmin only, integrity checks pass', async () => {
    assert.equal((await api('GET', '/api/mdm/registry', null, azam)).status, 403);
    const reg = (await api('GET', '/api/mdm/registry', null, admin)).data;
    assert.ok(reg.entities.find((e) => e.entity === 'card').versions > 0);
    assert.ok(reg.classification.technical.some((t) => t.table === 'az_event'));
    const ch = (await api('GET', '/api/mdm/changes?limit=20', null, admin)).data;
    assert.ok(ch.length > 0 && ch.every((c) => c.label && c.operation));
    const integ = (await api('GET', '/api/mdm/integrity', null, admin)).data;
    assert.equal(integ.ok, true, JSON.stringify(integ.checks.filter((c) => c.count && c.level === 'error')));
  });

  await test('seeded demo history is attributed to real people', async () => {
    const adv = board.cards.find((c) => c.title === 'AI Business Strategy Advisor');
    const h = (await api('GET', `/api/versions/card/${adv.id}`, null, azam)).data;
    assert.ok(h.current_version >= 4);
    assert.ok(h.versions.some((v) => v.summary.startsWith('Moved:')));
    assert.ok(h.versions.every((v) => v.changed_by_name && v.changed_by_name !== 'system'));
  });
} finally {
  srv.kill();
  const passed = results.filter((r) => r[1]).length;
  console.log(`\n${passed}/${results.length} passed\n`);
  if (passed !== results.length) { console.log('--- server log ---\n' + serverLog.slice(-3000)); process.exitCode = 1; }
}
