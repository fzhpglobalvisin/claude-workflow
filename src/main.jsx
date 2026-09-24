import { createRoot } from 'react-dom/client';
import { AppProvider } from './lib/store.jsx';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<AppProvider><App /></AppProvider>);

// Offline shell (PWA). Service workers need https or localhost.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
