// Architecture & flow diagrams: service communication, org hierarchy, request/real-time flow, offline sync, data model.
import { useData } from '../lib/store.jsx';
import { GET } from '../lib/api.js';
import { INetwork } from '../components/icons.js';

function Box({ x, y, w, h, title, sub, tone = 'svc' }) {
  return (
    <g className={`dg-box ${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={10} />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 3 : h / 2 + 5)} textAnchor="middle" className="dg-title">{title}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" className="dg-sub">{sub}</text>}
    </g>
  );
}
const Arrow = ({ d, label, lx, ly, dashed }) => (
  <g className="dg-arrow">
    <path d={d} markerEnd="url(#ah)" strokeDasharray={dashed ? '6 5' : undefined} />
    {label && <text x={lx} y={ly} textAnchor="middle" className="dg-label">{label}</text>}
  </g>
);

const SERVICES = [
  ['Auth', 'signup · login · JWT'], ['Org', 'companies · units · projects'], ['Boards', 'lists · tasks · inbox'], ['Tasks', 'subtasks · reqs · Drive'],
  ['Chat', 'channels · threads · @'], ['Search', 'global · notifications'], ['Reports', 'dashboard · builder'], ['AI crew', 'plan · triage · QA'],
  ['Ops', 'pipelines · alerts'], ['Admin', 'RBAC · audit · DB'],
];

export default function Architecture() {
  const { data: health } = useData(() => GET('/api/health'), []);
  return (
    <div className="page arch">
      <div className="page-head"><div><h1><INetwork /> Architecture &amp; flows</h1><p className="muted">How Workflow Hub’s services communicate and how data moves through them. Running services: {health?.services?.join(', ') || '…'} · AI engine: {health?.ai_engine || '…'}</p></div></div>

      <div className="card-panel">
        <h3>1 · Service architecture</h3>
        <div className="diagram-wrap">
          <svg viewBox="0 0 1000 600" className="diagram" role="img" aria-label="Service architecture diagram">
            <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="dg-head" /></marker></defs>
            <Box x={40} y={20} w={250} h={64} title="React + Vite PWA" sub="desktop · mobile · offline outbox" tone="client" />
            <Box x={375} y={20} w={250} h={64} title="Field teams (mobile)" sub="cached views · queued edits" tone="client" />
            <Box x={710} y={20} w={250} h={64} title="Admins" sub="alerts · audit · access" tone="client" />
            <Arrow d="M165 84 L420 150" label="REST /api (JWT)" lx={250} ly={112} />
            <Arrow d="M500 84 L500 150" />
            <Arrow d="M835 84 L580 150" label="SSE (local) · poll /api/events (Vercel)" lx={742} ly={112} dashed />
            <Box x={250} y={150} w={500} h={70} title="server/app.js — one handler, two runtimes" sub="local: server/index.js · Vercel: api/index.js · auth · RBAC · rate-limit · X-Op-Id" tone="gw" />
            {SERVICES.map(([t, s], i) => {
              const col = i % 5; const row = Math.floor(i / 5);
              return <Box key={t} x={40 + col * 188} y={270 + row * 86} w={170} h={66} title={t} sub={s} />;
            })}
            <Arrow d="M500 220 L500 262" label="route → service module" lx={590} ly={248} />
            <Box x={40} y={470} w={300} h={80} title="SQLite (local) · PostgreSQL (Vercel)" sub="same az_* schema · server/db/{sqlite,postgres}.js" tone="data" />
            <Box x={370} y={470} w={180} h={80} title="Real-time" sub="SSE push · az_event log + polling" tone="rt" />
            <Box x={580} y={470} w={180} h={80} title="Scheduler" sub="30 s timer · Vercel Cron" tone="rt" />
            <Box x={790} y={470} w={170} h={80} title="External" sub="Claude API (opt.) · Drive links" tone="ext" />
            <Arrow d="M190 438 L190 468" /><Arrow d="M460 438 L460 468" dashed /><Arrow d="M670 438 L670 468" dashed /><Arrow d="M875 438 L875 468" dashed />
          </svg>
        </div>
        <p className="small muted">Each service is an isolated module that registers its own routes and owns its tables. Today they run in one process behind the gateway, which keeps setup to a single command. Any module can be moved into its own process later, because services only share the DB layer and the event hub, and never call each other’s routes.</p>
      </div>

      <div className="arch-grid">
        <div className="card-panel">
          <h3>2 · Organisation hierarchy</h3>
          <ol className="hier">
            <li><b>Group</b> <span>az_group · subscription (plan, seats)</span>
              <ol><li><b>Company</b> <span>az_company · code badge, image</span>
                <ol><li><b>Unit</b> <span>az_workspace · members (admin/member/guest)</span>
                  <ol><li><b>Project</b> <span>az_project · status, dates</span>
                    <ol><li><b>Board</b> <span>az_board · board members & roles · log channel</span>
                      <ol><li><b>List</b> <span>az_list · “done” flag</span>
                        <ol><li><b>Task</b> <span>az_card · assignee, priority, due, labels, age</span>
                          <ol><li><b>Subtask</b> <span>az_subtask</span></li><li><b>Requirement</b> <span>az_task_requirement · text / PDF / media / link</span></li><li><b>Attachment</b> <span>az_attachment · Google Drive link + thumbnail</span></li><li><b>Comment</b> <span>az_card_comments</span></li></ol>
                        </li></ol></li></ol></li></ol></li></ol></li></ol></li></ol></li>
          </ol>
        </div>
        <div className="card-panel">
          <h3>3 · Request &amp; real-time flow (moving a task)</h3>
          <ol className="flow">
            <li><b>Browser</b> updates the board optimistically and sends <code>POST /api/cards/:id/move</code> with a JWT and an <code>X-Op-Id</code>.</li>
            <li><b>Gateway</b> verifies the token, loads the user and their role permissions, and checks the op id hasn’t been applied yet.</li>
            <li><b>Boards service</b> checks the user’s board role (member/admin), then re-indexes both lists in one transaction and sets <code>completed_at</code> when the task lands in a done list.</li>
            <li><b>Audit</b> writes <code>card.moved</code> to <code>az_activity_log</code>, posts a system message to the board’s chat channel, and notifies the assignee.</li>
            <li><b>Real-time hub</b> sends <code>board:changed</code> to the board’s audience (members, unit admins, admins): pushed over SSE on the local server, or written to <code>az_event</code> and picked up by the 2.5 s poll on Vercel.</li>
            <li><b>Other clients</b> refetch the board. Anyone with the task open sees it refresh live.</li>
          </ol>
        </div>
        <div className="card-panel">
          <h3>4 · Offline synchronisation (field teams)</h3>
          <ol className="flow">
            <li>Every GET response is cached on the device, and the service worker caches the app shell, so the app opens and shows boards with no signal.</li>
            <li>Edits made offline (tasks, moves, subtasks, comments, messages) get a client-generated UUID. They go into an <b>outbox</b> with a unique <code>X-Op-Id</code>, and the UI updates immediately.</li>
            <li>On reconnect, or every 15 s, the outbox is replayed <b>in order</b>.</li>
            <li>The server records each op id in <code>az_sync_op</code>, and creates are idempotent by id, so a retried request never duplicates data.</li>
            <li>If the server rejects an op (for example, access was revoked in the meantime), the user sees what was rejected.</li>
          </ol>
        </div>
        <div className="card-panel">
          <h3>5 · AI crew orchestration</h3>
          <ol className="flow">
            <li><b>Sentinel (triage)</b> sets priority from the task text and picks an assignee by designation and open workload. It also proposes a due date.</li>
            <li><b>Atlas (planner)</b> creates subtasks from description bullets or domain templates (mobile, WooCommerce, AI, bug, DevOps…).</li>
            <li><b>Quill (QA)</b> writes Given/When/Then acceptance criteria as a text requirement.</li>
            <li><b>Blaze (incident)</b>: when a pipeline fails, it raises an alert, notifies admins, and files an urgent incident task with a runbook on the Ops board.</li>
            <li><b>Echo (scribe)</b> summarises channels on request, or when someone writes <code>@ai summarize</code>.</li>
            <li>Every run is stored in <code>az_ai_run</code> and <code>az_activity_log</code> for the audit trail. With <code>ANTHROPIC_API_KEY</code> set, agents call Claude and fall back to rules on any error.</li>
          </ol>
        </div>
      </div>

      <div className="card-panel">
        <h3>7 · Two deployments, one codebase</h3>
        <div className="table-wrap"><table className="table">
          <thead><tr><th /><th>Local machine</th><th>Vercel</th></tr></thead>
          <tbody>
            <tr><td><b>Entry point</b></td><td><code>server/index.js</code> (long-running Node server)</td><td><code>api/index.js</code> (serverless function) + <code>api/health.js</code> + <code>api/cron/ops.js</code></td></tr>
            <tr><td><b>Request handler</b></td><td colSpan={2}><code>server/app.js</code>: the same routes, auth, RBAC and services in both runtimes</td></tr>
            <tr><td><b>Database</b></td><td>SQLite file <code>data/workflow.db</code> (or Postgres if <code>DATABASE_URL</code> is set)</td><td>PostgreSQL via <code>DATABASE_URL</code> (Neon / Supabase / Vercel Postgres)</td></tr>
            <tr><td><b>Real-time</b></td><td>Server-Sent Events push</td><td>Events stored in <code>az_event</code>, browsers poll every 2.5 s</td></tr>
            <tr><td><b>Scheduler</b></td><td>30-second timer in the process</td><td>Vercel Cron → <code>/api/cron/ops</code></td></tr>
            <tr><td><b>Background work</b></td><td>Runs in the process</td><td><code>waitUntil()</code> keeps the function alive until AI replies / pipeline runs finish</td></tr>
            <tr><td><b>Frontend</b></td><td>Vite dev server, or <code>dist/</code> served by the Node server</td><td><code>dist/</code> on Vercel’s CDN with SPA rewrite</td></tr>
            <tr><td><b>Moving data</b></td><td colSpan={2}><code>npm run db:push</code> copies local SQLite → Postgres · <code>npm run db:pull</code> copies Postgres → local</td></tr>
          </tbody>
        </table></div>
      </div>

      <div className="card-panel">
        <h3>8 · Enterprise data model — no delete, append-only versions</h3>
        <div className="arch-grid tight">
          <div><b>Append / version</b><p className="small">The base table row is the <i>current version</i>. Every business change appends a full snapshot to <code>az_version</code> (who, when, why, changed fields). Database triggers do it, so no code path can overwrite history.</p></div>
          <div><b>No physical delete</b><p className="small">DELETE on business tables raises <code>WFH-NODELETE</code>. Records are <b>retired</b> (<code>is_active = 0</code>) and can be reactivated. A Superadmin-only, reasoned <b>purge</b> is the single exception and leaves a tombstone version.</p></div>
          <div><b>Historical references</b><p className="small">Each version pins the version of every master record it points at (list, board, project, assignee…). A task always shows what it was posted against, even after the master data changed or was retired.</p></div>
          <div><b>Keys &amp; numbers</b><p className="small">UUID primary keys stay technical and never change. Business IDs — company code, username, role name, task <code>ZVL-142</code>, project <code>ZVL-P007</code> — are immutable and never reused.</p></div>
          <div><b>Effective dating</b><p className="small"><code>valid_from</code>/<code>valid_to</code> per version (as-of queries), plus <code>effective_from/to</code> on records: access that ends on a date is retired automatically by the scheduler.</p></div>
          <div><b>Neon branches</b><p className="small">The database is tagged with its environment. A development app refuses a production-tagged database, production refuses development, and <code>db:seed</code>/<code>db:push</code> refuse production targets.</p></div>
        </div>
      </div>

      <div className="card-panel">
        <h3>6 · Security &amp; RBAC</h3>
        <div className="arch-grid tight">
          <div><b>Authentication</b><p className="small">User ID + password. Passwords are hashed with scrypt, and sessions are HS256 JWTs (7 days). Login is rate-limited, and deactivating a user ends their live sessions.</p></div>
          <div><b>Authorisation</b><p className="small">The global role (super_admin, admin, manager, developer, guest) maps to permission keys. On top of that, per-board roles (admin, member, viewer) and unit membership scope every query to what the user may see.</p></div>
          <div><b>Audit trail</b><p className="small">Logins, failures, every mutation, AI runs, pipeline runs, access changes and DB edits go to <code>az_activity_log</code>. The log is filterable and exports to CSV.</p></div>
          <div><b>Data safety</b><p className="small">All SQL is parameterised. The report builder only accepts whitelisted keys, and the DB editor is super-admin only. Password hashes are never returned. Files stay on Google Drive and only their links are stored.</p></div>
        </div>
      </div>
    </div>
  );
}
