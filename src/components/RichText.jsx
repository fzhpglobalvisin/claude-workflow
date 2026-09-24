// Safe markdown-lite renderer (no innerHTML): **bold**, *italic*, `code`, links, @mentions, bullets.
import { Fragment, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store.jsx';
import { Avatar } from './ui.jsx';
import { cls } from '../lib/format.js';

const TOKEN = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|https?:\/\/[^\s<>()]+|@[a-z0-9._-]{2,32})/gi;

function inline(text, me, key = '') {
  const parts = String(text).split(TOKEN);
  return parts.map((p, i) => {
    const k = `${key}-${i}`;
    if (!p) return null;
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={k}>{p.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(p)) return <em key={k}>{p.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(p)) return <code key={k}>{p.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(p)) {
      const clean = p.replace(/[.,;:!?]+$/, '');
      return <Fragment key={k}><a href={clean} target="_blank" rel="noreferrer noopener">{clean.replace(/^https?:\/\//, '').slice(0, 48)}{clean.length > 56 ? '…' : ''}</a>{p.slice(clean.length)}</Fragment>;
    }
    if (/^@/.test(p)) {
      const h = p.slice(1).toLowerCase();
      return <span key={k} className={cls('mention', h === me && 'me', ['ai', 'assistant'].includes(h) && 'ai', ['channel', 'here', 'everyone'].includes(h) && 'all')}>{p}</span>;
    }
    return <Fragment key={k}>{p}</Fragment>;
  });
}

export function RichText({ text, className }) {
  const { user } = useApp();
  const me = user?.username;
  if (!text) return null;
  const lines = String(text).split('\n');
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={`ul${out.length}`}>{list}</ul>); list = []; } };
  lines.forEach((ln, i) => {
    const m = ln.match(/^\s*([-*•]|\d+[.)]|–)\s+(.*)$/);
    if (m) { list.push(<li key={i}>{inline(m[2], me, i)}</li>); return; }
    flush();
    out.push(ln.trim() ? <p key={i}>{inline(ln, me, i)}</p> : <br key={i} />);
  });
  flush();
  return <div className={cls('rich', className)}>{out}</div>;
}

const SPECIAL = [
  { username: 'ai', full_name: 'AI assistant', designation: 'summarize · status · create task', color: '#9f8fef', special: true },
  { username: 'channel', full_name: 'Notify everyone in this channel', designation: '', color: '#f5a623', special: true },
];

/** Textarea with @mention autocomplete. Enter sends, Shift+Enter adds a line. */
export function MentionInput({ value, onChange, onSubmit, placeholder, rows = 1, autoFocus, onTyping, disabled, inputRef }) {
  const { users } = useApp();
  const local = useRef(null);
  const ref = inputRef || local;
  const [q, setQ] = useState(null); // {start, text}
  const [idx, setIdx] = useState(0);
  const options = useMemo(() => {
    if (!q) return [];
    const t = q.text.toLowerCase();
    return [...users, ...SPECIAL].filter((u) => u.username.startsWith(t) || (u.full_name || '').toLowerCase().includes(t)).slice(0, 7);
  }, [q, users]);

  const detect = (val, caret) => {
    const before = val.slice(0, caret);
    const m = before.match(/(^|\s)@([a-z0-9._-]*)$/i);
    setQ(m ? { start: caret - m[2].length - 1, text: m[2] } : null);
    setIdx(0);
  };
  const choose = (u) => {
    const el = ref.current;
    const caret = el.selectionStart;
    const next = `${value.slice(0, q.start)}@${u.username} ${value.slice(caret)}`;
    onChange(next);
    setQ(null);
    requestAnimationFrame(() => { el.focus(); const p = q.start + u.username.length + 2; el.setSelectionRange(p, p); });
  };
  const onKeyDown = (e) => {
    if (q && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[idx]); return; }
      if (e.key === 'Escape') { setQ(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && onSubmit) { e.preventDefault(); onSubmit(); }
  };
  return (
    <div className="mention-input">
      {q && options.length > 0 && (
        <ul className="mention-menu" role="listbox">
          {options.map((u, i) => (
            <li key={u.username} role="option" aria-selected={i === idx} className={cls(i === idx && 'active')} onMouseDown={(e) => { e.preventDefault(); choose(u); }}>
              <Avatar user={u} size={22} /><strong>@{u.username}</strong><span>{u.full_name}</span>{u.designation && <em>{u.designation}</em>}
            </li>
          ))}
        </ul>
      )}
      <textarea ref={ref} rows={rows} value={value} disabled={disabled} autoFocus={autoFocus} placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); onTyping?.(); }}
        onKeyDown={onKeyDown} onClick={(e) => detect(value, e.target.selectionStart)}
        onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`; }} />
    </div>
  );
}
