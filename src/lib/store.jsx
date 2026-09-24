// App-wide state: session, people directory, presence, settings/theme, toasts, counters.
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { GET, POST, auth, bus, outbox, isOnline, flushOutbox } from './api.js';
import { connect, disconnect, subscribe } from './realtime.js';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export const BACKGROUNDS = {
  aurora: 'radial-gradient(ellipse 60% 55% at 8% 42%, #f97316 0%, rgba(249,115,22,0) 60%), radial-gradient(ellipse 55% 60% at 30% 0%, rgba(236,72,153,.55) 0%, rgba(236,72,153,0) 60%), radial-gradient(ellipse 70% 70% at 70% 60%, #7e22ce 0%, rgba(126,34,206,0) 70%), linear-gradient(115deg, #9a3412 0%, #86198f 38%, #6b21a8 58%, #3b0764 80%, #312e81 100%)',
  ocean: 'radial-gradient(ellipse at 20% 20%, #22d3ee55, transparent 55%), radial-gradient(ellipse at 80% 70%, #6366f155, transparent 55%), linear-gradient(135deg, #0c4a6e, #1e3a8a 55%, #0f172a)',
  forest: 'radial-gradient(ellipse at 15% 25%, #84cc1650, transparent 55%), linear-gradient(135deg, #064e3b, #065f46 45%, #0f172a)',
  sunset: 'radial-gradient(ellipse at 25% 20%, #fb718580, transparent 55%), radial-gradient(ellipse at 80% 80%, #f59e0b60, transparent 50%), linear-gradient(135deg, #7f1d1d, #9d174d 50%, #1e1b4b)',
  midnight: 'radial-gradient(ellipse at 70% 10%, #334155, transparent 55%), linear-gradient(160deg, #0f172a, #020617)',
  daylight: 'radial-gradient(ellipse at 10% 20%, #fde68a, transparent 50%), radial-gradient(ellipse at 90% 80%, #c4b5fd, transparent 55%), linear-gradient(135deg, #fef3c7, #e0e7ff)',
};
export const ACCENTS = ['#579dff', '#9f8fef', '#f87168', '#4bce97', '#f5a623', '#ec4899', '#22d3ee'];
const DEFAULT_SETTINGS = { mode: 'dark', bg: 'aurora', accent: '#579dff', compact: false, showAging: true };

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('wfh.settings') || '{}') }; } catch { return DEFAULT_SETTINGS; }
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!auth.token);
  const [users, setUsers] = useState([]);
  const [online, setOnlineUsers] = useState(new Set());
  const [settings, setSettingsState] = useState(loadSettings);
  const [toasts, setToasts] = useState([]);
  const [unread, setUnread] = useState(0);
  const [pinsVersion, setPinsVersion] = useState(0);
  const [net, setNet] = useState({ online: isOnline(), pending: outbox.list().length });
  const [companyId, setCompanyIdState] = useState(() => { try { return localStorage.getItem('wfh.company') || null; } catch { return null; } });
  const toastId = useRef(0);

  const toast = useCallback((message, type = 'info', ms = 3800) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const setCompanyId = useCallback((id) => { setCompanyIdState(id); try { id ? localStorage.setItem('wfh.company', id) : localStorage.removeItem('wfh.company'); } catch {} }, []);

  const setSettings = useCallback((patch) => {
    setSettingsState((s) => { const n = { ...s, ...patch }; try { localStorage.setItem('wfh.settings', JSON.stringify(n)); } catch {} return n; });
  }, []);

  // theme → CSS variables on <html>
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    const apply = () => {
      const mode = settings.mode === 'system' ? (mq?.matches ? 'light' : 'dark') : settings.mode;
      root.dataset.theme = mode;
      root.dataset.density = settings.compact ? 'compact' : 'normal';
      root.style.setProperty('--accent', settings.accent);
      root.style.setProperty('--hub-bg', BACKGROUNDS[settings.bg] || BACKGROUNDS.aurora);
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', mode === 'light' ? '#ffffff' : '#1d2125');
    };
    apply();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [settings]);

  const refreshUsers = useCallback(() => GET('/api/users').then((list) => {
    setUsers(list);
    setOnlineUsers(new Set(list.filter((u) => u.online).map((u) => u.id)));
  }).catch(() => {}), []);
  const refreshUnread = useCallback(() => GET('/api/notifications').then((n) => setUnread(n.unread)).catch(() => {}), []);

  const logout = useCallback(async (silent) => {
    try { if (!silent) await POST('/api/auth/logout', {}, { queue: false }); } catch {}
    auth.clear(); disconnect(); setUser(null); setUsers([]);
  }, []);

  const signIn = useCallback((token, u) => { auth.set(token); setUser(u); }, []);

  // boot: restore session
  useEffect(() => {
    if (!auth.token) return;
    GET('/api/auth/me').then((r) => setUser(r.user)).catch((e) => { if (e.status === 401 || e.status === 403) auth.clear(); }).finally(() => setBooting(false));
  }, []);

  // when signed in: realtime + directory
  useEffect(() => {
    if (!user) return undefined;
    connect(); refreshUsers(); refreshUnread(); flushOutbox();
    const offs = [
      subscribe('hello', (d) => setOnlineUsers(new Set(d?.online || []))),
      subscribe('presence', (d) => setOnlineUsers((s) => { const n = new Set(s); d.online ? n.add(d.userId) : n.delete(d.userId); return n; })),
      subscribe('notification', (n) => { setUnread((c) => c + 1); toast(n.title, n.type === 'alert' || n.type === 'incident' ? 'error' : 'info'); }),
      subscribe('force-logout', () => { toast('Your session was ended by an administrator', 'error'); logout(true); }),
    ];
    return () => offs.forEach((f) => f());
  }, [user?.id]);

  useEffect(() => {
    const onUnauth = () => { if (auth.token) { toast('Session expired — please sign in again', 'error'); logout(true); } };
    const onOnline = (e) => setNet((n) => ({ ...n, online: e.detail }));
    const onOutbox = (e) => setNet((n) => ({ ...n, pending: e.detail }));
    const onFailed = (e) => toast(`${e.detail.length} offline change(s) were rejected by the server: ${e.detail[0].error}`, 'error', 7000);
    const onSynced = (e) => { if (e.detail.remaining === 0) setNet((n) => (n.pending ? { ...n, pending: 0 } : n)); };
    bus.addEventListener('unauthorized', onUnauth); bus.addEventListener('online', onOnline); bus.addEventListener('outbox', onOutbox);
    bus.addEventListener('sync-failed', onFailed); bus.addEventListener('synced', onSynced);
    return () => { bus.removeEventListener('unauthorized', onUnauth); bus.removeEventListener('online', onOnline); bus.removeEventListener('outbox', onOutbox); bus.removeEventListener('sync-failed', onFailed); bus.removeEventListener('synced', onSynced); };
  }, [logout, toast]);

  const can = useCallback((perm) => !!user && (user.permissions?.includes('*') || user.permissions?.includes(perm)), [user]);
  const userById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);

  const value = {
    user, setUser, booting, signIn, logout, can, users, userById, refreshUsers, online, settings, setSettings,
    toast, toasts, unread, setUnread, refreshUnread, pinsVersion, bumpPins: () => setPinsVersion((v) => v + 1), net, companyId, setCompanyId,
    isSuper: !!user?.is_super_admin, isAdmin: !!user && (user.is_super_admin || user.role === 'admin'),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Load data with loading/error state; re-runs when deps change. */
export function useData(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const load = useCallback(() => {
    const s = ++seq.current;
    setState((st) => ({ ...st, loading: true, error: null }));
    return Promise.resolve().then(fn).then((data) => { if (s === seq.current) setState({ data, loading: false, error: null }); return data; })
      .catch((error) => { if (s === seq.current) setState((st) => ({ ...st, loading: false, error })); });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (d) => setState((st) => ({ ...st, data: typeof d === 'function' ? d(st.data) : d })) };
}
