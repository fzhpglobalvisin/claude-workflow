// Cover images by link for tiles: company · unit (workspace) · board · task.
//   Company & unit → Superadmin only.   Board & task → roles with the "cover.manage" permission
//   (the sales_marketing role; the Superadmin can grant it to other roles in Admin → Roles).
// The server re-checks the same rules (server/services/covers.js) and versions every change.
import { useState } from 'react';
import { PUT } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { Modal, Field } from './ui.jsx';
import { cls } from '../lib/format.js';
import { IImage } from './icons.js';
import './CoverPicker.css';

const LABEL = { company: 'company', unit: 'unit', board: 'board', card: 'task' };

/** { company, unit, board, card } → may the signed-in user set that cover? */
export function useCoverRights() {
  const { isSuper, can } = useApp();
  const tile = can('cover.manage');
  return { company: !!isSuper, unit: !!isSuper, board: tile, card: tile };
}

/** Same conversion the server does, so the preview matches what will be saved. */
export function previewUrl(input) {
  const s = (input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (/(^|\.)drive\.google\.com$/.test(u.hostname) || u.hostname === 'docs.google.com') {
      const id = (u.pathname.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || [])[1] || u.searchParams.get('id');
      if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;
    }
    if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); return u.toString(); }
    return u.toString();
  } catch { return ''; }
}

/** Dialog: paste a link, see the preview, save or remove. */
export function CoverModal({ entity, id, url, title, onClose, onSaved }) {
  const { toast } = useApp();
  const [value, setValue] = useState(url || '');
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = previewUrl(value);
  const save = async (next) => {
    setBusy(true);
    try {
      const r = await PUT(`/api/covers/${entity}/${encodeURIComponent(id)}`, { url: next }, { queue: false });
      toast(next ? 'Cover image saved' : 'Cover image removed', 'success');
      onSaved?.(r.cover_url || null, r);
      onClose();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Cover image — ${title || LABEL[entity]}`} onClose={onClose} width={560} footer={<>
      {url && <button className="btn danger" disabled={busy} onClick={() => save(null)}>Remove cover</button>}
      <span className="grow" />
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !shown} onClick={() => save(value.trim())}>{broken ? 'Save anyway' : 'Save cover'}</button>
    </>}>
      <div className={cls('cover-preview', entity)}>
        {shown && !broken
          ? <img src={shown} alt="Cover preview" onError={() => setBroken(true)} onLoad={() => setBroken(false)} />
          : <span className="muted small">{broken ? 'This link did not load as an image here — make sure it is public (Drive: “Anyone with the link”). You can still save it.' : 'Preview appears here'}</span>}
      </div>
      <Field label="Image link" hint="Any public https image link. Google Drive / Dropbox share links are converted automatically (the file must be shared as “Anyone with the link”).">
        <input autoFocus type="url" value={value} placeholder="https://images.unsplash.com/photo-…  or  https://drive.google.com/file/d/…/view"
          onChange={(e) => { setValue(e.target.value); setBroken(false); }} onKeyDown={(e) => { if (e.key === 'Enter' && shown) save(value.trim()); }} />
      </Field>
    </Modal>
  );
}

/**
 * Small camera button for a tile. Renders nothing when the user may not set this cover.
 * Safe inside links/clickable tiles (it stops the click from opening the tile).
 */
export function CoverButton({ entity, id, url, title, onSaved, className, label }) {
  const rights = useCoverRights();
  const [open, setOpen] = useState(false);
  if (!rights[entity]) return null;
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <>
      <button type="button" className={cls('cover-btn', label && 'with-label', className)} title={url ? 'Change cover image' : 'Add cover image'} aria-label="Cover image"
        onClick={(e) => { stop(e); setOpen(true); }} onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <IImage />{label && <span>{label}</span>}
      </button>
      {open && <span onClick={stop} onMouseDown={(e) => e.stopPropagation()}><CoverModal entity={entity} id={id} url={url} title={title} onClose={() => setOpen(false)} onSaved={onSaved} /></span>}
    </>
  );
}

/** CSS background for a tile that has a cover link (falls back to `fallback` style). */
export const coverStyle = (url, fallback = {}) => (url ? { backgroundImage: `url("${url}"), linear-gradient(135deg,#1e3a8a,#312e81)`, backgroundSize: 'cover', backgroundPosition: 'center' } : fallback);
