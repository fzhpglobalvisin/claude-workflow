// Version history shown ON the record itself (no need to visit an audit screen):
//   <VersionPanel entity="card" id={card.id} refreshKey={card.version_no} />
// → "Current version: 5 · Recent changes (v5 Priority changed · By Azam · 24-Sep-2026) · [View version history]"
// The data comes from az_version (append-only, written by database triggers).
import { useEffect, useState } from 'react';
import { GET, POST } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Modal, Spinner, ErrorBox, TimeAgo, Field } from './ui.jsx';
import { cls, fmtDateTime } from '../lib/format.js';
import { IClock, IArchive, IRefresh, ILayers, IDown, IRight, IUser } from './icons.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 24-Sep-2026 */
export const docDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`; };
const OP_TONE = { create: 'green', change: 'blue', retire: 'red', reactivate: 'green', purge: 'red' };
const val = (c, v) => (v == null ? '—' : c.kind === 'date' ? docDate(v) : v);

export function useVersions(entity, id, refreshKey, limit = 6) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    GET(`/api/versions/${entity}/${encodeURIComponent(id)}?limit=${limit}`)
      .then((data) => alive && setState({ data, error: null }))
      .catch((error) => alive && setState({ data: null, error }));
    return () => { alive = false; };
  }, [entity, id, refreshKey, limit]);
  return state;
}

/** Compact "Current version + Recent changes" block for a record page / side panel. */
export function VersionPanel({ entity, id, refreshKey, title = 'Version', recent = 3, showRefs = false, className }) {
  const { data, error } = useVersions(entity, id, refreshKey, Math.max(recent, 3));
  const [open, setOpen] = useState(false);
  if (error) return <div className={cls('version-panel', className)}><h5><IClock /> {title}</h5><p className="muted small">{error.message}</p></div>;
  if (!data) return <div className={cls('version-panel', className)}><h5><IClock /> {title}</h5><Spinner /></div>;
  return (
    <div className={cls('version-panel', className)}>
      <h5><IClock /> {title}</h5>
      <div className="vp-current">
        <span className="vp-badge">Current version: <strong>{data.current_version}</strong></span>
        {data.doc_no && <span className="vp-doc">{data.doc_no}</span>}
        <span className={cls('vp-status', data.is_active ? 'active' : 'retired')}>{data.is_active ? 'Active' : `Retired ${docDate(data.retired_at)}`}</span>
      </div>
      {(data.effective_from || data.effective_to) && <div className="vp-validity small muted">Valid {data.effective_from ? `from ${docDate(data.effective_from)}` : ''}{data.effective_to ? ` until ${docDate(data.effective_to)}` : ''}</div>}
      {data.owner && <div className="vp-owner small muted"><IUser /> Data owner: {data.owner.full_name || data.owner.username}</div>}
      <div className="vp-recent-label">Recent changes</div>
      <ol className="vp-recent">
        {data.versions.slice(0, recent).map((v) => (
          <li key={v.version_no}>
            <span className={cls('vp-v', OP_TONE[v.operation])}>v{v.version_no}</span>
            <div>
              <div className="vp-sum">{v.summary}</div>
              <div className="vp-meta">By: {v.changed_by_name || 'System'} · <span title={fmtDateTime(v.recorded_at)}>{docDate(v.valid_from)}</span></div>
              {v.change_note && !v.change_note.startsWith('Baseline') && <div className="vp-note">“{v.change_note}”</div>}
            </div>
          </li>
        ))}
      </ol>
      <button className="btn xs block" onClick={() => setOpen(true)}><ILayers /> View version history ({data.total})</button>
      {showRefs && <PostedAgainst entity={entity} id={id} refreshKey={refreshKey} />}
      {open && <HistoryModal entity={entity} id={id} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Which master-data versions this document was posted against (vs. today). */
export function PostedAgainst({ entity, id, refreshKey, version }) {
  const [d, setD] = useState(null);
  useEffect(() => { GET(`/api/versions/${entity}/${encodeURIComponent(id)}/refs${version ? `?version=${version}` : ''}`).then(setD).catch(() => setD(null)); }, [entity, id, refreshKey, version]);
  if (!d?.references?.length) return null;
  return (
    <div className="vp-refs">
      <div className="vp-recent-label">Posted against</div>
      <ul>{d.references.map((r) => (
        <li key={r.field}>
          <span className="muted">{r.label}</span>{' '}
          <strong>{r.pinned_title || '—'}</strong> <span className="vp-v xs">v{r.pinned_version}</span>
          {r.changed_since && <span className="vp-drift" title={`Now: ${r.current_title} (v${r.current_version})`}>now v{r.current_version}{r.current_title !== r.pinned_title ? ` “${r.current_title}”` : ''}</span>}
          {!r.is_active && <span className="vp-status retired xs">retired</span>}
        </li>
      ))}</ul>
    </div>
  );
}

/** Full version history: every version, the fields it changed (from → to), who, why, validity, snapshot. */
export function HistoryModal({ entity, id, onClose, title }) {
  const { data, error } = useVersions(entity, id, 0, 500);
  const [openV, setOpenV] = useState(null);
  return (
    <Modal title={title || (data ? `${data.label} history — ${data.doc_no ? `${data.doc_no} · ` : ''}${data.title || ''}` : 'Version history')} onClose={onClose} width={760}>
      <ErrorBox error={error} />
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="vh-head">
            <span className="vp-badge">Current version: <strong>{data.current_version}</strong></span>
            <span className={cls('vp-status', data.is_active ? 'active' : 'retired')}>{data.exists ? (data.is_active ? 'Active' : `Retired ${docDate(data.retired_at)}`) : 'Purged'}</span>
            <span className="muted small">{data.total} version{data.total === 1 ? '' : 's'} · {data.kind === 'master' ? 'master data' : 'business document'} · {data.scope} scope</span>
          </div>
          <ol className="vh-list">
            {data.versions.map((v) => {
              const expanded = openV === v.version_no;
              return (
                <li key={v.version_no} className={cls(v.is_current && 'current')}>
                  <button className="vh-row" onClick={() => setOpenV(expanded ? null : v.version_no)}>
                    {expanded ? <IDown /> : <IRight />}
                    <span className={cls('vp-v', OP_TONE[v.operation])}>v{v.version_no}</span>
                    <span className="vh-sum">{v.summary}</span>
                    <span className="vh-by">{v.changed_by_name || 'System'}</span>
                    <span className="vh-date" title={`Recorded ${fmtDateTime(v.recorded_at)}`}>{docDate(v.valid_from)}</span>
                  </button>
                  {expanded && (
                    <div className="vh-detail">
                      <div className="small muted">Valid {fmtDateTime(v.valid_from)} → {v.valid_to ? fmtDateTime(v.valid_to) : 'now (current)'}{v.change_id ? ` · change ${v.change_id}` : ''}</div>
                      {v.change_note && <div className="vp-note">“{v.change_note}”</div>}
                      {v.changes.length > 0 && (
                        <table className="table compact"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                          <tbody>{v.changes.map((c) => <tr key={c.field}><td>{c.label}</td><td className="old">{val(c, c.from)}</td><td className="new">{val(c, c.to)}</td></tr>)}</tbody></table>
                      )}
                      {Object.keys(v.refs || {}).length > 0 && <PostedAgainst entity={entity} id={id} version={v.version_no} />}
                      <details><summary className="small">Full snapshot of v{v.version_no}</summary><pre className="vh-snap">{JSON.stringify(v.data, null, 2)}</pre></details>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Modal>
  );
}

/** Retire / Reactivate buttons (retire asks for a reason — it is stored on the new version). */
export function RetireButton({ entity, id, active, label, onDone, className = 'btn block', retireText = 'Retire', confirmText }) {
  const { toast } = useApp();
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (kind, why) => {
    setBusy(true);
    try {
      const r = await POST(`/api/mdm/${entity}/${encodeURIComponent(id)}/${kind}`, { reason: why || null }, { queue: false });
      toast(kind === 'retire' ? `${label || 'Record'} retired${r.cascaded ? ` (+${r.cascaded} with it)` : ''} — kept in history` : `${label || 'Record'} reactivated${r.restored ? ` (+${r.restored} restored)` : ''}`, 'success');
      setAsk(false); setReason(''); onDone?.(kind, r);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  if (!active) return <button className={className} disabled={busy} onClick={() => act('reactivate', 'Reactivated')}><IRefresh /> Reactivate</button>;
  return (
    <>
      <button className={cls(className, 'warn')} onClick={() => setAsk(true)}><IArchive /> {retireText}</button>
      {ask && <ReasonModal title={`${retireText} ${label || ''}`.trim()} text={confirmText} busy={busy} reason={reason} setReason={setReason} onCancel={() => setAsk(false)} onOk={() => act('retire', reason)} okLabel={retireText} />}
    </>
  );
}

export function ReasonModal({ title, text, reason, setReason, onCancel, onOk, okLabel = 'Retire', busy }) {
  return (
    <Modal title={title} onClose={onCancel} width={460} footer={<>
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
      <button className="btn warn" disabled={busy} onClick={onOk}><IArchive /> {okLabel}</button>
    </>}>
      <p className="small">{text || 'Nothing is deleted. The record gets a new version marked retired, disappears from everyday lists, and every historical reference to it stays valid. It can be reactivated at any time.'}</p>
      <Field label="Reason (saved on the version)"><textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate of ZVL-12 / project closed / contract ended" /></Field>
    </Modal>
  );
}

/** Promise-based reason prompt for places that call a legacy DELETE endpoint: const why = await ask(...) */
export function useRetirePrompt() {
  const [st, setSt] = useState(null);
  const [reason, setReason] = useState('');
  const ask = (title, text, okLabel = 'Retire') => new Promise((resolve) => { setReason(''); setSt({ title, text, okLabel, resolve }); });
  const node = st && (
    <ReasonModal title={st.title} text={st.text} okLabel={st.okLabel} reason={reason} setReason={setReason}
      onCancel={() => { st.resolve(null); setSt(null); }} onOk={() => { st.resolve(reason.trim() || ''); setSt(null); }} />
  );
  return [ask, node];
}
/** `/api/x/1` + reason → `/api/x/1?reason=…` */
export const withReason = (url, reason) => (reason ? `${url}${url.includes('?') ? '&' : '?'}reason=${encodeURIComponent(reason)}` : url);
