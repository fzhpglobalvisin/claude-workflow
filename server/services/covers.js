// Cover images by link — shown on the tiles of companies, units (workspaces), boards and tasks.
//   Company & unit covers → Superadmin only (global / company master data)
//   Board & task covers   → roles with the `cover.manage` permission (e.g. sales_marketing)
// Every change is a normal versioned update, so it appears in the record's version history.
import { get, update, now } from '../db/index.js';
import { bad, forbidden, notFound } from '../lib/http.js';
import { isSuper, can, assertBoard } from '../lib/access.js';
import { audit } from '../lib/events.js';
import { boardChanged, assertCard } from './boards.js';

/** Which column holds the cover of each tile type, and who may set it. */
const TARGETS = {
  company: { table: 'az_company', column: 'image_url', who: 'super', label: 'Company' },
  unit: { table: 'az_workspace', column: 'cover_url', who: 'super', label: 'Unit' },
  board: { table: 'az_board', column: 'cover_url', who: 'cover.manage', label: 'Board' },
  card: { table: 'az_card', column: 'cover_url', who: 'cover.manage', label: 'Task' },
};

export function canSetCover(user, entity) {
  const t = TARGETS[entity];
  if (!t) return false;
  return t.who === 'super' ? isSuper(user) : can(user, t.who);
}

/**
 * Accepts any http(s) image link. Share links from Google Drive and Dropbox are turned into
 * direct image links so they render inside an <img> / CSS background.
 */
export function normalizeCoverUrl(input) {
  if (input == null || String(input).trim() === '') return null;
  const s = String(input).trim();
  if (s.length > 2000) throw bad('The link is too long (max 2000 characters)');
  let u;
  try { u = new URL(s); } catch { throw bad('Enter a full link starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw bad('Only http(s) links are allowed');
  // Google Drive: /file/d/<id>/view, open?id=<id>, uc?id=<id>  → thumbnail endpoint (works in <img>)
  if (/(^|\.)drive\.google\.com$/.test(u.hostname) || u.hostname === 'docs.google.com') {
    const id = (u.pathname.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || [])[1] || u.searchParams.get('id');
    if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;
  }
  // Dropbox share link → raw file
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('raw', '1'); return u.toString(); }
  return u.toString();
}

export function register(r) {
  // What may the signed-in user change? (the UI uses this to show the cover buttons)
  r.get('/api/covers/rights', async (ctx) => Object.fromEntries(Object.keys(TARGETS).map((e) => [e, canSetCover(ctx.user, e)])));

  // Set or remove a cover: { url: "https://…" } or { url: null }
  r.put('/api/covers/:entity/:id', async (ctx) => {
    const { entity, id } = ctx.params;
    const t = TARGETS[entity];
    if (!t) throw notFound('Covers exist for company, unit, board and card');
    if (!canSetCover(ctx.user, entity)) {
      throw forbidden(t.who === 'super'
        ? `${t.label} covers are set by the Superadmin`
        : `${t.label} covers need the "cover.manage" permission (e.g. the sales_marketing role)`);
    }
    const row = await get(`SELECT * FROM ${t.table} WHERE id = ?`, id);
    if (!row) throw notFound(`${t.label} not found`);
    if (row.is_active === 0) throw bad(`This ${t.label.toLowerCase()} is retired`);
    let boardId = null;
    if (entity === 'board') { await assertBoard(ctx.user, id, 'view'); boardId = id; }
    if (entity === 'card') { const { card } = await assertCard(ctx.user, id, 'view'); boardId = card.board_id; }
    const url = normalizeCoverUrl(ctx.body?.url);
    await update(t.table, id, {
      [t.column]: url, updated_at: now(),
      change_note: ctx.body?.change_note || (url ? 'Cover image changed' : 'Cover image removed'),
    });
    await audit({ actor: ctx.user, type: `${entity}.cover_${url ? 'set' : 'removed'}`, entityType: entity, entityId: id, boardId, details: { url }, ip: ctx.ip });
    if (boardId) await boardChanged(boardId, entity === 'card' ? 'card' : 'board', entity === 'card' ? { cardId: id } : {});
    const fresh = await get(`SELECT id, ${t.column} AS cover_url, version_no FROM ${t.table} WHERE id = ?`, id);
    return { entity, ...fresh };
  });
}
