// Tiny History-API router (no dependency).
import { useEffect, useState, useCallback } from 'react';

const listeners = new Set();
export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', to);
  listeners.forEach((fn) => fn());
  window.scrollTo(0, 0);
}
if (typeof window !== 'undefined') window.addEventListener('popstate', () => listeners.forEach((fn) => fn()));

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => { const fn = () => force((n) => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
  return { path: location.pathname, query: Object.fromEntries(new URLSearchParams(location.search)) };
}

export function matchRoute(pattern, path) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? '?([^/]*)' : '([^/]+)'; }).replace(/\/\?\(/g, '/?(') + '/?$');
  const m = re.exec(path);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined]));
}

export function Link({ to, children, className, onClick, ...rest }) {
  const handle = useCallback((e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onClick?.(e);
    navigate(to);
  }, [to, onClick]);
  return <a href={to} className={className} onClick={handle} {...rest}>{children}</a>;
}

export function setQuery(patch) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
  const s = q.toString();
  navigate(location.pathname + (s ? `?${s}` : ''), { replace: true });
}
