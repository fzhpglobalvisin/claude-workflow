-- =====================================================================
--  Workflow Hub — SQLite schema
--  Adapted from the supplied Postgres (az_*) schema:
--    uuid        -> TEXT (crypto.randomUUID)
--    timestamptz -> TEXT ISO-8601 (UTC)
--    jsonb       -> TEXT (JSON)
--    boolean     -> INTEGER 0/1
--  Hierarchy:  group -> company -> unit (az_workspace) -> project -> board
--              -> list -> card (task) -> subtask / requirement / attachment
-- =====================================================================
PRAGMA foreign_keys = ON;

-- schema / environment bookkeeping (environment = development | preview | production)
CREATE TABLE IF NOT EXISTS az_meta (key TEXT PRIMARY KEY, value TEXT);

-- ---------- Auth: user table + user detail table ----------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email           TEXT UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  is_super_admin  INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_login_at   TEXT,
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS profiles (            -- user detail table
  id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name       TEXT,
  email           TEXT,
  avatar_url      TEXT,
  whatsapp_number TEXT,
  status          TEXT DEFAULT 'offline',       -- online | away | busy | offline
  role            TEXT DEFAULT 'developer',     -- az_role.name
  designation     TEXT,
  department      TEXT,
  is_guest        INTEGER DEFAULT 0,
  bio             TEXT,
  color           TEXT,
  created_at      TEXT,
  updated_at      TEXT
);

-- ---------- RBAC ------------------------------------------------------
CREATE TABLE IF NOT EXISTS az_role (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_permission (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, description TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_role_permission (
  role_id TEXT NOT NULL REFERENCES az_role(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES az_permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------- Tenancy / organisation hierarchy --------------------------
CREATE TABLE IF NOT EXISTS az_group (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_subscription (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES az_group(id) ON DELETE CASCADE,
  stripe_customer_id TEXT, stripe_subscription_id TEXT,
  plan_tier TEXT, status TEXT, max_company INTEGER, max_seat INTEGER,
  current_period_end TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  group_id TEXT REFERENCES az_group(id) ON DELETE SET NULL,
  description TEXT,
  image_url TEXT,
  accent TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_workspace (           -- "Unit"
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  type TEXT DEFAULT 'unit',                         -- unit | department | client
  invite_code TEXT,
  company_id TEXT NOT NULL REFERENCES az_company(id) ON DELETE CASCADE,
  description TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_workspace_member (
  id TEXT PRIMARY KEY,
  role TEXT DEFAULT 'member',                       -- admin | member | guest
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE,
  custom_role_id TEXT REFERENCES az_role(id) ON DELETE SET NULL,
  created_at TEXT,
  UNIQUE (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS az_project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active',                     -- planning | active | on_hold | done
  start_date TEXT, end_date TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT
);

-- ---------- Kanban ----------------------------------------------------
CREATE TABLE IF NOT EXISTS az_board (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES az_project(id) ON DELETE SET NULL,
  log_channel_id TEXT,
  background TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_board_member (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES az_board(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',             -- admin | member | viewer
  created_at TEXT,
  UNIQUE (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS az_list (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  board_id TEXT NOT NULL REFERENCES az_board(id) ON DELETE CASCADE,
  is_done_list INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_card (                -- Task
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  start_date TEXT,
  list_id TEXT REFERENCES az_list(id) ON DELETE CASCADE,   -- NULL = personal inbox
  board_id TEXT REFERENCES az_board(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES az_project(id) ON DELETE SET NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT DEFAULT 'medium',                  -- low | medium | high | urgent
  labels TEXT DEFAULT '[]',                        -- JSON [{text,color}]
  cover_url TEXT,
  is_template INTEGER DEFAULT 0,
  estimate_hours REAL,
  completed_at TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_subtask (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  is_done INTEGER DEFAULT 0,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  position INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_ai_generated INTEGER DEFAULT 0,
  completed_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_task_requirement (    -- text / PDF / media / link
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('text','pdf','media','link')),
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  drive_file_id TEXT,
  mime_type TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_card_comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sender TEXT,
  reply_to TEXT,                                   -- JSON
  profile_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_pinned INTEGER DEFAULT 0,
  created_at TEXT
);

-- ---------- Chat (Slack-style) ---------------------------------------
CREATE TABLE IF NOT EXISTS az_channel (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'public',             -- public | private | dm | board_log
  workspace_id TEXT REFERENCES az_workspace(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES az_company(id) ON DELETE CASCADE,
  description TEXT,
  is_private INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_channel_member (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES az_channel(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT,
  created_at TEXT,
  UNIQUE (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS az_message (
  id TEXT PRIMARY KEY,
  content TEXT,
  file_url TEXT,
  type TEXT DEFAULT 'text',                        -- text | system | ai | file | voice
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel_id TEXT NOT NULL REFERENCES az_channel(id) ON DELETE CASCADE,
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL,
  parent_message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE,
  deleted INTEGER DEFAULT 0,
  media_type TEXT,
  duration_seconds INTEGER,
  is_ai_generated INTEGER DEFAULT 0,
  metadata TEXT,                                   -- JSON
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_attachment (          -- Google Drive links only
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  card_id TEXT REFERENCES az_card(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE,
  file_type TEXT, file_size INTEGER,
  uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  drive_file_id TEXT, drive_web_view_link TEXT, drive_thumbnail_link TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_reaction (
  id TEXT PRIMARY KEY,
  emoji TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES az_message(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS az_mention (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES az_message(id) ON DELETE CASCADE,
  mentioned_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  is_ai INTEGER DEFAULT 0,
  has_image_crop INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_voice_note (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE,
  audio_url TEXT, duration INTEGER, waveform TEXT, transcription TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_pinned_item (          -- "Pinned Chats" (per user)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES az_channel(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE,
  created_at TEXT
);

-- ---------- Audit, notifications, reports ----------------------------
CREATE TABLE IF NOT EXISTS az_activity_log (
  id TEXT PRIMARY KEY,
  board_id TEXT, workspace_id TEXT, company_id TEXT,
  actor_id TEXT,
  type TEXT NOT NULL,                              -- e.g. card.moved, auth.login
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,                                    -- JSON
  ip TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_notification (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT, title TEXT, body TEXT, link TEXT,
  actor_id TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_report (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL,                            -- JSON report definition
  company_id TEXT,
  is_shared INTEGER DEFAULT 1,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT
);

-- ---------- AI crew ---------------------------------------------------
CREATE TABLE IF NOT EXISTS az_ai_agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                              -- planner | triage | qa | incident | scribe
  goal TEXT, backstory TEXT, avatar TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_ai_run (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES az_ai_agent(id) ON DELETE SET NULL,
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL,
  channel_id TEXT,
  triggered_by TEXT,
  input TEXT, output TEXT, actions TEXT,           -- JSON
  engine TEXT,                                     -- heuristic | anthropic
  status TEXT DEFAULT 'running',
  created_at TEXT, finished_at TEXT
);

-- ---------- Deployment & monitoring pipelines ------------------------
CREATE TABLE IF NOT EXISTS az_pipeline (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                              -- deploy | monitor | backup
  company_id TEXT REFERENCES az_company(id) ON DELETE CASCADE,
  board_id TEXT REFERENCES az_board(id) ON DELETE SET NULL,
  target TEXT, schedule TEXT,
  status TEXT DEFAULT 'idle',                      -- idle | running | success | failed
  config TEXT,
  last_run_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_pipeline_run (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES az_pipeline(id) ON DELETE CASCADE,
  status TEXT, logs TEXT, triggered_by TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS az_alert (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT REFERENCES az_pipeline(id) ON DELETE SET NULL,
  company_id TEXT,
  severity TEXT DEFAULT 'warning',                 -- info | warning | critical
  source TEXT, title TEXT, message TEXT,
  status TEXT DEFAULT 'open',                      -- open | acknowledged | resolved
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL,
  acknowledged_by TEXT,
  created_at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS az_metric_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT, cpu_load REAL, mem_used_pct REAL, heap_mb REAL, rss_mb REAL,
  db_size_kb REAL, event_loop_ms REAL, active_clients INTEGER
);

-- ---------- Real-time event log (used when SSE isn't available, e.g. Vercel) -
CREATE TABLE IF NOT EXISTS az_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,                           -- recipient, or '*' for everyone
  event TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Enterprise versioning (append-only history of every business record) ---
-- One row per version of every protected record. Never updated, never deleted.
-- valid_to is not stored: it is the next version's valid_from (see az_version_timeline).
CREATE TABLE IF NOT EXISTS az_version (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type    TEXT NOT NULL,                    -- registry name: company, card, list …
  entity_id      TEXT NOT NULL,                    -- the record's technical key (UUID)
  version_no     INTEGER NOT NULL,                 -- 1, 2, 3 … per record
  operation      TEXT NOT NULL,                    -- create | change | retire | reactivate | purge
  valid_from     TEXT NOT NULL,                    -- when this version became effective
  recorded_at    TEXT NOT NULL,                    -- when it was written (system time)
  data           TEXT NOT NULL,                    -- JSON snapshot of the business columns
  changed_fields TEXT,                             -- JSON array of changed columns
  changed_by     TEXT,                             -- user id | 'system'
  change_note    TEXT,                             -- reason given for the change
  change_id      TEXT,                             -- <request>.<n> — groups changes made together
  refs           TEXT,                             -- JSON: pinned versions of referenced master data
  UNIQUE (entity_type, entity_id, version_no)
);
CREATE INDEX IF NOT EXISTS ix_version_recorded ON az_version(recorded_at);
CREATE INDEX IF NOT EXISTS ix_version_change   ON az_version(change_id);
CREATE INDEX IF NOT EXISTS ix_version_actor    ON az_version(changed_by, recorded_at);
CREATE VIEW IF NOT EXISTS az_version_timeline AS
  SELECT v.*,
         LEAD(v.valid_from) OVER (PARTITION BY v.entity_type, v.entity_id ORDER BY v.version_no) AS valid_to,
         CASE WHEN LEAD(v.version_no) OVER (PARTITION BY v.entity_type, v.entity_id ORDER BY v.version_no) IS NULL THEN 1 ELSE 0 END AS is_current
    FROM az_version v;

-- Business/document number ranges (TASK:ZVL → ZVL-142). Numbers are never reused.
CREATE TABLE IF NOT EXISTS az_number_range (
  range_key TEXT PRIMARY KEY, last_no INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);

-- Per-transaction control flags used by the triggers (bulk load / controlled purge). Always empty at rest.
CREATE TABLE IF NOT EXISTS az_ctl (k TEXT PRIMARY KEY, v TEXT);

-- ---------- Offline sync idempotency ---------------------------------
CREATE TABLE IF NOT EXISTS az_sync_op (
  op_id TEXT PRIMARY KEY, user_id TEXT, method TEXT, path TEXT, status INTEGER, applied_at TEXT
);

-- ---------- Indexes ---------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ws_company     ON az_workspace(company_id);
CREATE INDEX IF NOT EXISTS ix_wsm_user       ON az_workspace_member(user_id);
CREATE INDEX IF NOT EXISTS ix_project_ws     ON az_project(workspace_id);
CREATE INDEX IF NOT EXISTS ix_board_ws       ON az_board(workspace_id);
CREATE INDEX IF NOT EXISTS ix_board_project  ON az_board(project_id);
CREATE INDEX IF NOT EXISTS ix_bm_user        ON az_board_member(user_id);
CREATE INDEX IF NOT EXISTS ix_list_board     ON az_list(board_id, position);
CREATE INDEX IF NOT EXISTS ix_card_list      ON az_card(list_id, position);
CREATE INDEX IF NOT EXISTS ix_card_board     ON az_card(board_id);
CREATE INDEX IF NOT EXISTS ix_card_assignee  ON az_card(assignee_id);
CREATE INDEX IF NOT EXISTS ix_subtask_card   ON az_subtask(card_id, position);
CREATE INDEX IF NOT EXISTS ix_req_card       ON az_task_requirement(card_id);
CREATE INDEX IF NOT EXISTS ix_att_card       ON az_attachment(card_id);
CREATE INDEX IF NOT EXISTS ix_comment_card   ON az_card_comments(card_id);
CREATE INDEX IF NOT EXISTS ix_msg_channel    ON az_message(channel_id, created_at);
CREATE INDEX IF NOT EXISTS ix_msg_parent     ON az_message(parent_message_id);
CREATE INDEX IF NOT EXISTS ix_react_msg      ON az_reaction(message_id);
CREATE INDEX IF NOT EXISTS ix_mention_user   ON az_mention(mentioned_user_id);
CREATE INDEX IF NOT EXISTS ix_cm_user        ON az_channel_member(user_id);
CREATE INDEX IF NOT EXISTS ix_pin_user       ON az_pinned_item(user_id);
CREATE INDEX IF NOT EXISTS ix_log_created    ON az_activity_log(created_at);
CREATE INDEX IF NOT EXISTS ix_log_board      ON az_activity_log(board_id);
CREATE INDEX IF NOT EXISTS ix_notif_user     ON az_notification(user_id, is_read);
CREATE INDEX IF NOT EXISTS ix_alert_status   ON az_alert(status);
CREATE INDEX IF NOT EXISTS ix_event_user     ON az_event(user_id, id);
