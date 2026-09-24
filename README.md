# Workflow Hub

Enterprise workflow management for a software house. It combines **Trello-style Kanban boards**, **Slack-style channels**, **AI crew agents**, **deployment and monitoring pipelines**, **dashboards and a report builder**, **RBAC** and a full **audit trail**.

One codebase runs in **two places**:

| | Local machine | Vercel |
|---|---|---|
| Start | `npm run dev` | `git push` / `vercel deploy` |
| API | `server/index.js` (Node server) | `api/index.js` (serverless function) |
| Shared handler | `server/app.js` | `server/app.js` |
| Database | SQLite `data/workflow.db` (zero setup) | PostgreSQL via `DATABASE_URL` |
| Real-time | Server-Sent Events (instant) | event log + 2.5 s polling |
| Scheduler | 30 s timer | Vercel Cron → `api/cron/ops.js` |

**Enterprise data model (v2.1).** Business records are **never physically deleted** and **never overwritten**:

* every change appends a version (who / when / why / what changed), and each record shows its current version and recent changes;
* records are *retired* instead of deleted;
* tasks remember which master-data versions they were posted against.

The database enforces all of this with triggers on both engines. Details: **[docs/MDM_VERSIONING.md](docs/MDM_VERSIONING.md)**.

* **Frontend:** React 19 + Vite. It works as a PWA, fits mobile screens and keeps working offline.
* **Backend:** plain Node.js (`node:http`, `node:crypto`), with `pg` for Postgres and the built-in `node:sqlite` for local use.

---

## 1 · Run it on your machine

Requires **Node.js 22.13 or newer** (for the built-in `node:sqlite`). Check with `node -v`.

```bash
npm install
npm run dev          # API on :4000 + Vite on :5173 (proxying /api)
```

Open **http://localhost:5173**. The first start creates `data/workflow.db` and loads the demo data.

| User ID | Password | Role |
|---|---|---|
| `admin` | `admin123` | **Super admin**: manages users, board access, roles, audit, DB |
| `azam`, `fatima`, `ayesha` | `password123` | Managers |
| `maria`, `mansoor`, `usman`, `sara`, `bilal`, `hina`, `omar`, `zain` | `password123` | Developers, designer, QA, DevOps, AI/ML, WooCommerce |
| `nate` | `password123` | Guest client: **viewer** on the Zenara board only |

**Production build on your machine:** run `npm run build` then `npm start`. The app and API are both served on http://localhost:4000.

**Using Postgres locally as well:** put `DATABASE_URL=postgres://…` in `.env`. The same commands then use Postgres instead of SQLite.

---

## 2 · Deploy to Vercel with Neon (development and production branches)

Vercel functions have no persistent disk, so the SQLite file can't be used there. The app switches to **PostgreSQL** automatically when `DATABASE_URL` is set. The recommended setup is **Neon with two branches**:

```
Neon project
├── main          ← PRODUCTION   → Vercel "Production" DATABASE_URL
└── development   ← DEVELOPMENT  → your laptop's .env  +  Vercel "Preview" DATABASE_URL
```

1. **Create the Neon project** (Vercel → *Storage* → *Create* → Neon, or neon.tech). `main` is production. Create a branch **`development`** from it.
   * Development branch URL goes into your local `.env` (`DATABASE_URL=…`, `APP_ENV=development`).
   * A branch copied from production carries production's environment tag. Relabel it once: `npm run db:tag -- development`.
   * Or start the development branch empty and run `npm run db:seed` for demo data.
2. **Push the code to GitHub** and import the repo in Vercel (*Add New → Project*). The framework is detected as **Vite**, and `vercel.json` sets up the rest.
3. **Set Environment Variables** in *Project → Settings → Environment Variables*:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | **Production:** Neon `main` pooled URL · **Preview:** Neon `development` pooled URL |
   | `JWT_SECRET` | a long random string, e.g. `openssl rand -hex 48`. **Required** |
   | `CRON_SECRET` | any random string. Protects the cron endpoint |
   | `ADMIN_PASSWORD` | password of the Superadmin created in an **empty production** database |
   | `AUTO_SEED` | leave unset. Production then starts with roles + Superadmin only; preview/dev load demo data. `1` forces demo data, `0` never loads it |
   | `ANTHROPIC_API_KEY` | optional, lets the AI crew use Claude |

   The environment comes from Vercel (`VERCEL_ENV`). The database remembers which environment it belongs to, and a mismatch stops the app with a clear message. This prevents, for example, a laptop writing into the production branch.

4. **Deploy.** Then open **`https://<your-app>.vercel.app/api/health`**. You should see:
   * `"ok": true`
   * `"environment": "production"`
   * `"db": "postgres (…)"`
   * `"versioning": "enforced (triggers)"`

   The first call does one of three things:
   * **Empty database:** creates the tables and the versioning triggers, then the Superadmin.
   * **Existing v2 database:** upgrades it in place. That means new columns, triggers, document numbers and a baseline version 1 for every record, all in one transaction.
   * **Up-to-date database:** does nothing.
5. Sign in with `admin` and your `ADMIN_PASSWORD` (default `admin123`, so **change it straight away**).

**Moving data between databases** (run on your machine, `DATABASE_URL` in `.env`):

```bash
npm run db:push      # copies data/workflow.db → DATABASE_URL (replaces what's there; refused on production)
npm run db:pull      # the reverse: DATABASE_URL → data/workflow.db
```

Promote **code**, never data: dev → prod happens through Git/Vercel, and schema + triggers migrate themselves.

**Other database commands**

```bash
npm run db:migrate   # create/update tables + versioning triggers; claims an untagged DB for APP_ENV
npm run db:status    # which DB, its environment tag, this app's environment, version statistics
npm run db:tag -- development   # relabel a Neon branch (e.g. one just copied from production)
npm run db:seed      # wipe + reload demo data (refused on a production-tagged DB)
```

**Custom domain:** *Project → Settings → Domains*. Nothing in the app needs changing.

### How the Vercel side works
* `vercel.json` rewrites `/api/*` to `api/index.js`, except `/api/health` and `/api/cron/*`, which are their own functions. The original path travels as `?wfhpath=…`, and `server/app.js` restores it. Everything else rewrites to `index.html`, which is the SPA fallback.
* **Real-time:** serverless functions can't keep a connection open, so each event is written to the `az_event` table and browsers fetch `/api/events` every 2.5 s (every 12 s in background tabs). The browser picks SSE or polling automatically from `/api/health`.
* **Background work** such as `@ai` replies and pipeline runs is handed to Vercel's `waitUntil()`, so the response returns immediately while the work finishes.
* **Cron:** `vercel.json` runs `/api/cron/ops` once a day, which is what the Hobby plan allows. On Pro you can change the schedule to e.g. `*/5 * * * *` for near-live resource monitoring.
* **Schema:** `server/db/schema.pg.sql` is applied on cold start whenever it changes. An advisory lock stops parallel instances from colliding.
* **Postgres compatibility:** the app's SQL is written once. `server/db/postgres.js` translates `?` placeholders, `INSERT OR IGNORE` and `LIKE` → `ILIKE`. The schema adds `julianday`, `strftime`, `instr` and `json_extract` functions so the reports behave identically on both engines.

---

## What's inside

**Hierarchy:** Group → **Company** → **Unit** (`az_workspace`) → **Project** → **Board** → List → **Task** (`az_card`) → **Subtask**, **Requirement**, **Attachment** and **Comment**.

| Area | Features |
|---|---|
| **Company hub** | "Select Company" screen matching your reference design: gradient backdrop, glass search, photo cards with code badges. Edit mode lets you add, edit and delete companies. |
| **Boards** | Matches the Trello reference: personal **Inbox** panel, drag & drop with mouse and touch (long-press on phones), covers, labels, template cards, due and **age** chips, filters, table view, **Planner** calendar, **Switch boards** and **Share** (board access). Each board also has its own chat drawer. |
| **Tasks** | Assignee, priority, start and due dates, estimate, labels, a description with bullets, subtasks (assignee and due date per subtask), **requirements** (text / PDF / media / link, kept in their own table), **Google Drive attachments** (only the link is stored, with thumbnail and inline preview), pinned comments with @mentions, and an activity / audit feed. |
| **Chat** | Channels (public and private), board channels, DMs, threads, reactions, edits and deletes. **@mentions** with autocomplete (`@azam`) send notifications, and a message waiting on you shows **"Awaiting your reply · 2d"**. Also typing indicators, presence, unread and mention badges, and **Pinned Chats** (a dropdown with a count, as in the reference). |
| **Aging** | Colour-coded age chips (fresh <3d, warm, aging, stale 14d+) on tasks, messages, mentions and alerts. The dashboard adds aging buckets and an "oldest open tasks" list. |
| **Global search** | Press `/` or Ctrl+K. Searches tasks, subtasks, requirements, messages, boards, projects, channels, people and companies, scoped to what you're allowed to see. |
| **Dashboard** | KPIs (open, overdue, completed in the last 7 days, cycle time, aging, alerts, messages), a 30-day throughput chart, work by stage and priority, workload, aging, board health and live activity. |
| **Report builder** | Pick a source (tasks, subtasks, chat, audit log, alerts), a group-by, up to 4 metrics, filters and a chart type (bar, line, pie or table). You can save and share reports and export them to CSV. It only accepts whitelisted fields, so arbitrary SQL can't get through. |
| **Pipelines & alerts** | Deploy, monitor and backup pipelines with live logs. The **real** server metrics (CPU, memory, heap, event-loop lag, DB size) are sampled every 30 s. Failures raise alerts and notify admins, and alerts can be acknowledged or resolved. |
| **AI crew** | **Sentinel** triages (priority, assignee by skill and workload, due date). **Atlas** plans subtasks, **Quill** writes acceptance criteria, **Blaze** turns alerts into incident tasks, and **Echo** summarises channels. In chat you can use `@ai summarize`, `@ai status`, or `@ai create task …` from a board channel. |
| **RBAC** | Global roles (super_admin, admin, manager, developer, guest) map to 22 permission keys, which you can edit as a matrix. Per-board roles (admin, member, viewer) and unit membership then scope everything. One user can belong to many boards. |
| **Admin** | Users (create, change role, deactivate, reset password), a **board access matrix**, roles & permissions, an **audit log** with filters and CSV export, and a **database editor** (super admin only). The editor lets you browse, edit, insert, delete and export any table (SQLite or Postgres). |
| **Offline** | A service worker caches the app shell and every page's data is cached. Changes made offline are queued with an idempotency key (`X-Op-Id`) and replayed in order when the connection returns. |
| **Architecture** | The in-app `/architecture` page has the service diagram, hierarchy, request and real-time flow, offline sync and AI orchestration. There are also Mermaid versions in `docs/ARCHITECTURE.md`. |

Seed data is set in a software house: 5 companies (the ones in your reference screenshot), 12 units, 10 projects, 10 boards (including **AI Board Development** with *AZAM UNCLE TASKS / PROGRESS / ON REVIEW / COMPLETED*), about 76 tasks with subtasks, requirements, Drive links and comments, 27 channels with conversations, 10 pipelines with run history, and alerts, AI runs, saved reports and notifications.

---

## Project layout

```
az_workflow_hub/
├── api/                      ← Vercel functions (thin wrappers)
│   ├── index.js              all /api/* routes → server/app.js
│   ├── health.js             deployment / database check
│   └── cron/ops.js           scheduled metrics + monitors
├── server/
│   ├── app.js                shared request handler (routing, auth, RBAC ctx, idempotency)
│   ├── index.js              local server: SSE, static dist/, 30 s scheduler
│   ├── services/             auth · org · boards · tasks · chat · search · reports · ai · ops · admin · mdm
│   ├── lib/                  http · security · access (RBAC) · realtime · events · chatcore · background · async
│   │                         · mdm (retire/reactivate/history/purge) · environment (dev/prod guard)
│   ├── db/
│   │   ├── index.js          picks SQLite or Postgres; async all/get/run/tx/insert/update
│   │   ├── sqlite.js         node:sqlite adapter (local)
│   │   ├── postgres.js       pg adapter (Vercel / cloud)
│   │   ├── schema.sql        SQLite schema
│   │   ├── schema.pg.sql     Postgres schema + SQLite-compatible SQL functions
│   │   ├── versioning.js     MDM registry + versioning / no-delete triggers for both engines
│   │   ├── seed.js           demo data
│   │   ├── bootstrap.js      empty production DB → roles + Superadmin
│   │   ├── transfer.js       SQLite ⇄ Postgres bulk copy
│   │   └── cli.js            db:migrate / seed / push / pull / status / tag
│   └── tests/                api · mdm · env · vercel (serverless simulation)
├── src/                      React app (pages, components, lib) · components/VersionHistory.jsx · pages/MdmConsole.jsx
├── docs/                     ARCHITECTURE.md · MDM_VERSIONING.md (the data model, all 14 design points)
├── public/                   PWA manifest, service worker, icon
├── data/workflow.db          ← local only (git-ignored)
├── dist/                     ← generated by `npm run build`
├── vite.config.js · vercel.json · package.json · .env (local, git-ignored)
```

**Tests**

```bash
npm test                                                   # 24 API tests on a temp SQLite DB
npm run test:mdm                                           # 18 versioning / no-delete / MDM tests
npm run test:env                                           # 7 dev-vs-production separation tests
TEST_DATABASE_URL=postgres://…/scratch npm run test:mdm    # MDM suite on Postgres (wipes that DB!)
TEST_DATABASE_URL=postgres://…/scratch npm test            # same suite on Postgres (wipes that DB!)
TEST_REALTIME=poll npm test                                # exercise the serverless polling transport
TEST_DATABASE_URL=postgres://…/scratch npm run test:vercel # simulate Vercel: rewrites, req.body, cron…
```

### Schema changes vs. the pasted Postgres schema
* Types were mapped for SQLite: `uuid` becomes TEXT, `timestamptz` becomes ISO TEXT, `jsonb` becomes JSON TEXT, and `boolean` becomes 0/1.
* **New tables:**
  * `users` (auth, alongside the `profiles` detail table)
  * `az_subtask`
  * `az_task_requirement` (text / PDF / media / link)
  * `az_pinned_item`
  * `az_notification`
  * `az_report`
  * `az_ai_agent` and `az_ai_run`
  * `az_pipeline`, `az_pipeline_run`, `az_alert` and `az_metric_sample`
  * `az_sync_op` (offline idempotency)
* **Extra columns:**
  * `az_card`: board, project, priority, labels, cover, template, estimate, completed / archived
  * `az_company`: image and accent
  * `az_board`: background
  * `az_list`: done flag
  * `az_activity_log`: company, entity type and IP

## Notes & limits
* **Google Drive:** attachments are Drive **links**. Thumbnails and previews come from Drive, so viewers need access to the file.
* **Pipelines:** deploy and backup steps are **simulated**, with a configurable failure rate. Monitor pipelines check real server metrics. On Postgres, backups are left to your provider's point-in-time restore.
* **Serverless metrics:** on Vercel, CPU and memory describe the function instance handling the request, not a permanent server.
* **Rate limiting** is in memory per instance. For stricter limits on Vercel, add a KV/Redis-backed limiter or Vercel's Firewall rules.
* **Service worker:** needs `https` (Vercel) or `localhost`.
