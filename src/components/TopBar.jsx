// Trello-style top bar: apps menu, logo, global search, Create, pinned chats, notifications, help, settings, profile.
import { useEffect, useRef, useState } from 'react';
import { GET, POST } from '../lib/api.js';
import { useApp } from '../lib/store.jsx';
import { navigate, Link } from '../lib/router.jsx';
import { Avatar, Popover, TimeAgo, Spinner, AgeChip } from './ui.jsx';
import { cls, fmtDate } from '../lib/format.js';
import { CreateModal } from './CreateModal.jsx';
import { SettingsModal } from './SettingsModal.jsx';
import {
  ISearch, IBell, IPin, ISettings, IApps, IHelp, IBuilding, IBoard, IChat, IChart, ITable, IServer, IBot, IShield, INetwork, ILogout,
  IHash, ILock, IUser, IHome, IDown, IOffline, IRefresh, IProject, IFile, IAt,
} from './icons.js';

export const NAV = [
  { to: '/', label: 'Companies', icon: <IBuilding />, desc: 'Switch organisation' },
  { to: '/home', label: 'Company home', icon: <IHome />, desc: 'Units, projects & boards' },
  { to: '/chat', label: 'Chat', icon: <IChat />, desc: 'Channels, DMs & threads' },
  { to: '/dashboard', label: 'Dashboard', icon: <IChart />, desc: 'Management analytics', perm: 'report.view' },
  { to: '/reports', label: 'Report builder', icon: <ITable />, desc: 'Build & save reports', perm: 'report.view' },
  { to: '/ops', label: 'Pipelines & alerts', icon: <IServer />, desc: 'Deploys, monitoring, incidents', perm: 'ops.view' },
  { to: '/ai', label: 'AI crew', icon: <IBot />, desc: 'Agents that automate tasks' },
  { to: '/admin', label: 'Admin', icon: <IShield />, desc: 'Users, access, roles, audit, data', admin: true },
  { to: '/architecture', label: 'Architecture', icon: <INetwork />, desc: 'Service & data-flow diagrams' },
];

function AppsMenu() {
  const { can, isAdmin } = useApp();
  return (
    <Popover align="left" width={300} trigger={<button className="icon-btn" aria-label="Apps menu"><IApps /></button>}>
      {(close) => (
        <div className="menu">
          <div className="menu-title">Workflow Hub</div>
          {NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.admin || isAdmin)).map((n) => (
            <Link key={n.to} to={n.to} className="menu-item rich" onClick={close}>{n.icon}<span><strong>{n.label}</strong><small>{n.desc}</small></span></Link>
          ))}
        </div>
      )}
    </Popover>
  );
}

function GlobalSearch() {
  const { companyId } = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('company');
  const box = useRef(null); const input = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName)) || ((e.metaKey || e.ctrlKey) && e.key === 'k')) { e.preventDefault(); input.current?.focus(); }
    };
    const onDoc = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc); };
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return undefined; }
    setBusy(true);
    const t = setTimeout(() => {
      GET(`/api/search?q=${encodeURIComponent(q.trim())}${scope === 'company' && companyId ? `&company_id=${companyId}` : ''}`)
        .then(setRes).catch(() => setRes(null)).finally(() => setBusy(false));
    }, 220);
    return () => clearTimeout(t);
  }, [q, scope, companyId]);
  const go = (to) => { setOpen(false); setQ(''); navigate(to); };
  const r = res?.results || {};
  const Section = ({ title, items, render }) => (items?.length ? <div className="search-sec"><div className="search-sec-title">{title}</div>{items.map(render)}</div> : null);
  return (
    <div className="global-search" ref={box}>
      <ISearch className="gs-icon" />
      <input ref={input} value={q} placeholder="Search tasks, chats, people, boards…" onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} aria-label="Global search" />
      <kbd>/</kbd>
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          <div className="search-scope">
            <button className={cls(scope === 'company' && 'on')} onClick={() => setScope('company')} disabled={!companyId}>This company</button>
            <button className={cls(scope === 'all' && 'on')} onClick={() => setScope('all')}>All companies</button>
            {busy && <span className="spinner sm" />}
            {res && <span className="muted">{res.total} results</span>}
          </div>
          {res && res.total === 0 && <div className="muted pad">No matches for “{q}”.</div>}
          <Section title="Tasks" items={r.cards} render={(c) => (
            <button key={c.id} className="search-item" onClick={() => go(`/board/${c.board_id}?card=${c.id}`)}>
              <IBoard /><span><strong>{c.title}</strong><small>{c.company_code} · {c.board_title} › {c.list_title}{c.assignee_name ? ` · ${c.assignee_name}` : ''}</small></span><AgeChip iso={c.created_at} compact />
            </button>)} />
          <Section title="Subtasks & requirements" items={[...(r.subtasks || []), ...(r.requirements || [])]} render={(s) => (
            <button key={s.id} className="search-item" onClick={() => go(`/board/${s.board_id}?card=${s.card_id}`)}>
              {s.type ? <IFile /> : <ITable />}<span><strong>{s.title}</strong><small>in {s.card_title}</small></span>
            </button>)} />
          <Section title="Messages" items={r.messages} render={(m) => (
            <button key={m.id} className="search-item" onClick={() => go(`/chat/${m.channel_id}?m=${m.parent_message_id || m.id}`)}>
              <IChat /><span><strong>{m.full_name || 'AI'}: {m.content.replace(/\*\*|`/g, '').slice(0, 80)}</strong><small>{m.channel_type === 'dm' ? 'Direct message' : `#${m.channel_name}`} · <TimeAgo iso={m.created_at} /></small></span>
            </button>)} />
          <Section title="Boards & projects" items={[...(r.boards || []).map((b) => ({ ...b, kind: 'board' })), ...(r.projects || []).map((p) => ({ ...p, kind: 'project' }))]} render={(b) => (
            <button key={b.id} className="search-item" onClick={() => go(b.kind === 'board' ? `/board/${b.id}` : `/home?project=${b.id}`)}>
              {b.kind === 'board' ? <IBoard /> : <IProject />}<span><strong>{b.title}</strong><small>{b.kind} · {b.unit_name}</small></span>
            </button>)} />
          <Section title="Channels" items={r.channels} render={(c) => (
            <button key={c.id} className="search-item" onClick={() => go(`/chat/${c.id}`)}>{c.is_private ? <ILock /> : <IHash />}<span><strong>{c.name}</strong><small>{c.description}</small></span></button>)} />
          <Section title="People" items={r.people} render={(p) => (
            <button key={p.id} className="search-item" onClick={() => go(`/chat?dm=${p.id}`)}><Avatar user={p} size={22} /><span><strong>{p.full_name} <em>@{p.username}</em></strong><small>{p.designation}</small></span></button>)} />
          <Section title="Companies & units" items={[...(r.companies || []), ...(r.units || [])]} render={(c) => (
            <button key={c.id} className="search-item" onClick={() => go(c.code ? '/' : '/home')}><IBuilding /><span><strong>{c.name}</strong><small>{c.code || c.company_code}</small></span></button>)} />
        </div>
      )}
    </div>
  );
}

export function PinnedChats({ variant }) {
  const { pinsVersion } = useApp();
  const [pins, setPins] = useState(null);
  const [open, setOpen] = useState(false);
  const load = () => GET('/api/pins').then(setPins).catch(() => setPins([]));
  useEffect(() => { load(); }, [pinsVersion]);
  useEffect(() => { if (open) load(); }, [open]);
  const count = pins?.length || 0;
  return (
    <Popover open={open} onOpenChange={setOpen} width={360} trigger={
      <button className={cls('pill-btn', variant)} aria-label="Pinned chats"><IPin /> <span className="hide-sm">Pinned Chats</span> <span className="badge blue">{count}</span> <IDown className="hide-sm" /></button>}>
      {(close) => (
        <div className="menu">
          <div className="menu-title">Pinned chats <span className="muted">· {count}</span></div>
          {!pins && <Spinner />}
          {pins?.length === 0 && <div className="muted pad">Pin channels or messages from Chat to keep them here.</div>}
          {pins?.map((p) => (
            <button key={p.pin_id} className="menu-item rich" onClick={() => { close(); navigate(`/chat/${p.channel_id}${p.message_id ? `?m=${p.message_id}` : ''}`); }}>
              {p.channel_type === 'dm' ? <IUser /> : p.channel_type === 'private' ? <ILock /> : <IHash />}
              <span>
                <strong>{p.title}{p.company_code && <em className="muted"> · {p.company_code}</em>}{p.unread > 0 && <span className="badge red">{p.unread}</span>}</strong>
                <small>{p.message ? `📌 ${p.message.full_name || 'AI'}: ${(p.message.content || '').slice(0, 70)}` : `Last activity ${p.last_message_at ? new Date(p.last_message_at).toLocaleString() : '—'}`}</small>
              </span>
              <small className="muted nowrap"><TimeAgo iso={p.message?.created_at || p.last_message_at} short /></small>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function Notifications() {
  const { unread, setUnread } = useApp();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) GET('/api/notifications').then((d) => { setData(d); setUnread(d.unread); }).catch(() => {}); }, [open]);
  const markAll = async () => { await POST('/api/notifications/read', {}); setUnread(0); setData((d) => d && { ...d, items: d.items.map((n) => ({ ...n, is_read: true })) }); };
  const openItem = async (n, close) => {
    close();
    if (!n.is_read) { POST('/api/notifications/read', { ids: [n.id] }).catch(() => {}); setUnread((c) => Math.max(0, c - 1)); }
    if (n.link) navigate(n.link);
  };
  const ICON = { mention: <IAt />, alert: '🚨', incident: '🔥', assign: '👤', done: '✅', comment: '💬', thread: '🧵', dm: '✉️', access: '🔑', due: '⏰', pipeline: '🚀', channel: '📣' };
  return (
    <Popover open={open} onOpenChange={setOpen} width={380} trigger={
      <button className="icon-btn notif" aria-label="Notifications"><IBell />{unread > 0 && <span className="dot-count">{unread > 9 ? '9+' : unread}</span>}</button>}>
      {(close) => (
        <div className="menu notif-menu">
          <div className="menu-title">Notifications <button className="link" onClick={markAll}>Mark all read</button></div>
          {!data && <Spinner />}
          {data?.items.length === 0 && <div className="muted pad">You’re all caught up.</div>}
          {data?.items.map((n) => (
            <button key={n.id} className={cls('menu-item rich notif-item', !n.is_read && 'unread')} onClick={() => openItem(n, close)}>
              <span className="notif-icon">{ICON[n.type] || '🔔'}</span>
              <span><strong>{n.title}</strong>{n.body && <small>{n.body}</small>}<small className="muted"><TimeAgo iso={n.created_at} /></small></span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function ProfileMenu({ onSettings }) {
  const { user, logout } = useApp();
  return (
    <Popover width={260} trigger={<button className="avatar-btn" aria-label="Account"><Avatar user={user} size={30} showPresence /></button>}>
      {(close) => (
        <div className="menu">
          <div className="profile-head"><Avatar user={user} size={40} /><div><strong>{user.full_name}</strong><small>@{user.username} · {user.role}{user.is_super_admin ? ' (super admin)' : ''}</small><small>{user.designation}</small></div></div>
          <button className="menu-item" onClick={() => { close(); onSettings('profile'); }}><IUser /> Profile & password</button>
          <button className="menu-item" onClick={() => { close(); onSettings('appearance'); }}><ISettings /> Theme & settings</button>
          <button className="menu-item" onClick={() => { close(); logout(); navigate('/'); }}><ILogout /> Sign out</button>
        </div>
      )}
    </Popover>
  );
}

export function NetBanner() {
  const { net } = useApp();
  if (net.online && !net.pending) return null;
  return (
    <div className={cls('net-banner', !net.online && 'off')}>
      {!net.online ? <><IOffline /> You’re offline — showing cached data. Changes are saved on this device and will sync automatically.</> : <><IRefresh className="spin" /> Syncing {net.pending} offline change{net.pending === 1 ? '' : 's'}…</>}
      {net.pending > 0 && !net.online && <span className="badge">{net.pending} pending</span>}
    </div>
  );
}

export function TopBar() {
  const { can } = useApp();
  const [create, setCreate] = useState(null);
  const [settings, setSettings] = useState(null);
  return (
    <>
      <header className="topbar">
        <div className="tb-left">
          <AppsMenu />
          <Link to="/" className="logo"><img src="/icon.svg" alt="" width="22" height="22" /><span>Workflow Hub</span></Link>
        </div>
        <div className="tb-center">
          <GlobalSearch />
          <Popover align="left" width={260} trigger={<button className="btn primary create-btn">Create</button>}>
            {(close) => (
              <div className="menu">
                {[
                  ['task', 'Task', 'Add a card to any board you can edit', 'card.create'],
                  ['board', 'Board', 'Kanban board inside a unit / project', 'board.create'],
                  ['project', 'Project', 'Group boards & tasks', 'project.manage'],
                  ['unit', 'Unit', 'Team or department in a company', 'unit.manage'],
                  ['channel', 'Channel', 'Slack-style conversation', 'chat.channel.create'],
                ].filter((x) => can(x[3])).map(([k, l, d]) => (
                  <button key={k} className="menu-item rich" onClick={() => { close(); setCreate(k); }}><IFile /><span><strong>{l}</strong><small>{d}</small></span></button>
                ))}
              </div>
            )}
          </Popover>
        </div>
        <div className="tb-right">
          <span className="hide-md"><PinnedChats variant="dark" /></span>
          <Notifications />
          <Link to="/architecture" className="icon-btn hide-sm" aria-label="Help & architecture"><IHelp /></Link>
          <button className="icon-btn hide-sm" onClick={() => setSettings('appearance')} aria-label="Theme & settings"><ISettings /></button>
          <ProfileMenu onSettings={setSettings} />
        </div>
      </header>
      <NetBanner />
      {create && <CreateModal kind={create} onClose={() => setCreate(null)} />}
      {settings && <SettingsModal tab={settings} onClose={() => setSettings(null)} />}
    </>
  );
}

export { fmtDate };
