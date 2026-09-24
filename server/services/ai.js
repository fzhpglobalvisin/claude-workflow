// AI crew service — assistants that automate tasks & subtasks, incident response and summaries.
// Engine: Anthropic Messages API when ANTHROPIC_API_KEY is set, otherwise a deterministic
// built-in heuristic engine (works fully offline, so the app is always demo-able).
import { get, all, run, insert, update, uuid, now, j } from '../db/index.js';
import { bad, notFound, forbidden, str } from '../lib/http.js';
import { requirePerm, boardAudience, adminIds, visibleBoardIds, inList, canViewChannel, visibleCompanyIds } from '../lib/access.js';
import { audit, notify } from '../lib/events.js';
import { sendTo } from '../lib/realtime.js';
import { createMessage, postSystem } from '../lib/chatcore.js';

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5';
export const engineName = () => (API_KEY ? 'anthropic' : 'heuristic');

async function llm(system, prompt, maxTokens = 900) {
  if (!API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) { console.warn('[ai] API error', res.status, (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    return data.content?.map((c) => c.text || '').join('').trim() || null;
  } catch (e) { console.warn('[ai] request failed:', e.message); return null; }
}
async function llmJSON(system, prompt) {
  const text = await llm(system + '\nRespond with JSON only, no prose, no code fences.', prompt);
  if (!text) return null;
  try { return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()); } catch { return null; }
}

const agentByRole = async (role) => await get('SELECT * FROM az_ai_agent WHERE role = ? AND is_active = 1', role);
async function startRun(agent, { cardId = null, channelId = null, userId = null, input }) {
  return await insert('az_ai_run', { id: uuid(), agent_id: agent?.id || null, card_id: cardId, channel_id: channelId, triggered_by: userId, input: input || null, engine: engineName(), status: 'running', created_at: now() });
}
async function finishRun(runRow, output, actions, status = 'success') {
  await update('az_ai_run', runRow.id, { output, actions, status, finished_at: now() });
  return { ...runRow, output, actions, status };
}
async function cardWithCtx(cardId) {
  const card = await get(`SELECT k.*, b.title AS board_title, b.log_channel_id, w.company_id FROM az_card k LEFT JOIN az_board b ON b.id = k.board_id
                     LEFT JOIN az_workspace w ON w.id = b.workspace_id WHERE k.id = ?`, cardId);
  if (!card) throw notFound('Task not found');
  return card;
}
const touchBoard = async (card) => card.board_id && sendTo(await boardAudience(card.board_id), 'board:changed', { boardId: card.board_id, kind: 'card', cardId: card.id });

// ---------------------------------------------------------------- heuristics
const TEMPLATES = [
  [/mobile|android|ios|flutter|react native|app store/i, ['Set up project, CI and environments', 'Design screens & navigation flow', 'Implement authentication flow', 'Build core screens', 'Integrate backend APIs', 'Push notifications & deep links', 'Device QA (Android + iOS)', 'Store listing & submission']],
  [/woocommerce|wordpress|shop|store|e-?commerce|checkout/i, ['Install theme & required plugins', 'Configure products, categories & attributes', 'Payment gateway & shipping zones', 'Customise product & checkout templates', 'Speed optimisation (caching, images)', 'SEO & analytics setup', 'Cross-browser / mobile QA', 'Go-live checklist & backups']],
  [/\b(ai|ml|llm|model|gpt|claude|advisor|chatbot|agent)\b/i, ['Define use-cases & success metrics', 'Collect and clean sample data', 'Prompt / model design', 'Build inference API', 'Evaluation set & scoring', 'Guardrails & safety review', 'Integrate UI', 'Monitor cost & latency']],
  [/bug|fix|error|crash|issue|broken|regression/i, ['Reproduce and capture logs', 'Identify root cause', 'Implement fix', 'Add regression test', 'Code review', 'Deploy hotfix & verify']],
  [/deploy|pipeline|ci|cd|devops|docker|kubernetes|server|infra/i, ['Write deployment manifest', 'Configure secrets & env vars', 'Add health checks', 'Set up monitoring & alerts', 'Dry-run on staging', 'Production rollout & rollback plan']],
  [/design|ui|ux|figma|mockup|landing/i, ['Gather references & moodboard', 'Low-fidelity wireframes', 'High-fidelity mockups', 'Design system tokens', 'Prototype & usability check', 'Developer hand-off']],
  [/api|backend|endpoint|database|schema/i, ['Model the data / schema', 'Define API contract', 'Implement endpoints', 'Auth & permissions', 'Unit + integration tests', 'API docs']],
  [/real ?estate|property|listing/i, ['Property data model', 'Listing search & filters', 'Map integration', 'Lead capture forms', 'Agent dashboard', 'QA & launch']],
];
const GENERIC = ['Clarify requirements with stakeholder', 'Technical design & estimate', 'Implementation', 'Code review', 'QA & acceptance', 'Release & handover'];

function heuristicSubtasks(card) {
  const text = `${card.title} ${card.description || ''}`;
  const bullets = (card.description || '').split('\n').map((l) => l.trim()).filter((l) => /^([-*•]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, '')).filter((l) => l.length > 2);
  if (bullets.length >= 2) return bullets.slice(0, 12);
  for (const [re, steps] of TEMPLATES) if (re.test(text)) return steps;
  return GENERIC;
}
function heuristicPriority(card) {
  const t = `${card.title} ${card.description || ''}`;
  if (/urgent|asap|outage|down|critical|security|breach|p0|production issue/i.test(t)) return 'urgent';
  if (/bug|fix|client|deadline|payment|crash|launch|release/i.test(t)) return 'high';
  if (/docs?|refactor|cleanup|nice to have|research|idea/i.test(t)) return 'low';
  return 'medium';
}
const SKILL_HINTS = [
  [/mobile|android|ios|flutter|react native/i, /mobile/i], [/design|ui|ux|figma|mockup/i, /design/i],
  [/qa|test|regression/i, /qa|test/i], [/deploy|devops|pipeline|server|infra|docker/i, /devops/i],
  [/\b(ai|ml|llm|model|advisor|agent)\b/i, /ai|ml/i], [/api|backend|database/i, /backend|full.?stack/i],
  [/frontend|react|css|landing|woocommerce|wordpress/i, /frontend|full.?stack|wordpress/i],
];
async function suggestAssignee(card) {
  if (!card.board_id) return null;
  const members = await all(`SELECT u.id, u.username, p.full_name, p.designation,
      (SELECT COUNT(*) FROM az_card k JOIN az_list l ON l.id = k.list_id WHERE k.assignee_id = u.id AND l.is_done_list = 0 AND k.archived = 0) AS load
      FROM az_board_member m JOIN users u ON u.id = m.user_id JOIN profiles p ON p.id = u.id
     WHERE m.board_id = ? AND m.is_active = 1 AND m.role <> 'viewer' AND p.is_guest = 0 AND u.is_active = 1`, card.board_id);
  if (!members.length) return null;
  const text = `${card.title} ${card.description || ''}`;
  let pool = members;
  for (const [taskRe, desigRe] of SKILL_HINTS) {
    if (taskRe.test(text)) { const m = members.filter((x) => desigRe.test(x.designation || '')); if (m.length) { pool = m; break; } }
  }
  return pool.sort((a, b) => a.load - b.load)[0];
}
function heuristicCriteria(card, subtasks) {
  const lines = [`Acceptance criteria for “${card.title}”`, ''];
  lines.push(`1. GIVEN the feature is deployed to staging, WHEN a user completes the main flow, THEN it works without errors on desktop and mobile.`);
  (subtasks.length ? subtasks : heuristicSubtasks(card)).slice(0, 5).forEach((s, i) => lines.push(`${i + 2}. “${s.title || s}” is done, reviewed and demonstrable.`));
  lines.push(`${lines.length - 1}. No new console errors; page load under 3 s on 4G.`, `${lines.length}. Audit log shows the change; docs/README updated.`);
  return lines.join('\n');
}
const DUE_OFFSET = { urgent: 1, high: 3, medium: 7, low: 14 };

// ---------------------------------------------------------------- agents
export async function runPlanner(cardId, user) {
  const agent = await agentByRole('planner');
  const card = await cardWithCtx(cardId);
  const runRow = await startRun(agent, { cardId, userId: user?.id, input: card.title });
  let steps = null;
  const ai = await llmJSON('You are Atlas, a senior delivery lead at a software house. Break tasks into 4-8 concrete, verb-first subtasks.',
    `Task: ${card.title}\nDescription: ${card.description || '(none)'}\nReturn {"subtasks": ["..."]}`);
  if (Array.isArray(ai?.subtasks) && ai.subtasks.length) steps = ai.subtasks.map(String).slice(0, 12);
  if (!steps) steps = heuristicSubtasks(card);
  const existing = new Set((await all('SELECT lower(title) AS t FROM az_subtask WHERE card_id = ?', cardId)).map((r) => r.t));
  let pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_subtask WHERE card_id = ?', cardId)).p;
  const created = [];
  for (const title of steps) {
    if (existing.has(title.toLowerCase())) continue;
    created.push(await insert('az_subtask', { id: uuid(), card_id: cardId, title, is_done: 0, position: pos++, created_by: user?.id || null, is_ai_generated: 1, created_at: now(), updated_at: now() }));
  }
  await audit({ actor: user, type: 'ai.subtasks_generated', entityType: 'card', entityId: cardId, boardId: card.board_id, companyId: card.company_id, details: { agent: agent?.name, count: created.length } });
  await touchBoard(card);
  return await finishRun(runRow, `Created ${created.length} subtasks for “${card.title}”.`, { subtasks: created.map((s) => s.title) });
}

export async function runTriage(cardId, user) {
  const agent = await agentByRole('triage');
  const card = await cardWithCtx(cardId);
  const runRow = await startRun(agent, { cardId, userId: user?.id, input: card.title });
  const ai = await llmJSON('You are Sentinel, a triage lead. Classify priority as low|medium|high|urgent.',
    `Task: ${card.title}\nDescription: ${card.description || ''}\nReturn {"priority":"...","reason":"..."}`);
  const priority = ['low', 'medium', 'high', 'urgent'].includes(ai?.priority) ? ai.priority : heuristicPriority(card);
  const patch = { priority, updated_at: now() };
  const actions = { priority, reason: ai?.reason || 'keyword-based classification' };
  if (!card.assignee_id) {
    const who = await suggestAssignee(card);
    if (who) { patch.assignee_id = who.id; actions.assignee = `${who.full_name} (@${who.username}, ${who.designation || 'member'}, ${who.load} open tasks)`; }
  }
  if (!card.due_date) {
    patch.due_date = new Date(Date.now() + DUE_OFFSET[priority] * 864e5).toISOString();
    actions.due_date = patch.due_date.slice(0, 10);
  }
  await update('az_card', cardId, patch);
  if (patch.assignee_id) await notify([patch.assignee_id], { type: 'assign', title: `🤖 Sentinel assigned you “${card.title}”`, body: `Priority: ${priority}`, link: `/board/${card.board_id}?card=${cardId}` });
  await audit({ actor: user, type: 'ai.triaged', entityType: 'card', entityId: cardId, boardId: card.board_id, companyId: card.company_id, details: { agent: agent?.name, ...actions } });
  await touchBoard(card);
  const summary = [`Priority → ${priority}`, actions.assignee && `Assignee → ${actions.assignee}`, actions.due_date && `Due → ${actions.due_date}`].filter(Boolean).join(' · ');
  return await finishRun(runRow, summary, actions);
}

export async function runQA(cardId, user) {
  const agent = await agentByRole('qa');
  const card = await cardWithCtx(cardId);
  const runRow = await startRun(agent, { cardId, userId: user?.id, input: card.title });
  const subtasks = await all('SELECT title FROM az_subtask WHERE card_id = ? ORDER BY position', cardId);
  const text = (await llm('You are Quill, a QA lead. Write 5-8 numbered Given/When/Then acceptance criteria. Plain text.',
    `Task: ${card.title}\nDescription: ${card.description || ''}\nSubtasks: ${subtasks.map((s) => s.title).join('; ')}`)) || heuristicCriteria(card, subtasks);
  const q = await insert('az_task_requirement', { id: uuid(), card_id: cardId, type: 'text', title: 'Acceptance criteria (AI · Quill)', content: text, created_by: user?.id || null, created_at: now(), updated_at: now() });
  await audit({ actor: user, type: 'ai.criteria_written', entityType: 'card', entityId: cardId, boardId: card.board_id, companyId: card.company_id, details: { agent: agent?.name } });
  await touchBoard(card);
  return await finishRun(runRow, 'Added acceptance criteria as a text requirement.', { requirement_id: q.id });
}

export async function runCrew(cardId, user) {
  const steps = [];
  for (const [name, fn] of [['Sentinel · triage', runTriage], ['Atlas · plan', runPlanner], ['Quill · QA', runQA]]) {
    try { const r = await fn(cardId, user); steps.push({ step: name, status: r.status, output: r.output }); }
    catch (e) { steps.push({ step: name, status: 'failed', output: e.message }); }
  }
  const card = await cardWithCtx(cardId);
  if (card.log_channel_id) {
    const ch = await get('SELECT * FROM az_channel WHERE id = ?', card.log_channel_id);
    await createMessage({ user: null, channel: ch, cardId, isAi: true, type: 'ai', metadata: { agent: 'AI Crew' },
      content: `🤖 **AI crew** processed “${card.title}”:\n${steps.map((s) => `• ${s.step}: ${s.output}`).join('\n')}` });
  }
  return { steps };
}

export async function runIncident(alertId, user) {
  const agent = await agentByRole('incident');
  const alert = await get('SELECT a.*, p.name AS pipeline_name, p.board_id AS pipeline_board FROM az_alert a LEFT JOIN az_pipeline p ON p.id = a.pipeline_id WHERE a.id = ?', alertId);
  if (!alert) throw notFound('Alert not found');
  if (alert.card_id) return { card_id: alert.card_id, output: 'Incident task already exists' };
  const runRow = await startRun(agent, { userId: user?.id, input: alert.title });
  const board = alert.pipeline_board ? await get('SELECT * FROM az_board WHERE id = ?', alert.pipeline_board)
    : await get(`SELECT b.* FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = ? AND lower(b.title) LIKE '%ops%' LIMIT 1`, alert.company_id)
      || await get(`SELECT b.* FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = ? LIMIT 1`, alert.company_id);
  if (!board) { await finishRun(runRow, 'No board available for incidents', {}, 'failed'); throw bad('No board found in this company to file the incident'); }
  const list = await get('SELECT * FROM az_list WHERE board_id = ? AND is_done_list = 0 ORDER BY position LIMIT 1', board.id);
  const cardId = uuid(); const t = now();
  const priority = alert.severity === 'critical' ? 'urgent' : 'high';
  const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_card WHERE list_id = ?', list.id)).p;
  await insert('az_card', {
    id: cardId, title: `🔥 Incident: ${alert.title}`, description: `Auto-filed by Blaze from alert (${alert.severity}).\nSource: ${alert.source || alert.pipeline_name}\n\n${alert.message || ''}`,
    position: pos, list_id: list.id, board_id: board.id, project_id: board.project_id, priority, labels: [{ text: 'incident', color: '#ef4444' }, { text: alert.severity, color: '#f97316' }],
    due_date: new Date(Date.now() + (priority === 'urgent' ? 4 : 24) * 36e5).toISOString(), created_by: user?.id || null, created_at: t, updated_at: t,
  });
  const runbook = ['Acknowledge & assign incident commander', 'Check dashboards, logs and recent deploys', 'Mitigate (rollback / scale / hotfix)', 'Confirm recovery with monitoring', 'Write post-mortem & follow-up tasks'];
  for (const [i, title] of runbook.entries()) await insert('az_subtask', { id: uuid(), card_id: cardId, title, position: i, is_ai_generated: 1, is_done: 0, created_at: t, updated_at: t });
  const who = await suggestAssignee({ ...alert, title: 'devops deploy server', board_id: board.id });
  if (who) await update('az_card', cardId, { assignee_id: who.id });
  await update('az_alert', alert.id, { card_id: cardId, status: alert.status === 'open' ? 'acknowledged' : alert.status });
  await notify((await adminIds()).concat(who ? [who.id] : []), { type: 'incident', title: `🔥 Incident filed: ${alert.title}`, body: `${board.title} · ${priority}`, link: `/board/${board.id}?card=${cardId}` });
  await postSystem(board.log_channel_id, `🔥 **Blaze** opened incident “${alert.title}” (${alert.severity})${who ? ` → @${who.username}` : ''}`, { cardId });
  await audit({ actor: user, type: 'ai.incident_filed', entityType: 'card', entityId: cardId, boardId: board.id, companyId: alert.company_id, details: { alert: alert.id, severity: alert.severity } });
  sendTo(await boardAudience(board.id), 'board:changed', { boardId: board.id, kind: 'card', cardId });
  await finishRun(runRow, `Filed incident task on “${board.title}”`, { card_id: cardId, board_id: board.id });
  return { card_id: cardId, board_id: board.id, output: `Filed incident task on “${board.title}”` };
}

export async function runScribe(channelId, user) {
  const agent = await agentByRole('scribe');
  const ch = await get('SELECT * FROM az_channel WHERE id = ?', channelId);
  if (!ch) throw notFound('Channel not found');
  const msgs = (await all(`SELECT m.content, m.created_at, p.full_name FROM az_message m LEFT JOIN profiles p ON p.id = m.user_id
                     WHERE m.channel_id = ? AND m.deleted = 0 AND m.type IN ('text','file') ORDER BY m.created_at DESC LIMIT 60`, channelId)).reverse();
  const runRow = await startRun(agent, { channelId, userId: user?.id, input: `${msgs.length} messages` });
  let summary = await llm('You are Echo, a concise team scribe. Summarise the conversation in <=8 bullets: decisions, open questions, action items with owners.',
    msgs.map((m) => `[${m.created_at.slice(0, 16)}] ${m.full_name}: ${m.content}`).join('\n'));
  if (!summary) {
    const people = [...new Set(msgs.map((m) => m.full_name).filter(Boolean))];
    const questions = msgs.filter((m) => /\?\s*$/.test(m.content || '')).slice(-4);
    const actions = msgs.filter((m) => /\b(will|todo|please|need to|let's|deadline|by (mon|tue|wed|thu|fri|tomorrow|eod))\b/i.test(m.content || '')).slice(-5);
    const mentioned = [...new Set(msgs.flatMap((m) => (m.content || '').match(/@[a-z0-9._-]+/gi) || []))];
    summary = [
      `**Summary of the last ${msgs.length} messages in #${ch.name}**`,
      `• Participants: ${people.join(', ') || '—'}`,
      mentioned.length ? `• People called in: ${mentioned.join(', ')}` : null,
      questions.length ? `• Open questions:\n${questions.map((q) => `   – ${q.full_name}: ${q.content.slice(0, 120)}`).join('\n')}` : '• No open questions detected',
      actions.length ? `• Action items:\n${actions.map((a) => `   – ${a.full_name}: ${a.content.slice(0, 120)}`).join('\n')}` : '• No explicit action items detected',
    ].filter(Boolean).join('\n');
  }
  const { message } = await createMessage({ user: null, channel: ch, content: summary, isAi: true, type: 'ai', metadata: { agent: agent?.name || 'Echo', avatar: agent?.avatar } });
  await finishRun(runRow, summary.slice(0, 500), { message_id: message.id });
  return { message };
}

/** Reply when someone writes @ai / @assistant in a channel. */
export async function respondInChannel({ user, channel, message }) {
  const text = (message.content || '').replace(/@(ai|assistant|atlas|sentinel|quill|blaze|echo)\b/gi, '').trim();
  const reply = async (content, agent = 'Assistant') => await createMessage({ user: null, channel, content, isAi: true, type: 'ai', parentId: message.parent_message_id || message.id, metadata: { agent } });
  const board = channel.type === 'board_log' ? await get('SELECT * FROM az_board WHERE log_channel_id = ?', channel.id) : null;

  if (/^summar/i.test(text) || /\bsummar(y|ise|ize)\b/i.test(text)) return await runScribe(channel.id, user);

  const m = text.match(/^(create|add|new)\s+(a\s+)?(task|card)[:\s]+(.+)/i);
  if (m) {
    if (!board) return await reply('I can create tasks from a board’s log channel. Open the board’s chat and try: `@ai create task Fix checkout bug`.');
    const list = await get('SELECT * FROM az_list WHERE board_id = ? AND is_done_list = 0 ORDER BY position LIMIT 1', board.id);
    const title = m[4].trim().slice(0, 300);
    const id = uuid(); const t = now();
    const pos = (await get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM az_card WHERE list_id = ?', list.id)).p;
    await insert('az_card', { id, title, position: pos, list_id: list.id, board_id: board.id, project_id: board.project_id, created_by: user.id, priority: 'medium', labels: [], created_at: t, updated_at: t });
    await audit({ actor: user, type: 'card.created', entityType: 'card', entityId: id, boardId: board.id, details: { title, via: '@ai' } });
    await runCrew(id, user);
    sendTo(await boardAudience(board.id), 'board:changed', { boardId: board.id, kind: 'card', cardId: id });
    return await reply(`✅ Created “${title}” in *${list.title}* and ran the AI crew on it (priority, assignee, subtasks, acceptance criteria).`);
  }

  if (/overdue|status|stuck|aging|stale|report/i.test(text)) {
    const [bSql, bp] = inList(board ? [board.id] : (await all(`SELECT b.id FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE w.company_id = ?`, channel.company_id)).map((r) => r.id));
    const overdue = await all(`SELECT k.title, k.due_date, p.full_name FROM az_card k JOIN az_list l ON l.id = k.list_id LEFT JOIN profiles p ON p.id = k.assignee_id
                          WHERE k.board_id IN ${bSql} AND l.is_done_list = 0 AND k.archived = 0 AND k.due_date < ? ORDER BY k.due_date LIMIT 8`, ...bp, now());
    const stale = await all(`SELECT k.title, k.updated_at FROM az_card k JOIN az_list l ON l.id = k.list_id
                        WHERE k.board_id IN ${bSql} AND l.is_done_list = 0 AND k.archived = 0 AND k.updated_at < ? ORDER BY k.updated_at LIMIT 5`, ...bp, new Date(Date.now() - 14 * 864e5).toISOString());
    const days = (d) => Math.max(0, Math.round((Date.now() - new Date(d)) / 864e5));
    return await reply([
      `📊 **Status${board ? ` for ${board.title}` : ''}**`,
      overdue.length ? `**Overdue (${overdue.length})**\n${overdue.map((o) => `• ${o.title} — ${days(o.due_date)}d late${o.full_name ? ` · ${o.full_name}` : ''}`).join('\n')}` : '• Nothing overdue 🎉',
      stale.length ? `**Aging (no update in 14d+)**\n${stale.map((s) => `• ${s.title} — idle ${days(s.updated_at)}d`).join('\n')}` : '',
    ].filter(Boolean).join('\n'), 'Sentinel');
  }

  const context = board ? `Board: ${board.title}. Lists: ${(await all('SELECT title FROM az_list WHERE board_id = ?', board.id)).map((l) => l.title).join(', ')}` : `Channel #${channel.name}`;
  const answer = await llm('You are the Workflow Hub assistant for a software house. Be brief and practical.', `${context}\nQuestion from ${user.full_name}: ${text}`);
  return await reply(answer || [
    `Hi ${user.full_name.split(' ')[0]} 👋 I’m running on the built-in engine (set ANTHROPIC_API_KEY for free-form answers). Try:`,
    '• `@ai summarize` — summary of this channel',
    '• `@ai status` — overdue & aging tasks',
    '• `@ai create task <title>` — (in a board channel) create a task and let the crew plan it',
  ].join('\n'));
}

export function register(r) {
  r.get('/api/ai/status', () => ({ engine: engineName(), model: API_KEY ? MODEL : null }));
  r.get('/api/ai/agents', async () => (await all(`SELECT g.*, (SELECT COUNT(*) FROM az_ai_run r WHERE r.agent_id = g.id) AS runs,
                                            (SELECT MAX(created_at) FROM az_ai_run r WHERE r.agent_id = g.id) AS last_run_at FROM az_ai_agent g ORDER BY g.created_at`))
    .map((g) => ({ ...g, is_active: !!g.is_active })));
  r.patch('/api/ai/agents/:id', async (ctx) => {
    requirePerm(ctx.user, 'ai.manage');
    const g = await get('SELECT * FROM az_ai_agent WHERE id = ?', ctx.params.id);
    if (!g) throw notFound('Agent not found');
    const patch = {};
    for (const k of ['goal', 'backstory', 'name']) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
    if (ctx.body.is_active !== undefined) patch.is_active = ctx.body.is_active ? 1 : 0;
    await update('az_ai_agent', g.id, patch);
    await audit({ actor: ctx.user, type: 'ai.agent_updated', entityType: 'agent', entityId: g.id, details: patch, ip: ctx.ip });
    return await get('SELECT * FROM az_ai_agent WHERE id = ?', g.id);
  });
  r.get('/api/ai/runs', async (ctx) => {
    const [bSql, bp] = inList(await visibleBoardIds(ctx.user));
    return (await all(`SELECT r.*, g.name AS agent_name, g.avatar, g.role AS agent_role, k.title AS card_title, k.board_id, p.full_name AS triggered_by_name
                  FROM az_ai_run r LEFT JOIN az_ai_agent g ON g.id = r.agent_id LEFT JOIN az_card k ON k.id = r.card_id LEFT JOIN profiles p ON p.id = r.triggered_by
                 WHERE r.card_id IS NULL OR k.board_id IN ${bSql} ORDER BY r.created_at DESC LIMIT 80`, ...bp)).map((x) => ({ ...x, actions: j(x.actions) }));
  });

  async function onCard(ctx, fn) {
    requirePerm(ctx.user, 'ai.run');
    const cardId = str(ctx.body.card_id, 'card_id');
    const card = await get('SELECT board_id FROM az_card WHERE id = ?', cardId);
    if (!card) throw notFound('Task not found');
    if (card.board_id && !(await visibleBoardIds(ctx.user)).includes(card.board_id)) throw forbidden('No access to this board');
    return fn(cardId, ctx.user);
  }
  r.post('/api/ai/plan', async (ctx) => await onCard(ctx, runPlanner));
  r.post('/api/ai/triage', async (ctx) => await onCard(ctx, runTriage));
  r.post('/api/ai/qa', async (ctx) => await onCard(ctx, runQA));
  r.post('/api/ai/crew', async (ctx) => await onCard(ctx, runCrew));
  r.post('/api/ai/summarize', async (ctx) => {
    requirePerm(ctx.user, 'ai.run');
    const ch = await get('SELECT * FROM az_channel WHERE id = ?', str(ctx.body.channel_id, 'channel_id'));
    if (!ch || !await canViewChannel(ctx.user, ch)) throw forbidden('No access to this channel');
    return await runScribe(ch.id, ctx.user);
  });
  r.post('/api/ai/incident', async (ctx) => {
    requirePerm(ctx.user, 'ai.run');
    const a = await get('SELECT company_id FROM az_alert WHERE id = ?', str(ctx.body.alert_id, 'alert_id'));
    if (!a) throw notFound('Alert not found');
    if (a.company_id && !(await visibleCompanyIds(ctx.user)).includes(a.company_id)) throw forbidden();
    return await runIncident(ctx.body.alert_id, ctx.user);
  });
}
