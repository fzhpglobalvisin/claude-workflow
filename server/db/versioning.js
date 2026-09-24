// =====================================================================
//  Workflow Hub — enterprise versioning & no-delete engine (MDM layer)
//
//  One registry describes every business table. From it we generate, for
//  BOTH engines, the database triggers that enforce the rules no matter
//  which code path (service, DB editor, psql, a future script) touches the data:
//
//   • Append/version — every INSERT writes version 1 into az_version, every
//     UPDATE that changes a business column writes version n+1 (full snapshot,
//     changed fields, who, why, pinned versions of referenced master data).
//     The base table row is the *current version* (version_no = latest).
//   • No physical delete — DELETE on a protected table raises WFH-NODELETE.
//     Records are retired (is_active = 0) instead. The only exception is the
//     controlled purge operation (super admin, reason, tombstone version).
//   • Immutable business keys — ids, document numbers, company codes, usernames…
//   • Retired references — new/changed rows cannot point at retired master data.
//   • Append-only logs — az_version and az_activity_log can never be edited.
//
//  Technical tables (sessions, events, caches, metrics, read receipts…) are not
//  registered and may be cleaned up freely.
// =====================================================================

/** Columns every versioned table gets (added by migration when missing). */
export const CONTROL_COLUMNS = [
  ['version_no', 'INTEGER NOT NULL DEFAULT 1'],   // current version number (maintained by trigger)
  ['is_active', 'INTEGER NOT NULL DEFAULT 1'],    // 0 = retired / inactive (never deleted)
  ['effective_from', 'TEXT'],                     // business validity start (optional)
  ['effective_to', 'TEXT'],                       // business validity end (optional; scheduler retires)
  ['retired_at', 'TEXT'],                         // maintained by trigger
  ['changed_by', 'TEXT'],                         // stamped by the data layer (request actor)
  ['change_note', 'TEXT'],                        // reason for the change (optional, required for retire)
  ['change_id', 'TEXT'],                          // unique per write — lets triggers detect unattributed writes
];
const NOT_IN_SNAPSHOT = ['version_no', 'retired_at', 'changed_by', 'change_note', 'change_id', 'created_at', 'updated_at'];

const ref = (entity, opts = {}) => ({ entity, check: true, parent: false, ...opts });
const parent = (entity, opts = {}) => ref(entity, { parent: true, ...opts });
const soft = (entity, opts = {}) => ref(entity, { check: false, ...opts }); // pinned, but may point at retired data

const COMPANY_OF_BOARD = 'SELECT c.code FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id JOIN az_company c ON c.id = w.company_id WHERE b.id = ?';
const COMPANY_OF_UNIT = 'SELECT c.code FROM az_workspace w JOIN az_company c ON c.id = w.company_id WHERE w.id = ?';

/**
 * kind:  master   — reference data governed by MDM (companies, units, users, roles…)
 *        document — business transactions (tasks, subtasks, requirements, messages…)
 * scope: global | company | workspace — who governs it (see server/lib/mdm.js)
 */
const DEFS = [
  // ---------- global master data (Superadmin = MDM authority) ----------
  { entity: 'user', table: 'users', kind: 'master', scope: 'global', label: 'User', title: 'username', tech: ['password_hash', 'last_login_at', 'last_seen_at'], immutable: ['username'] },
  { entity: 'profile', table: 'profiles', kind: 'master', scope: 'global', label: 'User profile', title: 'full_name', tech: ['status'], refs: { id: soft('user') } },
  { entity: 'role', table: 'az_role', kind: 'master', scope: 'global', label: 'Role', title: 'name', immutable: ['name'] },
  { entity: 'permission', table: 'az_permission', kind: 'master', scope: 'global', label: 'Permission', title: 'key', immutable: ['key'] },
  { entity: 'role_permission', table: 'az_role_permission', kind: 'master', scope: 'global', label: 'Role grant', key: ['role_id', 'permission_id'], refs: { role_id: parent('role'), permission_id: parent('permission') } },
  { entity: 'group', table: 'az_group', kind: 'master', scope: 'global', label: 'Group', title: 'name' },
  { entity: 'subscription', table: 'az_subscription', kind: 'master', scope: 'global', label: 'Subscription', title: 'plan_tier', refs: { group_id: parent('group') } },
  { entity: 'company', table: 'az_company', kind: 'master', scope: 'global', label: 'Company', title: 'name', immutable: ['code'], refs: { group_id: ref('group') } },
  { entity: 'ai_agent', table: 'az_ai_agent', kind: 'master', scope: 'global', label: 'AI agent', title: 'name' },
  // ---------- company-level master data ----------
  { entity: 'unit', table: 'az_workspace', kind: 'master', scope: 'company', label: 'Unit', title: 'name', refs: { company_id: parent('company') } },
  { entity: 'unit_member', table: 'az_workspace_member', kind: 'master', scope: 'company', label: 'Unit membership', refs: { workspace_id: parent('unit'), user_id: ref('user'), custom_role_id: ref('role') } },
  { entity: 'channel', table: 'az_channel', kind: 'master', scope: 'company', label: 'Channel', title: 'name', tech: ['updated_at'], refs: { company_id: parent('company'), workspace_id: parent('unit') } },
  { entity: 'channel_member', table: 'az_channel_member', kind: 'master', scope: 'company', label: 'Channel membership', tech: ['last_read_at'], refs: { channel_id: parent('channel'), user_id: ref('user') } },
  { entity: 'pipeline', table: 'az_pipeline', kind: 'master', scope: 'company', label: 'Pipeline', title: 'name', tech: ['status', 'last_run_at'], refs: { company_id: parent('company'), board_id: soft('board') } },
  // ---------- workspace / project-level master data ----------
  { entity: 'project', table: 'az_project', kind: 'master', scope: 'workspace', label: 'Project', title: 'title', refs: { workspace_id: parent('unit') },
    docNo: { range: 'PROJ', sql: COMPANY_OF_UNIT, arg: 'workspace_id', fallback: 'PRJ', letter: 'P', pad: 3 } },
  { entity: 'board', table: 'az_board', kind: 'master', scope: 'workspace', label: 'Board', title: 'title', refs: { workspace_id: parent('unit'), project_id: ref('project') } },
  { entity: 'board_member', table: 'az_board_member', kind: 'master', scope: 'workspace', label: 'Board access', refs: { board_id: parent('board'), user_id: ref('user') } },
  { entity: 'list', table: 'az_list', kind: 'master', scope: 'workspace', label: 'List', title: 'title', tech: ['position'], refs: { board_id: parent('board') },
    cascade: [{ entity: 'card', fk: 'list_id' }] },
  // ---------- business documents ----------
  { entity: 'card', table: 'az_card', kind: 'document', scope: 'workspace', label: 'Task', title: 'title', tech: ['position'],
    refs: { list_id: parent('list'), board_id: parent('board'), project_id: soft('project'), assignee_id: ref('user') },
    docNo: { range: 'TASK', sql: COMPANY_OF_BOARD, arg: 'board_id', fallback: 'TASK', letter: '', pad: 0 },
    retireSet: { archived: 1 }, reactivateSet: { archived: 0 } },
  { entity: 'subtask', table: 'az_subtask', kind: 'document', scope: 'workspace', label: 'Subtask', title: 'title', tech: ['position'], refs: { card_id: parent('card'), assignee_id: ref('user') } },
  { entity: 'requirement', table: 'az_task_requirement', kind: 'document', scope: 'workspace', label: 'Requirement', title: 'title', refs: { card_id: parent('card') } },
  { entity: 'attachment', table: 'az_attachment', kind: 'document', scope: 'workspace', label: 'Attachment', title: 'name', refs: { card_id: parent('card'), message_id: soft('message') } },
  { entity: 'comment', table: 'az_card_comments', kind: 'document', scope: 'workspace', label: 'Comment', title: 'text', refs: { card_id: parent('card') } },
  { entity: 'message', table: 'az_message', kind: 'document', scope: 'company', label: 'Message', title: 'content', refs: { channel_id: parent('channel'), card_id: soft('card'), user_id: soft('user') },
    retireSet: { deleted: 1 }, reactivateSet: { deleted: 0 } },
  { entity: 'voice_note', table: 'az_voice_note', kind: 'document', scope: 'company', label: 'Voice note', refs: { message_id: soft('message') } },
  { entity: 'report', table: 'az_report', kind: 'document', scope: 'company', label: 'Report', title: 'name', refs: { company_id: soft('company') } },
  { entity: 'alert', table: 'az_alert', kind: 'document', scope: 'company', label: 'Alert', title: 'title', refs: { pipeline_id: soft('pipeline'), card_id: soft('card') } },
];

/** Append-only / retained logs (no versioning, but protected). */
export const LOG_TABLES = {
  az_version: 'immutable',       // version history itself
  az_activity_log: 'immutable',  // security / system audit trail
  az_ai_run: 'nodelete',         // updated while running, then kept
  az_pipeline_run: 'nodelete',
  az_mention: 'nodelete',
  az_number_range: 'nodelete',   // document numbers are never reused
};

/** Technical tables — may be cleaned up (no business meaning, no history needed). */
export const TECHNICAL_TABLES = {
  az_event: 'real-time delivery queue (kept 15 min)',
  az_sync_op: 'offline-sync idempotency keys',
  az_metric_sample: 'monitoring samples (rolling window)',
  az_notification: 'user inbox notifications (derived from events)',
  az_reaction: 'emoji reactions (toggle)',
  az_pinned_item: 'personal pins / shortcuts',
  az_meta: 'schema bookkeeping',
  az_ctl: 'per-transaction control flags (SQLite)',
};

// ---------------------------------------------------------------- derived registry
export const ENTITIES = {};
export const BY_TABLE = {};
for (const d of DEFS) {
  const def = {
    ...d,
    key: d.key || ['id'],
    tech: d.tech || [],
    refs: d.refs || {},
    immutable: [...(d.key || ['id']), ...(d.immutable || []), ...(d.docNo ? ['doc_no'] : [])],
    hasOwner: d.kind === 'master',
  };
  def.hide = [...new Set([...NOT_IN_SNAPSHOT, ...def.tech])];
  def.nonBusiness = new Set([...def.hide, 'doc_no']);
  ENTITIES[d.entity] = def;
  BY_TABLE[d.table] = def;
}
for (const def of Object.values(ENTITIES)) {
  for (const [col, r] of Object.entries(def.refs)) r.table = ENTITIES[r.entity].table;
}
export const isVersioned = (table) => !!BY_TABLE[table];

/** Columns a table must have for versioning. */
export function requiredColumns(def) {
  const cols = [...CONTROL_COLUMNS];
  if (def.hasOwner) cols.push(['owner_id', 'TEXT']);
  if (def.docNo) cols.push(['doc_no', 'TEXT']);
  return cols;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const keyExpr = (def, p) => def.key.map((k) => `${p}.${k}`).join(" || ':' || ");

// ================================================================ SQLite
const S_TS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const S_FLAG = (k) => `EXISTS (SELECT 1 FROM az_ctl WHERE k = '${k}')`;
const VERSION_COLS = 'entity_type, entity_id, version_no, operation, valid_from, recorded_at, data, changed_fields, changed_by, change_note, change_id, refs';

function sqliteSnapshot(cols, p) {
  return `json_object(${cols.map((c) => `'${c}', ${p}.${c}`).join(', ')})`;
}
function sqliteRefs(def, p) {
  const parts = Object.entries(def.refs).map(([col, r]) =>
    `SELECT '${col}' AS col, json_object('e', '${r.entity}', 'id', ${p}.${col}, 'v', (SELECT x.version_no FROM ${r.table} x WHERE x.id = ${p}.${col})) AS val WHERE ${p}.${col} IS NOT NULL`);
  if (!parts.length) return "'{}'";
  return `(SELECT json_group_object(col, json(val)) FROM (${parts.join(' UNION ALL ')}))`;
}

/** All CREATE TRIGGER statements for one table (SQLite). `cols` = the table's actual columns. */
export function sqliteTriggerSql(def, cols) {
  const t = def.table; const e = def.entity;
  const snapCols = cols.filter((c) => !def.hide.includes(c));
  const diffCols = snapCols.filter((c) => c !== 'doc_no');
  const out = [];
  const drop = (name) => out.push(`DROP TRIGGER IF EXISTS ${name}`);
  const notBulk = `NOT ${S_FLAG('bulk')}`;

  // ---- immutable keys
  const imm = def.immutable.filter((c) => cols.includes(c));
  drop(`wfh_imm_${t}`);
  out.push(`CREATE TRIGGER wfh_imm_${t} BEFORE UPDATE ON ${t} WHEN ${notBulk} AND (${imm.map((c) => `(OLD.${c} IS NOT NULL AND NEW.${c} IS NOT OLD.${c})`).join(' OR ')})
BEGIN SELECT RAISE(ABORT, ${q(`WFH-IMMUTABLE: ${def.label} ${imm.join('/')} is a permanent business key and cannot be changed`)}); END`);

  // ---- retired references (insert + change)
  for (const [col, r] of Object.entries(def.refs)) {
    drop(`wfh_ref_i_${t}_${col}`); drop(`wfh_ref_u_${t}_${col}`);
    if (!r.check || !cols.includes(col)) continue;
    const retired = `EXISTS (SELECT 1 FROM ${r.table} x WHERE x.id = NEW.${col} AND x.is_active = 0)`;
    const msg = q(`WFH-RETIRED-REF: the ${ENTITIES[r.entity].label.toLowerCase()} referenced by ${col} is retired — it cannot be used on a new or changed ${def.label.toLowerCase()}`);
    out.push(`CREATE TRIGGER wfh_ref_i_${t}_${col} BEFORE INSERT ON ${t} WHEN ${notBulk} AND NEW.${col} IS NOT NULL AND ${retired}
BEGIN SELECT RAISE(ABORT, ${msg}); END`);
    out.push(`CREATE TRIGGER wfh_ref_u_${t}_${col} BEFORE UPDATE OF ${col} ON ${t} WHEN ${notBulk} AND NEW.${col} IS NOT OLD.${col} AND NEW.${col} IS NOT NULL AND ${retired}
BEGIN SELECT RAISE(ABORT, ${msg}); END`);
  }

  // ---- version 1 on insert (+ document number)
  drop(`wfh_ver_i_${t}`);
  let docno = '';
  if (def.docNo && cols.includes('doc_no')) {
    const d = def.docNo;
    const code = `COALESCE((${d.sql.replace('?', `NEW.${d.arg}`)}), ${q(d.fallback)})`;
    const key = `${q(`${d.range}:`)} || ${code}`;
    const num = `(SELECT last_no FROM az_number_range WHERE range_key = ${key})`;
    docno = `
  INSERT OR IGNORE INTO az_number_range (range_key, last_no, updated_at) SELECT ${key}, 0, ${S_TS} WHERE NEW.doc_no IS NULL;
  UPDATE az_number_range SET last_no = last_no + 1, updated_at = ${S_TS} WHERE range_key = ${key} AND NEW.doc_no IS NULL;
  UPDATE ${t} SET doc_no = ${code} || '-' || ${q(d.letter)} || printf('%0${d.pad || 1}d', ${num}) WHERE rowid = NEW.rowid AND doc_no IS NULL;`;
  }
  out.push(`CREATE TRIGGER wfh_ver_i_${t} AFTER INSERT ON ${t} WHEN ${notBulk}
BEGIN${docno}
  UPDATE ${t} SET version_no = 1, retired_at = NULL WHERE rowid = NEW.rowid AND (version_no IS NOT 1 OR retired_at IS NOT NULL);
  INSERT INTO az_version (${VERSION_COLS})
  SELECT ${q(e)}, ${keyExpr(def, 'r')}, 1, 'create', COALESCE(${cols.includes('created_at') ? 'r.created_at' : 'NULL'}, ${S_TS}), ${S_TS}, ${sqliteSnapshot(snapCols, 'r')}, NULL,
         COALESCE(r.changed_by, 'system'), r.change_note, r.change_id, ${sqliteRefs(def, 'r')}
    FROM ${t} r WHERE r.rowid = NEW.rowid;
END`);

  // ---- version n+1 on a business change
  drop(`wfh_ver_u_${t}`);
  const changed = diffCols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const fieldList = diffCols.map((c) => `SELECT '${c}' AS f WHERE OLD.${c} IS NOT NEW.${c}`).join(' UNION ALL ');
  const own = 'NEW.change_id IS NOT OLD.change_id';
  out.push(`CREATE TRIGGER wfh_ver_u_${t} AFTER UPDATE ON ${t} WHEN ${notBulk} AND (${changed})
BEGIN
  UPDATE ${t} SET version_no = OLD.version_no + 1,
         retired_at = CASE WHEN OLD.is_active <> 0 AND NEW.is_active = 0 THEN ${S_TS} WHEN NEW.is_active <> 0 THEN NULL ELSE OLD.retired_at END
   WHERE rowid = NEW.rowid;
  INSERT INTO az_version (${VERSION_COLS})
  SELECT ${q(e)}, ${keyExpr(def, 'NEW')}, OLD.version_no + 1,
         CASE WHEN OLD.is_active <> 0 AND NEW.is_active = 0 THEN 'retire' WHEN OLD.is_active = 0 AND NEW.is_active <> 0 THEN 'reactivate' ELSE 'change' END,
         ${S_TS}, ${S_TS}, ${sqliteSnapshot(snapCols, 'NEW')},
         (SELECT json_group_array(f) FROM (${fieldList})),
         CASE WHEN ${own} THEN COALESCE(NEW.changed_by, 'system') ELSE 'system' END,
         CASE WHEN ${own} THEN NEW.change_note END,
         CASE WHEN ${own} THEN NEW.change_id END,
         ${sqliteRefs(def, 'NEW')};
END`);

  // ---- no physical delete (controlled purge leaves a tombstone version)
  drop(`wfh_nodel_${t}`); drop(`wfh_purge_${t}`);
  out.push(`CREATE TRIGGER wfh_nodel_${t} BEFORE DELETE ON ${t} WHEN NOT ${S_FLAG('purge')}
BEGIN SELECT RAISE(ABORT, ${q(`WFH-NODELETE: ${def.label} records are never physically deleted — retire them instead`)}); END`);
  out.push(`CREATE TRIGGER wfh_purge_${t} AFTER DELETE ON ${t} WHEN ${S_FLAG('purge')} AND ${notBulk}
BEGIN
  INSERT INTO az_version (${VERSION_COLS})
  VALUES (${q(e)}, ${keyExpr(def, 'OLD')}, OLD.version_no + 1, 'purge', ${S_TS}, ${S_TS}, ${sqliteSnapshot(snapCols, 'OLD')}, NULL,
          COALESCE((SELECT v FROM az_ctl WHERE k = 'actor'), 'system'), (SELECT v FROM az_ctl WHERE k = 'note'), NULL, NULL);
END`);
  return out;
}

export function sqliteLogTriggerSql(table, mode) {
  const out = [`DROP TRIGGER IF EXISTS wfh_log_u_${table}`, `DROP TRIGGER IF EXISTS wfh_log_d_${table}`];
  if (mode === 'immutable') {
    out.push(`CREATE TRIGGER wfh_log_u_${table} BEFORE UPDATE ON ${table} WHEN NOT ${S_FLAG('bulk')}
BEGIN SELECT RAISE(ABORT, ${q(`WFH-IMMUTABLE: ${table} is append-only`)}); END`);
  }
  out.push(`CREATE TRIGGER wfh_log_d_${table} BEFORE DELETE ON ${table} WHEN NOT ${S_FLAG('purge')}
BEGIN SELECT RAISE(ABORT, ${q(`WFH-NODELETE: ${table} rows are retained permanently`)}); END`);
  return out;
}

export function sqliteBaselineSql(def, cols) {
  const snapCols = cols.filter((c) => !def.hide.includes(c));
  return `INSERT INTO az_version (${VERSION_COLS})
SELECT ${q(def.entity)}, ${keyExpr(def, 't')}, t.version_no, 'create', COALESCE(${cols.includes('created_at') ? 't.created_at' : 'NULL'}, ${S_TS}), ${S_TS}, ${sqliteSnapshot(snapCols, 't')}, NULL,
       'system', 'Baseline — record existed before versioning was enabled', NULL, ${sqliteRefs(def, 't')}
  FROM ${def.table} t
 WHERE NOT EXISTS (SELECT 1 FROM az_version v WHERE v.entity_type = ${q(def.entity)} AND v.entity_id = ${keyExpr(def, 't')})`;
}

// ================================================================ PostgreSQL
function pgCfg(def) {
  const refs = {};
  for (const [col, r] of Object.entries(def.refs)) refs[col] = { entity: r.entity, table: r.table, check: r.check, label: ENTITIES[r.entity].label };
  return {
    entity: def.entity, label: def.label, key: def.key, hide: def.hide, immutable: def.immutable, refs,
    ...(def.docNo ? { docno: { ...def.docNo, sql: def.docNo.sql.replace('?', '$1') } } : {}),
  };
}

export const PG_FUNCTIONS = `
CREATE OR REPLACE FUNCTION wfh_now() RETURNS text LANGUAGE sql VOLATILE AS
$$ SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE OR REPLACE FUNCTION wfh_flag(f text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('wfh.' || f, true), '') = '1' $$;

-- Generic versioning trigger. TG_ARGV[0] is the table's registry entry (JSON).
CREATE OR REPLACE FUNCTION wfh_version_trg() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  cfg jsonb := TG_ARGV[0]::jsonb;
  ent text := cfg->>'entity';
  hide text[] := ARRAY(SELECT jsonb_array_elements_text(cfg->'hide'));
  n jsonb; o jsonb; snap jsonb; diff jsonb; patch jsonb; refs jsonb := '{}'::jsonb;
  ts text := wfh_now(); eid text; op text; ver int; valid text;
  col text; r jsonb; val text; ract int; rver int; code text; nextno int;
  actor text; note text; cid text;
BEGIN
  IF wfh_flag('bulk') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT wfh_flag('purge') THEN
      RAISE EXCEPTION 'WFH-NODELETE: % records are never physically deleted — retire them instead', cfg->>'label';
    END IF;
    o := to_jsonb(OLD);
    eid := (SELECT string_agg(o->>k, ':' ORDER BY i) FROM jsonb_array_elements_text(cfg->'key') WITH ORDINALITY AS x(k, i));
    INSERT INTO az_version (entity_type, entity_id, version_no, operation, valid_from, recorded_at, data, changed_fields, changed_by, change_note, change_id, refs)
    VALUES (ent, eid, COALESCE((o->>'version_no')::int, 0) + 1, 'purge', ts, ts, (o - hide)::text, NULL,
            COALESCE(NULLIF(current_setting('wfh.actor', true), ''), 'system'), NULLIF(current_setting('wfh.note', true), ''), NULL, NULL);
    RETURN OLD;
  END IF;

  n := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD);
    FOR col IN SELECT jsonb_array_elements_text(cfg->'immutable') LOOP
      IF o ? col AND jsonb_typeof(o->col) <> 'null' AND (n->col) IS DISTINCT FROM (o->col) THEN
        RAISE EXCEPTION 'WFH-IMMUTABLE: % % is a permanent business key and cannot be changed', cfg->>'label', col;
      END IF;
    END LOOP;
    SELECT jsonb_agg(d.key ORDER BY d.key) INTO diff
      FROM jsonb_each(n - hide - 'doc_no'::text) d WHERE d.value IS DISTINCT FROM (o->d.key);
    IF diff IS NULL THEN                         -- technical-only change (position, read receipt…) → no new version
      NEW.version_no := OLD.version_no;
      RETURN NEW;
    END IF;
    ver := COALESCE((o->>'version_no')::int, 1) + 1;
    op := CASE WHEN (o->>'is_active') <> '0' AND (n->>'is_active') = '0' THEN 'retire'
               WHEN (o->>'is_active') = '0' AND (n->>'is_active') <> '0' THEN 'reactivate' ELSE 'change' END;
    patch := jsonb_build_object('version_no', ver, 'retired_at',
               CASE op WHEN 'retire' THEN to_jsonb(ts) WHEN 'reactivate' THEN 'null'::jsonb ELSE COALESCE(o->'retired_at', 'null'::jsonb) END);
    IF (n->>'change_id') IS DISTINCT FROM (o->>'change_id') THEN
      actor := COALESCE(n->>'changed_by', 'system'); note := n->>'change_note'; cid := n->>'change_id';
    ELSE
      actor := 'system'; note := NULL; cid := NULL;       -- write that bypassed the data layer
    END IF;
    valid := ts;
  ELSE
    ver := 1; op := 'create';
    patch := jsonb_build_object('version_no', 1, 'retired_at', 'null'::jsonb);
    IF cfg ? 'docno' AND COALESCE(n->>'doc_no', '') = '' THEN
      code := NULL;
      IF (n->>(cfg->'docno'->>'arg')) IS NOT NULL THEN
        EXECUTE cfg->'docno'->>'sql' INTO code USING n->>(cfg->'docno'->>'arg');
      END IF;
      code := COALESCE(code, cfg->'docno'->>'fallback');
      INSERT INTO az_number_range (range_key, last_no, updated_at) VALUES ((cfg->'docno'->>'range') || ':' || code, 1, ts)
        ON CONFLICT (range_key) DO UPDATE SET last_no = az_number_range.last_no + 1, updated_at = EXCLUDED.updated_at
        RETURNING last_no INTO nextno;
      patch := patch || jsonb_build_object('doc_no', code || '-' || (cfg->'docno'->>'letter')
               || lpad(nextno::text, GREATEST(COALESCE((cfg->'docno'->>'pad')::int, 0), length(nextno::text)), '0'));
    END IF;
    actor := COALESCE(n->>'changed_by', 'system'); note := n->>'change_note'; cid := n->>'change_id';
    valid := COALESCE(n->>'created_at', ts);
  END IF;

  -- referenced master data: must be active when newly referenced; pin its current version
  FOR col, r IN SELECT key, value FROM jsonb_each(cfg->'refs') LOOP
    val := n->>col;
    CONTINUE WHEN val IS NULL;
    ract := NULL; rver := NULL;
    EXECUTE format('SELECT is_active, version_no FROM %I WHERE id = $1', r->>'table') INTO ract, rver USING val;
    IF (r->>'check')::boolean AND ract = 0 AND (TG_OP = 'INSERT' OR val IS DISTINCT FROM o->>col) THEN
      RAISE EXCEPTION 'WFH-RETIRED-REF: the % referenced by % is retired — it cannot be used on a new or changed %', lower(r->>'label'), col, lower(cfg->>'label');
    END IF;
    IF rver IS NOT NULL THEN
      refs := refs || jsonb_build_object(col, jsonb_build_object('e', r->>'entity', 'id', val, 'v', rver));
    END IF;
  END LOOP;

  NEW := jsonb_populate_record(NEW, patch);
  n := to_jsonb(NEW);
  eid := (SELECT string_agg(n->>k, ':' ORDER BY i) FROM jsonb_array_elements_text(cfg->'key') WITH ORDINALITY AS x(k, i));
  INSERT INTO az_version (entity_type, entity_id, version_no, operation, valid_from, recorded_at, data, changed_fields, changed_by, change_note, change_id, refs)
  VALUES (ent, eid, ver, op, valid, ts, (n - hide)::text, diff::text, actor, note, cid, refs::text);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION wfh_log_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF wfh_flag('purge') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'WFH-NODELETE: % rows are retained permanently', TG_TABLE_NAME;
  END IF;
  IF wfh_flag('bulk') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'WFH-IMMUTABLE: % is append-only', TG_TABLE_NAME;
END
$fn$;

CREATE OR REPLACE FUNCTION wfh_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF wfh_flag('purge') THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'WFH-NODELETE: TRUNCATE is not allowed on protected table %', TG_TABLE_NAME;
END
$fn$;
`;

/** Full Postgres DDL for versioning (idempotent). Applied inside the schema migration. */
export function pgVersioningSql() {
  const out = [PG_FUNCTIONS];
  for (const def of Object.values(ENTITIES)) {
    for (const [c, type] of requiredColumns(def)) out.push(`ALTER TABLE ${def.table} ADD COLUMN IF NOT EXISTS ${c} ${type};`);
    if (def.docNo) out.push(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${def.table}_doc_no ON ${def.table}(doc_no);`);
    out.push(`DROP TRIGGER IF EXISTS wfh_version ON ${def.table};`);
    out.push(`CREATE TRIGGER wfh_version BEFORE INSERT OR UPDATE OR DELETE ON ${def.table} FOR EACH ROW EXECUTE FUNCTION wfh_version_trg(${q(JSON.stringify(pgCfg(def)))});`);
    out.push(`DROP TRIGGER IF EXISTS wfh_truncate ON ${def.table};`);
    out.push(`CREATE TRIGGER wfh_truncate BEFORE TRUNCATE ON ${def.table} FOR EACH STATEMENT EXECUTE FUNCTION wfh_truncate_guard();`);
  }
  for (const [table, mode] of Object.entries(LOG_TABLES)) {
    out.push(`DROP TRIGGER IF EXISTS wfh_log ON ${table};`);
    out.push(`CREATE TRIGGER wfh_log BEFORE ${mode === 'immutable' ? 'UPDATE OR ' : ''}DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION wfh_log_guard();`);
    out.push(`DROP TRIGGER IF EXISTS wfh_truncate ON ${table};`);
    out.push(`CREATE TRIGGER wfh_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION wfh_truncate_guard();`);
  }
  return out.join('\n');
}

function pgRefs(def, p) {
  const parts = Object.entries(def.refs).map(([col, r]) =>
    `${q(col)}, CASE WHEN ${p}.${col} IS NULL THEN NULL ELSE jsonb_build_object('e', ${q(r.entity)}, 'id', ${p}.${col}, 'v', (SELECT x.version_no FROM ${r.table} x WHERE x.id = ${p}.${col})) END`);
  return parts.length ? `COALESCE(jsonb_strip_nulls(jsonb_build_object(${parts.join(', ')})), '{}'::jsonb)::text` : "'{}'";
}
export function pgBaselineSql(def) {
  return `INSERT INTO az_version (${VERSION_COLS})
SELECT ${q(def.entity)}, ${keyExpr(def, 't')}, t.version_no, 'create', COALESCE(to_jsonb(t)->>'created_at', wfh_now()), wfh_now(),
       (to_jsonb(t) - ARRAY[${def.hide.map(q).join(',')}]::text[])::text, NULL,
       'system', 'Baseline — record existed before versioning was enabled', NULL, ${pgRefs(def, 't')}
  FROM ${def.table} t
 WHERE NOT EXISTS (SELECT 1 FROM az_version v WHERE v.entity_type = ${q(def.entity)} AND v.entity_id = ${keyExpr(def, 't')})`;
}

// ================================================================ engine-neutral post-migration steps
/**
 * Runs after triggers exist, with the bulk flag ON (no versions written):
 *  1. assigns document numbers to existing rows that have none (in creation order)
 *  2. writes a baseline version 1 for every existing row that has no history yet
 * `db` = { dialect, all, get, run } bound to the migration connection/transaction.
 */
export async function backfill(db, cols = {}) {
  let numbered = 0; let baselined = 0;
  for (const def of Object.values(ENTITIES)) {
    if (!def.docNo) continue;
    const d = def.docNo;
    const rows = await db.all(`SELECT id, ${d.arg} AS arg FROM ${def.table} WHERE doc_no IS NULL ORDER BY created_at, id`);
    for (const row of rows) {
      const code = (row.arg ? (await db.get(d.sql.replace('SELECT c.code', 'SELECT c.code AS code'), row.arg))?.code : null) || d.fallback;
      const key = `${d.range}:${code}`;
      await db.run('INSERT INTO az_number_range (range_key, last_no, updated_at) VALUES (?, 0, ?) ON CONFLICT (range_key) DO NOTHING', key, new Date().toISOString());
      await db.run('UPDATE az_number_range SET last_no = last_no + 1 WHERE range_key = ?', key);
      const n = (await db.get('SELECT last_no FROM az_number_range WHERE range_key = ?', key)).last_no;
      await db.run(`UPDATE ${def.table} SET doc_no = ? WHERE id = ?`, `${code}-${d.letter}${String(n).padStart(d.pad || 0, '0')}`, row.id);
      numbered++;
    }
  }
  for (const def of Object.values(ENTITIES)) {
    const sql = db.dialect === 'pg' ? pgBaselineSql(def) : sqliteBaselineSql(def, cols[def.table]);
    const r = await db.run(sql);
    baselined += Number(r?.changes || 0);
  }
  return { numbered, baselined };
}
