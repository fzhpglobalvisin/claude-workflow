-- =====================================================================
--  Workflow Hub — PostgreSQL schema (Neon, Supabase, Vercel Postgres, RDS, local)
--  Same tables and column types as schema.sql so both engines run the exact
--  same application SQL. Timestamps are ISO-8601 TEXT, JSON is TEXT, booleans 0/1.
--  The functions at the bottom give Postgres the handful of SQLite built-ins the
--  app uses (julianday, strftime, instr, json_extract, round(double, int)).
--  Applied automatically by server/db/postgres.js (guarded by an advisory lock).
-- =====================================================================

CREATE TABLE IF NOT EXISTS az_meta (key TEXT PRIMARY KEY, value TEXT);

-- ---------- Auth: user table + user detail table ----------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT UNIQUE,
  password_hash   TEXT NOT NULL,
  is_super_admin  INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_login_at   TEXT,
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS profiles (            -- user detail table
  id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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
  role_id TEXT NOT NULL REFERENCES az_role(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  permission_id TEXT NOT NULL REFERENCES az_permission(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------- Tenancy / organisation hierarchy --------------------------
CREATE TABLE IF NOT EXISTS az_group (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_subscription (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES az_group(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  stripe_customer_id TEXT, stripe_subscription_id TEXT,
  plan_tier TEXT, status TEXT, max_company INTEGER, max_seat INTEGER,
  current_period_end TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  group_id TEXT REFERENCES az_group(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
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
  company_id TEXT NOT NULL REFERENCES az_company(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  description TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_workspace_member (
  id TEXT PRIMARY KEY,
  role TEXT DEFAULT 'member',                       -- admin | member | guest
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  custom_role_id TEXT REFERENCES az_role(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT,
  UNIQUE (user_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS az_project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  status TEXT DEFAULT 'active',                     -- planning | active | on_hold | done
  start_date TEXT, end_date TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT, updated_at TEXT
);

-- ---------- Kanban ----------------------------------------------------
CREATE TABLE IF NOT EXISTS az_board (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  workspace_id TEXT NOT NULL REFERENCES az_workspace(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT REFERENCES az_project(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  log_channel_id TEXT,
  background TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_board_member (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES az_board(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  role TEXT NOT NULL DEFAULT 'member',             -- admin | member | viewer
  created_at TEXT,
  UNIQUE (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS az_list (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  board_id TEXT NOT NULL REFERENCES az_board(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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
  list_id TEXT REFERENCES az_list(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,   -- NULL = personal inbox
  board_id TEXT REFERENCES az_board(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT REFERENCES az_project(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  priority TEXT DEFAULT 'medium',                  -- low | medium | high | urgent
  labels TEXT DEFAULT '[]',                        -- JSON [{text,color}]
  cover_url TEXT,
  is_template INTEGER DEFAULT 0,
  estimate_hours DOUBLE PRECISION,
  completed_at TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_subtask (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  title TEXT NOT NULL,
  is_done INTEGER DEFAULT 0,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  due_date TEXT,
  position INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  is_ai_generated INTEGER DEFAULT 0,
  completed_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_task_requirement (    -- text / PDF / media / link
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL CHECK (type IN ('text','pdf','media','link')),
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  drive_file_id TEXT,
  mime_type TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_card_comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES az_card(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  text TEXT NOT NULL,
  sender TEXT,
  reply_to TEXT,                                   -- JSON
  profile_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  is_pinned INTEGER DEFAULT 0,
  created_at TEXT
);

-- ---------- Chat (Slack-style) ---------------------------------------
CREATE TABLE IF NOT EXISTS az_channel (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'public',             -- public | private | dm | board_log
  workspace_id TEXT REFERENCES az_workspace(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT REFERENCES az_company(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  description TEXT,
  is_private INTEGER DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_channel_member (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES az_channel(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  last_read_at TEXT,
  created_at TEXT,
  UNIQUE (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS az_message (
  id TEXT PRIMARY KEY,
  content TEXT,
  file_url TEXT,
  type TEXT DEFAULT 'text',                        -- text | system | ai | file | voice
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  channel_id TEXT NOT NULL REFERENCES az_channel(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  parent_message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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
  card_id TEXT REFERENCES az_card(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  file_type TEXT, file_size INTEGER,
  uploader_id TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  drive_file_id TEXT, drive_web_view_link TEXT, drive_thumbnail_link TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS az_reaction (
  id TEXT PRIMARY KEY,
  emoji TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS az_mention (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  mentioned_user_id TEXT REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  is_ai INTEGER DEFAULT 0,
  has_image_crop INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_voice_note (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  audio_url TEXT, duration INTEGER, waveform TEXT, transcription TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_pinned_item (          -- "Pinned Chats" (per user)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  channel_id TEXT REFERENCES az_channel(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  message_id TEXT REFERENCES az_message(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
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
  agent_id TEXT REFERENCES az_ai_agent(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
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
  company_id TEXT REFERENCES az_company(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  board_id TEXT REFERENCES az_board(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  target TEXT, schedule TEXT,
  status TEXT DEFAULT 'idle',                      -- idle | running | success | failed
  config TEXT,
  last_run_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS az_pipeline_run (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES az_pipeline(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  status TEXT, logs TEXT, triggered_by TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS az_alert (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT REFERENCES az_pipeline(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  company_id TEXT,
  severity TEXT DEFAULT 'warning',                 -- info | warning | critical
  source TEXT, title TEXT, message TEXT,
  status TEXT DEFAULT 'open',                      -- open | acknowledged | resolved
  card_id TEXT REFERENCES az_card(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  acknowledged_by TEXT,
  created_at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS az_metric_sample (
  id BIGSERIAL PRIMARY KEY,
  ts TEXT, cpu_load DOUBLE PRECISION, mem_used_pct DOUBLE PRECISION, heap_mb DOUBLE PRECISION, rss_mb DOUBLE PRECISION,
  db_size_kb DOUBLE PRECISION, event_loop_ms DOUBLE PRECISION, active_clients INTEGER
);

-- ---------- Real-time event log (used when SSE isn't available, e.g. Vercel) -
CREATE TABLE IF NOT EXISTS az_event (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,                           -- recipient, or '*' for everyone
  event TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Enterprise versioning (append-only history of every business record) ---
-- One row per version of every protected record. Never updated, never deleted.
-- valid_to is not stored: it is the next version's valid_from (see az_version_timeline).
CREATE TABLE IF NOT EXISTS az_version (
  id             BIGSERIAL PRIMARY KEY,
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
CREATE OR REPLACE VIEW az_version_timeline AS
  SELECT v.*,
         LEAD(v.valid_from) OVER (PARTITION BY v.entity_type, v.entity_id ORDER BY v.version_no) AS valid_to,
         CASE WHEN LEAD(v.version_no) OVER (PARTITION BY v.entity_type, v.entity_id ORDER BY v.version_no) IS NULL THEN 1 ELSE 0 END AS is_current
    FROM az_version v;

-- Business/document number ranges (TASK:ZVL → ZVL-142). Numbers are never reused.
CREATE TABLE IF NOT EXISTS az_number_range (
  range_key TEXT PRIMARY KEY, last_no INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);

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

-- ---------- SQLite-compatible helper functions ------------------------
CREATE OR REPLACE FUNCTION wfh_ts(t TEXT) RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t IS NULL THEN NULL WHEN lower(t) = 'now' THEN now() ELSE t::timestamptz END
$$;

CREATE OR REPLACE FUNCTION julianday(t TEXT) RETURNS DOUBLE PRECISION LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM wfh_ts(t)) / 86400.0 + 2440587.5
$$;

-- supports the tokens used by the app: %Y %m %d %H %M %S %f %W %j %%
CREATE OR REPLACE FUNCTION strftime(fmt TEXT, t TEXT) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  ts TIMESTAMP;
  out TEXT := '';
  i INT := 1;
  c TEXT;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  ts := wfh_ts(t) AT TIME ZONE 'UTC';
  WHILE i <= length(fmt) LOOP
    c := substr(fmt, i, 1);
    IF c = '%' AND i < length(fmt) THEN
      i := i + 1;
      c := substr(fmt, i, 1);
      out := out || CASE c
        WHEN 'Y' THEN to_char(ts, 'YYYY')
        WHEN 'm' THEN to_char(ts, 'MM')
        WHEN 'd' THEN to_char(ts, 'DD')
        WHEN 'H' THEN to_char(ts, 'HH24')
        WHEN 'M' THEN to_char(ts, 'MI')
        WHEN 'S' THEN to_char(ts, 'SS')
        WHEN 'f' THEN to_char(ts, 'SS.MS')
        WHEN 'j' THEN to_char(ts, 'DDD')
        WHEN 'W' THEN lpad(floor((extract(doy FROM ts) - 1 + 7 - ((extract(dow FROM ts)::int + 6) % 7)) / 7)::int::text, 2, '0')
        WHEN '%' THEN '%'
        ELSE '%' || c END;
    ELSE
      out := out || c;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION instr(haystack TEXT, needle TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT position(needle IN haystack)
$$;

CREATE OR REPLACE FUNCTION json_extract(doc TEXT, p TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN (doc::jsonb) #>> string_to_array(regexp_replace(p, '^\$\.?', ''), '.');
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION round(v DOUBLE PRECISION, places INT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT round(v::numeric, places)
$$;
