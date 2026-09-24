// Minimal dependency-free HTTP router (Express-like) used by every service.
export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (m) => new HttpError(400, m);
export const forbidden = (m = 'You do not have permission for this action') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, path, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve({});
  // Vercel functions pre-read the body and expose it as req.body (a lazy getter)
  if (process.env.VERCEL) {
    let b;
    try { b = req.body; } catch { return Promise.reject(bad('Invalid JSON body')); }
    if (b !== undefined) {
      if (b == null || b === '') return Promise.resolve({});
      if (typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
      try { return Promise.resolve(JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : String(b))); } catch { return Promise.reject(bad('Invalid JSON body')); }
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { reject(bad('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function sendJSON(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

// tiny validators
export function str(v, name, { min = 1, max = 5000, optional = false } = {}) {
  if (v == null || v === '') { if (optional) return null; throw bad(`${name} is required`); }
  const s = String(v).trim();
  if (s.length < min) throw bad(`${name} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}
export function oneOf(v, name, list, fallback) {
  if (v == null || v === '') return fallback;
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}
