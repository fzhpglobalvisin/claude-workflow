// Task detail (Trello-style card back): fields, subtasks, requirements, Drive attachments,
// comments, activity/audit, AI crew actions.
import { useCallback, useEffect, useState } from 'react';
import { GET, POST, PATCH, DEL, uid } from '../lib/api.js';
import { subscribe } from '../lib/realtime.js';
import { useApp } from '../lib/store.jsx';
import { navigate } from '../lib/router.jsx';
import { Modal, Avatar, Spinner, InlineEdit, TimeAgo, AgeChip, Tabs, useConfirm, ErrorBox, PriorityPill } from './ui.jsx';
import { RichText, MentionInput } from './RichText.jsx';
import { cls, fmtDate, fmtDateTime, toInputDate, fromInputDate, dueStatus, drivePreview, fileSize, ageDays, PRIORITY_COLORS } from '../lib/format.js';
import {
  IX, IDesc, IChecklist, IClip, IComment, IActivity, IBot, ITrash, ICopy, IArchive, IFile, ILink, IImage, IFilm, IPlus, ISparkles,
  IChat, IPin, IEye, IExternal, ITag, IClock, IUser, IFlag, ITimer, IBoard,
} from './icons.js';
import { VersionPanel, RetireButton } from './VersionHistory.jsx';
import { CoverModal, useCoverRights } from './CoverPicker.jsx';

const REQ_ICON = { text: <IFile />, pdf: <IFile />, media: <IFilm />, link: <ILink /> };
const LABEL_COLORS = ['#4bce97', '#f5cd47', '#fea362', '#f87168', '#9f8fef', '#579dff', '#6cc3e0', '#94c748', '#e774bb'];

export function CardModal({ cardId, onClose }) {
  const { users, toast, can } = useApp();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('comments');
  const [busyAi, setBusyAi] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, confirmNode] = useConfirm();
  const [coverEdit, setCoverEdit] = useState(false);
  const coverRights = useCoverRights();

  const load = useCallback(() => GET(`/api/cards/${cardId}`).then((x) => { setD(x); setError(null); }).catch(setError), [cardId]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEffect(() => subscribe('board:changed', (e) => { if (e.cardId === cardId) { if (e.deleted) onClose(); else load(); } }), [cardId, load]);

  if (error) return <Modal title="Task" onClose={onClose}><ErrorBox error={error} onRetry={load} /></Modal>;
  if (!d) return <Modal title="Loading…" onClose={onClose} width={900}><Spinner /></Modal>;
  const { card, access } = d;
  const edit = access.canEdit && card.is_active; // retired tasks are read-only until reactivated
  const patchCard = async (patch) => {
    setD((x) => ({ ...x, card: { ...x.card, ...patch } }));
    // base_version = optimistic concurrency: the server refuses to overwrite a newer version (409)
    try { const c = await PATCH(`/api/cards/${card.id}`, { ...patch, base_version: card.version_no }); if (!c.queued) setD((x) => ({ ...x, card: { ...x.card, ...c } })); }
    catch (e) { toast(e.status === 409 ? `${e.message}` : e.message, 'error'); load(); }
  };
  const move = async (listId) => { try { await POST(`/api/cards/${card.id}/move`, { list_id: listId, index: 0 }); load(); } catch (e) { toast(e.message, 'error'); } };
  const runAi = async (kind) => {
    setBusyAi(kind);
    try {
      const r = await POST(`/api/ai/${kind}`, { card_id: card.id }, { queue: false });
      toast(kind === 'crew' ? 'AI crew finished: triage → plan → acceptance criteria' : r.output || 'Done', 'success');
      load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusyAi(null); }
  };
  const shareToChat = async () => {
    if (!d.board?.log_channel_id) return;
    await POST(`/api/channels/${d.board.log_channel_id}/messages`, { content: `📋 Let’s discuss “${card.title}” (${card.list_title})`, card_id: card.id });
    toast('Shared to the board chat', 'success');
  };
  const copy = async () => { const c = await POST(`/api/cards/${card.id}/copy`, {}, { queue: false }); toast('Copied', 'success'); navigate(`/board/${c.board_id}?card=${c.id}`); };
  const ds = dueStatus(card.due_date, card.is_done_list);
  const done = d.subtasks.filter((s) => s.is_done).length;

  return (
    <Modal bare onClose={onClose} width={960} className="card-modal">
      {card.cover_url && <div className="cm-cover" style={{ backgroundImage: `url("${card.cover_url}")` }}>{edit && coverRights.card && (
        <span className="cover-actions"><button className="btn sm" onClick={() => setCoverEdit(true)}>Change cover</button><button className="btn sm" onClick={() => patchCard({ cover_url: null })}>Remove cover</button></span>)}</div>}
      <button className="icon-btn cm-close" onClick={onClose} aria-label="Close"><IX /></button>
      <div className="cm-head">
        <IBoard className="cm-icon" />
        <div className="grow">
          <h2>{card.doc_no && <span className="doc-no" title="Task number (permanent business ID)">{card.doc_no}</span>}<InlineEdit value={card.title} onSave={(v) => patchCard({ title: v })} disabled={!edit} /></h2>
          <div className="cm-sub">
            {d.board ? <>in board <strong>{d.board.title}</strong> · list{' '}
              <select value={card.list_id || ''} disabled={!edit} onChange={(e) => move(e.target.value)} className="inline-select">{d.lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select></> : <strong>Personal inbox</strong>}
            {card.is_template && <span className="badge blue">Template</span>}
            <AgeChip iso={card.created_at} label="Task age" />
            <span className="muted small">created <TimeAgo iso={card.created_at} /> · updated <TimeAgo iso={card.updated_at} /></span>
          </div>
        </div>
      </div>

      {!card.is_active && (
        <div className="retired-banner"><IArchive /> This task is <strong>retired</strong> (version {card.version_no}) — it is kept with its full history and is read-only.
          {access.canDelete && <RetireButton entity="card" id={card.id} active={false} label="Task" className="btn sm" onDone={load} />}</div>
      )}
      <div className="cm-grid">
        <div className="cm-main">
          <div className="cm-fields">
            <label><span><IUser /> Assignee</span>
              <select value={card.assignee_id || ''} disabled={!edit} onChange={(e) => patchCard({ assignee_id: e.target.value || null })}>
                <option value="">Unassigned</option>{users.filter((u) => !u.is_guest).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select></label>
            <label><span><IFlag /> Priority</span>
              <select value={card.priority} disabled={!edit} onChange={(e) => patchCard({ priority: e.target.value })} style={{ borderLeft: `4px solid ${PRIORITY_COLORS[card.priority]}` }}>
                {['low', 'medium', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select></label>
            <label><span><IClock /> Start</span><input type="date" disabled={!edit} value={toInputDate(card.start_date)} onChange={(e) => patchCard({ start_date: fromInputDate(e.target.value) })} /></label>
            <label className={cls('due-field', ds)}><span><IClock /> Due {ds === 'overdue' && <em>overdue</em>}{ds === 'soon' && <em>soon</em>}{ds === 'done' && <em>done</em>}</span><input type="date" disabled={!edit} value={toInputDate(card.due_date)} onChange={(e) => patchCard({ due_date: fromInputDate(e.target.value) })} /></label>
            <label><span><ITimer /> Estimate (h)</span><input type="number" min="0" step="0.5" disabled={!edit} defaultValue={card.estimate_hours ?? ''} onBlur={(e) => patchCard({ estimate_hours: e.target.value })} /></label>
          </div>
          <Labels card={card} edit={edit} onChange={(labels) => patchCard({ labels })} />

          <section className="cm-sec">
            <h4><IDesc /> Description</h4>
            {edit ? <DescriptionEditor value={card.description} onSave={(v) => patchCard({ description: v })} /> : <RichText text={card.description || '—'} />}
          </section>

          <section className="cm-sec">
            <h4><IChecklist /> Subtasks <span className="muted">{done}/{d.subtasks.length}</span>
              {edit && can('ai.run') && <button className="btn xs ghost" disabled={!!busyAi} onClick={() => runAi('plan')}><ISparkles /> {busyAi === 'plan' ? 'Atlas is planning…' : 'Generate with Atlas'}</button>}</h4>
            {d.subtasks.length > 0 && <div className="progress"><i style={{ width: `${Math.round((done / d.subtasks.length) * 100)}%` }} /></div>}
            <Subtasks card={card} items={d.subtasks} edit={edit} reload={load} setD={setD} />
          </section>

          <section className="cm-sec">
            <h4><IFile /> Requirements <span className="muted">{d.requirements.length}</span>
              {edit && can('ai.run') && <button className="btn xs ghost" disabled={!!busyAi} onClick={() => runAi('qa')}><ISparkles /> {busyAi === 'qa' ? 'Quill is writing…' : 'Acceptance criteria (Quill)'}</button>}</h4>
            <Requirements card={card} items={d.requirements} edit={edit} reload={load} onPreview={setPreview} />
          </section>

          <section className="cm-sec">
            <h4><IClip /> Attachments <span className="muted">{d.attachments.length}</span><span className="muted small">Google Drive links</span></h4>
            <Attachments card={card} items={d.attachments} edit={edit} reload={load} onPreview={setPreview} onCover={coverRights.card ? (url) => patchCard({ cover_url: url }) : null} />
          </section>

          <section className="cm-sec">
            <Tabs value={tab} onChange={setTab} tabs={[
              { value: 'comments', label: 'Comments', icon: <IComment />, count: d.comments.length },
              { value: 'activity', label: 'Activity', icon: <IActivity />, count: d.activity.length },
              { value: 'ai', label: 'AI runs', icon: <IBot />, count: d.aiRuns.length },
            ]} />
            {tab === 'comments' && <Comments card={card} items={d.comments} reload={load} />}
            {tab === 'activity' && (
              <ul className="activity">{d.activity.map((a) => (
                <li key={a.id}><Avatar user={{ full_name: a.actor_name || 'System', color: '#626f86' }} size={24} />
                  <span><strong>{a.actor_name || 'System / AI'}</strong> {describe(a)} <small className="muted" title={fmtDateTime(a.created_at)}><TimeAgo iso={a.created_at} /></small></span></li>
              ))}</ul>
            )}
            {tab === 'ai' && (
              <ul className="activity">{d.aiRuns.map((r) => <li key={r.id}><span className="ai-avatar sm">{r.avatar}</span><span><strong>{r.agent_name}</strong> <em className="muted">({r.engine})</em> {r.output}<small className="muted"> · <TimeAgo iso={r.created_at} /></small></span></li>)}
                {!d.aiRuns.length && <li className="muted">No AI runs yet — try “Run AI crew”.</li>}</ul>
            )}
          </section>
        </div>

        <aside className="cm-side">
          {can('ai.run') && edit && (
            <div className="side-group">
              <h5>AI crew</h5>
              <button className="btn block ai-btn" disabled={!!busyAi} onClick={() => runAi('crew')}><ISparkles /> {busyAi === 'crew' ? 'Crew working…' : 'Run AI crew'}</button>
              <button className="btn block" disabled={!!busyAi} onClick={() => runAi('triage')}>🛡️ Triage (Sentinel)</button>
              <button className="btn block" disabled={!!busyAi} onClick={() => runAi('plan')}>🧭 Plan subtasks (Atlas)</button>
              <button className="btn block" disabled={!!busyAi} onClick={() => runAi('qa')}>✒️ Acceptance criteria (Quill)</button>
            </div>
          )}
          <div className="side-group">
            <h5>Actions</h5>
            {d.board && <button className="btn block" onClick={shareToChat}><IChat /> Discuss in board chat</button>}
            {edit && coverRights.card && <button className="btn block" onClick={() => setCoverEdit(true)}><IImage /> {card.cover_url ? 'Change cover' : 'Cover image'}</button>}
            {d.board && <button className="btn block" onClick={copy}><ICopy /> {card.is_template ? 'Create from template' : 'Copy'}</button>}
            {edit && <button className="btn block" onClick={() => patchCard({ is_template: !card.is_template })}><IPin /> {card.is_template ? 'Unmark template' : 'Make template'}</button>}
            {edit && <button className="btn block" onClick={() => { patchCard({ archived: true }); toast('Archived'); onClose(); }}><IArchive /> Archive</button>}
            {access.canDelete && card.is_active && <RetireButton entity="card" id={card.id} active label="Task" retireText="Retire task"
              confirmText={`Retire ${card.doc_no || 'this task'}? It leaves the board but is never deleted: subtasks, requirements, comments and every version stay available, and it can be reactivated.`}
              onDone={() => onClose()} />}
          </div>
          <div className="side-group small">
            <h5>Details</h5>
            <div className="kv"><span>Priority</span><PriorityPill p={card.priority} /></div>
            <div className="kv"><span>Due</span><span className={cls('due', ds)}>{card.due_date ? fmtDate(card.due_date, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span></div>
            <div className="kv"><span>Age</span><span>{ageDays(card.created_at)} days</span></div>
            <div className="kv"><span>Idle</span><span>{ageDays(card.updated_at)} days</span></div>
            {card.completed_at && <div className="kv"><span>Completed</span><span>{fmtDate(card.completed_at)}</span></div>}
            <div className="kv"><span>Your access</span><span>{access.role}</span></div>
            {d.board && <div className="kv"><span>Company</span><span>{d.board.company_code} · {d.board.workspace_name}</span></div>}
          </div>
          <div className="side-group">
            <VersionPanel entity="card" id={card.id} refreshKey={card.version_no} showRefs />
          </div>
        </aside>
      </div>
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {coverEdit && <CoverModal entity="card" id={card.id} url={card.cover_url} title={card.doc_no || card.title} onClose={() => setCoverEdit(false)} onSaved={() => load()} />}
      {confirmNode}
    </Modal>
  );
}

function describe(a) {
  const x = a.details || {};
  switch (a.type) {
    case 'card.created': return <>created this task{x.list ? <> in <b>{x.list}</b></> : ''}</>;
    case 'card.moved': return <>moved it from <b>{x.from}</b> to <b>{x.to}</b></>;
    case 'card.updated': return <>updated {(x.fields || []).join(', ')}</>;
    case 'subtask.created': return <>added subtask “{x.title}”</>;
    case 'subtask.completed': return <>completed “{x.title}”</>;
    case 'subtask.reopened': return <>reopened “{x.title}”</>;
    case 'requirement.added': return <>added {x.type} requirement “{x.title}”</>;
    case 'attachment.added': return <>attached “{x.name}”</>;
    case 'comment.added': return <>commented “{x.preview}”</>;
    case 'ai.subtasks_generated': return <>🤖 {x.agent} generated {x.count} subtasks</>;
    case 'ai.triaged': return <>🤖 {x.agent} set priority {x.priority}{x.assignee ? `, assignee ${x.assignee}` : ''}</>;
    case 'ai.criteria_written': return <>🤖 {x.agent} wrote acceptance criteria</>;
    default: return <>{a.type.replace('.', ' ')}</>;
  }
}

function DescriptionEditor({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value || '');
  useEffect(() => { if (!editing) setV(value || ''); }, [value, editing]);
  if (!editing) return <div className="desc-view" onClick={() => setEditing(true)} role="button" tabIndex={0}>{value ? <RichText text={value} /> : <span className="muted">Add a more detailed description… (bullet lines become subtasks with Atlas)</span>}</div>;
  return (
    <div className="desc-edit">
      <textarea rows={6} autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="Supports **bold**, *italic*, `code`, - bullets, links and @mentions" />
      <div className="row-inline"><button className="btn primary sm" onClick={() => { onSave(v); setEditing(false); }}>Save</button><button className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>
  );
}

function Labels({ card, edit, onChange }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const labels = card.labels || [];
  return (
    <div className="cm-labels">
      <span className="muted small"><ITag /> Labels</span>
      {labels.map((l, i) => <span key={i} className="label" style={{ background: l.color }}>{l.text}{edit && <button onClick={() => onChange(labels.filter((_, j) => j !== i))} aria-label="Remove label"><IX /></button>}</span>)}
      {edit && !adding && <button className="btn xs ghost" onClick={() => setAdding(true)}><IPlus /> Label</button>}
      {adding && (
        <span className="label-add">
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="label" onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { onChange([...labels, { text: text.trim(), color }]); setText(''); setAdding(false); } }} />
          {LABEL_COLORS.map((c) => <button key={c} className={cls('dot-btn', c === color && 'on')} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
          <button className="btn xs primary" onClick={() => { if (text.trim()) onChange([...labels, { text: text.trim(), color }]); setText(''); setAdding(false); }}>Add</button>
        </span>
      )}
    </div>
  );
}

function Subtasks({ card, items, edit, reload, setD }) {
  const { users, toast } = useApp();
  const [title, setTitle] = useState('');
  const upd = (id, patch) => setD((x) => ({ ...x, subtasks: x.subtasks.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const toggle = async (s) => { upd(s.id, { is_done: !s.is_done }); try { await PATCH(`/api/subtasks/${s.id}`, { is_done: !s.is_done }); } catch (e) { toast(e.message, 'error'); reload(); } };
  const add = async () => {
    if (!title.trim()) return;
    const id = uid();
    setD((x) => ({ ...x, subtasks: [...x.subtasks, { id, title: title.trim(), is_done: false, pending: true }] }));
    setTitle('');
    try { await POST(`/api/cards/${card.id}/subtasks`, { id, title: title.trim() }); } catch (e) { toast(e.message, 'error'); reload(); }
  };
  return (
    <div className="subtasks">
      {items.map((s) => (
        <div key={s.id} className={cls('subtask', s.is_done && 'done', s.pending && 'pending')}>
          <input type="checkbox" checked={!!s.is_done} disabled={!edit} onChange={() => toggle(s)} aria-label="Done" />
          <InlineEdit value={s.title} disabled={!edit} onSave={(v) => { upd(s.id, { title: v }); PATCH(`/api/subtasks/${s.id}`, { title: v }); }} className="grow" />
          {s.is_ai_generated && <span className="badge ai" title="Generated by the AI crew">AI</span>}
          {edit ? (
            <select className="mini-select" value={s.assignee_id || ''} onChange={(e) => { upd(s.id, { assignee_id: e.target.value }); PATCH(`/api/subtasks/${s.id}`, { assignee_id: e.target.value || null }); }} aria-label="Subtask assignee">
              <option value="">—</option>{users.filter((u) => !u.is_guest).map((u) => <option key={u.id} value={u.id}>{u.full_name.split(' ')[0]}</option>)}
            </select>
          ) : s.assignee_name && <small className="muted">{s.assignee_name}</small>}
          {edit && <input type="date" className="mini-date" value={toInputDate(s.due_date)} onChange={(e) => { upd(s.id, { due_date: fromInputDate(e.target.value) }); PATCH(`/api/subtasks/${s.id}`, { due_date: fromInputDate(e.target.value) }); }} aria-label="Subtask due date" />}
          {edit && <button className="icon-btn sm" onClick={async () => { setD((x) => ({ ...x, subtasks: x.subtasks.filter((y) => y.id !== s.id) })); await DEL(`/api/subtasks/${s.id}`); }} aria-label="Remove subtask (kept in history)" title="Remove (kept in history)"><IArchive /></button>}
        </div>
      ))}
      {edit && <div className="add-row"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a subtask…" onKeyDown={(e) => e.key === 'Enter' && add()} /><button className="btn sm" onClick={add}>Add</button></div>}
    </div>
  );
}

function Requirements({ card, items, edit, reload, onPreview }) {
  const { toast } = useApp();
  const [f, setF] = useState({ type: 'text', title: '', content: '', url: '' });
  const [open, setOpen] = useState(false);
  const add = async (e) => {
    e.preventDefault();
    try { await POST(`/api/cards/${card.id}/requirements`, f, { queue: false }); setF({ type: 'text', title: '', content: '', url: '' }); setOpen(false); reload(); } catch (ex) { toast(ex.message, 'error'); }
  };
  return (
    <div className="reqs">
      {items.map((q) => (
        <div key={q.id} className={cls('req', q.type)}>
          <div className="req-head">{REQ_ICON[q.type]}<strong>{q.title}</strong><span className="pill">{q.type}</span>
            <small className="muted">{q.author} · <TimeAgo iso={q.created_at} /></small>
            <span className="grow" />
            {q.url && drivePreview(q.url) && <button className="btn xs ghost" onClick={() => onPreview({ name: q.title, url: q.url })}><IEye /> Preview</button>}
            {q.url && <a className="btn xs ghost" href={q.url} target="_blank" rel="noreferrer"><IExternal /> Open</a>}
            {edit && <button className="icon-btn sm" onClick={async () => { await DEL(`/api/requirements/${q.id}`); reload(); }} aria-label="Remove requirement (kept in history)" title="Remove (kept in history)"><IArchive /></button>}
          </div>
          {q.content && <RichText text={q.content} className="req-body" />}
        </div>
      ))}
      {!items.length && <p className="muted small">No requirements yet — add specs as text, PDFs, media or links.</p>}
      {edit && !open && <button className="btn sm" onClick={() => setOpen(true)}><IPlus /> Add requirement</button>}
      {open && (
        <form className="req-form" onSubmit={add}>
          <div className="seg">{['text', 'pdf', 'media', 'link'].map((t) => <button type="button" key={t} className={cls(f.type === t && 'on')} onClick={() => setF({ ...f, type: t })}>{REQ_ICON[t]} {t}</button>)}</div>
          <input required placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          {f.type === 'text'
            ? <textarea required rows={4} placeholder="Requirement text…" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
            : <><input required placeholder={f.type === 'link' ? 'https://…' : 'Google Drive link (https://drive.google.com/file/d/…)'} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /><input placeholder="Note (optional)" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></>}
          <div className="row-inline"><button className="btn primary sm">Save</button><button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

function Attachments({ card, items, edit, reload, onPreview, onCover }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', url: '' });
  const add = async (e) => {
    e.preventDefault();
    try { const a = await POST(`/api/cards/${card.id}/attachments`, f, { queue: false }); if (!a.is_drive) toast('Saved — tip: Google Drive links get thumbnails & previews', 'info'); setF({ name: '', url: '' }); reload(); } catch (ex) { toast(ex.message, 'error'); }
  };
  return (
    <div className="atts">
      <div className="att-grid">
        {items.map((a) => (
          <div key={a.id} className="att">
            <button className="att-thumb" onClick={() => (drivePreview(a.url) ? onPreview(a) : window.open(a.url, '_blank', 'noopener'))}>
              {a.drive_thumbnail_link ? <img src={a.drive_thumbnail_link} alt="" loading="lazy" onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { textContent: (a.file_type || 'file').toUpperCase() })); }} /> : <span>{(a.file_type || 'file').toUpperCase()}</span>}
            </button>
            <div className="att-info">
              <a href={a.drive_web_view_link || a.url} target="_blank" rel="noreferrer"><strong>{a.name}</strong></a>
              <small className="muted">{a.uploader} · <TimeAgo iso={a.created_at} />{a.file_size ? ` · ${fileSize(a.file_size)}` : ''}</small>
              <span className="row-inline">
                {edit && onCover && a.drive_thumbnail_link && <button className="link" onClick={() => onCover(a.drive_thumbnail_link)}>Make cover</button>}
                {edit && <button className="link danger" onClick={async () => { await DEL(`/api/attachments/${a.id}`); reload(); }}>Remove</button>}
              </span>
            </div>
          </div>
        ))}
      </div>
      {edit && (
        <form className="add-row" onSubmit={add}>
          <input placeholder="Name (e.g. Wireframes.pdf)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input required placeholder="Google Drive link" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          <button className="btn sm">Attach</button>
        </form>
      )}
    </div>
  );
}

function Comments({ card, items, reload }) {
  const { user, toast, isAdmin, can } = useApp();
  const [text, setText] = useState('');
  const post = async () => {
    if (!text.trim()) return;
    try { await POST(`/api/cards/${card.id}/comments`, { id: uid(), text }); setText(''); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const sorted = [...items].sort((a, b) => (b.is_pinned - a.is_pinned) || (new Date(b.created_at) - new Date(a.created_at)));
  return (
    <div className="comments">
      {can('chat.post') && (
        <div className="comment-new"><Avatar user={user} size={30} />
          <div className="grow"><MentionInput value={text} onChange={setText} onSubmit={post} placeholder="Write a comment… @mention to notify" rows={2} />
            <button className="btn primary sm" onClick={post} disabled={!text.trim()}>Save</button></div></div>
      )}
      {sorted.map((c) => (
        <div key={c.id} className={cls('comment', c.is_pinned && 'pinned')}>
          <Avatar user={c} size={30} />
          <div className="grow">
            <div className="msg-head"><strong>{c.full_name || c.sender}</strong><small className="muted"><TimeAgo iso={c.created_at} /></small><AgeChip iso={c.created_at} compact />{c.is_pinned && <span className="badge blue"><IPin /> pinned</span>}</div>
            <div className="comment-body"><RichText text={c.text} /></div>
            <div className="row-inline small">
              <button className="link" onClick={async () => { await PATCH(`/api/comments/${c.id}`, { is_pinned: !c.is_pinned }); reload(); }}>{c.is_pinned ? 'Unpin' : 'Pin'}</button>
              {(c.profile_id === user.id || isAdmin) && <button className="link danger" onClick={async () => { await DEL(`/api/comments/${c.id}`); reload(); }}>Remove</button>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PreviewModal({ item, onClose }) {
  const src = drivePreview(item.url);
  return (
    <Modal title={item.name} onClose={onClose} width={960}>
      {src ? <iframe className="drive-frame" src={src} title={item.name} allow="autoplay" /> : <p>No inline preview for this link.</p>}
      <p className="muted small">Preview is served by Google Drive — you must have access to the file in your Google account. <a href={item.url} target="_blank" rel="noreferrer">Open in Drive</a></p>
    </Modal>
  );
}
