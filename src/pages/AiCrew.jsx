// AI crew — the agents that automate tasks/subtasks, incidents and summaries.
import { useState } from 'react';
import { GET, POST, PATCH } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { Link } from '../lib/router.jsx';
import { Spinner, TimeAgo, Pill, Field, Empty } from '../components/ui.jsx';
import { cls } from '../lib/format.js';
import { IBot, ISparkles, IBoard, ISearch } from '../components/icons.js';

const HOW = {
  planner: 'Breaks a task into 4–8 concrete subtasks (uses bullet lines in the description when present).',
  triage: 'Sets priority from the task text, picks the best-fit board member by designation and current workload, proposes a due date.',
  qa: 'Writes Given/When/Then acceptance criteria and stores them as a text requirement on the task.',
  incident: 'Turns an alert into an urgent incident task with a runbook checklist on the Ops board and pages admins.',
  scribe: 'Summarises a channel: participants, decisions, open questions and action items. Mention @ai summarize.',
};

export default function AiCrew() {
  const { can, toast } = useApp();
  const { data: status } = useData(() => GET('/api/ai/status'), []);
  const { data: agents, reload } = useData(() => GET('/api/ai/agents'), []);
  const { data: runs, reload: reloadRuns } = useData(() => GET('/api/ai/runs'), []);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(null);

  const search = async () => { if (q.trim().length < 2) return; const r = await GET(`/api/search?q=${encodeURIComponent(q)}`); setResults(r.results.cards); };
  const runOn = async (card, kind) => {
    setBusy(`${card.id}:${kind}`);
    try { await POST(`/api/ai/${kind}`, { card_id: card.id }, { queue: false }); toast(`Done on “${card.title}”`, 'success'); reloadRuns(); reload(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const toggle = async (a) => { try { await PATCH(`/api/ai/agents/${a.id}`, { is_active: !a.is_active }, { queue: false }); reload(); } catch (e) { toast(e.message, 'error'); } };

  return (
    <div className="page ai-page">
      <div className="page-head">
        <div><h1><IBot /> AI crew</h1><p className="muted">A crew of assistants that automate task planning, triage, QA, incident response and summaries.</p></div>
        {status && <Pill tone={status.engine === 'anthropic' ? 'ok' : 'info'}>{status.engine === 'anthropic' ? `Claude API · ${status.model}` : 'Built-in heuristic engine (offline)'}</Pill>}
      </div>
      {status?.engine === 'heuristic' && <p className="note">Running without an API key: agents use deterministic rules, so they work offline. Set <code>ANTHROPIC_API_KEY</code> (and optionally <code>AI_MODEL</code>) before starting the server to let the crew use Claude for free-form planning, criteria and answers.</p>}

      <div className="agent-grid">
        {!agents && <Spinner />}
        {agents?.map((a) => (
          <article key={a.id} className={cls('agent-card', !a.is_active && 'off')}>
            <div className="agent-top"><span className="ai-avatar lg">{a.avatar}</span><div><h3>{a.name}</h3><Pill>{a.role}</Pill></div>
              {can('ai.manage') && <label className="switch" title="Active"><input type="checkbox" checked={a.is_active} onChange={() => toggle(a)} /><i /></label>}</div>
            <p>{a.goal}</p>
            <p className="muted small">{HOW[a.role]}</p>
            <div className="muted small">{a.runs} runs{a.last_run_at && <> · last <TimeAgo iso={a.last_run_at} /></>}</div>
          </article>
        ))}
      </div>

      {can('ai.run') && (
        <div className="card-panel">
          <h3><ISparkles /> Run the crew on a task</h3>
          <div className="row-inline">
            <label className="search-input"><ISearch /><input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Find a task by title…" /></label>
            <button className="btn" onClick={search}>Search</button>
          </div>
          {results && !results.length && <p className="muted">No tasks found.</p>}
          <ul className="plain-list">{results?.map((c) => (
            <li key={c.id} className="run-target">
              <Link to={`/board/${c.board_id}?card=${c.id}`}><strong>{c.title}</strong></Link><small className="muted"> {c.board_title} › {c.list_title}</small>
              <span className="row-inline">
                {[['crew', '🤖 Full crew'], ['triage', '🛡️ Triage'], ['plan', '🧭 Plan'], ['qa', '✒️ Criteria']].map(([k, l]) => <button key={k} className="btn xs" disabled={!!busy} onClick={() => runOn(c, k)}>{busy === `${c.id}:${k}` ? '…' : l}</button>)}
              </span>
            </li>
          ))}</ul>
        </div>
      )}

      <div className="card-panel">
        <h3>Recent runs</h3>
        {!runs ? <Spinner /> : !runs.length ? <Empty title="No runs yet" /> : (
          <ul className="activity">{runs.map((r) => (
            <li key={r.id}><span className="ai-avatar sm">{r.avatar || '🤖'}</span>
              <span><strong>{r.agent_name}</strong> <Pill tone={r.status === 'success' ? 'ok' : r.status === 'failed' ? 'bad' : 'info'}>{r.status}</Pill> <em className="muted small">{r.engine}</em><br />
                {r.output?.slice(0, 220)}{r.card_title && <> — <Link to={`/board/${r.board_id}?card=${r.card_id}`}><IBoard /> {r.card_title}</Link></>}
                <small className="muted"> · {r.triggered_by_name ? `by ${r.triggered_by_name} · ` : ''}<TimeAgo iso={r.created_at} /></small></span></li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}

export { Field };
