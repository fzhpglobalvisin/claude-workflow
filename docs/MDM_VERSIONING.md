# Workflow Hub: enterprise data model, versioning and MDM

Workflow Hub manages business data the way an SAP-style master-data system does. Two rules apply:

- **No physical delete.** Business records are never removed from the database. They are *retired* (`is_active = 0`), and every historical reference to them stays valid.
- **Append instead of overwrite.** An important change writes a *new version*, and the previous version is kept. The system can say which version was in effect at any moment.

Both rules are enforced **inside the database** by triggers that the application installs on every start. They work the same on PostgreSQL (Neon, Vercel) and SQLite (local). The service layer then provides safe operations on top of them (retire, reactivate, history, as-of, controlled purge) and the UI shows the history on each record. No code path can get around them: not the services, not the DB editor, and not a `psql` session.

```
             ┌────────────── application (server/app.js) ───────────────┐
 request ──► │ withChange({actor, note, requestId})  → every write stamped │
             │ services: retire()/reactivate()/update(… _expect_version) │
             └───────────────────────────┬───────────────────────────────┘
                                         ▼
 ┌─────────── database (triggers generated from server/db/versioning.js) ───────────┐
 │ INSERT  → version 1 + document number          DELETE   → WFH-NODELETE (unless purge) │
 │ UPDATE  → business change? version n+1         TRUNCATE → refused                     │
 │           technical change? no version         key change → WFH-IMMUTABLE              │
 │ new/changed reference to retired data → WFH-RETIRED-REF                              │
 │ az_version / az_activity_log → append-only                                           │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1 · Versioning strategy

The model is **current row + append-only version log** (SAP's KNA1 + change documents, or a "type-2 history table").

| Piece | Role |
|---|---|
| Base table (`az_company`, `az_card`, …) | Holds **one row per business record: the current version**. The row keeps its stable technical id, so every existing foreign key, index and query keeps working. |
| `az_version` | Holds **one row per version of every protected record**: a full JSON snapshot of its business columns, which fields changed, who changed them, why, when the version became valid, and the pinned versions of the master data it referenced. Rows are never updated or deleted. |
| Triggers | Maintain `version_no` on the base row and write the `az_version` row in the **same transaction** as the change, so history cannot drift from reality. |

Why not "a new row per version in the base table"? That approach would change the primary key of a record every time it is edited. Every foreign key in the app (card → list → board → unit → company, memberships, messages…) would then need versioned composite keys, and the whole application would have to be rewritten. The current-row + version-log design delivers the same guarantees (nothing overwritten, every version recoverable, as-of queries) with **minimal structural change**.

**Business vs technical columns.** Only business changes create versions. Columns that change constantly and carry no business meaning are registered as *technical* per table and never create a version:

- card and list `position` (drag and drop)
- `updated_at`
- `profiles.status`
- `last_read_at`, `last_login_at`, `last_seen_at`
- pipeline `status` and `last_run_at`
- `channel.updated_at`

`password_hash` is technical **and** excluded from snapshots, so hashes never enter history.

## 2 · PostgreSQL table structure

Columns added to every protected table (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, run automatically):

| Column | Meaning |
|---|---|
| `version_no INTEGER NOT NULL DEFAULT 1` | Current version number. Owned by the trigger: writes to it are ignored. |
| `is_active INTEGER NOT NULL DEFAULT 1` | `0` means retired or inactive. This replaces DELETE. |
| `effective_from TEXT`, `effective_to TEXT` | Business validity period of the record (for example, a board access grant that ends on a date). |
| `retired_at TEXT` | Set by the trigger when `is_active` changes 1 → 0, and cleared on reactivation. |
| `changed_by`, `change_note`, `change_id` | Attribution stamped by the data layer on every business write. |
| `owner_id TEXT` (master data) | Data owner, i.e. who is accountable for the master record. |
| `doc_no TEXT UNIQUE` (tasks, projects) | Business document number. |

New tables:

```sql
CREATE TABLE az_version (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    TEXT NOT NULL,     -- company | unit | project | board | list | card | subtask | …
  entity_id      TEXT NOT NULL,     -- the record's UUID (role grants: role_id:permission_id)
  version_no     INTEGER NOT NULL,  -- 1, 2, 3 …
  operation      TEXT NOT NULL,     -- create | change | retire | reactivate | purge
  valid_from     TEXT NOT NULL,     -- when this version became effective
  recorded_at    TEXT NOT NULL,     -- when it was written (DB clock)
  data           TEXT NOT NULL,     -- JSON snapshot of the business columns
  changed_fields TEXT,              -- JSON array
  changed_by     TEXT,              -- user id | system | system:scheduler
  change_note    TEXT,              -- the reason
  change_id      TEXT,              -- <request>.<n>  (groups changes made together)
  refs           TEXT,              -- JSON: pinned versions of referenced master data
  UNIQUE (entity_type, entity_id, version_no)
);
CREATE VIEW az_version_timeline AS          -- valid_to + is_current, derived (never stored)
  SELECT v.*, LEAD(valid_from) OVER w AS valid_to, (LEAD(version_no) OVER w IS NULL) AS is_current
  FROM az_version v WINDOW w AS (PARTITION BY entity_type, entity_id ORDER BY version_no);

CREATE TABLE az_number_range (range_key TEXT PRIMARY KEY, last_no INTEGER NOT NULL, updated_at TEXT);
CREATE TABLE az_meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version, environment
```

On PostgreSQL there is **one generic PL/pgSQL trigger function**, `wfh_version_trg()`. Each table's registry entry is passed to it as a JSON trigger argument. Each protected table also gets a `BEFORE TRUNCATE` guard. On SQLite the same rules are generated as per-table triggers. Both are produced from **one registry**: `server/db/versioning.js`.

## 3 · Primary keys vs business / document IDs

| Kind | Examples | Rules |
|---|---|---|
| **Technical key** | `id` UUID on every table | Never shown to users as an identifier. Never changes (enforced). All foreign keys use it. |
| **Business key** | company `code` (ZVL), `users.username`, `az_role.name`, `az_permission.key` | Unique, **immutable** (`WFH-IMMUTABLE`), and **never reused**, even after retirement. |
| **Document number** | task `ZVL-142`, project `ZVL-P007` | Assigned by the database at insert time from `az_number_range` (per company code). Immutable, unique, never reused. Searchable in global search. Existing rows are numbered in creation order during migration. |

Changing a company code is refused. Create a new company instead, which is the same as SAP's customer number rule.

## 4 · Version numbers

- Every record starts at **version 1** (`operation = create`). Rows that existed before versioning was switched on get a **baseline** version 1 with the note "Baseline — record existed before versioning was enabled".
- Each business change increments `version_no` by exactly 1. The integrity check verifies there are no gaps and that the base row equals the newest history row.
- Retire and reactivate are versions too (`operation = retire | reactivate`).
- A controlled purge writes a final **tombstone** version (`operation = purge`) holding the last state.

## 5 · `valid_from` / `valid_to`

- `az_version.valid_from` is when the version became effective. Version 1 uses the record's `created_at`, and later versions use the database clock. Using the database clock gives one consistent clock across all serverless instances.
- `valid_to` is **derived**: it equals the next version's `valid_from` (see `az_version_timeline`). It is never stored, so version rows are never updated.
- Point-in-time lookup: `GET /api/versions/:entity/:id/at?at=2026-09-01T00:00:00Z` returns the version that was effective then. This is `versionAt()` in `server/lib/mdm.js`.
- The **business validity** of a record (`effective_from` / `effective_to` on the base row) is separate. It controls when a record is in force. The scheduler (local: every 30 s; Vercel: the daily cron plus a lazy check on requests at most every 5 minutes) handles two cases:
  - When `effective_to` passes, the record is retired with the note "Validity period ended".
  - A *pending* record whose `effective_from` arrives is activated.

  Board and unit access grants accept both fields. The Share dialog has an "access until" date.

## 6 · Current-version identification

These three statements are always equivalent, and the integrity check proves it:

1. The base table row **is** the current version, and `base.version_no` is its number.
2. `SELECT … FROM az_version WHERE entity_type = ? AND entity_id = ? ORDER BY version_no DESC LIMIT 1`.
3. `SELECT … FROM az_version_timeline WHERE … AND is_current`.

Everyday screens read (1), so there is no performance cost. History screens read (2) or (3).

## 7 · Referential integrity between historical records

- **Nothing is deleted**, so no foreign key can ever dangle and no version row can lose its target. The `ON DELETE CASCADE` clauses in the schema are therefore unreachable. They only matter inside a controlled purge, which first refuses if any record still references the target (see §11).
- **Retired references are blocked.** A *new or changed* reference to retired master data fails with `WFH-RETIRED-REF`. Examples: a task added to a retired list, or a retired user assigned to a task. Existing references to data that is later retired stay untouched, because history remains valid.
- **Pins.** Every version row stores `refs`: for each reference column, the **version number of the referenced record at that moment**. For example, `{"list_id":{"e":"list","id":"…","v":3}, "assignee_id":{"e":"user","id":"…","v":5}}`. Because `(entity_type, entity_id, version_no)` is unique and version rows are immutable, a pin always resolves to exactly one historical snapshot. The integrity check verifies this.
- **Reference rules per column** come from the registry:
  - *parent*: the record is hidden with its parent and cannot be reactivated while the parent is retired.
  - *ref*: a new reference must be active.
  - *soft*: the reference is pinned but may point at retired data. Example: a task keeps its project after the project is retired.

## 8 · How tasks, projects and documents reference historical master-data versions

A task's live foreign keys (`list_id`, `board_id`, `project_id`, `assignee_id`) always point at the record. **Which version** of that record the task was posted against is pinned in each task version:

- `GET /api/versions/card/:id/refs` shows the pins of the current task version, next to today's version of the same master record. For example, "List *To Do* v1, now v2 'Backlog'".
- `GET /api/versions/card/:id/refs?version=3` does the same for any older task version.
- The task drawer shows this as **"Posted against"**, and the full history modal shows it for every version.

So if a list, board, project or user changes after the task was created or changed, the task still shows the master data *as it was*, and also shows that it has changed since.

## 9 · How the UI shows the current version and recent changes

Directly on the record, without opening a separate audit screen (`src/components/VersionHistory.jsx`):

```
VERSION
Current version: 4   ZVL-4   Active
RECENT CHANGES
v4  Moved: PROGRESS → ON REVIEW · Assignee, Priority changed
    By: Azam Khan · 24-Sep-2026
    “Client moved the investor demo forward — design review before release”
v3  Due date, Estimate (h) changed
    By: Fatima Latif · 24-Sep-2026
[ View version history (4) ]
POSTED AGAINST
List ON REVIEW v1 · Board AI Board Development v1 · Project … v1 (now v2) · Assignee Maria Ahmed v1
```

Where it appears:

- **Task drawer**: the panel above, a doc-number badge, a read-only banner plus Reactivate when the task is retired, and a **Retire task** button with a reason. There is no Delete button.
- **Company edit** (Superadmin): the form, a "Reason for this change" field, **Save as new version**, and the history beside it.
- **User edit** (Admin): profile versions and account versions.
- **Company home**: a `vN` history button for the company or unit, `vN` on each project card, and project and unit retire actions.
- **Board**: menu → *Board version history* and *Retire board…*; list menu → *List history* and *Retire list…*.
- **View version history** opens a modal with every version. Each version expands to a *field / before / after* table, its validity period, its reason, its "posted against" pins and the full snapshot.
- **Admin → Master data (MDM)** is the central view: the registry, the change log across all records, retired records, integrity checks and data classification. `az_activity_log` stays as the separate security / system audit trail.

## 10 · How the Superadmin (MDM authority) creates a new version

1. Open the record (for example Company Hub → *Edit mode* → *Edit* on a company), change the values, optionally enter a **reason**, and choose **Save as new version**.
2. The client sends `PATCH /api/companies/:id` with `base_version` (the version they started from) and `change_note`.
3. The server runs inside `withChange({ actorId, note, requestId })`. `db.update()` stamps `changed_by`, `change_note` and a unique `change_id`, and adds `AND version_no = :base_version` (**optimistic concurrency**). If someone else saved first, the request gets a **409** "changed by someone else (now version 6, you edited 5)". Nothing is overwritten.
4. The database trigger sees a business change. It writes `az_version` v(n+1) with the snapshot, changed fields, pins, author and reason, then bumps `version_no`, all in one transaction.

**Governance by data scope** (`server/services/mdm.js`):

| Scope | Records | Who may create a version / retire / reactivate |
|---|---|---|
| **Global** | companies, users & profiles, roles, permissions, role grants, AI agents, groups, subscriptions | **Superadmin only** for retire/reactivate/purge/ownership. Existing permissions such as `company.manage` and `admin.users` still gate ordinary edits. |
| **Company** | units, unit memberships, channels, channel memberships, pipelines, alerts, reports, messages | Company admins (plus the owner/author where natural, e.g. your own report or message) |
| **Workspace / project** | projects, boards, board access, lists, tasks, subtasks, requirements, attachments, comments | Existing board/project permissions: board admin to manage the board, member to edit tasks, `project.manage`… |

**Data ownership:** master records carry `owner_id`, which defaults to their creator. The Superadmin can reassign it with `PUT /api/mdm/:entity/:id/owner`, and the change is itself a version.

## 11 · How inactive / retired records work

- **Retire** = a new version with `is_active = 0`, `effective_to = now`, `retired_at = now` and a reason. The record disappears from everyday lists, pickers, search, access calculations and counts. It still exists, and every link, pin and history entry to it still resolves.
- **Cascade by change group.** Retiring a *list* also archives its active tasks. Retiring a *board* also retires its chat channel. Both happen in the same change group. **Reactivating** the list or board restores exactly what was retired with it, and nothing that was retired separately.
- **Hidden with the parent.** Retired companies, units and boards drop out of `visibleCompanyIds` / `visibleWorkspaceIds` / `visibleBoardIds`, so everything under them disappears too. They come back unchanged on reactivation. A retired board is read-only (409 on edits). Its history remains readable by the Superadmin.
- **Memberships** (board access, unit membership, channel membership) are retired, not deleted. Re-granting reactivates **the same record** as a new version, so "who had access, and until when" is permanently answerable.
- **Users.** "Delete user" now retires the account: the user cannot sign in, disappears from pickers, and stays the author of all their work. Reactivation is a toggle in Admin → Users.
- **Role permissions** are toggled (`is_active`), instead of the old *delete all grants and re-insert* approach.
- **Chat messages.** "Delete" sets `deleted = 1` and retires the message. The text remains in its version history.
- **Reactivate** from the record itself (task drawer banner) or from Admin → Master data → *Retired records*. A child cannot be reactivated while its parent is retired; the error says which parent.
- **Controlled purge** (the exceptional correction) is `POST /api/mdm/:entity/:id/purge`, and only the Superadmin can run it. The record must already be retired. It needs a reason of at least 10 characters and the typed document number or title. It is **refused while any record still references it**. It runs with the `purge` flag and leaves a `purge` tombstone version. It is written to the audit log with the environment name.

## 12 · Which technical records may be deleted

| Table / data | Why it may be deleted | How |
|---|---|---|
| `az_event` | Real-time delivery queue | Pruned after 15 min |
| `az_metric_sample` | Monitoring samples | Rolling window of 720 |
| `az_sync_op` | Offline-sync idempotency keys | May be pruned |
| `az_notification` | Inbox items derived from events | DB editor delete allowed |
| `az_reaction` | Emoji toggle | Removed on un-react |
| `az_pinned_item` | Personal shortcuts | Removed on unpin |
| `az_ctl` | Per-transaction trigger flags (SQLite) | Always empty at rest |
| `az_meta` | Schema bookkeeping | Managed by migrations |
| JWT sessions | Stateless, expire after 7 days | Nothing stored |
| Temp seed files, `workflow.db.bak`, `dist/`, `node_modules/` | Files, not data | Delete freely |

**Retained logs** are never deleted:

- `az_activity_log` and `az_version` are append-only and can never be edited.
- `az_ai_run`, `az_pipeline_run`, `az_mention` and `az_number_range` can be updated while running, but never deleted.

The DB editor (Admin → Database) marks each table: 🛡 versioned, 🔒 log, or plain (technical). It only offers Delete on technical tables. Edits to versioned tables become attributed versions, and trigger-owned columns are read-only.

## 13 · Neon branches: development and production

```
Neon project "workflow-hub"
├── main          ← PRODUCTION  (Vercel → Production environment)
└── development   ← child branch (your laptop .env + Vercel → Preview environment)
```

1. **Create the project** in Neon. The default branch `main` is production.
2. **Create the development branch** from `main`: Neon → Branches → *Create branch* → name `development`. It starts as a copy of production, including production's environment tag. Tag it once:
   ```bash
   DATABASE_URL="<development pooled URL>" npm run db:tag -- development
   ```
   You can also start from an empty branch and run `npm run db:seed` for demo data.
3. **Local `.env`**: `DATABASE_URL=<development pooled URL>` and `APP_ENV=development`. Then run `npm run dev`. Migrations and triggers apply automatically on start.
4. **Vercel → Settings → Environment Variables**:
   - *Production*: `DATABASE_URL = <main pooled URL>`, plus `JWT_SECRET`, `CRON_SECRET`, `ADMIN_PASSWORD`. APP_ENV follows `VERCEL_ENV=production`.
   - *Preview*: `DATABASE_URL = <development pooled URL>`. Preview deployments may use a development-tagged database.
5. **The first production start on an empty `main`** creates only the roles, the permissions and one Superadmin (`ADMIN_USERNAME` / `ADMIN_PASSWORD`), with **no demo data**, and tags the database `production`. An existing v2 production database is upgraded in place on first start: columns, triggers, document numbers and a baseline version 1 for every existing record, all in one transaction under an advisory lock.

Safety rails:

- A **development** app refuses to start against a **production**-tagged database. This catches a laptop pointed at `main` by mistake.
- A **production** app refuses a development-tagged database.
- `npm run db:seed` and `npm run db:push` refuse production-tagged targets unless you pass `--allow-production`.
- `npm run db:status` shows the database, its environment tag, the app's environment and version statistics.
- *Never copy development data into production.* Promote code with Git and Vercel. Schema and trigger changes travel in the code and apply themselves in every environment.
- A new branch for an experiment, or Neon's point-in-time restore, gives you a disposable copy. Because triggers and history travel with the data, every branch has the full version history.

## 14 · How this fits the existing architecture

**Unchanged**:

- React + Vite frontend
- the zero-dependency HTTP router
- `server/app.js` shared by the local server and Vercel functions
- SQLite locally / Postgres on Vercel
- SSE / polling real-time
- the offline outbox
- the report builder, AI crew, pipelines
- every existing table, column and foreign key

**Added**:

| File | What |
|---|---|
| `server/db/versioning.js` | **The registry** (master / document / log / technical classification, scopes, technical columns, business keys, references, document-number ranges, cascades) and the trigger generators for both engines, plus migration backfill. |
| `server/db/index.js` | `withChange()` request context; `insert()`/`update()` stamp attribution; `_expect_version` optimistic concurrency; `withFlags()` |
| `server/db/sqlite.js`, `postgres.js` | Apply columns and triggers on migrate; backfill numbers and baseline versions; `withFlags` (bulk / purge) |
| `server/db/transfer.js` | Copies run with `bulk`+`purge` flags (a physical replica: versions copied as-is) |
| `server/db/bootstrap.js` | Empty production database → roles + Superadmin only |
| `server/lib/mdm.js` | retire / reactivate (with change-group cascade), memberships, history with readable diffs, as-of, pins, purge, effective dates, integrity, change log |
| `server/lib/environment.js` | APP_ENV, database environment tag, mismatch guard |
| `server/services/mdm.js` | `/api/versions/*`, `/api/mdm/*`, scope-based governance |
| `src/components/VersionHistory.jsx` | VersionPanel, HistoryModal, PostedAgainst, RetireButton, reason prompt |
| `src/pages/MdmConsole.jsx` | Admin → Master data (MDM) |
| `server/tests/mdm.test.js`, `env.test.js` | 18 + 7 tests (both engines for MDM) |

### Places where UPDATE/DELETE conflicted with the model, and their replacements

| Where | Before | Now |
|---|---|---|
| `DELETE /api/companies/:id` | `DELETE FROM az_company` (cascaded to units, boards, tasks, chats) | Superadmin **retires** the company (reason); everything under it is hidden, nothing deleted |
| `DELETE /api/units/:id` | hard delete + cascade | retire unit |
| `DELETE /api/projects/:id` | hard delete; boards lost the link | retire project; boards/tasks keep their (soft, pinned) link |
| `DELETE /api/boards/:id` | deleted board + log channel | retire both in one change group (reactivating restores both) |
| `DELETE /api/lists/:id` | deleted list **and all its tasks** | retire list + archive its active tasks together; reactivation restores them |
| `DELETE /api/cards/:id` | hard delete with subtasks, requirements, comments | retire (archived) — children and history kept |
| `DELETE /api/subtasks`, `/requirements`, `/attachments`, `/comments` | hard delete | retire (text kept in history) |
| `DELETE /api/channels/:id` | hard delete with messages | retire channel |
| `DELETE /api/reports/:id`, `/api/ops/pipelines/:id` | hard delete (pipeline runs cascaded) | retire |
| `DELETE /api/admin/users/:id` | deleted the user (tasks became unassigned, profile/memberships cascaded) | retire account (cannot sign in; authorship intact) |
| Board / unit / channel member removal | `DELETE FROM …_member` | membership retired (`is_active=0`, `effective_to=now`); re-grant reactivates the same row |
| Membership grant | `INSERT … ON CONFLICT DO UPDATE SET role` (silent overwrite) / `INSERT OR IGNORE` | `upsertMembership()` → new version; optional effective dates |
| `PUT /api/admin/roles/:id/permissions` | `DELETE` all grants then re-`INSERT` | each grant toggled via retire / reactivate (versioned) |
| Company code edit | overwrote the business key | refused (409) — permanent key |
| `PATCH /api/auth/me` email | raw `UPDATE users/profiles` (no attribution) | `update()` → versioned, attributed |
| DB editor PATCH | raw UPDATE | stamped → a version attributed to the Superadmin; trigger-owned columns read-only |
| DB editor DELETE | any table, "FKs may cascade" | technical tables only; protected tables → 409 (retire or purge) |
| Seed: `UPDATE az_activity_log SET workspace_id…` | edited the audit log | values resolved at insert (log is append-only) |
| `transfer.js` (`db:push` / `db:pull` / seed copy) | `TRUNCATE` / `DELETE` targets | runs with bulk + purge flags (a replica copy) |
| Any other code or a `psql` session | could do anything | triggers: `WFH-NODELETE`, `WFH-IMMUTABLE`, `WFH-RETIRED-REF`; unattributed updates are still versioned as `system` |
| Read paths | counted and listed everything | filter `is_active = 1` (lists, members, subtasks, channels, search, access, permissions); retired boards / units / companies drop out of visibility |

### API summary

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/versions/:entity/:id` | anyone who can see the record | full history, readable diffs, current version, owner, validity |
| `GET /api/versions/:entity/:id/at?at=ISO` | same | point-in-time version |
| `GET /api/versions/:entity/:id/refs[?version=n]` | same | pinned master-data versions ("posted against") |
| `POST /api/mdm/:entity/:id/retire` `{reason}` | by scope (§10) | retire |
| `POST /api/mdm/:entity/:id/reactivate` `{reason}` | by scope | reactivate (+ what was retired with it) |
| `PUT /api/mdm/:entity/:id/owner` | Superadmin | data owner |
| `GET /api/mdm/registry` · `changes` · `retired` · `integrity` | Superadmin | governance console |
| `POST /api/mdm/effective-dates` | Superadmin | apply validity dates now (also runs on schedule) |
| `GET /api/mdm/:entity/:id/dependents` · `POST …/purge` `{reason, confirm}` | Superadmin | controlled purge |

Entity names: `company, unit, unit_member, project, board, board_member, list, card, subtask, requirement, attachment, comment, channel, channel_member, message, voice_note, report, pipeline, alert, user, profile, role, permission, role_permission, ai_agent, group, subscription`.

Existing endpoints accept `base_version` (optimistic concurrency) and `change_note` (reason) in PATCH bodies. DELETE endpoints (which now retire) accept `?reason=`.

### Tests

```bash
npm test            # 24 API tests (unchanged behaviour)
npm run test:mdm    # 18 versioning / no-delete / MDM tests
npm run test:env    # 7 environment-separation tests
TEST_DATABASE_URL=postgres://… npm run test:mdm   # same suite on PostgreSQL (wipes that DB)
```

### Known limits (honest notes)

- Versions record the **transaction time** of a change. A future-dated change to a single field, such as "credit limit becomes 150,000 on 1 Oct", is not scheduled yet. Records can be future-dated as a whole (`effective_from` / `effective_to`), and the next step would be a pending-version queue applied by the scheduler.
- On SQLite (local only), trigger flags live in a control table inside the transaction. Purge and bulk copy are single-user operations there. PostgreSQL uses transaction-local settings.
