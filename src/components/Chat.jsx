// Slack-style channel view (messages, day separators, threads, reactions, pins, mentions, typing).
// Used by the Chat page and by the board chat drawer.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GET, POST, PATCH, DEL, uid } from '../lib/api.js';
import { subscribe } from '../lib/realtime.js';
import { useApp } from '../lib/store.jsx';
import { Link, navigate } from '../lib/router.jsx';
import { Avatar, TimeAgo, Spinner, Popover, AgeChip, useConfirm, ErrorBox } from './ui.jsx';
import { RichText, MentionInput } from './RichText.jsx';
import { cls, dayLabel, fmtTime, fmtDateTime, ageDays } from '../lib/format.js';
import { ISend, ISmile, IReply, IPin, IPinOff, IEdit, ITrash, IX, IClip, IBoard, IHash, ILock, IUser, ISparkles, IUsers, ILink } from './icons.js';

const QUICK = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🔥'];
const AGENT_AVATAR = { Echo: '📝', Atlas: '🧭', Sentinel: '🛡️', Quill: '✒️', Blaze: '🔥', 'AI Crew': '🤖', Assistant: '🤖' };

function Composer({ channel, parentId, onSent, placeholder, compact }) {
  const { user, toast, can } = useApp();
  const [text, setText] = useState('');
  const [atts, setAtts] = useState([]);
  const [link, setLink] = useState({ name: '', url: '' });
  const lastTyping = useRef(0);
  const input = useRef(null);
  useEffect(() => { if (!compact) input.current?.focus(); }, [channel?.id, parentId]);
  if (!can('chat.post')) return <div className="composer disabled muted">Your role can read but not post in chats.</div>;
  const typing = () => {
    if (Date.now() - lastTyping.current < 2500) return;
    lastTyping.current = Date.now();
    POST(`/api/channels/${channel.id}/typing`, { parent_message_id: parentId }, { queue: false }).catch(() => {});
  };
  const send = async () => {
    const content = text.trim();
    if (!content && !atts.length) return;
    const id = uid();
    const optimistic = { id, content, user_id: user.id, full_name: user.full_name, username: user.username, color: user.color, created_at: new Date().toISOString(), reactions: [], attachments: atts.map((a, i) => ({ ...a, id: `${id}-${i}` })), parent_message_id: parentId || null, pending: true, type: 'text' };
    onSent?.(optimistic);
    setText(''); setAtts([]);
    try {
      const saved = await POST(`/api/channels/${channel.id}/messages`, { id, content, parent_message_id: parentId || null, attachments: atts });
      if (!saved.queued) onSent?.(saved, true);
    } catch (e) { toast(e.message, 'error'); }
  };
  const addLink = () => {
    if (!/^https?:\/\//.test(link.url)) return toast('Paste a full Google Drive link (https://…)', 'error');
    setAtts((a) => [...a, { name: link.name || 'Drive file', url: link.url }]); setLink({ name: '', url: '' });
    return null;
  };
  return (
    <div className={cls('composer', compact && 'compact')}>
      {atts.length > 0 && <div className="composer-atts">{atts.map((a, i) => <span key={i} className="chip"><IClip />{a.name}<button onClick={() => setAtts(atts.filter((_, j) => j !== i))} aria-label="Remove"><IX /></button></span>)}</div>}
      <MentionInput inputRef={input} value={text} onChange={setText} onSubmit={send} onTyping={typing}
        placeholder={placeholder || (channel.type === 'dm' ? `Message ${channel.name}` : `Message #${channel.name} — use @name to mention, @ai for the assistant`)} />
      <div className="composer-bar">
        <Popover align="left" width={320} trigger={<button className="icon-btn sm" aria-label="Attach Google Drive link" title="Attach Google Drive link"><IClip /></button>}>
          {(close) => (
            <div className="pad form">
              <strong>Attach a Google Drive file</strong>
              <p className="muted small">Files live on Google Drive — only the link is stored, keeping the database light.</p>
              <input placeholder="File name" value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} />
              <input placeholder="https://drive.google.com/file/d/…" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
              <button className="btn primary sm" onClick={() => { addLink(); close(); }}>Attach</button>
            </div>
          )}
        </Popover>
        <Popover align="left" width={240} trigger={<button className="icon-btn sm" aria-label="Emoji"><ISmile /></button>}>
          {(close) => <div className="emoji-grid">{['😀', '😂', '😍', '🤔', '😅', '😎', '🙌', '👏', '💪', '🚀', '🎯', '💡', ...QUICK].map((e) => <button key={e} onClick={() => { setText((t) => t + e); close(); }}>{e}</button>)}</div>}
        </Popover>
        <button className="icon-btn sm" title="Ask the AI assistant" onClick={() => setText((t) => (t.includes('@ai') ? t : `@ai ${t}`))}><ISparkles /></button>
        <span className="grow muted small hide-sm">Enter to send · Shift+Enter new line</span>
        <button className="btn primary sm" onClick={send} disabled={!text.trim() && !atts.length} aria-label="Send"><ISend /></button>
      </div>
    </div>
  );
}

function Attachments({ items }) {
  if (!items?.length) return null;
  return (
    <div className="msg-atts">
      {items.map((a) => (
        <a key={a.id} href={a.drive_web_view_link || a.url} target="_blank" rel="noreferrer" className="att-card">
          {a.drive_thumbnail_link && ['image', 'video', 'pdf'].includes(a.file_type) ? <img src={a.drive_thumbnail_link} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <IClip />}
          <span><strong>{a.name}</strong><small>{a.drive_file_id ? 'Google Drive' : 'Link'} · {a.file_type}</small></span>
        </a>
      ))}
    </div>
  );
}

function Message({ m, grouped, onThread, onUpdate, inThread, me, highlight, awaitingMe }) {
  const { user, isAdmin, toast, bumpPins } = useApp();
  const [editing, setEditing] = useState(false);
  const [showActs, setShowActs] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [confirm, confirmNode] = useConfirm();
  const ref = useRef(null);
  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: 'center' }); }, [highlight]);
  const mine = m.user_id === user.id;
  const react = async (emoji) => { try { onUpdate(await POST(`/api/messages/${m.id}/reactions`, { emoji }, { queue: false })); } catch (e) { toast(e.message, 'error'); } };
  const pin = async () => {
    try {
      if (m.pin_id) { await DEL(`/api/pins/${m.pin_id}`); onUpdate({ ...m, pin_id: null }); toast('Unpinned'); }
      else { const p = await POST('/api/pins', { message_id: m.id }, { queue: false }); onUpdate({ ...m, pin_id: p.id }); toast('Pinned to your Pinned Chats', 'success'); }
      bumpPins();
    } catch (e) { toast(e.message, 'error'); }
  };
  const save = async () => { try { onUpdate(await PATCH(`/api/messages/${m.id}`, { content: draft }, { queue: false })); setEditing(false); } catch (e) { toast(e.message, 'error'); } };
  const remove = async () => { if (await confirm('Remove this message? The text stays in the audit/version history.', { ok: 'Remove' })) { await DEL(`/api/messages/${m.id}`); onUpdate({ ...m, deleted: true, content: '' }); } };
  const copyLink = () => { navigator.clipboard?.writeText(`${location.origin}/chat/${m.channel_id}?m=${m.parent_message_id || m.id}`); toast('Link copied'); };

  if (m.type === 'system') {
    return (
      <div ref={ref} className={cls('msg system', highlight && 'hl')}>
        <span className="sys-time" title={fmtDateTime(m.created_at)}>{fmtTime(m.created_at)}</span>
        <RichText text={m.content} />
        {m.card_id && m.card_board_id && <Link className="chip xs" to={`/board/${m.card_board_id}?card=${m.card_id}`}><IBoard />{m.card_title}</Link>}
      </div>
    );
  }
  const agent = m.metadata?.agent;
  const author = m.is_ai_generated ? { full_name: agent || 'AI assistant', color: '#6e5dc6' } : m;
  return (
    <div ref={ref} className={cls('msg', grouped && 'grouped', m.pending && 'pending', highlight && 'hl', m.is_ai_generated && 'ai', awaitingMe && 'awaiting', showActs && 'show-actions')}
      onClick={(e) => { if (window.matchMedia('(hover: none)').matches && !e.target.closest('button, a, input, textarea')) setShowActs((v) => !v); }}>
      <div className="msg-gutter">
        {grouped ? <span className="msg-time-hover">{fmtTime(m.created_at)}</span>
          : m.is_ai_generated ? <span className="ai-avatar">{AGENT_AVATAR[agent] || '🤖'}</span> : <Avatar user={author} size={34} showPresence />}
      </div>
      <div className="msg-body">
        {!grouped && (
          <div className="msg-head">
            <strong>{author.full_name}</strong>
            {m.is_ai_generated && <span className="badge ai">AI</span>}
            {m.designation && !m.is_ai_generated && <span className="muted small hide-sm">{m.designation}</span>}
            <span className="muted small"><TimeAgo iso={m.created_at} /></span>
            {ageDays(m.created_at) >= 1 && <AgeChip iso={m.created_at} compact label="Message age" />}
            {m.pin_id && <IPin className="pinned-icon" />}
          </div>
        )}
        {m.deleted ? <em className="muted">This message was deleted.</em> : editing ? (
          <div className="msg-edit"><MentionInput value={draft} onChange={setDraft} onSubmit={save} autoFocus /><div className="row-inline"><button className="btn sm" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary sm" onClick={save}>Save</button></div></div>
        ) : <RichText text={m.content} />}
        {m.metadata?.edited && !m.deleted && <span className="muted xsmall">(edited)</span>}
        {awaitingMe && <span className="await-chip">⏳ Awaiting your reply · {ageDays(m.created_at) ? `${ageDays(m.created_at)}d` : 'today'}</span>}
        {m.card_id && m.card_board_id && <Link className="chip xs card-ref" to={`/board/${m.card_board_id}?card=${m.card_id}`}><IBoard />{m.card_title}</Link>}
        <Attachments items={m.attachments} />
        {m.reactions?.length > 0 && (
          <div className="reactions">{m.reactions.map((r) => <button key={r.emoji} className={cls('reaction', r.mine && 'mine')} title={r.users.join(', ')} onClick={() => react(r.emoji)}>{r.emoji} {r.count}</button>)}</div>
        )}
        {!inThread && m.reply_count > 0 && (
          <button className="thread-link" onClick={() => onThread(m)}><IReply /> {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'} <span className="muted">· last <TimeAgo iso={m.last_reply_at} /></span></button>
        )}
      </div>
      {!m.deleted && !m.pending && (
        <div className="msg-actions">
          {QUICK.slice(0, 4).map((e) => <button key={e} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}
          <Popover width={220} trigger={<button aria-label="More reactions"><ISmile /></button>}>{(close) => <div className="emoji-grid">{QUICK.map((e) => <button key={e} onClick={() => { react(e); close(); }}>{e}</button>)}</div>}</Popover>
          {!inThread && <button onClick={() => onThread(m)} aria-label="Reply in thread" title="Reply in thread"><IReply /></button>}
          <button onClick={pin} title={m.pin_id ? 'Unpin' : 'Pin to Pinned Chats'} aria-label="Pin">{m.pin_id ? <IPinOff /> : <IPin />}</button>
          <button onClick={copyLink} title="Copy link" aria-label="Copy link"><ILink /></button>
          {mine && <button onClick={() => { setDraft(m.content); setEditing(true); }} aria-label="Edit"><IEdit /></button>}
          {(mine || isAdmin) && <button onClick={remove} aria-label="Delete"><ITrash /></button>}
        </div>
      )}
      {confirmNode}
    </div>
  );
}

function MessageList({ messages, onThread, onUpdate, inThread, highlightId, me }) {
  // who has spoken after a message (for "awaiting your reply")
  const lastMine = useMemo(() => { let t = ''; for (const m of messages) if (m.username === me) t = m.created_at; return t; }, [messages, me]);
  let prev = null;
  return messages.map((m) => {
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
    const grouped = !newDay && prev && prev.user_id === m.user_id && !m.is_ai_generated && m.type !== 'system' && prev.type !== 'system' && (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60e3;
    const awaiting = m.username !== me && new RegExp(`@${me}\\b`, 'i').test(m.content || '') && m.created_at > lastMine && !m.deleted;
    prev = m;
    return (
      <Fragment key={m.id}>
        {newDay && <div className="day-sep"><span>{dayLabel(m.created_at)}</span></div>}
        <Message m={m} grouped={grouped} onThread={onThread} onUpdate={onUpdate} inThread={inThread} highlight={highlightId === m.id} me={me} awaitingMe={awaiting && !inThread} />
      </Fragment>
    );
  });
}

function ThreadPanel({ channel, parentId, onClose, onParentChange }) {
  const { user } = useApp();
  const [data, setData] = useState(null);
  const bottom = useRef(null);
  const load = useCallback(() => GET(`/api/messages/${parentId}/thread`).then(setData).catch(() => {}), [parentId]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => subscribe('message:new', (e) => { if (e.message.parent_message_id === parentId) setData((d) => d && (d.replies.some((r) => r.id === e.message.id) ? { ...d, replies: d.replies.map((r) => (r.id === e.message.id ? e.message : r)) } : { ...d, replies: [...d.replies, e.message] })); }), [parentId]);
  useEffect(() => subscribe('message:updated', (e) => setData((d) => d && ({ parent: d.parent.id === e.message.id ? { ...d.parent, ...e.message, pin_id: d.parent.pin_id } : d.parent, replies: d.replies.map((r) => (r.id === e.message.id ? { ...e.message, pin_id: r.pin_id } : r)) }))), []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [data?.replies.length]);
  const upsert = (m) => setData((d) => ({ ...d, replies: d.replies.some((r) => r.id === m.id) ? d.replies.map((r) => (r.id === m.id ? m : r)) : [...d.replies, m] }));
  return (
    <aside className="thread-panel">
      <div className="thread-head"><strong>Thread</strong><span className="muted small">{channel.type === 'dm' ? channel.name : `#${channel.name}`}</span><button className="icon-btn" onClick={onClose} aria-label="Close thread"><IX /></button></div>
      <div className="thread-scroll">
        {!data ? <Spinner /> : <>
          <Message m={data.parent} inThread onUpdate={(m) => { setData((d) => ({ ...d, parent: m })); onParentChange?.(m); }} me={user.username} />
          <div className="thread-count">{data.replies.length} {data.replies.length === 1 ? 'reply' : 'replies'}</div>
          <MessageList messages={data.replies} inThread onUpdate={upsert} me={user.username} />
          <div ref={bottom} />
        </>}
      </div>
      <Composer channel={channel} parentId={parentId} compact placeholder="Reply in thread…" onSent={(m, replace) => upsert(m)} />
    </aside>
  );
}

export function ChannelView({ channelId, highlightId, compact, header = true, onClose }) {
  const { user, toast, bumpPins } = useApp();
  const [channel, setChannel] = useState(null);
  const [messages, setMessages] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [thread, setThread] = useState(null);
  const [typing, setTyping] = useState({});
  const [error, setError] = useState(null);
  const [showMembers, setShowMembers] = useState(false);
  const scroller = useRef(null);
  const atBottom = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ch, ms] = await Promise.all([GET(`/api/channels/${channelId}`), GET(`/api/channels/${channelId}/messages?limit=80`)]);
      setChannel(ch); setMessages(ms.messages); setHasMore(ms.has_more);
      requestAnimationFrame(() => { if (!highlightId && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    } catch (e) { setError(e); }
  }, [channelId]);
  useEffect(() => { setChannel(null); setMessages(null); setThread(null); load(); }, [load]);
  useEffect(() => {
    if (!highlightId || !messages) return;
    const inList = messages.some((m) => m.id === highlightId);
    if (!inList) GET(`/api/messages/${highlightId}/thread`).then((t) => { if (t.parent.parent_message_id == null && t.replies.length) setThread(t.parent.id); }).catch(() => {});
  }, [highlightId, messages?.length]);

  const upsert = useCallback((m, replaceOnly) => setMessages((list) => {
    if (!list) return list;
    if (list.some((x) => x.id === m.id)) return list.map((x) => (x.id === m.id ? { ...x, ...m, pin_id: m.pin_id !== undefined ? m.pin_id : x.pin_id } : x));
    if (replaceOnly) return list;
    return [...list, m];
  }), []);

  useEffect(() => {
    const offs = [
      subscribe('message:new', (e) => {
        if (e.channelId !== channelId) return;
        if (e.message.parent_message_id) {
          setMessages((list) => list && list.map((x) => (x.id === e.message.parent_message_id ? { ...x, reply_count: (x.reply_count || 0) + 1, last_reply_at: e.message.created_at } : x)));
        } else {
          upsert(e.message);
          POST(`/api/channels/${channelId}/read`, {}, { queue: false }).catch(() => {});
          if (atBottom.current) requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
        }
        setTyping((t) => { const n = { ...t }; delete n[e.message.user_id]; return n; });
      }),
      subscribe('message:updated', (e) => { if (e.channelId === channelId) upsert({ ...e.message, pin_id: undefined }, true); }),
      subscribe('typing', (e) => {
        if (e.channelId !== channelId || e.parentId) return;
        setTyping((t) => ({ ...t, [e.userId]: { name: e.name, at: Date.now() } }));
        setTimeout(() => setTyping((t) => { const n = { ...t }; if (n[e.userId] && Date.now() - n[e.userId].at > 3500) delete n[e.userId]; return n; }), 4000);
      }),
      subscribe('channel:changed', (e) => { if (e.channelId === channelId) { if (e.deleted) navigate('/chat'); else GET(`/api/channels/${channelId}`).then(setChannel).catch(() => {}); } }),
    ];
    return () => offs.forEach((f) => f());
  }, [channelId, upsert, user.id]);

  const loadOlder = async () => {
    const first = messages[0];
    const el = scroller.current; const h = el.scrollHeight;
    const r = await GET(`/api/channels/${channelId}/messages?limit=60&before=${encodeURIComponent(first.created_at)}`);
    setMessages((l) => [...r.messages, ...l]); setHasMore(r.has_more);
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - h; });
  };
  const onSent = (m, confirmed) => {
    if (confirmed) upsert({ ...m, pending: false });
    else { upsert(m); requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }); }
  };
  const togglePin = async () => {
    try {
      if (channel.pinned) await POST('/api/pins/unpin-channel', { channel_id: channel.id }, { queue: false });
      else await POST('/api/pins', { channel_id: channel.id }, { queue: false });
      setChannel((c) => ({ ...c, pinned: !c.pinned })); bumpPins();
      toast(channel.pinned ? 'Channel unpinned' : 'Channel pinned', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
  const summarize = async () => {
    toast('Echo is summarising the channel…');
    try { await POST('/api/ai/summarize', { channel_id: channel.id }, { queue: false }); } catch (e) { toast(e.message, 'error'); }
  };

  if (error) return <div className="pad"><ErrorBox error={error} onRetry={load} /></div>;
  if (!channel || !messages) return <Spinner label="Loading conversation…" />;
  const typers = Object.entries(typing).filter(([id]) => id !== user.id).map(([, v]) => v.name);
  return (
    <div className={cls('channel-view', compact && 'compact', thread && 'with-thread')}>
      <div className="channel-main">
        {header && (
          <div className="channel-head">
            <div className="ch-title">
              {channel.type === 'dm' ? <IUser /> : channel.is_private ? <ILock /> : channel.type === 'board_log' ? <IBoard /> : <IHash />}
              <strong>{channel.name}</strong>
              {channel.board && <Link to={`/board/${channel.board.id}`} className="chip xs">{channel.board.title}</Link>}
              <span className="muted small hide-sm grow ellipsis">{channel.description}</span>
            </div>
            <div className="ch-actions">
              <button className="btn sm ghost" onClick={() => setShowMembers(!showMembers)}><IUsers /> {channel.members.length}</button>
              <button className="btn sm ghost" onClick={summarize} title="AI summary (Echo)"><ISparkles /> <span className="hide-sm">Summarize</span></button>
              <button className={cls('btn sm ghost', channel.pinned && 'on')} onClick={togglePin} title="Pin channel">{channel.pinned ? <IPinOff /> : <IPin />}</button>
              {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close chat"><IX /></button>}
            </div>
            {showMembers && (
              <div className="members-pop">
                {channel.members.map((m) => <div key={m.id} className="member-row"><Avatar user={m} size={24} showPresence /><span>{m.full_name}</span><small className="muted">@{m.username}</small></div>)}
                {!channel.members.length && <span className="muted small">Open channel — visible to everyone in the {channel.workspace_id ? 'unit' : 'company'}.</span>}
              </div>
            )}
          </div>
        )}
        <div className="messages" ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {hasMore && <button className="btn sm ghost center" onClick={loadOlder}>Load older messages</button>}
          {!messages.length && <div className="empty"><strong>This is the very beginning of {channel.type === 'dm' ? `your conversation with ${channel.name}` : `#${channel.name}`}.</strong><p>Say hello 👋 — mention teammates with @, or ask @ai.</p></div>}
          <MessageList messages={messages} onThread={(m) => setThread(m.id)} onUpdate={(m) => upsert(m, true)} highlightId={highlightId} me={user.username} />
        </div>
        <div className="typing">{typers.length ? `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…` : ''}</div>
        <Composer channel={channel} onSent={onSent} compact={compact} />
      </div>
      {thread && <ThreadPanel channel={channel} parentId={thread} onClose={() => setThread(null)} onParentChange={(m) => upsert(m, true)} />}
    </div>
  );
}
