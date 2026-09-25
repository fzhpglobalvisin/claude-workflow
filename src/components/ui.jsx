// Shared UI primitives.
import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { initials, cls, ageDays, agingLevel, timeAgo, fmtDateTime } from '../lib/format.js';
import { useApp } from '../lib/store.jsx';
import { IX, IHourglass } from './icons.js';

export function Avatar({ user, size = 28, ring, title, showPresence }) {
  const { online } = useApp();
  if (!user) return <span className="avatar ghost" style={{ width: size, height: size }} />;
  const name = user.full_name || user.name || user.assignee_name || user.username || '?';
  const color = user.color || user.assignee_color || '#579dff';
  const isOnline = showPresence && online.has(user.id);
  return (
    <span className={cls('avatar', ring && 'ring')} title={title || name} style={{ width: size, height: size, fontSize: Math.max(10, size * 0.4), background: color }}>
      {user.avatar_url ? <img src={user.avatar_url} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : initials(name)}
      {showPresence && <i className={cls('presence', isOnline && 'on')} />}
    </span>
  );
}
export function AvatarStack({ users = [], max = 4, size = 28 }) {
  const shown = users.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((u) => <Avatar key={u.id} user={u} size={size} ring />)}
      {users.length > max && <span className="avatar more" style={{ width: size, height: size }}>+{users.length - max}</span>}
    </span>
  );
}

export function Modal({ open = true, onClose, title, children, width = 560, className, footer, bare }) {
  const backdrop = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    // Escape closes only the top-most modal (e.g. version history opened from a task)
    const onKey = (e) => { if (e.key === 'Escape' && backdrop.current === [...document.querySelectorAll('.modal-backdrop')].pop()) onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); setTimeout(() => { if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('modal-open'); }, 0); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" ref={backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={cls('modal', className)} style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        {!bare && (
          <div className="modal-head">
            <h3>{title}</h3>
            <button className="icon-btn" onClick={onClose} aria-label="Close"><IX /></button>
          </div>
        )}
        <div className={cls(!bare && 'modal-body')}>{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>, document.body);
}

/**
 * Popover anchored to its trigger. It opens below the trigger, or ABOVE it when there is more
 * room there (e.g. the bottom board dock → "Switch boards"), and its height is capped to the
 * space available so the content scrolls instead of running off-screen.
 */
export function Popover({ trigger, children, align = 'right', width = 320, open: controlled, onOpenChange, className }) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = (v) => { onOpenChange ? onOpenChange(v) : setInner(v); };
  const ref = useRef(null);
  const pop = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return undefined;
    const place = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const vw = window.innerWidth; const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      const below = vh - r.bottom - 14;   // free space under the trigger
      const above = r.top - 14;           // free space over the trigger
      const wanted = Math.min(560, vh * 0.7);
      if (below >= Math.min(wanted, 260) || below >= above) {
        setPos({ top: r.bottom + 6, left, width: w, maxHeight: Math.max(120, Math.min(wanted, below)) });
      } else {
        setPos({ bottom: vh - r.top + 6, left, width: w, maxHeight: Math.max(120, Math.min(wanted, above)) });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, align, width]);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!ref.current?.contains(e.target) && !pop.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  });
  return (
    <>
      <span ref={ref} className="popover-anchor" onClick={() => setOpen(!open)}>{trigger}</span>
      {open && pos && createPortal(
        <div ref={pop} className={cls('popover', className, pos.bottom != null && 'above')}
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>, document.body)}
    </>
  );
}

export function Spinner({ label }) { return <div className="spinner-wrap"><span className="spinner" />{label && <span>{label}</span>}</div>; }
export function Empty({ icon, title, children, action }) {
  return <div className="empty">{icon && <div className="empty-icon">{icon}</div>}<strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return <div className="error-box"><span>{error.message || String(error)}</span>{onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}</div>;
}

/** Colour-coded age chip — the "aging" indicator for tasks and chats. */
export function AgeChip({ iso, label, compact }) {
  const { settings } = useApp();
  if (!iso || !settings.showAging) return null;
  const d = ageDays(iso);
  const lvl = agingLevel(d);
  return <span className={cls('age-chip', lvl)} title={`${label || 'Age'}: ${d} day${d === 1 ? '' : 's'} (${fmtDateTime(iso)})`}><IHourglass />{compact ? `${d}d` : d === 0 ? 'today' : `${d}d`}</span>;
}
export function TimeAgo({ iso, short }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);
  return <time dateTime={iso} title={fmtDateTime(iso)}>{timeAgo(iso, { short })}</time>;
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cls('tabs', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={cls('tab', value === t.value && 'active')} onClick={() => onChange(t.value)}>
          {t.icon}{t.label}{t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export function Toasts() {
  const { toasts } = useApp();
  return createPortal(<div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={cls('toast', t.type)}>{t.message}</div>)}</div>, document.body);
}

export function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = (message, { danger = true, ok = 'Delete' } = {}) => new Promise((resolve) => setState({ message, danger, ok, resolve }));
  const node = state && (
    <Modal title="Please confirm" onClose={() => { state.resolve(false); setState(null); }} width={420}
      footer={<>
        <button className="btn ghost" onClick={() => { state.resolve(false); setState(null); }}>Cancel</button>
        <button className={cls('btn', state.danger ? 'danger' : 'primary')} onClick={() => { state.resolve(true); setState(null); }}>{state.ok}</button>
      </>}>
      <p>{state.message}</p>
    </Modal>
  );
  return [confirm, node];
}

export function InlineEdit({ value, onSave, className, multiline, placeholder, disabled }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value || '');
  useEffect(() => { if (!editing) setV(value || ''); }, [value, editing]);
  const save = () => { setEditing(false); if ((v || '').trim() !== (value || '').trim()) onSave(v.trim()); };
  if (!editing || disabled) return <span className={cls('inline-edit', className, disabled && 'disabled')} onClick={() => !disabled && setEditing(true)} tabIndex={disabled ? -1 : 0} onKeyDown={(e) => e.key === 'Enter' && !disabled && setEditing(true)}>{value || <em className="muted">{placeholder}</em>}</span>;
  const props = { autoFocus: true, value: v, onChange: (e) => setV(e.target.value), onBlur: save, className: cls('inline-input', className),
    onKeyDown: (e) => { if (e.key === 'Escape') { setV(value || ''); setEditing(false); } if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } } };
  return multiline ? <textarea rows={4} {...props} /> : <input {...props} />;
}

export function PriorityPill({ p }) { return p ? <span className={cls('prio', p)}>{p}</span> : null; }
export function Pill({ children, tone = 'default', title }) { return <span className={cls('pill', tone)} title={title}>{children}</span>; }

export function useMediaQuery(q) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const fn = () => setM(mq.matches); mq.addEventListener('change', fn); return () => mq.removeEventListener('change', fn); }, [q]);
  return m;
}