// Master-data governance console (Superadmin = enterprise MDM authority).
// Registry of versioned record types · central change log · retired records (reactivate / purge)
// · integrity checks · data classification (master / documents / logs / technical).
import { useState } from 'react';
import { GET, POST } from '../lib/api.js';
import { useApp, useData } from '../lib/store.jsx';
import { Tabs, Spinner, ErrorBox, Modal, Field, Pill, TimeAgo, Empty } from '../components/ui.jsx';
import { HistoryModal, docDate } from '../components/VersionHistory.jsx';
import { cls, fmtDateTime } from '../lib/format.js';
import { ILayers, IClock, IArchive, IShield, IOk, IAlert, IRefresh, ITable, IDatabase } from '../components/icons.js';

const OPS = ['change', 'create', 'retire', 'reactivate', 'purge'];
const OP_TONE = { create: 'green', change: 'blue', retire: 'red', reactivate: 'green', purge: 'red' };

export default function MdmConsole() {
  const [tab, setTab] = useState('registry');
  const { data: reg, error, reload } = useData(() => GET('/api/mdm/registry'), []);
  const [history, setHistory] = useState(null);
  const [entity, setEntity] = useState('');
  return (
    <div className="mdm">
      <div className="mdm-intro">
        <div>
          <h3><ILayers /> Master data governance</h3>
          <p className="muted small">Business records are <b>never physically deleted</b> and <b>never overwritten</b>: every change appends a version (who, when, why) enforced by database triggers.
            Records leave circulation by being <b>retired</b>; purging is an exceptional, audited correction.</p>
        </div>
        {reg && <span className={cls('env-badge', reg.environment)} title="Environment this app runs in (and the database is tagged with)">{reg.environment}</span>}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'registry', label: 'Registry', icon: <ITable /> },
        { value: 'changes', label: 'Change log', icon: <IClock /> },
        { value: 'retired', label: 'Retired records', icon: <IArchive /> },
        { value: 'integrity', label: 'Integrity', icon: <IShield /> },
        { value: 'classes', label: 'Data classification', icon: <IDatabase /> },
      ]} />
      {tab === 'registry' && (!reg ? <Spinner /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Record type</th><th>Table</th><th>Kind</th><th>Scope</th><th className="num">Active</th><th className="num">Retired</th><th className="num">Versions</th><th>Last change</th><th /></tr></thead>
          <tbody>{reg.entities.map((e) => (
            <tr key={e.entity}>
              <td><strong>{e.label}</strong>{e.doc_numbers && <small className="muted"> · numbered</small>}</td>
              <td><code>{e.table}</code></td>
              <td><Pill tone={e.kind === 'master' ? 'info' : 'default'}>{e.kind}</Pill></td>
              <td className="small">{e.scope}</td>
              <td className="num">{e.active}</td><td className="num">{e.retired || ''}</td><td className="num">{e.versions}</td>
              <td className="small">{e.last_change ? <TimeAgo iso={e.last_change} /> : '—'}</td>
              <td className="nowrap"><button className="btn xs" onClick={() => { setEntity(e.entity); setTab('changes'); }}>Changes</button>
                {e.retired > 0 && <button className="btn xs" onClick={() => { setEntity(e.entity); setTab('retired'); }}>Retired</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ))}
      {tab === 'changes' && <ChangeLog reg={reg} entity={entity} setEntity={setEntity} onOpen={setHistory} />}
      {tab === 'retired' && <Retired reg={reg} entity={entity} setEntity={setEntity} onOpen={setHistory} onChanged={reload} />}
      {tab === 'integrity' && <Integrity />}
      {tab === 'classes' && (!reg ? <Spinner /> : <Classification c={reg.classification} />)}
      {history && <HistoryModal entity={history.entity} id={history.id} onClose={() => setHistory(null)} />}
    </div>
  );
}

function EntitySelect({ reg, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Record type">
      <option value="">All record types</option>
      {(reg?.entities || []).map((e) => <option key={e.entity} value={e.entity}>{e.label}</option>)}
    </select>
  );
}

function ChangeLog({ reg, entity, setEntity, onOpen }) {
  const [op, setOp] = useState('');
  const { data, error, reload } = useData(() => GET(`/api/mdm/changes?limit=200${entity ? `&entity=${entity}` : ''}${op ? `&operation=${op}` : ''}`), [entity, op]);
  return (
    <div>
      <div className="toolbar">
        <EntitySelect reg={reg} value={entity} onChange={setEntity} />
        <select value={op} onChange={(e) => setOp(e.target.value)} aria-label="Operation"><option value="">All operations (excl. baseline)</option>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
        <span className="grow" /><button className="btn sm" onClick={reload}><IRefresh /> Refresh</button>
      </div>
      <ErrorBox error={error} />
      {!data ? <Spinner /> : !data.length ? <Empty title="No changes yet" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>When</th><th>Record</th><th>Version</th><th>What changed</th><th>By</th><th>Reason</th></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => onOpen({ entity: c.entity, id: c.entity_id })}>
              <td className="small nowrap" title={fmtDateTime(c.recorded_at)}>{docDate(c.recorded_at)} <span className="muted"><TimeAgo iso={c.recorded_at} short /></span></td>
              <td><span className="muted small">{c.label}</span> {c.doc_no && <span className="doc-no">{c.doc_no}</span>}<strong>{c.title}</strong></td>
              <td><span className={cls('vp-v', OP_TONE[c.operation])}>v{c.version_no}</span> <small className="muted">{c.operation}</small></td>
              <td className="small">{c.fields.join(', ') || '—'}</td>
              <td className="small">{c.changed_by_name || 'System'}</td>
              <td className="small muted">{c.change_note || ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function Retired({ reg, entity, setEntity, onOpen, onChanged }) {
  const { toast } = useApp();
  const { data, error, reload } = useData(() => GET(`/api/mdm/retired${entity ? `?entity=${entity}` : ''}`), [entity]);
  const [purge, setPurge] = useState(null);
  const reactivate = async (r) => {
    try { const x = await POST(`/api/mdm/${r.entity}/${encodeURIComponent(r.id)}/reactivate`, { reason: 'Reactivated by the MDM authority' }, { queue: false }); toast(`${r.label} reactivated${x.restored ? ` (+${x.restored} restored with it)` : ''}`, 'success'); reload(); onChanged(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div>
      <div className="toolbar"><EntitySelect reg={reg} value={entity} onChange={setEntity} /><span className="grow" /><span className="muted small">Retired records are hidden from everyday screens but keep every version and reference.</span></div>
      <ErrorBox error={error} />
      {!data ? <Spinner /> : !data.length ? <Empty title="Nothing retired" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Record</th><th>Retired</th><th>Reason</th><th>Version</th><th /></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={`${r.entity}:${r.id}`}>
              <td><span className="muted small">{r.label}</span> {r.doc_no && <span className="doc-no">{r.doc_no}</span>}<strong>{r.title}</strong>{r.pending && <Pill tone="info">pending start</Pill>}</td>
              <td className="small">{docDate(r.retired_at)}</td>
              <td className="small muted">{r.reason || '—'}</td>
              <td><button className="vp-v link" onClick={() => onOpen({ entity: r.entity, id: r.id })}>v{r.version_no}</button></td>
              <td className="nowrap">
                <button className="btn xs" onClick={() => reactivate(r)}><IRefresh /> Reactivate</button>
                <button className="btn xs danger" onClick={() => setPurge(r)} title="Exceptional administrative correction">Purge…</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {purge && <PurgeModal rec={purge} onClose={() => setPurge(null)} onDone={() => { setPurge(null); reload(); onChanged(); }} />}
    </div>
  );
}

function PurgeModal({ rec, onClose, onDone }) {
  const { toast } = useApp();
  const { data: deps } = useData(() => GET(`/api/mdm/${rec.entity}/${encodeURIComponent(rec.id)}/dependents`), [rec.id]);
  const [reason, setReason] = useState('');
  const [confirmText, setConfirm] = useState('');
  const key = rec.doc_no || rec.title;
  const go = async () => {
    try { await POST(`/api/mdm/${rec.entity}/${encodeURIComponent(rec.id)}/purge`, { reason, confirm: confirmText }, { queue: false }); toast('Purged — a tombstone version keeps the final state', 'success'); onDone(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Purge ${rec.label.toLowerCase()} — exceptional correction`} onClose={onClose} width={520} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn danger" disabled={!deps || deps.length > 0 || reason.trim().length < 10 || confirmText.trim() !== key} onClick={go}>Purge permanently</button>
    </>}>
      <p className="small"><IAlert /> Purging physically removes the row. It is only for data that should never have existed (e.g. created by mistake, legal erasure). The full history is kept and a final <b>purge</b> version records who did it and why.</p>
      {!deps ? <Spinner /> : deps.length ? (
        <div className="error-box">Still referenced by {deps.map((d) => `${d.count} ${d.label.toLowerCase()}${d.count > 1 ? 's' : ''} (${d.field})`).join(', ')} — purge or re-point those first.</div>
      ) : <p className="small muted">No other record references it.</p>}
      <Field label="Reason (min. 10 characters, kept forever)"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label={<>Type <code>{key}</code> to confirm</>}><input value={confirmText} onChange={(e) => setConfirm(e.target.value)} /></Field>
    </Modal>
  );
}

function Integrity() {
  const { data, error, reload, loading } = useData(() => GET('/api/mdm/integrity'), []);
  return (
    <div>
      <div className="toolbar">{data && (data.ok ? <Pill tone="ok"><IOk /> All integrity checks passed</Pill> : <Pill tone="bad"><IAlert /> Problems found</Pill>)}
        <span className="grow" /><button className="btn sm" disabled={loading} onClick={reload}><IRefresh /> Run checks</button></div>
      <ErrorBox error={error} />
      {!data ? <Spinner label="Checking…" /> : (
        <ul className="integrity">{data.checks.map((c) => (
          <li key={c.name} className={`lvl-${c.level}`}>
            {c.level === 'ok' ? <IOk /> : <IAlert />}
            <div><strong>{c.name}</strong>{c.count ? <b className="count">{c.count}</b> : null}<div className="small muted">{c.detail}</div></div>
          </li>
        ))}<li className="muted small">Checked {fmtDateTime(data.checked_at)}</li></ul>
      )}
    </div>
  );
}

function Classification({ c }) {
  const col = (title, text, rows, render) => (
    <div className="class-col"><h4>{title}</h4><p className="small muted">{text}</p><ul>{rows.map(render)}</ul></div>
  );
  return (
    <div className="class-grid">
      {col('Master data', 'Versioned · retire only · governed by scope (global = Superadmin).', c.master, (r) => <li key={r.table}><strong>{r.label}</strong> <code>{r.table}</code> <small className="muted">{r.scope}</small></li>)}
      {col('Business documents', 'Versioned · retire only · pin the master-data versions they were posted against.', c.documents, (r) => <li key={r.table}><strong>{r.label}</strong> <code>{r.table}</code></li>)}
      {col('Retained logs', 'Never deleted; append-only logs can never be edited.', c.logs, (r) => <li key={r.table}><code>{r.table}</code> <small className="muted">{r.mode === 'immutable' ? 'append-only' : 'no delete'}</small></li>)}
      {col('Technical data', 'May be cleaned up — no business meaning, no history needed.', c.technical, (r) => <li key={r.table}><code>{r.table}</code> <small className="muted">{r.purpose}</small></li>)}
    </div>
  );
}
