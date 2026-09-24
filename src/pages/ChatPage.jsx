// Slack-style chat: channel sidebar (channels, board channels, DMs) + conversation + threads.
import { useEffect, useMemo, useState } from 'react';
import { GET, POST } from '../lib/api.js';
import { subscribe } from '../lib/realtime.js';
import { useApp, useData } from '../lib/store.jsx';
import { navigate, Link } from '../lib/router.jsx';
import { Avatar, Spinner, Popover, TimeAgo, Empty, useMediaQuery } from '../components/ui.jsx';
import { ChannelView } from '../components/Chat.jsx';
import { CreateModal } from '../components/CreateModal.jsx';
import { IHash, ILock, IBoard, IPlus, IDown, IPin, IAt, ISearch, ILeft, IChat } from '../components/icons.js';
import { cls, ageDays } from '../lib/format.js';

export default function ChatPage({ params, query }) {
  const { companyId, setCompanyId, users, user, online, can, toast } = useApp();
  const { data: companies } = useData(() => GET('/api/companies'), []);
  const [channels, setChannels] = useState(null);
  const [filter, setFilter] = useState('');
  const [create, setCreate] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const narrow = useMediaQuery('(max-width: 760px)');

  useEffect(() => { if (companies && !companyId && companies[0]) setCompanyId(companies[0].id); }, [companies]);
  const load = () => companyId && GET(`/api/channels?company_id=${companyId}`).then(setChannels).catch(() => setChannels([]));
  useEffect(() => { setChannels(null); load(); }, [companyId]);
  useEffect(() => {
    const offs = [
      subscribe('message:new', (e) => {
        setChannels((list) => list && list.map((c) => (c.id === e.channelId && !e.message.parent_message_id ? {
          ...c, last_message_at: e.message.created_at,
          unread: c.id === params.channelId || e.message.user_id === user.id ? 0 : c.unread + 1,
          mentions: c.id !== params.channelId && new RegExp(`@${user.username}\\b`, 'i').test(e.message.content || '') ? c.mentions + 1 : c.mentions,
        } : c)));
        if (channels && !channels.some((c) => c.id === e.channelId)) load();
      }),
      subscribe('channel:changed', () => load()),
    ];
    return () => offs.forEach((f) => f());
  }, [params.channelId, channels?.length, companyId]);

  // open DM from ?dm=userId (people search / directory)
  useEffect(() => {
    if (!query.dm) return;
    POST('/api/dm', { user_id: query.dm, company_id: companyId }, { queue: false }).then((c) => { load(); navigate(`/chat/${c.id}`, { replace: true }); }).catch((e) => toast(e.message, 'error'));
  }, [query.dm]);

  // default channel
  useEffect(() => {
    if (!params.channelId && channels?.length && !narrow && !query.dm) {
      const first = channels.find((c) => c.name === 'general') || channels.find((c) => c.type === 'public') || channels[0];
      navigate(`/chat/${first.id}`, { replace: true });
    }
  }, [params.channelId, channels, narrow]);
  useEffect(() => { if (params.channelId) setChannels((l) => l && l.map((c) => (c.id === params.channelId ? { ...c, unread: 0, mentions: 0 } : c))); }, [params.channelId]);

  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const list = (channels || []).filter((c) => !f || c.name.toLowerCase().includes(f));
    const byTime = (a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || '');
    return {
      starred: list.filter((c) => c.pinned).sort(byTime),
      channels: list.filter((c) => (c.type === 'public' || c.type === 'private') && !c.pinned).sort((a, b) => a.name.localeCompare(b.name)),
      boards: list.filter((c) => c.type === 'board_log' && !c.pinned).sort(byTime),
      dms: list.filter((c) => c.type === 'dm' && !c.pinned).sort(byTime),
    };
  }, [channels, filter]);
  const openDm = async (u) => { const c = await POST('/api/dm', { user_id: u.id, company_id: companyId }, { queue: false }); load(); navigate(`/chat/${c.id}`); };

  const Item = ({ c }) => {
    const icon = c.type === 'dm' ? <span className="dm-av"><Avatar user={c.dm_user || { full_name: c.name }} size={20} showPresence /></span> : c.type === 'board_log' ? <IBoard /> : c.is_private ? <ILock /> : <IHash />;
    const idle = c.last_message_at ? ageDays(c.last_message_at) : null;
    return (
      <Link to={`/chat/${c.id}`} className={cls('ch-item', params.channelId === c.id && 'on', c.unread > 0 && 'unread')} title={c.description || c.name}>
        {icon}<span className="grow ellipsis">{c.type === 'board_log' && c.board ? c.board.title : c.name}</span>
        {c.mentions > 0 ? <span className="badge red">@{c.mentions}</span> : c.unread > 0 ? <span className="badge">{c.unread}</span> : idle != null && idle >= 7 ? <span className="idle" title="Days since last message">{idle}d</span> : null}
      </Link>
    );
  };
  const Section = ({ id, title, items, action }) => (
    <div className="ch-sec">
      <div className="ch-sec-title"><button onClick={() => setCollapsed((s) => ({ ...s, [id]: !s[id] }))}><IDown className={cls(collapsed[id] && 'rot')} /> {title}</button>{action}</div>
      {!collapsed[id] && items.map((c) => <Item key={c.id} c={c} />)}
    </div>
  );

  const showSidebar = !narrow || !params.channelId;
  return (
    <div className="chat-page">
      {showSidebar && (
        <aside className="chat-side">
          <div className="chat-company">
            <select value={companyId || ''} onChange={(e) => { setCompanyId(e.target.value); navigate('/chat'); }} aria-label="Company">
              {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </div>
          <label className="ch-filter"><ISearch /><input placeholder="Find a channel" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          {!channels ? <Spinner /> : (
            <div className="ch-scroll">
              {groups.starred.length > 0 && <Section id="s" title={<><IPin /> Pinned</>} items={groups.starred} />}
              <Section id="c" title="Channels" items={groups.channels} action={can('chat.channel.create') && <button className="icon-btn sm" onClick={() => setCreate(true)} aria-label="Create channel"><IPlus /></button>} />
              <Section id="b" title="Board channels" items={groups.boards} />
              <Section id="d" title="Direct messages" items={groups.dms} action={
                <Popover width={280} trigger={<button className="icon-btn sm" aria-label="New direct message"><IPlus /></button>}>
                  {(close) => (
                    <div className="menu"><div className="menu-title">Message someone</div>
                      {users.filter((u) => u.id !== user.id).map((u) => <button key={u.id} className="menu-item" onClick={() => { close(); openDm(u); }}><Avatar user={u} size={22} showPresence /> {u.full_name} <small className="muted">@{u.username}</small></button>)}
                    </div>
                  )}
                </Popover>} />
              <div className="ch-sec">
                <div className="ch-sec-title"><span>People online</span></div>
                <div className="online-row">{users.filter((u) => online.has(u.id)).map((u) => <button key={u.id} onClick={() => u.id !== user.id && openDm(u)} title={u.full_name}><Avatar user={u} size={26} showPresence /></button>)}</div>
              </div>
            </div>
          )}
        </aside>
      )}
      {params.channelId ? (
        <section className="chat-main">
          {narrow && <button className="btn sm ghost back-btn" onClick={() => navigate('/chat')}><ILeft /> Channels</button>}
          <ChannelView key={params.channelId} channelId={params.channelId} highlightId={query.m} />
        </section>
      ) : !narrow && <section className="chat-main"><Empty icon={<IChat />} title="Pick a conversation" /></section>}
      {create && <CreateModal kind="channel" onClose={() => { setCreate(false); load(); }} />}
    </div>
  );
}

export { TimeAgo, IAt };
