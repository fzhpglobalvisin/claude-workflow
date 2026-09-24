// Trello-style board: inbox panel, lists with drag & drop (mouse + touch), planner, table view,
// board chat drawer, access sharing, filters, real-time updates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GET, POST, PATCH, DEL, PUT, uid } from '../lib/api.js';
import { subscribe } from '../lib/realtime.js';
import { useApp } from '../lib/store.jsx';
import { navigate, setQuery, Link } from '../lib/router.jsx';
import { Avatar, AvatarStack, Spinner, ErrorBox, InlineEdit, Popover, Modal, AgeChip, useConfirm, Empty, PriorityPill, TimeAgo } from '../components/ui.jsx';
import { CardModal } from '../components/CardModal.jsx';
import { useRetirePrompt, withReason, HistoryModal } from '../components/VersionHistory.jsx';
import { ChannelView } from '../components/Chat.jsx';
import { bgStyle, BOARD_BACKGROUNDS } from '../components/CreateModal.jsx';
import { cls, fmtDate, dueStatus, ageDays, PRIORITY_COLORS } from '../lib/format.js';
import {
  IInbox, ICalendar, IBoard, ISwitch, IPlus, IX, IMore, IEye, IDesc, IComment, IClip, ICheckSquare, IClock, IFilter, IShare, IStar,
  IChat, IFile, ITable, ITrash, IEdit, ILeft, IRight, ISparkles, IUserPlus, IChart, IArchive,
} from '../components/icons.js';

// ---------------------------------------------------------------- drag & drop (pointer events, works on touch)
function useKanbanDnd({ onDrop, scrollRef }) {
  const [drag, setDrag] = useState(null);
  const st = useRef(null);
  const suppressClick = useRef(false);

  const computeTarget = (x, y) => {
    const els = document.elementsFromPoint(x, y);
    const listEl = els.find((el) => el.dataset && el.dataset.listId);
    if (!listEl) return null;
    const cards = [...listEl.querySelectorAll('[data-card-id]')].filter((el) => el.dataset.cardId !== st.current.card.id);
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    return { listId: listEl.dataset.listId, index };
  };

  const start = (e, card, fromList) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button, a, input, textarea, select')) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    st.current = { card, fromList, sx: e.clientX, sy: e.clientY, rect, active: false, touch: e.pointerType === 'touch', timer: null, id: e.pointerId };
    const activate = () => {
      if (!st.current) return;
      st.current.active = true;
      navigator.vibrate?.(15);
      const t = computeTarget(st.current.x ?? st.current.sx, st.current.y ?? st.current.sy) || { listId: fromList, index: 0 };
      st.current.drag = { card, fromList, x: st.current.x ?? st.current.sx, y: st.current.y ?? st.current.sy, ox: st.current.sx - rect.left, oy: st.current.sy - rect.top, w: rect.width, h: rect.height, over: t };
      setDrag(st.current.drag);
    };
    if (st.current.touch) st.current.timer = setTimeout(activate, 240);

    const move = (ev) => {
      const s = st.current; if (!s) return;
      s.x = ev.clientX; s.y = ev.clientY;
      if (!s.active) {
        const dist = Math.hypot(ev.clientX - s.sx, ev.clientY - s.sy);
        if (s.touch) { if (dist > 10) { clearTimeout(s.timer); cleanup(); } return; }
        if (dist > 6) activate(); else return;
      }
      const over = computeTarget(ev.clientX, ev.clientY);
      s.drag = { ...s.drag, x: ev.clientX, y: ev.clientY, over: over || s.drag.over };
      setDrag(s.drag);
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        if (ev.clientX > r.right - 60) sc.scrollLeft += 18; else if (ev.clientX < r.left + 60) sc.scrollLeft -= 18;
      }
    };
    const touchMove = (ev) => { if (st.current?.active) ev.preventDefault(); };
    const up = () => {
      const s = st.current;
      if (s?.active) {
        suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 50);
        const d = s.drag;
        setDrag(null);
        if (d?.over) onDrop(d.card, d.fromList, d.over.listId, d.over.index);
      }
      cleanup();
    };
    const cleanup = () => {
      if (st.current?.timer) clearTimeout(st.current.timer);
      st.current = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchmove', touchMove);
      document.body.classList.remove('dragging');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    window.addEventListener('touchmove', touchMove, { passive: false });
    document.body.classList.add('dragging');
  };
  return { drag, start, suppressClick };
}

// ---------------------------------------------------------------- card tile
function CardTile({ card, onOpen, onPointerDown, dragging }) {
  const ds = dueStatus(card.due_date, card.is_done_list);
  return (
    <div className={cls('kcard', dragging && 'ghosted', card.pending && 'pending')} data-card-id={card.id} onPointerDown={onPointerDown} onClick={onOpen}
      onContextMenu={(e) => e.preventDefault()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()} style={{ '--prio': PRIORITY_COLORS[card.priority] }}>
      {card.cover_url && <div className="kcard-cover"><img src={card.cover_url} alt="" loading="lazy" draggable={false} onError={(e) => { e.currentTarget.parentElement.remove(); }} /></div>}
      <div className="kcard-body">
        {card.labels?.length > 0 && <div className="kcard-labels">{card.labels.map((l, i) => <span key={i} style={{ background: l.color }} title={l.text}>{l.text}</span>)}</div>}
        <div className="kcard-title">{card.title}</div>
        {card.is_template && <span className="template-badge"><IFile /> This card is a template.</span>}
        <div className="kcard-badges">
          {card.due_date && <span className={cls('due', ds)} title={`Due ${new Date(card.due_date).toLocaleString()}`}><IClock />{fmtDate(card.due_date)}</span>}
          {card.description && <span title="Has description"><IDesc /></span>}
          {card.comment_count > 0 && <span title="Comments"><IComment />{card.comment_count}</span>}
          {card.attachment_count > 0 && <span title="Drive attachments"><IClip />{card.attachment_count}</span>}
          {card.requirement_count > 0 && <span title="Requirements"><IFile />{card.requirement_count}</span>}
          {card.subtask_total > 0 && <span className={cls(card.subtask_done === card.subtask_total && 'all-done')} title="Subtasks"><ICheckSquare />{card.subtask_done}/{card.subtask_total}</span>}
          {!card.is_done_list && <AgeChip iso={card.created_at} compact label="Open for" />}
          <span className="grow" />
          {card.assignee_id && <Avatar user={{ id: card.assignee_id, full_name: card.assignee_name, color: card.assignee_color, avatar_url: card.assignee_avatar }} size={24} />}
        </div>
      </div>
    </div>
  );
}

function AddCard({ onAdd, label = 'Add a card' }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const submit = () => { if (title.trim()) { onAdd(title.trim()); setTitle(''); } };
  if (!open) return <button className="add-card" onClick={() => setOpen(true)}><IPlus /> {label}</button>;
  return (
    <div className="add-card-form">
      <textarea autoFocus rows={2} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter a title for this card…"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') setOpen(false); }} />
      <div className="row-inline"><button className="btn primary sm" onClick={submit}>Add card</button><button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Cancel"><IX /></button></div>
    </div>
  );
}

// ---------------------------------------------------------------- page
export default function BoardPage({ params, query }) {
  const boardId = params.id;
  const { user, toast, can, isSuper } = useApp();
  const [data, setData] = useState(null);
  const [inbox, setInbox] = useState([]);
  const [error, setError] = useState(null);
  const [panel, setPanel] = useState(() => { if (window.matchMedia('(max-width: 760px)').matches) return false; try { return localStorage.getItem('wfh.inbox') !== '0'; } catch { return true; } });
  const [view, setView] = useState('board');
  const [chat, setChat] = useState(false);
  const [share, setShare] = useState(false);
  const [filters, setFilters] = useState({ q: '', assignee: '', priority: '', due: '' });
  const [confirm, confirmNode] = useConfirm();
  const [askRetire, retireNode] = useRetirePrompt();
  const [history, setHistory] = useState(null); // { entity, id }
  const scrollRef = useRef(null);
  const reloadTimer = useRef(null);

  const load = useCallback(() => GET(`/api/boards/${boardId}`).then((d) => { setData(d); setError(null); }).catch(setError), [boardId]);
  const loadInbox = useCallback(() => GET('/api/inbox').then(setInbox).catch(() => {}), []);
  useEffect(() => { setData(null); load(); loadInbox(); }, [load, loadInbox]);
  useEffect(() => subscribe('board:changed', (e) => {
    if (e.boardId !== boardId) return;
    if (e.kind === 'deleted') { toast('This board was retired', 'error'); navigate('/home'); return; }
    clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(load, 150);
  }), [boardId, load]);
  useEffect(() => { if (window.matchMedia('(max-width: 760px)').matches) return; try { localStorage.setItem('wfh.inbox', panel ? '1' : '0'); } catch {} }, [panel]);

  const onDrop = useCallback(async (card, fromList, toList, index) => {
    if (toList === 'inbox') { if (fromList !== 'inbox') toast('Board tasks can’t go back to your personal inbox', 'error'); return; }
    if (!data?.access.canEdit) { toast('You have view-only access on this board', 'error'); return; }
    // optimistic reorder
    setData((d) => {
      const others = d.cards.filter((c) => c.id !== card.id);
      const target = others.filter((c) => c.list_id === toList).sort((a, b) => a.position - b.position);
      const list = d.lists.find((l) => l.id === toList);
      target.splice(index, 0, { ...card, list_id: toList, board_id: boardId, is_done_list: list?.is_done_list });
      const pos = Object.fromEntries(target.map((c, i) => [c.id, i]));
      return { ...d, cards: [...others.filter((c) => c.list_id !== toList), ...target].map((c) => (pos[c.id] != null ? { ...c, position: pos[c.id] } : c)) };
    });
    if (fromList === 'inbox') setInbox((l) => l.filter((c) => c.id !== card.id));
    try { await POST(`/api/cards/${card.id}/move`, { list_id: toList, index }); } catch (e) { toast(e.message, 'error'); load(); loadInbox(); }
  }, [data?.access.canEdit, boardId, load, loadInbox]);
  const { drag, start, suppressClick } = useKanbanDnd({ onDrop, scrollRef });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filters.q.toLowerCase();
    return data.cards.filter((c) => (!q || c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
      && (!filters.assignee || (filters.assignee === 'me' ? c.assignee_id === user.id : filters.assignee === 'none' ? !c.assignee_id : c.assignee_id === filters.assignee))
      && (!filters.priority || c.priority === filters.priority)
      && (!filters.due || (filters.due === 'overdue' ? dueStatus(c.due_date, c.is_done_list) === 'overdue' : filters.due === 'soon' ? dueStatus(c.due_date, c.is_done_list) === 'soon' : filters.due === 'stale' ? !c.is_done_list && ageDays(c.updated_at) >= 14 : true)));
  }, [data, filters, user.id]);
  const activeFilters = Object.values(filters).filter(Boolean).length;

  if (error) return <div className="page"><ErrorBox error={error} onRetry={load} /><Link to="/home" className="btn">Back to company</Link></div>;
  if (!data) return <Spinner label="Loading board…" />;
  const { board, lists, members, access } = data;

  const addCard = async (list, title) => {
    const id = uid();
    const optimistic = { id, title, list_id: list.id, board_id: boardId, position: 1e6, priority: 'medium', labels: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), pending: true, subtask_total: 0, is_done_list: list.is_done_list };
    setData((d) => ({ ...d, cards: [...d.cards, optimistic] }));
    try { await POST(`/api/lists/${list.id}/cards`, { id, title }); } catch (e) { toast(e.message, 'error'); load(); }
  };
  const addList = async (title) => { try { await POST(`/api/boards/${boardId}/lists`, { id: uid(), title }); load(); } catch (e) { toast(e.message, 'error'); } };
  const renameList = async (l, title) => { setData((d) => ({ ...d, lists: d.lists.map((x) => (x.id === l.id ? { ...x, title } : x)) })); await PATCH(`/api/lists/${l.id}`, { title }); };
  const moveList = async (l, dir) => {
    const ids = lists.map((x) => x.id); const i = ids.indexOf(l.id); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setData((d) => ({ ...d, lists: ids.map((id, k) => ({ ...d.lists.find((x) => x.id === id), position: k })) }));
    await POST(`/api/boards/${boardId}/lists/reorder`, { ids });
  };
  // lists are never deleted: retiring archives the list's active tasks in the same change (reactivation restores them)
  const retireList = async (l) => {
    const n = (data?.cards || []).filter((c) => c.list_id === l.id).length;
    const why = await askRetire(`Retire list “${l.title}”`, `The list${n ? ` and its ${n} task${n === 1 ? '' : 's'}` : ''} will be retired together — nothing is deleted, every version is kept, and reactivating the list later brings ${n ? 'its tasks' : 'it'} back.`, 'Retire list');
    if (why === null) return;
    try { const r = await DEL(withReason(`/api/lists/${l.id}`, why), { queue: false }); toast(`List retired${r.tasks_archived ? ` with ${r.tasks_archived} task${r.tasks_archived === 1 ? '' : 's'}` : ''}`, 'success'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const addInbox = async (title) => {
    const id = uid();
    setInbox((l) => [...l, { id, title, pending: true, labels: [], created_at: new Date().toISOString() }]);
    try { await POST('/api/inbox', { id, title }); loadInbox(); } catch (e) { toast(e.message, 'error'); }
  };
  const openCard = (c) => { if (!suppressClick.current && !c.pending) setQuery({ card: c.id }); };

  const renderCards = (listId, cards) => {
    const items = cards.filter((c) => !drag || c.id !== drag.card.id);
    const out = items.map((c) => (
      <CardTile key={c.id} card={c} onOpen={() => openCard(c)} onPointerDown={(e) => (access.canEdit || listId === 'inbox') && start(e, c, listId)} />
    ));
    if (drag && drag.over?.listId === listId) out.splice(Math.min(drag.over.index, out.length), 0, <div key="ph" className="kcard-placeholder" style={{ height: drag.h }} />);
    return out;
  };

  return (
    <div className="board-page" style={bgStyle(board.background)}>
      <div className="board-shell">
        {panel && (
          <aside className="inbox-panel" data-list-id="inbox">
            <div className="inbox-head"><IInbox /><strong>Inbox</strong><span className="grow" /><button className="icon-btn sm" onClick={() => setPanel(false)} aria-label="Close inbox"><IX /></button></div>
            <AddCard onAdd={addInbox} label="Add a card" />
            <div className="list-cards inbox-cards">{renderCards('inbox', inbox)}</div>
            <p className="inbox-tip">Capture to-dos here, then drag them onto any list.</p>
          </aside>
        )}

        <section className="board-main">
          <div className="board-head">
            <h1><InlineEdit value={board.title} disabled={!access.canManage} onSave={async (v) => { await PATCH(`/api/boards/${boardId}`, { title: v }); load(); }} /></h1>
            <Popover align="left" width={220} trigger={<button className="icon-btn" aria-label="Change view">{view === 'board' ? <IBoard /> : view === 'table' ? <ITable /> : <ICalendar />}</button>}>
              {(close) => <div className="menu">{[['board', <IBoard key="b" />, 'Board'], ['table', <ITable key="t" />, 'Table'], ['planner', <ICalendar key="c" />, 'Planner (calendar)']].map(([v, i, l]) => <button key={v} className="menu-item" onClick={() => { setView(v); close(); }}>{i} {l}</button>)}</div>}
            </Popover>
            <span className="board-crumb hide-sm">{board.company_code} · {board.workspace_name}{data.project && <> · {data.project.title}</>}</span>
            <span className="grow" />
            <AvatarStack users={members} max={4} size={28} />
            <Popover width={300} trigger={<button className={cls('icon-btn', activeFilters && 'on')} aria-label="Filter cards"><IFilter />{activeFilters > 0 && <span className="dot-count">{activeFilters}</span>}</button>}>
              <div className="pad form">
                <strong>Filter</strong>
                <input placeholder="Keyword…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
                <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}><option value="">Any member</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select>
                <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}><option value="">Any priority</option>{['urgent', 'high', 'medium', 'low'].map((p) => <option key={p}>{p}</option>)}</select>
                <select value={filters.due} onChange={(e) => setFilters({ ...filters, due: e.target.value })}><option value="">Any due date</option><option value="overdue">Overdue</option><option value="soon">Due in 48h</option><option value="stale">Aging (idle 14d+)</option></select>
                <button className="btn sm" onClick={() => setFilters({ q: '', assignee: '', priority: '', due: '' })}>Clear filters</button>
              </div>
            </Popover>
            <button className={cls('icon-btn', chat && 'on')} onClick={() => setChat(!chat)} aria-label="Board chat" title="Board chat"><IChat /></button>
            <button className="btn share-btn" onClick={() => setShare(true)}><IUserPlus /> <span className="hide-sm">Share</span></button>
            <Popover width={260} trigger={<button className="icon-btn" aria-label="Board menu"><IMore /></button>}>
              {(close) => (
                <div className="menu">
                  <div className="menu-title">Board menu</div>
                  <div className="muted small pad-x">Your access: <b>{access.role}</b></div>
                  {can('report.view') && <Link to="/dashboard" className="menu-item" onClick={close}><IChart /> Dashboard</Link>}
                  {access.canManage && <BackgroundMenu board={board} onPick={async (bg) => { await PATCH(`/api/boards/${boardId}`, { background: bg }); load(); close(); }} />}
                  <button className="menu-item" onClick={() => { close(); setHistory({ entity: 'board', id: boardId }); }}><IClock /> Board version history</button>
                  {access.canManage && <button className="menu-item danger" onClick={async () => {
                    close();
                    const why = await askRetire(`Retire board “${board.title}”`, 'The board and its chat channel leave circulation. Lists, tasks, messages and every version are kept; the Superadmin can reactivate the board from Admin → Master data.', 'Retire board');
                    if (why === null) return;
                    try { await DEL(withReason(`/api/boards/${boardId}`, why), { queue: false }); toast('Board retired — kept in history', 'success'); navigate('/home'); } catch (e) { toast(e.message, 'error'); }
                  }}><IArchive /> Retire board…</button>}
                </div>
              )}
            </Popover>
          </div>

          {view === 'board' && (
            <div className={cls('lists', drag && 'is-dragging')} ref={scrollRef}>
              {lists.map((l, li) => {
                const cards = filtered.filter((c) => c.list_id === l.id).sort((a, b) => a.position - b.position);
                return (
                  <div key={l.id} className={cls('klist', l.is_done_list && 'done-list', drag?.over?.listId === l.id && 'drop-target')} data-list-id={l.id}>
                    <div className="klist-head">
                      <InlineEdit value={l.title} disabled={!access.canEdit} onSave={(v) => renameList(l, v)} className="klist-title" />
                      <span className="klist-count">{cards.length}</span>
                      {access.canEdit && (
                        <Popover width={230} trigger={<button className="icon-btn sm" aria-label="List actions"><IMore /></button>}>
                          {(close) => (
                            <div className="menu">
                              <div className="menu-title">List actions</div>
                              <button className="menu-item" disabled={li === 0} onClick={() => { moveList(l, -1); close(); }}><ILeft /> Move left</button>
                              <button className="menu-item" disabled={li === lists.length - 1} onClick={() => { moveList(l, 1); close(); }}><IRight /> Move right</button>
                              <button className="menu-item" onClick={async () => { await PATCH(`/api/lists/${l.id}`, { is_done_list: !l.is_done_list }); load(); close(); }}><ICheckSquare /> {l.is_done_list ? 'Unmark as “done” list' : 'Mark as “done” list'}</button>
                              <button className="menu-item" onClick={() => { close(); setHistory({ entity: 'list', id: l.id }); }}><IClock /> List history</button>
                              {access.canDelete && <button className="menu-item danger" onClick={() => { close(); retireList(l); }}><IArchive /> Retire list…</button>}
                            </div>
                          )}
                        </Popover>
                      )}
                    </div>
                    <div className="list-cards">{renderCards(l.id, cards)}</div>
                    {access.canCreate && <AddCard onAdd={(t) => addCard(l, t)} />}
                  </div>
                );
              })}
              {access.canEdit && <AddList onAdd={addList} />}
            </div>
          )}
          {view === 'table' && <TableView cards={filtered} lists={lists} onOpen={openCard} />}
          {view === 'planner' && <Planner cards={filtered} onOpen={openCard} />}
        </section>

        {chat && board.log_channel_id && (
          <aside className="board-chat"><ChannelView channelId={board.log_channel_id} compact onClose={() => setChat(false)} /></aside>
        )}
      </div>

      <nav className="board-dock" aria-label="Board navigation">
        <button className={cls(panel && 'on')} onClick={() => setPanel(!panel)}><IInbox /> Inbox</button>
        <button className={cls(view === 'planner' && 'on')} onClick={() => setView(view === 'planner' ? 'board' : 'planner')}><ICalendar /> Planner</button>
        <button className={cls(view === 'board' && 'on')} onClick={() => setView('board')}><IBoard /> Board</button>
        <SwitchBoards current={boardId} />
      </nav>

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x - drag.ox, top: drag.y - drag.oy, width: drag.w }}>
          <CardTile card={drag.card} onOpen={() => {}} />
        </div>
      )}
      {query.card && <CardModal cardId={query.card} onClose={() => setQuery({ card: null })} />}
      {share && <ShareModal board={board} members={members} canManage={isSuper || (access.canManage && can('board.members'))} onClose={() => { setShare(false); load(); }} />}
      {confirmNode}
      {retireNode}
      {history && <HistoryModal entity={history.entity} id={history.id} onClose={() => setHistory(null)} />}
    </div>
  );
}

function BackgroundMenu({ onPick }) {
  return (
    <div className="pad"><div className="muted small">Background</div>
      <div className="bg-picker sm">{BOARD_BACKGROUNDS.map(([n, bg]) => <button key={n} title={n} className="bg-swatch" style={bgStyle(bg)} onClick={() => onPick(bg)} />)}</div></div>
  );
}

function AddList({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState('');
  if (!open) return <button className="add-list" onClick={() => setOpen(true)}><IPlus /> Add another list</button>;
  return (
    <div className="klist add-list-form">
      <input autoFocus value={t} onChange={(e) => setT(e.target.value)} placeholder="Enter list name…" onKeyDown={(e) => { if (e.key === 'Enter' && t.trim()) { onAdd(t.trim()); setT(''); } if (e.key === 'Escape') setOpen(false); }} />
      <div className="row-inline"><button className="btn primary sm" onClick={() => { if (t.trim()) { onAdd(t.trim()); setT(''); } }}>Add list</button><button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Cancel"><IX /></button></div>
    </div>
  );
}

function SwitchBoards({ current }) {
  const { data } = useDataOnce(() => GET('/api/boards'));
  return (
    <Popover align="right" width={300} trigger={<button><ISwitch /> Switch boards</button>}>
      {(close) => (
        <div className="menu">
          <div className="menu-title">Your boards</div>
          {!data && <Spinner />}
          {data?.map((b) => (
            <button key={b.id} className={cls('menu-item rich', b.id === current && 'on')} onClick={() => { close(); navigate(`/board/${b.id}`); }}>
              <span className="board-swatch" style={bgStyle(b.background)} /><span><strong>{b.title}</strong><small>{b.company_code} · {b.unit_name} · {b.card_count} tasks</small></span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
function useDataOnce(fn) {
  const [data, setData] = useState(null);
  useEffect(() => { fn().then(setData).catch(() => setData([])); }, []); // eslint-disable-line
  return { data };
}

function TableView({ cards, lists, onOpen }) {
  const [sort, setSort] = useState({ key: 'due_date', dir: 1 });
  const listName = Object.fromEntries(lists.map((l) => [l.id, l.title]));
  const rows = [...cards].sort((a, b) => {
    const va = sort.key === 'age' ? -new Date(a.created_at) : sort.key === 'list' ? listName[a.list_id] : a[sort.key];
    const vb = sort.key === 'age' ? -new Date(b.created_at) : sort.key === 'list' ? listName[b.list_id] : b[sort.key];
    return (va == null) - (vb == null) || (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir;
  });
  const H = ({ k, children }) => <th onClick={() => setSort({ key: k, dir: sort.key === k ? -sort.dir : 1 })} className="sortable">{children}{sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>;
  return (
    <div className="board-table">
      <table className="table">
        <thead><tr><H k="title">Task</H><H k="list">List</H><H k="assignee_name">Assignee</H><H k="priority">Priority</H><H k="due_date">Due</H><H k="age">Age</H><th>Subtasks</th></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id} onClick={() => onOpen(c)} className="clickable">
            <td><strong>{c.title}</strong></td><td>{listName[c.list_id]}</td><td>{c.assignee_name || '—'}</td><td><PriorityPill p={c.priority} /></td>
            <td className={cls('due', dueStatus(c.due_date, c.is_done_list))}>{c.due_date ? fmtDate(c.due_date) : '—'}</td><td><AgeChip iso={c.created_at} compact /></td>
            <td>{c.subtask_total ? `${c.subtask_done}/${c.subtask_total}` : '—'}</td>
          </tr>
        ))}</tbody>
      </table>
      {!rows.length && <Empty title="No tasks match these filters" />}
    </div>
  );
}

function Planner({ cards, onOpen }) {
  const [offset, setOffset] = useState(0);
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + offset * 14);
  const days = [...Array(14)].map((_, i) => new Date(start.getTime() + i * 864e5));
  const unscheduled = cards.filter((c) => !c.due_date && !c.is_done_list);
  return (
    <div className="planner">
      <div className="planner-head">
        <button className="btn sm" onClick={() => setOffset(offset - 1)}><ILeft /></button>
        <strong>{days[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – {days[13].toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</strong>
        <button className="btn sm" onClick={() => setOffset(offset + 1)}><IRight /></button>
        <button className="btn sm ghost" onClick={() => setOffset(0)}>Today</button>
      </div>
      <div className="planner-grid">
        {days.map((d) => {
          const items = cards.filter((c) => c.due_date && new Date(c.due_date).toDateString() === d.toDateString());
          const today = d.toDateString() === new Date().toDateString();
          return (
            <div key={d.toISOString()} className={cls('pday', today && 'today', [0, 6].includes(d.getDay()) && 'weekend')}>
              <div className="pday-head">{d.toLocaleDateString(undefined, { weekday: 'short' })} <b>{d.getDate()}</b></div>
              {items.map((c) => <button key={c.id} className={cls('pitem', dueStatus(c.due_date, c.is_done_list))} onClick={() => onOpen(c)} style={{ borderLeftColor: PRIORITY_COLORS[c.priority] }}>{c.title}</button>)}
            </div>
          );
        })}
      </div>
      {unscheduled.length > 0 && <div className="unscheduled"><strong>No due date ({unscheduled.length})</strong>{unscheduled.map((c) => <button key={c.id} className="chip" onClick={() => onOpen(c)}>{c.title}</button>)}</div>}
    </div>
  );
}

function ShareModal({ board, members, canManage, onClose }) {
  const { users, toast } = useApp();
  const [add, setAdd] = useState({ user: '', role: 'member', until: '' });
  const [list, setList] = useState(members);
  const setRole = async (userId, role, until) => {
    // effective-dated access: "until" ends the grant automatically (a new version, never a delete)
    try { await PUT(`/api/boards/${board.id}/members/${userId}`, { role, ...(until ? { effective_to: new Date(`${until}T23:59:59`).toISOString() } : {}) }, { queue: false }); setList((l) => (l.some((m) => m.id === userId) ? l.map((m) => (m.id === userId ? { ...m, role } : m)) : [...l, { ...users.find((u) => u.id === userId), role }])); toast('Access updated', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async (userId) => { try { await DEL(`/api/boards/${board.id}/members/${userId}`, { queue: false }); setList((l) => l.filter((m) => m.id !== userId)); } catch (e) { toast(e.message, 'error'); } };
  const ids = new Set(list.map((m) => m.id));
  return (
    <Modal title={`Share “${board.title}”`} onClose={onClose}>
      <p className="muted small">Board roles: <b>admin</b> (manage board & access) · <b>member</b> (create/edit/move tasks) · <b>viewer</b> (read & comment). {canManage ? '' : 'Only the super admin or a board admin can change access.'}</p>
      <ul className="member-list">
        {list.map((m) => (
          <li key={m.id}><Avatar user={m} size={30} showPresence /><span className="grow"><strong>{m.full_name}</strong><small className="muted"> @{m.username}{m.designation ? ` · ${m.designation}` : ''}</small></span>
            {canManage ? <select value={m.role} onChange={(e) => setRole(m.id, e.target.value)}>{['admin', 'member', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select> : <span className="pill">{m.role}</span>}
            {m.effective_to && <span className="pill" title="Access ends automatically">until {new Date(m.effective_to).toLocaleDateString()}</span>}
            {canManage && <button className="icon-btn sm" onClick={() => remove(m.id)} aria-label="Revoke access" title="Revoke access (kept in history)"><IX /></button>}</li>
        ))}
      </ul>
      {canManage && (
        <div className="row-inline">
          <select value={add.user} onChange={(e) => setAdd({ ...add, user: e.target.value })}><option value="">Add people…</option>{users.filter((u) => !ids.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.full_name} (@{u.username})</option>)}</select>
          <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>{['member', 'viewer', 'admin'].map((r) => <option key={r}>{r}</option>)}</select>
          <input type="date" title="Access until (optional)" aria-label="Access until (optional)" value={add.until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setAdd({ ...add, until: e.target.value })} />
          <button className="btn primary" disabled={!add.user} onClick={() => { setRole(add.user, add.role, add.until); setAdd({ user: '', role: 'member', until: '' }); }}>Share</button>
        </div>
      )}
    </Modal>
  );
}

export { TimeAgo, IEye, IStar, IEdit, ISparkles, IShare };
