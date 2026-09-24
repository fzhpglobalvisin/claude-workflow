import { useEffect } from 'react';
import { useApp } from './lib/store.jsx';
import { useLocation, matchRoute, navigate } from './lib/router.jsx';
import { Spinner, Toasts } from './components/ui.jsx';
import { TopBar } from './components/TopBar.jsx';
import Login from './pages/Login.jsx';
import CompanyHub from './pages/CompanyHub.jsx';
import CompanyHome from './pages/CompanyHome.jsx';
import BoardPage from './pages/BoardPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Reports from './pages/Reports.jsx';
import OpsPage from './pages/OpsPage.jsx';
import AiCrew from './pages/AiCrew.jsx';
import AdminPage from './pages/AdminPage.jsx';
import Architecture from './pages/Architecture.jsx';

const ROUTES = [
  ['/board/:id', BoardPage, { full: true }],
  ['/chat/:channelId?', ChatPage, { full: true }],
  ['/home', CompanyHome],
  ['/dashboard', Dashboard],
  ['/reports', Reports],
  ['/ops', OpsPage],
  ['/ai', AiCrew],
  ['/admin', AdminPage],
  ['/architecture', Architecture],
];

export default function App() {
  const { user, booting } = useApp();
  const { path, query } = useLocation();

  useEffect(() => { if (user && (path === '/login' || path === '/signup')) navigate('/', { replace: true }); }, [user, path]);

  if (booting) return <div className="boot"><Spinner label="Loading Workflow Hub…" /></div>;
  if (!user) return <><Login mode={path === '/signup' ? 'signup' : 'login'} /><Toasts /></>;
  if (path === '/' || path === '/login' || path === '/signup') return <><CompanyHub /><Toasts /></>;

  for (const [pattern, Page, opts = {}] of ROUTES) {
    const params = matchRoute(pattern, path);
    if (params) {
      return (
        <div className={opts.full ? 'shell full' : 'shell'}>
          <TopBar />
          <main className="main"><Page params={params} query={query} /></main>
          <Toasts />
        </div>
      );
    }
  }
  return <div className="shell"><TopBar /><main className="main page"><h2>Page not found</h2><button className="btn" onClick={() => navigate('/')}>Go to companies</button></main></div>;
}
