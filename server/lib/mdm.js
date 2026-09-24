// Master-data management (MDM) core — the service-layer half of the versioning model.
// The database triggers (server/db/versioning.js) guarantee the rules; this module gives the
// services safe, intention-revealing operations on top of them:
//   retire / reactivate      — the only way business records leave or re-enter circulation
//   versions / versionAt     — full history and point-in-time ("as of") views, with readable diffs
//   references               — which historical master-data versions a document was posted against
//   purge                    — controlled, audited correction (super admin only; leaves a tombstone)
//   applyEffectiveDates      — scheduler: validity periods start / end without anyone clicking
//   integrity / summary      — governance console checks
import { get, all, run, tx, now, j, stamp, withChange, withFlags, dialect, insert, update, uuid } from '../db/index.js';
import { ENTITIES, LOG_TABLES, TECHNICAL_TABLES } from '../db/versioning.js';
import { HttpError, notFound, forbidden, bad } from './http.js';

export function entityDef(entity) {
  const d = ENTITIES[entity];
  if (!d) throw notFound(`Unknown record type "${entity}"`);
  return d;
}
const keyWhere = (d) => d.key.map((k) => `${k} = ?`).join(' AND ');
const keyParams = (d, id) => (d.key.length > 1 ? String(id).split(':') : [id]);
const keyOf = (d, row) => d.key.map((k) => row[k]).join(':');

export async function loadRecord(entity, id) {
  const d = entityDef(entity);
  return get(`SELECT * FROM ${d.table} WHERE ${keyWhere(d)}`, ...keyParams(d, id));
}

/** Update a record by its (possibly composite) key through the attribution stamp. */
export async function updateRecord(d, id, patch) {
  const o = stamp(d.table, patch);
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  if (!keys.length) return;
  await run(`UPDATE ${d.table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${keyWhere(d)}`, ...keys.map((k) => o[k]), ...keyParams(d, id));
}

const titleOf = (d, row) => (row ? String(row[d.title] ?? row.doc_no ?? keyOf(d, row) ?? '').slice(0, 140) : null);

// ------------------------------------------------------------------ retire / reactivate
/**
 * Retire (soft-deactivate) a record. Nothing is deleted: a new version with is_active = 0
 * is written, the record disappears from normal lists, and every historical reference to it
 * stays valid. Registry `cascade` entries retire dependent documents in the same change group.
 */
export async function retire(entity, id, { reason } = {}) {
  const d = entityDef(entity);
  return tx(async () => {
    const row = await loadRecord(entity, id);
    if (!row) throw notFound(`${d.label} not found`);
    if (!row.is_active) return { already: true, cascaded: 0, row };
    const t = now();
    await updateRecord(d, id, { is_active: 0, effective_to: row.effective_to && row.effective_to < t ? row.effective_to : t, change_note: reason || null, ...(d.retireSet || {}) });
    let cascaded = 0;
    for (const c of d.cascade || []) {
      const cd = ENTITIES[c.entity];
      for (const k of await all(`SELECT id FROM ${cd.table} WHERE ${c.fk} = ? AND is_active = 1`, id)) {
        await updateRecord(cd, k.id, { is_active: 0, effective_to: t, change_note: `Retired with ${d.label.toLowerCase()} “${titleOf(d, row)}”${reason ? ` — ${reason}` : ''}`, ...(cd.retireSet || {}) });
        cascaded++;
      }
    }
    return { cascaded, row: await loadRecord(entity, id) };
  });
}

/** Reactivate a retired record (new version) and everything that was retired together with it. */
export async function reactivate(entity, id, { reason } = {}) {
  const d = entityDef(entity);
  return tx(async () => {
    const row = await loadRecord(entity, id);
    if (!row) throw notFound(`${d.label} not found`);
    if (row.is_active) return { already: true, restored: 0, row };
    await assertParentsActive(d, row);
    const last = await get(`SELECT change_id FROM az_version WHERE entity_type = ? AND entity_id = ? AND operation = 'retire' ORDER BY version_no DESC LIMIT 1`, entity, String(id));
    await updateRecord(d, id, { is_active: 1, effective_to: null, change_note: reason || null, ...(d.reactivateSet || {}) });
    let restored = 0;
    const cut = last?.change_id ? last.change_id.lastIndexOf('.') : -1;
    if (cut > 0) {
      const group = last.change_id.slice(0, cut);
      const peers = await all(`SELECT DISTINCT entity_type, entity_id FROM az_version
                                WHERE operation = 'retire' AND change_id LIKE ? AND NOT (entity_type = ? AND entity_id = ?)`, `${group}.%`, entity, String(id));
      for (const p of peers) {
        const pd = ENTITIES[p.entity_type];
        const pr = pd && await loadRecord(p.entity_type, p.entity_id);
        if (!pr || pr.is_active) continue;
        const lastPeer = await get(`SELECT change_id FROM az_version WHERE entity_type = ? AND entity_id = ? AND operation = 'retire' ORDER BY version_no DESC LIMIT 1`, p.entity_type, p.entity_id);
        if (!lastPeer?.change_id?.startsWith(`${group}.`)) continue; // retired again later, on its own
        await updateRecord(pd, p.entity_id, { is_active: 1, effective_to: null, change_note: `Reactivated with ${d.label.toLowerCase()} “${titleOf(d, row)}”`, ...(pd.reactivateSet || {}) });
        restored++;
      }
    }
    return { restored, row: await loadRecord(entity, id) };
  });
}

async function assertParentsActive(d, row) {
  for (const [col, r] of Object.entries(d.refs)) {
    if (!r.parent || !row[col]) continue;
    const p = await get(`SELECT * FROM ${r.table} WHERE id = ?`, row[col]);
    if (p && !p.is_active) {
      const pd = ENTITIES[r.entity];
      throw new HttpError(409, `Reactivate the ${pd.label.toLowerCase()} “${titleOf(pd, p)}” first — it is retired`);
    }
  }
}

/**
 * Grant / change a membership (unit, board, channel) without ever deleting rows:
 * an existing (even retired) membership gets a new version; a future effective_from
 * creates a pending grant that the scheduler activates on that date.
 */
export async function upsertMembership(entity, match, fields = {}) {
  const d = entityDef(entity);
  const where = Object.keys(match).map((k) => `${k} = ?`).join(' AND ');
  const ex = await get(`SELECT * FROM ${d.table} WHERE ${where}`, ...Object.values(match));
  const t = now();
  const pending = fields.effective_from && fields.effective_from > t;
  if (fields.effective_to && fields.effective_to <= (fields.effective_from || t)) throw bad('“Valid to” must be after “valid from”');
  if (!ex) {
    const row = { id: uuid(), ...match, ...fields, is_active: pending ? 0 : 1, created_at: t };
    await insert(d.table, row);
    return { created: true, pending, row };
  }
  const patch = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && ex[k] !== v) patch[k] = v;
  if (!ex.is_active && !pending) { patch.is_active = 1; if (fields.effective_to === undefined) patch.effective_to = null; }
  if (Object.keys(patch).length) await update(d.table, ex.id, patch);
  return { created: false, reactivated: !ex.is_active && !pending, pending, row: { ...ex, ...patch } };
}

/** End a membership (retire it) — history keeps who had access and until when. */
export async function endMembership(entity, match, reason) {
  const d = entityDef(entity);
  const where = Object.keys(match).map((k) => `${k} = ?`).join(' AND ');
  const ex = await get(`SELECT id FROM ${d.table} WHERE ${where}`, ...Object.values(match));
  if (!ex) throw notFound('Membership not found');
  return retire(entity, ex.id, { reason });
}

// ------------------------------------------------------------------ history
const FIELD_LABELS = {
  is_active: 'Status', list_id: 'List', board_id: 'Board', project_id: 'Project', assignee_id: 'Assignee', workspace_id: 'Unit',
  company_id: 'Company', user_id: 'User', card_id: 'Task', channel_id: 'Channel', group_id: 'Group', role_id: 'Role',
  permission_id: 'Permission', custom_role_id: 'Custom role', owner_id: 'Owner', created_by: 'Created by', due_date: 'Due date',
  start_date: 'Start date', end_date: 'End date', effective_from: 'Valid from', effective_to: 'Valid to', is_done: 'Done',
  is_done_list: 'Done list', is_template: 'Template', is_private: 'Private', is_shared: 'Shared', is_guest: 'Guest',
  is_super_admin: 'Super admin', estimate_hours: 'Estimate (h)', completed_at: 'Completed', cover_url: 'Cover',
  image_url: 'Image', drive_file_id: 'Drive file', whatsapp_number: 'WhatsApp', full_name: 'Full name', doc_no: 'Document no.',
  archived: 'Archived', deleted: 'Deleted', is_pinned: 'Pinned', acknowledged_by: 'Acknowledged by', resolved_at: 'Resolved',
};
export const fieldLabel = (f) => FIELD_LABELS[f] || f.replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function display(field, v, names) {
  if (v == null || v === '') return null;
  if (field === 'is_active') return Number(v) ? 'Active' : 'Retired';
  if (/^is_|^archived$|^deleted$/.test(field)) return Number(v) ? 'Yes' : 'No';
  if (field === 'labels') { const l = j(v, []); return Array.isArray(l) ? l.map((x) => x.text || x).join(', ') || null : String(v); }
  if (names[v]) return names[v];
  if (typeof v === 'string' && v.startsWith('{') && v.length > 60) return '(settings)';
  const s = String(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/** Resolve ids found in refs / *_id fields to readable names (current titles). */
async function nameMap(ids) {
  const out = {};
  const list = [...ids].filter((x) => typeof x === 'string' && x.length >= 8);
  if (!list.length) return out;
  const ph = list.map(() => '?').join(',');
  const sources = [
    ['SELECT u.id, COALESCE(p.full_name, u.username) AS t FROM users u LEFT JOIN profiles p ON p.id = u.id', 'u.id'],
    ['SELECT id, name AS t FROM az_company', 'id'], ['SELECT id, name AS t FROM az_workspace', 'id'],
    ['SELECT id, title AS t FROM az_project', 'id'], ['SELECT id, title AS t FROM az_board', 'id'],
    ['SELECT id, title AS t FROM az_list', 'id'], ['SELECT id, title AS t FROM az_card', 'id'],
    ['SELECT id, name AS t FROM az_role', 'id'], ['SELECT id, key AS t FROM az_permission', 'id'],
    ['SELECT id, name AS t FROM az_channel', 'id'], ['SELECT id, name AS t FROM az_group', 'id'],
    ['SELECT id, name AS t FROM az_pipeline', 'id'],
  ];
  for (const [sql, col] of sources) for (const r of await all(`${sql} WHERE ${col} IN (${ph})`, ...list)) out[r.id] = r.t;
  return out;
}

function summarize(d, v, changes) {
  switch (v.operation) {
    case 'create': return v.change_note?.startsWith('Baseline') ? 'Existing record (baseline)' : 'Created';
    case 'retire': return 'Retired';
    case 'reactivate': return 'Reactivated';
    case 'purge': return 'Purged (controlled correction)';
    default: {
      const move = changes.find((c) => c.field === 'list_id');
      const others = changes.filter((c) => !['list_id', 'board_id', 'completed_at', 'project_id'].includes(c.field)).map((c) => c.label);
      if (move) return `Moved: ${move.from || '—'} → ${move.to || '—'}${others.length ? ` · ${others.join(', ')} changed` : ''}`;
      const labels = changes.filter((c) => !['completed_at', 'project_id'].includes(c.field) || changes.length === 1).map((c) => c.label);
      if (!labels.length) return 'Changed';
      return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more changed` : `${labels.join(', ')} changed`;
    }
  }
}

/** Full, readable version history of one record (newest first). */
export async function versions(entity, id, { limit = 200 } = {}) {
  const d = entityDef(entity);
  const rows = await all(`SELECT v.*, u.username AS changed_by_username, p.full_name AS changed_by_name
                            FROM az_version v LEFT JOIN users u ON u.id = v.changed_by LEFT JOIN profiles p ON p.id = v.changed_by
                           WHERE v.entity_type = ? AND v.entity_id = ? ORDER BY v.version_no`, entity, String(id));
  if (!rows.length) throw notFound(`No history for this ${d.label.toLowerCase()}`);
  const ids = new Set();
  for (const r of rows) {
    r.data = j(r.data, {}); r.changed_fields = j(r.changed_fields, []); r.refs = j(r.refs, {});
    for (const [k, v] of Object.entries(r.data)) if (/_id$|^created_by$|^acknowledged_by$/.test(k) && v) ids.add(v);
  }
  const names = await nameMap(ids);
  const out = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1].data : {};
    const fields = r.operation === 'change' ? r.changed_fields : r.operation === 'create' ? [] : r.changed_fields.filter((f) => !['is_active', 'effective_to', 'archived', 'deleted'].includes(f));
    const changes = fields.map((f) => ({ field: f, label: fieldLabel(f), from: display(f, prev[f], names), to: display(f, r.data[f], names), kind: ISO.test(String(r.data[f] ?? prev[f] ?? '')) ? 'date' : 'text' }));
    return {
      version_no: r.version_no, operation: r.operation, valid_from: r.valid_from, valid_to: rows[i + 1]?.valid_from || null,
      recorded_at: r.recorded_at, is_current: i === rows.length - 1, summary: summarize(d, r, changes), changes,
      changed_by: r.changed_by, changed_by_name: r.changed_by_name || (r.changed_by?.startsWith('system') ? 'System' : r.changed_by_username || r.changed_by),
      change_note: r.change_note, change_id: r.change_id, refs: r.refs, data: r.data,
    };
  }).reverse();
  const current = await loadRecord(entity, id);
  const owner = current?.owner_id ? await get('SELECT u.id, u.username, p.full_name FROM users u LEFT JOIN profiles p ON p.id = u.id WHERE u.id = ?', current.owner_id) : null;
  return {
    entity, label: d.label, kind: d.kind, scope: d.scope, id: String(id), title: titleOf(d, current || rows[rows.length - 1].data),
    doc_no: current?.doc_no || null, exists: !!current, is_active: current ? !!current.is_active : false,
    current_version: current?.version_no ?? rows[rows.length - 1].version_no, retired_at: current?.retired_at || null,
    effective_from: current?.effective_from || null, effective_to: current?.effective_to || null, owner,
    total: out.length, versions: out.slice(0, limit),
  };
}

/** The version that was effective at a point in time. */
export async function versionAt(entity, id, at) {
  entityDef(entity);
  const ts = new Date(at);
  if (Number.isNaN(ts.getTime())) throw bad('at must be a date/time');
  const v = await get(`SELECT * FROM az_version WHERE entity_type = ? AND entity_id = ? AND valid_from <= ? AND operation <> 'purge'
                        ORDER BY version_no DESC LIMIT 1`, entity, String(id), ts.toISOString());
  if (!v) throw notFound('The record did not exist at that time');
  const next = await get('SELECT valid_from FROM az_version WHERE entity_type = ? AND entity_id = ? AND version_no = ?', entity, String(id), v.version_no + 1);
  return { entity, id: String(id), as_of: ts.toISOString(), version_no: v.version_no, operation: v.operation, valid_from: v.valid_from, valid_to: next?.valid_from || null, data: j(v.data, {}), refs: j(v.refs, {}) };
}

/**
 * Historical references: the master-data versions a document version was posted against,
 * compared with today's version of the same master record.
 */
export async function references(entity, id, versionNo) {
  entityDef(entity);
  const v = versionNo
    ? await get('SELECT * FROM az_version WHERE entity_type = ? AND entity_id = ? AND version_no = ?', entity, String(id), Number(versionNo))
    : await get("SELECT * FROM az_version WHERE entity_type = ? AND entity_id = ? AND operation <> 'purge' ORDER BY version_no DESC LIMIT 1", entity, String(id));
  if (!v) throw notFound('Version not found');
  const refs = j(v.refs, {});
  const out = [];
  for (const [col, r] of Object.entries(refs)) {
    const rd = ENTITIES[r.e];
    if (!rd) continue;
    const pinned = await get('SELECT data, valid_from FROM az_version WHERE entity_type = ? AND entity_id = ? AND version_no = ?', r.e, String(r.id), r.v);
    const cur = await get(`SELECT * FROM ${rd.table} WHERE id = ?`, r.id);
    const then = j(pinned?.data, {});
    if (r.e === 'user') { // show people by name (the profile), not by username
      const p = await get('SELECT full_name FROM profiles WHERE id = ?', r.id);
      if (p?.full_name) { then.username = p.full_name; if (cur) cur.username = p.full_name; }
    }
    out.push({
      field: col, label: fieldLabel(col), entity: r.e, entity_label: rd.label, id: r.id,
      pinned_version: r.v, pinned_title: titleOf(rd, then), pinned_valid_from: pinned?.valid_from || null,
      current_version: cur?.version_no ?? null, current_title: cur ? titleOf(rd, cur) : null,
      is_active: cur ? !!cur.is_active : false, changed_since: !!cur && cur.version_no !== r.v,
    });
  }
  return { entity, id: String(id), version_no: v.version_no, recorded_at: v.recorded_at, references: out };
}

// ------------------------------------------------------------------ controlled purge
/** Records that still reference this one (purge is refused while any exist). */
export async function dependents(entity, id) {
  const out = [];
  for (const d of Object.values(ENTITIES)) {
    for (const [col, r] of Object.entries(d.refs)) {
      if (r.entity !== entity) continue;
      const n = (await get(`SELECT COUNT(*) AS n FROM ${d.table} WHERE ${col} = ?`, id)).n;
      if (n) out.push({ entity: d.entity, label: d.label, field: col, count: n });
    }
  }
  return out;
}

export async function purge(entity, id, { user, reason, confirm }) {
  const d = entityDef(entity);
  const row = await loadRecord(entity, id);
  if (!row) throw notFound(`${d.label} not found`);
  if (!reason || String(reason).trim().length < 10) throw bad('A purge needs a reason of at least 10 characters (it is kept in the version history)');
  const accepted = [row.doc_no, row[d.title], keyOf(d, row)].filter(Boolean).map(String);
  if (!accepted.includes(String(confirm || '').trim())) throw bad(`Type the ${row.doc_no ? 'document number' : d.title ? d.title.replace(/_/g, ' ') : 'id'} exactly to confirm the purge`);
  if (row.is_active) throw new HttpError(409, `Retire the ${d.label.toLowerCase()} first — only retired records can be purged`);
  const deps = await dependents(entity, keyOf(d, row));
  if (deps.length) throw new HttpError(409, `Still referenced by ${deps.map((x) => `${x.count} ${x.label.toLowerCase()}${x.count > 1 ? 's' : ''}`).join(', ')} — purge or re-point those first`, { dependents: deps });
  await withFlags({ purge: 1, actor: user.id, note: String(reason).trim() }, async () => {
    await run(`DELETE FROM ${d.table} WHERE ${keyWhere(d)}`, ...keyParams(d, id));
  });
  return { purged: true, entity, id: keyOf(d, row), title: titleOf(d, row) };
}

// ------------------------------------------------------------------ effective dating
/** Retire records whose validity ended; activate pending records whose validity started. */
export async function applyEffectiveDates() {
  const t = now();
  let ended = 0; let started = 0;
  await withChange({ actorId: 'system:scheduler', requestId: `sched-${Date.now().toString(36)}` }, async () => {
    for (const d of Object.values(ENTITIES)) {
      const key = d.key.join(', ');
      for (const r of await all(`SELECT ${key} FROM ${d.table} WHERE is_active = 1 AND effective_to IS NOT NULL AND effective_to <= ?`, t)) {
        await updateRecord(d, keyOf(d, r), { is_active: 0, change_note: 'Validity period ended', ...(d.retireSet || {}) }); ended++;
      }
      for (const r of await all(`SELECT ${key} FROM ${d.table} WHERE is_active = 0 AND retired_at IS NULL AND effective_from IS NOT NULL AND effective_from <= ?
                                  AND (effective_to IS NULL OR effective_to > ?)`, t, t)) {
        await updateRecord(d, keyOf(d, r), { is_active: 1, change_note: 'Validity period started', ...(d.reactivateSet || {}) }); started++;
      }
    }
  });
  return { ended, started };
}
let lastEffective = 0;
/** Cheap throttle so serverless instances also apply validity dates between cron runs. */
export async function maybeApplyEffectiveDates(everyMs = 5 * 60e3) {
  if (Date.now() - lastEffective < everyMs) return null;
  lastEffective = Date.now();
  return applyEffectiveDates();
}

// ------------------------------------------------------------------ governance console
export async function summary() {
  const out = [];
  for (const d of Object.values(ENTITIES)) {
    const c = await get(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM ${d.table}`);
    const v = await get('SELECT COUNT(*) AS n, MAX(recorded_at) AS last FROM az_version WHERE entity_type = ?', d.entity);
    out.push({ entity: d.entity, label: d.label, table: d.table, kind: d.kind, scope: d.scope, total: c.total, active: c.active || 0, retired: c.total - (c.active || 0), versions: v.n, last_change: v.last, doc_numbers: !!d.docNo });
  }
  return out;
}

export async function changes({ entity, actor, operation, since, limit = 100 } = {}) {
  const where = ['1 = 1']; const p = [];
  if (entity) { where.push('v.entity_type = ?'); p.push(entity); }
  if (actor) { where.push('v.changed_by = ?'); p.push(actor); }
  if (operation) { where.push('v.operation = ?'); p.push(operation); }
  else where.push("NOT (v.operation = 'create' AND v.change_note LIKE 'Baseline%')");
  if (since) { where.push('v.recorded_at >= ?'); p.push(new Date(since).toISOString()); }
  const rows = await all(`SELECT v.id, v.entity_type, v.entity_id, v.version_no, v.operation, v.valid_from, v.recorded_at, v.changed_fields, v.changed_by,
                                 v.change_note, v.data, u.username AS changed_by_username, pr.full_name AS changed_by_name
                            FROM az_version v LEFT JOIN users u ON u.id = v.changed_by LEFT JOIN profiles pr ON pr.id = v.changed_by
                           WHERE ${where.join(' AND ')} ORDER BY v.id DESC LIMIT ${Math.min(500, Number(limit) || 100)}`, ...p);
  return rows.map((r) => {
    const d = ENTITIES[r.entity_type]; const data = j(r.data, {});
    const fields = j(r.changed_fields, []) || [];
    return {
      id: r.id, entity: r.entity_type, label: d?.label || r.entity_type, entity_id: r.entity_id, title: d ? titleOf(d, data) : r.entity_id,
      doc_no: data.doc_no || null, version_no: r.version_no, operation: r.operation, recorded_at: r.recorded_at,
      fields: fields.map(fieldLabel), change_note: r.change_note, changed_by: r.changed_by,
      changed_by_name: r.changed_by_name || (String(r.changed_by || '').startsWith('system') ? 'System' : r.changed_by_username || r.changed_by),
    };
  });
}

export async function retiredRecords(entity) {
  const defs = entity ? [entityDef(entity)] : Object.values(ENTITIES);
  const out = [];
  for (const d of defs) {
    const rows = await all(`SELECT * FROM ${d.table} WHERE is_active = 0 ORDER BY retired_at DESC LIMIT 200`);
    for (const r of rows) {
      const v = await get("SELECT change_note, changed_by FROM az_version WHERE entity_type = ? AND entity_id = ? AND operation = 'retire' ORDER BY version_no DESC LIMIT 1", d.entity, keyOf(d, r));
      out.push({ entity: d.entity, label: d.label, id: keyOf(d, r), title: titleOf(d, r), doc_no: r.doc_no || null, version_no: r.version_no, retired_at: r.retired_at, reason: v?.change_note || null, pending: !r.retired_at && !!r.effective_from });
    }
  }
  return out.sort((a, b) => String(b.retired_at || '').localeCompare(String(a.retired_at || '')));
}

export async function integrity() {
  const checks = [];
  const add = (name, count, level, detail) => checks.push({ name, count: Number(count) || 0, level: count ? level : 'ok', detail });
  let missing = 0; let drift = 0; let dangling = 0; let hidden = 0;
  for (const d of Object.values(ENTITIES)) {
    const k = d.key.map((c) => `t.${c}`).join(" || ':' || ");
    missing += (await get(`SELECT COUNT(*) AS n FROM ${d.table} t WHERE NOT EXISTS (SELECT 1 FROM az_version v WHERE v.entity_type = ? AND v.entity_id = ${k})`, d.entity)).n;
    drift += (await get(`SELECT COUNT(*) AS n FROM ${d.table} t WHERE t.version_no <> COALESCE((SELECT MAX(v.version_no) FROM az_version v WHERE v.entity_type = ? AND v.entity_id = ${k}), -1)`, d.entity)).n;
    for (const [col, r] of Object.entries(d.refs)) {
      if (col === 'id') continue;
      dangling += (await get(`SELECT COUNT(*) AS n FROM ${d.table} t WHERE t.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${r.table} x WHERE x.id = t.${col})`)).n;
      if (r.parent) hidden += (await get(`SELECT COUNT(*) AS n FROM ${d.table} t JOIN ${r.table} x ON x.id = t.${col} WHERE t.is_active = 1 AND x.is_active = 0`)).n;
    }
  }
  const gaps = (await get('SELECT COUNT(*) AS n FROM (SELECT entity_type, entity_id, COUNT(*) AS c, MAX(version_no) AS m, MIN(version_no) AS lo FROM az_version GROUP BY entity_type, entity_id) x WHERE x.c <> x.m OR x.lo <> 1')).n;
  add('Records without version history', missing, 'error', 'Every protected record must have at least version 1');
  add('Current version ≠ latest history version', drift, 'error', 'Base table version_no must equal the newest az_version row');
  add('Version sequences with gaps', gaps, 'error', 'Versions must be 1, 2, 3 … without holes');
  add('References to missing records', dangling, 'error', 'A reference column points at a record that does not exist');
  add('Active records under a retired parent', hidden, 'info', 'Hidden together with their retired parent; restored when it is reactivated');
  // pinned historical versions must exist (sample of the most recent versions)
  const recent = await all("SELECT refs FROM az_version WHERE refs IS NOT NULL AND refs <> '{}' ORDER BY id DESC LIMIT 400");
  let badPins = 0; const seen = new Set();
  for (const r of recent) for (const p of Object.values(j(r.refs, {}))) {
    const key = `${p.e}|${p.id}|${p.v}`; if (seen.has(key)) continue; seen.add(key);
    if (!(await get('SELECT 1 AS x FROM az_version WHERE entity_type = ? AND entity_id = ? AND version_no = ?', p.e, String(p.id), p.v))) badPins++;
  }
  add('Pinned master-data versions that do not exist', badPins, 'error', `Checked ${seen.size} pins from the latest 400 versions`);
  const dia = await dialect();
  const trig = dia === 'pg'
    ? (await get("SELECT COUNT(*) AS n FROM pg_trigger WHERE tgname LIKE 'wfh_%' AND NOT tgisinternal")).n
    : (await get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'wfh_%'")).n;
  const expected = dia === 'pg' ? Object.keys(ENTITIES).length * 2 + Object.keys(LOG_TABLES).length * 2 : null;
  add('Protection triggers installed', expected && trig < expected ? expected - trig : 0, 'error', `${trig} triggers enforce versioning, no-delete, immutable keys and retired references`);
  return { ok: !checks.some((c) => c.level === 'error' && c.count), checked_at: now(), checks };
}

export const CLASSIFICATION = () => ({
  master: Object.values(ENTITIES).filter((d) => d.kind === 'master').map((d) => ({ entity: d.entity, table: d.table, scope: d.scope, label: d.label })),
  documents: Object.values(ENTITIES).filter((d) => d.kind === 'document').map((d) => ({ entity: d.entity, table: d.table, scope: d.scope, label: d.label })),
  logs: Object.entries(LOG_TABLES).map(([table, mode]) => ({ table, mode })),
  technical: Object.entries(TECHNICAL_TABLES).map(([table, purpose]) => ({ table, purpose })),
});
