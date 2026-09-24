// Preloaded seed data — a software house ("Zynex Holdings") with 5 companies, units, projects,
// boards, tasks, subtasks, requirements, Drive attachments, chat, pipelines, alerts, AI crew & reports.
// The seed is always built into a SQLite file (fast, synchronous). For PostgreSQL the CLI
// seeds a temporary SQLite file and bulk-copies it across (see transfer.js / cli.js).
//   npm run db:seed        (drops and recreates everything)
import crypto from 'node:crypto';
import { openSync } from './sqlite.js';
import { hashPassword } from '../lib/security.js';
import { BY_TABLE } from './versioning.js';

const uuid = () => crypto.randomUUID();
let seq = 0;
let S = null; // sync SQLite handle for the file being seeded
let db = null;
const all = (sql, ...p) => S.all(sql, ...p);
const get = (sql, ...p) => S.get(sql, ...p);
const run = (sql, ...p) => S.run(sql, ...p);
const tx = (fn) => S.tx(fn);
const migrate = () => S.migrate();
let seedAdmin = null;
function insert(table, input) {
  const obj = { ...input };
  if (BY_TABLE[table]) {
    // attribute version 1 of every seeded record to the person who created it
    const by = obj.created_by || obj.uploader_id || obj.profile_id || (table === 'az_message' ? obj.user_id : null) || seedAdmin || 'system';
    obj.changed_by ??= by;
    obj.change_id ??= `seed.${++seq}`;
    if (BY_TABLE[table].hasOwner && obj.owner_id === undefined) obj.owner_id = obj.created_by || seedAdmin || null;
  }
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => obj[k]));
  return obj;
}

// deterministic randomness so every install looks the same
let _s = 20260923;
const rnd = () => { _s |= 0; _s = (_s + 0x6d2b79f5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString();
const ahead = (days) => new Date(Date.now() + days * 864e5).toISOString();
const IMG = (id, w = 1200) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;
const drive = (id) => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const fakeDriveId = () => '1' + [...Array(32)].map(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[Math.floor(rnd() * 64)]).join('');

export const PERMISSIONS = {
  'company.manage': 'Create and edit companies', 'unit.manage': 'Create and edit units', 'project.manage': 'Create and edit projects',
  'board.create': 'Create boards', 'board.manage': 'Edit/delete boards they administer', 'board.members': 'Grant board access (board admins)',
  'card.create': 'Create tasks', 'card.edit': 'Edit and move tasks', 'card.delete': 'Delete tasks',
  'chat.post': 'Post chat messages', 'chat.channel.create': 'Create channels',
  'report.view': 'View dashboards & run reports', 'report.build': 'Save reports in the report builder',
  'ops.view': 'View pipelines, metrics and alerts', 'ops.run': 'Trigger pipelines', 'ops.manage': 'Create and edit pipelines',
  'alert.manage': 'Acknowledge / resolve alerts', 'ai.run': 'Run AI crew agents', 'ai.manage': 'Configure AI agents',
  'admin.users': 'Manage users', 'admin.roles': 'Manage roles & permissions', 'audit.view': 'View the audit trail',
};
export const ROLES = {
  super_admin: ['Full control of auth, access rights and data', Object.keys(PERMISSIONS)],
  admin: ['Company administrator', Object.keys(PERMISSIONS).filter((k) => k !== 'admin.roles')],
  manager: ['Delivery / engineering manager', ['unit.manage', 'project.manage', 'board.create', 'board.manage', 'board.members', 'card.create', 'card.edit', 'card.delete', 'chat.post', 'chat.channel.create', 'report.view', 'report.build', 'ops.view', 'ops.run', 'alert.manage', 'ai.run', 'audit.view']],
  developer: ['Engineer, designer, QA', ['card.create', 'card.edit', 'chat.post', 'chat.channel.create', 'report.view', 'ops.view', 'ai.run']],
  guest: ['Client or external collaborator', ['chat.post']],
};

const USERS = [
  ['admin', 'System Administrator', 'super_admin', 'Platform Owner', 'Management', '#0ea5e9', 'admin123'],
  ['azam', 'Azam Khan', 'manager', 'Delivery Head', 'Management', '#f97316'],
  ['fatima', 'Fatima Latif', 'manager', 'Engineering Manager', 'Engineering', '#10b981'],
  ['maria', 'Maria Ahmed', 'developer', 'UI/UX Designer', 'Design', '#ec4899'],
  ['mansoor', 'Mansoor Ali', 'developer', 'Mobile Developer (Flutter)', 'Engineering', '#8b5cf6'],
  ['usman', 'Usman Tariq', 'developer', 'Backend Engineer', 'Engineering', '#6366f1'],
  ['sara', 'Sara Qureshi', 'developer', 'QA Engineer', 'Quality', '#eab308'],
  ['bilal', 'Bilal Hussain', 'developer', 'DevOps Engineer', 'Cloud', '#14b8a6'],
  ['hina', 'Hina Raza', 'developer', 'AI/ML Engineer', 'Data & AI', '#a855f7'],
  ['omar', 'Omar Farooq', 'developer', 'WordPress / WooCommerce Developer', 'Engineering', '#ef4444'],
  ['ayesha', 'Ayesha Siddiqui', 'manager', 'Business Analyst', 'Client Services', '#84cc16'],
  ['zain', 'Zain Malik', 'developer', 'Frontend Engineer (React)', 'Engineering', '#06b6d4'],
  ['nate', 'Nate Paul', 'guest', 'Client — Zenara Peptides', 'External', '#64748b'],
];

const COMPANIES = [
  ['OmniSphere Enterprise', 'OSE', IMG('1464822759023-fed622ff2c3b'), 'Enterprise ERP & analytics programs', '#f59e0b'],
  ['FZHP Global Vision', 'FGV', IMG('1486406146926-c627a4ad1ab0'), 'Where Technology Meets Marketing', '#3b82f6'],
  ['Zynex Vision LLC', 'ZVL', IMG('1541701494587-cb58502866ab'), 'Flagship software house — AI, mobile & web', '#ec4899'],
  ['Apex Digital Dynamics', 'ADD', IMG('1506905925346-21bda4d32df4'), 'Digital products & e-commerce', '#22c55e'],
  ['Nexus Cloud Solutions', 'NCS', IMG('1469474968028-56623f02e42e'), 'Cloud migration & managed platforms', '#06b6d4'],
];

export function seedSqliteFile(file, { reset = false, quiet = false } = {}) {
  S = openSync(file); db = S.db;
  try {
    seedInner({ reset, quiet });
  } finally { S.close(); S = null; db = null; }
}

function seedInner({ reset, quiet }) {
  seq = 0; seedAdmin = null;
  if (reset) {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    db.exec('PRAGMA foreign_keys = ON');
  }
  migrate();
  tx(() => {
    const T0 = ago(120);
    // ---------------- RBAC ----------------
    const permId = {};
    for (const [key, description] of Object.entries(PERMISSIONS)) permId[key] = insert('az_permission', { id: uuid(), key, description, created_at: T0 }).id;
    for (const [name, [description, keys]] of Object.entries(ROLES)) {
      const r = insert('az_role', { id: uuid(), name, description, created_at: T0, updated_at: T0 });
      for (const k of keys) insert('az_role_permission', { role_id: r.id, permission_id: permId[k] });
    }

    // ---------------- Users + profiles ----------------
    const U = {};
    for (const [username, full, role, designation, dept, color, pw] of USERS) {
      const id = uuid();
      U[username] = { id, username, full_name: full };
      if (username === 'admin') seedAdmin = id;
      insert('users', { id, username, email: `${username}@zynexvision.dev`, password_hash: hashPassword(pw || 'password123'), is_super_admin: role === 'super_admin' ? 1 : 0, is_active: 1, last_login_at: ago(rnd() * 3), created_at: T0, updated_at: T0 });
      insert('profiles', { id, full_name: full, email: `${username}@zynexvision.dev`, role, designation, department: dept, color, status: 'offline', is_guest: role === 'guest' ? 1 : 0, whatsapp_number: `+92 3${Math.floor(rnd() * 90 + 10)} ${Math.floor(rnd() * 9000000 + 1000000)}`, created_at: T0, updated_at: T0 });
    }

    // ---------------- Group / subscription / companies ----------------
    const group = insert('az_group', { id: uuid(), name: 'Zynex Holdings', description: 'Parent group of the Zynex software-house companies', created_at: T0, updated_at: T0 });
    insert('az_subscription', { id: uuid(), group_id: group.id, stripe_customer_id: 'cus_demo_zynex', stripe_subscription_id: 'sub_demo_enterprise', plan_tier: 'enterprise', status: 'active', max_company: 10, max_seat: 250, current_period_end: ahead(210), created_at: T0, updated_at: T0 });
    const C = {};
    COMPANIES.forEach(([name, code, image, description, accent], i) => {
      C[code] = insert('az_company', { id: uuid(), name, code, group_id: group.id, description, image_url: image, accent, created_at: ago(120 - i), updated_at: ago(10) });
    });

    // ---------------- Units (az_workspace) ----------------
    const W = {};
    const UNITS = {
      ZVL: [['Engineering', 'unit'], ['Design Studio', 'unit'], ['DevOps & Cloud', 'unit'], ['Client Services', 'client']],
      OSE: [['Enterprise Solutions', 'unit'], ['Data & AI', 'unit']],
      FGV: [['Global', 'unit'], ['Marketing Tech', 'department']],
      ADD: [['Digital Products', 'unit'], ['E-commerce', 'unit']],
      NCS: [['Cloud Ops', 'unit'], ['Platform', 'unit']],
    };
    for (const [code, units] of Object.entries(UNITS)) {
      units.forEach(([name, type], i) => {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        W[`${code}:${name}`] = insert('az_workspace', { id: uuid(), name, slug, type, invite_code: `${code}-${slug.slice(0, 4).toUpperCase()}${i}`, company_id: C[code].id, description: `${name} — ${C[code].name}`, created_at: ago(110 - i), updated_at: ago(20) });
      });
    }
    const unitMembers = {
      'ZVL:Engineering': { azam: 'admin', fatima: 'admin', mansoor: 'member', usman: 'member', sara: 'member', hina: 'member', zain: 'member', maria: 'member', bilal: 'member', omar: 'member', ayesha: 'member', nate: 'guest' },
      'ZVL:Design Studio': { maria: 'admin', fatima: 'member', zain: 'member', azam: 'member' },
      'ZVL:DevOps & Cloud': { bilal: 'admin', usman: 'member', fatima: 'member', azam: 'member' },
      'ZVL:Client Services': { ayesha: 'admin', omar: 'member', azam: 'member', maria: 'member', sara: 'member' },
      'OSE:Enterprise Solutions': { azam: 'admin', usman: 'member', ayesha: 'member' },
      'OSE:Data & AI': { hina: 'admin', usman: 'member', fatima: 'member' },
      'FGV:Global': { azam: 'admin', zain: 'member', maria: 'member', sara: 'member' },
      'FGV:Marketing Tech': { ayesha: 'admin', omar: 'member' },
      'ADD:Digital Products': { fatima: 'admin', zain: 'member', mansoor: 'member' },
      'ADD:E-commerce': { omar: 'admin', ayesha: 'member', hina: 'member', sara: 'member' },
      'NCS:Cloud Ops': { bilal: 'admin', usman: 'member' },
      'NCS:Platform': { bilal: 'admin', fatima: 'member' },
    };
    for (const [wk, members] of Object.entries(unitMembers)) for (const [un, role] of Object.entries(members)) insert('az_workspace_member', { id: uuid(), role, user_id: U[un].id, workspace_id: W[wk].id, created_at: ago(100) });

    // ---------------- Projects ----------------
    const P = {};
    const PROJECTS = [
      ['ZVL:Engineering', 'AI Business Strategy Advisor', 'Voice-first AI advisor that analyses a business and proposes growth strategies.', 'active', 60, 40],
      ['ZVL:Engineering', 'Zenara Peptides Mobile App', 'Flutter app for Zenara Peptides (client: Nate Paul) — catalogue, ordering, loyalty.', 'active', 45, 50],
      ['ZVL:Engineering', 'Workflow Hub (internal)', 'Our own task management system — Kanban, chat, AI crew and reporting.', 'active', 90, 30],
      ['ZVL:Design Studio', 'Brand & UI Kits', 'Design requests, brand refreshes and component libraries for clients.', 'active', 80, 60],
      ['ZVL:DevOps & Cloud', 'Infrastructure & Incidents', 'CI/CD, monitoring, backups and incident response.', 'active', 100, 365],
      ['ZVL:Client Services', 'WooCommerce Storefronts', 'WordPress/WooCommerce builds and retainers for retail clients.', 'active', 70, 90],
      ['ADD:E-commerce', 'AI Real Estate Portal', 'Property listings with AI valuation and lead scoring.', 'active', 50, 45],
      ['OSE:Data & AI', 'Enterprise Analytics Platform', 'Warehouse, dashboards and forecasting for OmniSphere.', 'planning', 30, 120],
      ['FGV:Global', 'FGV Website Revamp', 'Corporate site redesign on headless CMS.', 'active', 35, 25],
      ['NCS:Cloud Ops', 'Cloud Migration 2026', 'Lift-and-shift of 14 services to managed Kubernetes.', 'on_hold', 60, 80],
    ];
    for (const [wk, title, description, status, started, due] of PROJECTS) {
      P[title] = insert('az_project', { id: uuid(), title, description, workspace_id: W[wk].id, status, start_date: ago(started), end_date: ahead(due), created_by: U.azam.id, created_at: ago(started), updated_at: ago(3) });
    }

    // ---------------- Boards, lists, cards ----------------
    const B = {}; const L = {};
    const channelIds = {};
    function makeBoard(key, { unit, project, title, description, background, lists, members, createdDaysAgo = 60 }) {
      const w = W[unit];
      const t = ago(createdDaysAgo);
      const chId = uuid();
      const chName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)}-log`;
      insert('az_channel', { id: chId, name: chName, type: 'board_log', workspace_id: w.id, company_id: w.company_id, description: `Activity & discussion for board "${title}"`, created_by: U.azam.id, created_at: t, updated_at: t });
      const b = insert('az_board', { id: uuid(), title, description, workspace_id: w.id, project_id: project ? P[project].id : null, log_channel_id: chId, background, created_by: U.azam.id, created_at: t, updated_at: t });
      B[key] = b; channelIds[`log:${key}`] = chId;
      L[key] = lists.map(([name, done], i) => insert('az_list', { id: uuid(), title: name, position: i, board_id: b.id, is_done_list: done ? 1 : 0, created_at: t, updated_at: t }));
      for (const [un, role] of Object.entries(members)) insert('az_board_member', { id: uuid(), board_id: b.id, user_id: U[un].id, role, created_at: t });
      return b;
    }
    const STD = [['To Do'], ['In Progress'], ['Code Review'], ['QA'], ['Done', 1]];
    makeBoard('ai', { unit: 'ZVL:Engineering', project: 'AI Business Strategy Advisor', title: 'AI Board Development', description: 'Azam’s AI initiatives — strategy advisor, real-estate AI, task management.', background: IMG('1535223289827-42f1e9919769', 1920), lists: [['AZAM UNCLE TASKS'], ['PROGRESS 🖌️'], ['ON REVIEW 😵'], ['COMPLETED 👍', 1]], members: { azam: 'admin', fatima: 'admin', maria: 'member', mansoor: 'member', hina: 'member', usman: 'member', sara: 'member', zain: 'member' }, createdDaysAgo: 75 });
    makeBoard('zenara', { unit: 'ZVL:Engineering', project: 'Zenara Peptides Mobile App', title: 'Zenara Mobile App', description: 'Sprint board for the Zenara Peptides Flutter app.', background: IMG('1512941937669-90a1b58e7e9c', 1920), lists: [['Backlog'], ['Sprint To Do'], ['In Progress'], ['Code Review'], ['QA'], ['Released', 1]], members: { mansoor: 'admin', fatima: 'admin', azam: 'member', maria: 'member', usman: 'member', sara: 'member', nate: 'viewer' }, createdDaysAgo: 45 });
    makeBoard('hub', { unit: 'ZVL:Engineering', project: 'Workflow Hub (internal)', title: 'Workflow Hub Product', description: 'Roadmap and delivery of our internal workflow platform.', background: IMG('1498050108023-c5249f4df085', 1920), lists: STD, members: { fatima: 'admin', zain: 'member', usman: 'member', hina: 'member', sara: 'member', bilal: 'member', azam: 'member' }, createdDaysAgo: 90 });
    makeBoard('design', { unit: 'ZVL:Design Studio', project: 'Brand & UI Kits', title: 'Design Requests', description: 'Intake board for design work.', background: IMG('1558655146-9f40138edfeb', 1920), lists: [['Requests'], ['Designing'], ['Client Feedback'], ['Approved', 1]], members: { maria: 'admin', zain: 'member', fatima: 'member', azam: 'viewer' }, createdDaysAgo: 80 });
    makeBoard('ops', { unit: 'ZVL:DevOps & Cloud', project: 'Infrastructure & Incidents', title: 'Ops & Incidents', description: 'CI/CD, monitoring work and incident response (AI crew files incidents here).', background: IMG('1518770660439-4636190af475', 1920), lists: [['Triage'], ['Investigating'], ['Mitigated'], ['Resolved', 1]], members: { bilal: 'admin', usman: 'member', fatima: 'member', azam: 'member' }, createdDaysAgo: 100 });
    makeBoard('woo', { unit: 'ZVL:Client Services', project: 'WooCommerce Storefronts', title: 'WooCommerce Client Sites', description: 'Builds, fixes and retainers for WooCommerce clients.', background: IMG('1460925895917-afdab827c52f', 1920), lists: [['Incoming'], ['Building'], ['Client Review'], ['Live', 1]], members: { omar: 'admin', ayesha: 'admin', maria: 'member', sara: 'member', azam: 'member' }, createdDaysAgo: 70 });
    makeBoard('realestate', { unit: 'ADD:E-commerce', project: 'AI Real Estate Portal', title: 'Real Estate Portal', description: 'AI valuation and listings portal for Apex.', background: IMG('1560518883-ce09059eeffa', 1920), lists: STD, members: { omar: 'admin', hina: 'member', sara: 'member', ayesha: 'member', azam: 'member' }, createdDaysAgo: 50 });
    makeBoard('analytics', { unit: 'OSE:Data & AI', project: 'Enterprise Analytics Platform', title: 'Analytics Platform', description: 'OmniSphere data warehouse & dashboards.', background: IMG('1551288049-bebda4e38f71', 1920), lists: [['Discovery'], ['Building'], ['Validation'], ['Shipped', 1]], members: { hina: 'admin', usman: 'member', fatima: 'member', azam: 'member' }, createdDaysAgo: 30 });
    makeBoard('fgv', { unit: 'FGV:Global', project: 'FGV Website Revamp', title: 'FGV Website Revamp', description: 'Headless CMS corporate website.', background: IMG('1486406146926-c627a4ad1ab0', 1920), lists: STD, members: { zain: 'admin', maria: 'member', sara: 'member', azam: 'member' }, createdDaysAgo: 35 });
    makeBoard('cloud', { unit: 'NCS:Cloud Ops', project: 'Cloud Migration 2026', title: 'Cloud Migration', description: 'Service-by-service migration tracker.', background: IMG('1469474968028-56623f02e42e', 1920), lists: [['Not Started'], ['Migrating'], ['Verifying'], ['Cut Over', 1]], members: { bilal: 'admin', usman: 'member', fatima: 'member' }, createdDaysAgo: 60 });

    const CARD = {};
    const activityRows = [];
    function card(key, boardKey, listIdx, title, opts = {}) {
      const b = B[boardKey]; const list = L[boardKey][listIdx];
      const created = ago(opts.age ?? Math.floor(rnd() * 30 + 1), rnd() * 10);
      const pos = get('SELECT COUNT(*) AS n FROM az_card WHERE list_id = ?', list.id).n;
      const done = !!list.is_done_list;
      const c = insert('az_card', {
        id: uuid(), title, description: opts.desc || null, position: pos, due_date: opts.due != null ? (opts.due >= 0 ? ahead(opts.due) : ago(-opts.due)) : null,
        start_date: created, list_id: list.id, board_id: b.id, project_id: b.project_id, assignee_id: opts.who ? U[opts.who].id : null,
        created_by: U[opts.by || 'azam'].id, priority: opts.pri || 'medium', labels: opts.labels || [], cover_url: opts.cover || null,
        is_template: opts.template ? 1 : 0, estimate_hours: opts.est ?? Math.round(rnd() * 24 + 2),
        completed_at: done ? ago(Math.max(0.2, Math.min((opts.age ?? 10) - 1, rnd() * 16))) : null, archived: 0,
        created_at: created, updated_at: opts.idle != null ? ago(opts.idle) : ago(Math.floor(rnd() * Math.min(opts.age ?? 10, 6))),
      });
      CARD[key || title] = c;
      activityRows.push({ type: 'card.created', actor: opts.by || 'azam', card: c, at: created, details: { title, list: L[boardKey][0].title } });
      if (listIdx > 0) activityRows.push({ type: 'card.moved', actor: opts.who || 'fatima', card: c, at: ago(Math.max(0, (opts.age ?? 5) - 2)), details: { title, from: L[boardKey][Math.max(0, listIdx - 1)].title, to: list.title } });
      for (const [i, st] of (opts.subs || []).entries()) {
        const isDone = typeof st === 'object' ? st[1] : (done || rnd() < 0.35);
        const stTitle = typeof st === 'object' ? st[0] : st;
        insert('az_subtask', { id: uuid(), card_id: c.id, title: stTitle, is_done: isDone ? 1 : 0, assignee_id: opts.who ? U[opts.who].id : null, position: i, created_by: U[opts.by || 'azam'].id, is_ai_generated: opts.aiSubs ? 1 : 0, completed_at: isDone ? ago(1) : null, created_at: created, updated_at: created });
      }
      const reqs = opts.reqs || (rnd() < 0.35 ? [['text', 'Definition of done', `- Meets the brief for “${title}”\n- Reviewed by a teammate\n- Tested on desktop and mobile\n- Client / PM sign-off recorded`]] : []);
      for (const rq of reqs) insert('az_task_requirement', { id: uuid(), card_id: c.id, type: rq[0], title: rq[1], content: rq[0] === 'text' ? rq[2] : rq[3] || null, url: rq[0] === 'text' ? null : rq[2], drive_file_id: rq[0] === 'text' ? null : (rq[2].match(/\/d\/([^/]+)/) || [])[1] || null, mime_type: rq[0] === 'pdf' ? 'application/pdf' : null, created_by: U[opts.by || 'azam'].id, created_at: created, updated_at: created });
      for (let i = 0; i < (opts.atts || 0); i++) {
        const id = fakeDriveId();
        const [nm, ft] = pick([['Requirements.pdf', 'pdf'], ['Wireframes.fig.png', 'image'], ['Sprint-notes.docx', 'doc'], ['Estimates.xlsx', 'sheet'], ['Demo-recording.mp4', 'video'], ['Brand-assets.zip', 'archive'], ['API-contract.pdf', 'pdf'], ['Screenshot.png', 'image']]);
        insert('az_attachment', { id: uuid(), name: nm, url: drive(id), card_id: c.id, file_type: ft, file_size: Math.floor(rnd() * 8e6 + 5e4), uploader_id: U[pick(['azam', 'fatima', 'maria', opts.who || 'usman'])].id, drive_file_id: id, drive_web_view_link: `https://drive.google.com/file/d/${id}/view`, drive_thumbnail_link: `https://drive.google.com/thumbnail?id=${id}&sz=w480`, created_at: created, updated_at: created });
      }
      const commenters = opts.commenters || ['azam', 'fatima', opts.who || 'maria'];
      const lines = opts.comments || [];
      for (let i = 0; i < (opts.nComments ?? lines.length); i++) {
        const who = commenters[i % commenters.length];
        const text = lines[i] || pick(['Looks good 👍', 'Pushed an update, please re-check.', 'Blocked on API keys from the client.', 'Moved estimate to 6h.', 'Added screenshots to the Drive folder.', 'Can we demo this on Thursday?', 'QA notes added under requirements.', 'Merged to develop.', 'Client asked for a darker header.', 'Needs one more review pass.']);
        insert('az_card_comments', { id: uuid(), card_id: c.id, text, sender: U[who].full_name, profile_id: U[who].id, is_pinned: i === 0 && lines.length > 2 ? 1 : 0, created_at: ago(Math.max(0, (opts.age ?? 10) * (1 - (i + 1) / ((opts.nComments ?? lines.length) + 1))), rnd() * 5) });
      }
      return c;
    }

    // --- AI Board Development (mirrors the reference screenshot) ---
    card('aiTemplate', 'ai', 0, 'AI business Strategy', { template: true, pri: 'medium', age: 40, desc: 'Template card — copy it for every new AI strategy engagement.\n- Discovery call with founder\n- Collect financials & KPIs\n- Run advisor analysis\n- Present strategy deck', subs: ['Discovery call with founder', 'Collect financials & KPIs', 'Run advisor analysis', 'Present strategy deck'], idle: 20 });
    card('zenaraCard', 'ai', 0, 'nate paul (mobile app) Zenara Peptides', { who: 'mansoor', pri: 'high', age: 12, due: 9, atts: 1, desc: 'Client brief from Nate Paul. Flutter app for Zenara Peptides — product catalogue, reorder reminders and loyalty points.', comments: ['@mansoor please own the estimate for this.', 'Nate shared the brand guide on Drive.', 'Estimate: 6 sprints incl. store submission.', '@azam awaiting the project brief sign-off from Nate before we start sprint 1.'], commenters: ['azam', 'fatima', 'mansoor', 'mansoor'], reqs: [['text', 'Scope summary', 'Catalogue with 120 SKUs, cart, Stripe checkout, reorder reminders (push), loyalty points, Arabic + English.'], ['pdf', 'Client brief (PDF)', drive(fakeDriveId()), 'Signed brief v2']], labels: [{ text: 'client', color: '#f59e0b' }, { text: 'mobile', color: '#8b5cf6' }] });
    card('taskMgmt', 'ai', 1, 'Task Management system', { who: 'fatima', pri: 'high', age: 26, due: 5, atts: 2, cover: IMG('1551288049-bebda4e38f71', 600), desc: 'Internal Trello-style task manager with Slack-style chat (this app!).', nComments: 4, subs: [['Kanban board with drag & drop', true], ['Channels, threads & mentions', true], ['Report builder', false], ['Offline sync', false], ['AI crew agents', true]], reqs: [['link', 'Reference design (Figma)', 'https://www.figma.com/file/example/workflow-hub'], ['media', 'Walkthrough video', drive(fakeDriveId()), 'Loom export on Drive']], labels: [{ text: 'internal', color: '#0ea5e9' }] });
    card('advisor', 'ai', 2, 'AI Business Strategy Advisor', { who: 'maria', pri: 'urgent', age: 34, due: -2, atts: 6, cover: IMG('1620712943543-bcc4688e7485', 600), desc: 'Voice-first AI advisor: “Talk to your advisor to uncover growth opportunities”. Speech in → analysis → strategy cards out.', nComments: 11, commenters: ['azam', 'maria', 'hina', 'fatima', 'sara'], subs: [['Voice capture & transcription', true], ['Strategy generation prompt chain', true], ['Advisor UI (orb + cards)', true], ['Export to PDF', false], ['Latency under 2 s', false]], reqs: [['text', 'Acceptance criteria', '1. User can speak for up to 60 s.\n2. Advisor returns 3–5 strategy cards.\n3. Each card has impact/effort score.\n4. Works on mobile Safari & Chrome.'], ['pdf', 'Product spec v3', drive(fakeDriveId())], ['media', 'UI mock — dark mode', drive(fakeDriveId())]], labels: [{ text: 'AI', color: '#a855f7' }, { text: 'priority', color: '#ef4444' }] });
    card('aiRealEstate', 'ai', 2, 'AI Real estate', { who: 'hina', pri: 'high', age: 22, due: 3, atts: 1, cover: IMG('1560518883-ce09059eeffa', 600), nComments: 7, commenters: ['hina', 'omar', 'azam'], desc: 'Landing page + valuation model for the real-estate AI product.', subs: ['Valuation model v1', 'Landing page', 'Lead capture', 'CRM webhook'], labels: [{ text: 'AI', color: '#a855f7' }] });

    // --- Zenara Mobile App ---
    const Z = [
      [0, 'Loyalty points ledger', 'usman', 'medium', 18, 20], [0, 'Arabic RTL support', 'mansoor', 'low', 16, 25], [0, 'In-app chat with pharmacist', null, 'low', 14, null],
      [1, 'Reorder reminders (push notifications)', 'mansoor', 'high', 10, 6], [1, 'Stripe checkout integration', 'usman', 'high', 9, 4],
      [2, 'Product catalogue screens', 'mansoor', 'high', 12, 2], [2, 'Auth: email + Apple/Google sign-in', 'mansoor', 'medium', 11, -1],
      [3, 'Cart & order summary', 'mansoor', 'medium', 8, 1], [4, 'Onboarding flow', 'sara', 'medium', 15, -3],
      [5, 'Project setup, flavours & CI', 'mansoor', 'medium', 40, null], [5, 'Design system in Flutter', 'maria', 'medium', 35, null], [5, 'Splash & app icon', 'maria', 'low', 30, null],
    ];
    for (const [li, title, who, pri, age, due] of Z) card(null, 'zenara', li, title, { who, pri, age, due, by: 'mansoor', subs: ['Implement', 'Unit tests', 'QA on Android', 'QA on iOS'], nComments: Math.floor(rnd() * 4), atts: Math.floor(rnd() * 2), labels: [{ text: 'mobile', color: '#8b5cf6' }] });

    // --- Workflow Hub Product ---
    const H = [
      [0, 'Google Drive picker for attachments', 'zain', 'medium', 6, 12], [0, 'Report builder: scheduled email digests', 'usman', 'low', 5, 30], [0, 'Dark/light theme polish', 'zain', 'low', 4, null],
      [1, 'Offline sync conflict resolution', 'usman', 'high', 9, 5], [1, 'Mobile drag & drop for cards', 'zain', 'high', 7, 3],
      [2, 'RBAC permission matrix UI', 'fatima', 'high', 10, 1], [3, 'Audit log CSV export', 'sara', 'medium', 12, -1],
      [4, 'Slack-style threads', 'zain', 'medium', 28, null], [4, 'Global search', 'usman', 'medium', 25, null], [4, 'Pinned chats', 'zain', 'low', 21, null], [4, 'AI crew: planner agent', 'hina', 'high', 19, null], [4, 'SSE real-time events', 'usman', 'high', 30, null],
    ];
    for (const [li, title, who, pri, age, due] of H) card(null, 'hub', li, title, { who, pri, age, due, by: 'fatima', subs: ['Design', 'Build', 'Test'], nComments: Math.floor(rnd() * 3), atts: Math.floor(rnd() * 2), labels: [{ text: 'product', color: '#0ea5e9' }] });

    // --- Design requests ---
    const D = [[0, 'FGV homepage hero illustrations', 'maria', 'medium', 3, 7], [0, 'Zenara loyalty badge icons', 'maria', 'low', 2, 10], [1, 'Advisor orb animation (Lottie)', 'maria', 'high', 8, 2], [1, 'WooCommerce theme mockups — Bloom Florist', 'zain', 'medium', 6, 4], [2, 'Apex real-estate brand refresh', 'maria', 'medium', 16, -4], [3, 'Workflow Hub logo', 'maria', 'low', 40, null], [3, 'OmniSphere pitch deck template', 'maria', 'medium', 25, null]];
    for (const [li, title, who, pri, age, due] of D) card(null, 'design', li, title, { who, pri, age, due, by: 'maria', atts: 1 + Math.floor(rnd() * 3), nComments: Math.floor(rnd() * 3), labels: [{ text: 'design', color: '#ec4899' }] });

    // --- Ops & incidents ---
    card(null, 'ops', 0, 'p95 latency spikes on advisor API', { who: 'bilal', pri: 'high', age: 2, due: 1, by: 'bilal', desc: 'Grafana shows p95 > 800 ms between 14:00–15:00 PKT.', subs: ['Check recent deploys', 'Profile slow endpoints', 'Add caching'], labels: [{ text: 'incident', color: '#ef4444' }] });
    card(null, 'ops', 1, 'Nightly backup job exceeded window', { who: 'bilal', pri: 'medium', age: 4, due: 2, by: 'bilal', subs: ['Inspect logs', 'Move to incremental backups'] });
    card(null, 'ops', 2, 'SSL certificate renewal — staging', { who: 'bilal', pri: 'medium', age: 9, by: 'bilal' });
    card(null, 'ops', 3, 'Disk usage alert on db-01', { who: 'usman', pri: 'high', age: 20, by: 'bilal', subs: [['Rotate logs', true], ['Expand volume', true]] });
    card(null, 'ops', 3, 'Set up uptime monitoring', { who: 'bilal', pri: 'medium', age: 45, by: 'bilal' });
    card(null, 'ops', 0, 'Rotate API keys for Zenara payment gateway', { who: 'usman', pri: 'urgent', age: 1, due: 0, by: 'bilal', labels: [{ text: 'security', color: '#ef4444' }] });

    // --- WooCommerce client sites ---
    const WC = [
      [0, 'Bloom Florist — WooCommerce build', 'omar', 'high', 5, 14, 'New WooCommerce store: 80 products, delivery slots, gift messages.\n- Install Storefront child theme\n- Delivery date plugin\n- Stripe + JazzCash payments\n- Speed optimisation'],
      [0, 'Karachi Kicks — size chart plugin', 'omar', 'low', 3, 20, null], [1, 'Spice Route — multi-currency checkout', 'omar', 'high', 11, 2, null],
      [1, 'Urban Threads — product filters (AJAX)', 'omar', 'medium', 9, 6, null], [2, 'Glow Beauty — checkout speed fixes', 'omar', 'urgent', 13, -2, 'Checkout takes 7 s. Client is losing orders — urgent.'],
      [3, 'Peshawar Crafts — go-live', 'omar', 'medium', 30, null, null], [3, 'Monthly retainer — plugin updates (Aug)', 'omar', 'low', 35, null, null], [3, 'Glow Beauty — abandoned cart emails', 'omar', 'medium', 28, null, null],
    ];
    for (const [li, title, who, pri, age, due, desc] of WC) card(null, 'woo', li, title, { who, pri, age, due, desc, by: 'ayesha', subs: ['Build', 'Client review', 'Go-live checks'], atts: Math.floor(rnd() * 3), nComments: 1 + Math.floor(rnd() * 3), commenters: ['ayesha', 'omar'], labels: [{ text: 'woocommerce', color: '#7c3aed' }] });

    // --- Real estate portal ---
    const RE = [[0, 'Map-based search (Leaflet)', 'omar', 'medium', 6, 10], [0, 'Agent CRM export', null, 'low', 4, null], [1, 'AI valuation API v2', 'hina', 'high', 10, 4], [1, 'Listing detail page', 'omar', 'medium', 8, 3], [2, 'Lead scoring model', 'hina', 'high', 14, -1], [3, 'Image compression pipeline', 'sara', 'low', 12, 2], [4, 'Property data model', 'omar', 'medium', 40, null], [4, 'Scraper for public listings', 'hina', 'medium', 33, null]];
    for (const [li, title, who, pri, age, due] of RE) card(null, 'realestate', li, title, { who, pri, age, due, by: 'omar', subs: ['Spec', 'Build', 'Test'], nComments: Math.floor(rnd() * 3), labels: [{ text: 'AI', color: '#a855f7' }] });

    // --- Analytics / FGV / Cloud ---
    for (const [li, title, who, pri, age, due] of [[0, 'Source system inventory', 'hina', 'medium', 12, 8], [0, 'KPI dictionary workshop', 'hina', 'medium', 9, 5], [1, 'Warehouse schema (dbt)', 'usman', 'high', 15, 10], [1, 'Sales forecasting prototype', 'hina', 'medium', 8, 20], [2, 'Finance dashboard validation', 'fatima', 'medium', 20, -5], [3, 'Kick-off & data access', 'hina', 'low', 29, null]])
      card(null, 'analytics', li, title, { who, pri, age, due, by: 'hina', subs: ['Analyse', 'Build', 'Review'] });
    for (const [li, title, who, pri, age, due] of [[0, 'Careers page', 'zain', 'low', 5, 15], [1, 'Headless CMS models', 'zain', 'high', 10, 3], [1, 'Homepage build', 'zain', 'high', 9, 6], [2, 'Contact form + CRM', 'zain', 'medium', 7, 2], [3, 'Accessibility audit', 'sara', 'medium', 6, 4], [4, 'Sitemap & IA', 'maria', 'medium', 30, null]])
      card(null, 'fgv', li, title, { who, pri, age, due, by: 'zain', subs: ['Build', 'Review'] });
    for (const [li, title, who, pri, age, due] of [[0, 'Billing service', null, 'medium', 30, 40], [0, 'Legacy reporting service', null, 'low', 30, 60], [1, 'Auth service → EKS', 'bilal', 'high', 25, -6], [2, 'Notification service', 'usman', 'medium', 22, 3], [3, 'Static assets → CloudFront', 'bilal', 'low', 50, null], [3, 'Redis → ElastiCache', 'bilal', 'medium', 44, null]])
      card(null, 'cloud', li, title, { who, pri, age, due, by: 'bilal', subs: ['Terraform', 'Migrate data', 'Cut over', 'Decommission'], idle: 18 });

    // ---------------- Channels & chat ----------------
    const CH = {};
    function channel(key, { company, unit, name, type = 'public', description, members = [], by = 'azam', age = 90 }) {
      const c = insert('az_channel', { id: uuid(), name, type, company_id: C[company].id, workspace_id: unit ? W[unit].id : null, description, is_private: type === 'private' || type === 'dm' ? 1 : 0, created_by: U[by].id, created_at: ago(age), updated_at: ago(0) });
      CH[key] = c;
      for (const m of members) insert('az_channel_member', { id: uuid(), channel_id: c.id, user_id: U[m].id, last_read_at: ago(rnd() * 2), created_at: ago(age) });
      return c;
    }
    const zvlAll = ['admin', 'azam', 'fatima', 'maria', 'mansoor', 'usman', 'sara', 'bilal', 'hina', 'omar', 'ayesha', 'zain'];
    channel('general', { company: 'ZVL', unit: 'ZVL:Engineering', name: 'general', description: 'Company-wide announcements & chatter', members: zvlAll });
    channel('engineering', { company: 'ZVL', unit: 'ZVL:Engineering', name: 'engineering', description: 'Engineering discussions, standups and releases', members: ['azam', 'fatima', 'mansoor', 'usman', 'sara', 'hina', 'zain', 'bilal', 'omar'] });
    channel('design', { company: 'ZVL', unit: 'ZVL:Design Studio', name: 'design-crit', description: 'Share work, get feedback', members: ['maria', 'zain', 'fatima', 'azam'] });
    channel('devops', { company: 'ZVL', unit: 'ZVL:DevOps & Cloud', name: 'devops-alerts', description: 'Deploys, pipelines and alert chatter', members: ['bilal', 'usman', 'fatima', 'azam', 'admin'] });
    channel('woo', { company: 'ZVL', unit: 'ZVL:Client Services', name: 'woocommerce', description: 'WooCommerce builds & client requests', members: ['omar', 'ayesha', 'maria', 'sara', 'azam'] });
    channel('zenaraClient', { company: 'ZVL', unit: 'ZVL:Engineering', name: 'zenara-client', type: 'private', description: 'Shared channel with Nate Paul (Zenara Peptides)', members: ['nate', 'mansoor', 'azam', 'fatima', 'maria'] });
    channel('leadership', { company: 'ZVL', unit: null, name: 'leadership', type: 'private', description: 'Management only', members: ['admin', 'azam', 'fatima', 'ayesha'] });
    channel('random', { company: 'ZVL', unit: 'ZVL:Engineering', name: 'random', description: 'Memes, lunch, cricket 🏏', members: zvlAll });
    channel('oseGeneral', { company: 'OSE', unit: 'OSE:Enterprise Solutions', name: 'general', description: 'OmniSphere general', members: ['azam', 'usman', 'ayesha', 'hina'] });
    channel('oseData', { company: 'OSE', unit: 'OSE:Data & AI', name: 'data-ai', description: 'Analytics platform work', members: ['hina', 'usman', 'fatima'] });
    channel('fgvGeneral', { company: 'FGV', unit: 'FGV:Global', name: 'general', description: 'FGV general', members: ['azam', 'zain', 'maria', 'sara'] });
    channel('addGeneral', { company: 'ADD', unit: 'ADD:E-commerce', name: 'general', description: 'Apex general', members: ['omar', 'ayesha', 'hina', 'sara', 'fatima', 'zain', 'mansoor'] });
    channel('ncsGeneral', { company: 'NCS', unit: 'NCS:Cloud Ops', name: 'general', description: 'Nexus general', members: ['bilal', 'usman', 'fatima'] });
    // DMs
    function dm(key, a, b) { return channel(key, { company: 'ZVL', unit: null, name: `dm-${a}-${b}`, type: 'dm', members: [a, b], by: a, age: 60 }); }
    dm('dmFatimaMaria', 'fatima', 'maria'); dm('dmAzamAdmin', 'azam', 'admin'); dm('dmAzamMansoor', 'azam', 'mansoor'); dm('dmAdminBilal', 'admin', 'bilal');

    const MSG = {};
    function msg(chKey, who, content, { h, key, parent, react = [], card: cardKey, type = 'text', ai = false, meta = null } = {}) {
      const ch = CH[chKey] || { id: channelIds[chKey] };
      const t = ago(0, h);
      const m = insert('az_message', { id: uuid(), content, type, user_id: who ? U[who].id : null, channel_id: ch.id, card_id: cardKey ? CARD[cardKey]?.id : null, parent_message_id: parent ? MSG[parent].id : null, deleted: 0, is_ai_generated: ai ? 1 : 0, metadata: meta, created_at: t, updated_at: t });
      if (key) MSG[key] = m;
      for (const mm of content.matchAll(/@([a-z0-9._-]+)/gi)) {
        const target = U[mm[1].toLowerCase()];
        if (target) insert('az_mention', { id: uuid(), message_id: m.id, mentioned_user_id: target.id, is_ai: 0, has_image_crop: 0, created_at: t });
        else if (/^(ai|assistant)$/i.test(mm[1])) insert('az_mention', { id: uuid(), message_id: m.id, mentioned_user_id: null, is_ai: 1, has_image_crop: 0, created_at: t });
      }
      for (const [emoji, users] of react) for (const u of users) insert('az_reaction', { id: uuid(), emoji, message_id: m.id, user_id: U[u].id });
      return m;
    }
    // #general
    msg('general', 'azam', 'Assalam o Alaikum team! 🎉 Welcome to Workflow Hub — all boards, chats and reports now live in one place.', { h: 24 * 9, react: [['🎉', ['fatima', 'maria', 'zain', 'omar']], ['❤️', ['sara', 'hina']]] });
    msg('general', 'ayesha', 'Reminder: timesheets are due Friday 5 pm. Please log hours on your cards (estimate field).', { h: 24 * 6 });
    msg('general', 'fatima', 'Office will be closed on Monday for maintenance — remote day for everyone 🏠', { h: 24 * 3, react: [['👍', ['usman', 'bilal', 'mansoor']]] });
    msg('general', 'azam', '@channel Q3 all-hands tomorrow at 4 pm in the main room. Each unit lead: 5 slides max.', { h: 20, key: 'allhands', react: [['✅', ['fatima', 'ayesha', 'bilal', 'maria']]] });
    msg('general', 'hina', 'Can we get pizza this time? 🍕', { h: 19, parent: 'allhands' });
    msg('general', 'azam', 'Deal 😄', { h: 18.5, parent: 'allhands' });
    // #engineering
    msg('engineering', 'fatima', 'Standup notes: advisor latency work continues, Zenara sprint 1 starts once brief is signed.', { h: 26 });
    msg('engineering', 'mansoor', '@azam awaiting the project brief for Zenara Peptides — Nate sent the Figma link yesterday, can you confirm scope so we can start sprint 1?', { h: 22, key: 'awaitAzam', card: 'zenaraCard', react: [['👀', ['fatima']]] });
    msg('engineering', 'fatima', 'Following — @azam this is blocking two devs.', { h: 21, parent: 'awaitAzam' });
    msg('engineering', 'hina', 'Advisor model eval on the new rubric: 87% → 91% after prompt chain v3 🎯', { h: 14, react: [['🔥', ['azam', 'fatima', 'usman', 'zain']], ['🚀', ['maria']]] });
    msg('engineering', 'usman', 'Heads-up: I’m deploying advisor API to staging in 10 min. @bilal pipeline is green on my side.', { h: 6, key: 'deploy' });
    msg('engineering', 'bilal', 'Staging deploy ✅ health checks passing. Prod rollout tomorrow 11 am.', { h: 5.5, parent: 'deploy', react: [['🙌', ['usman', 'fatima']]] });
    msg('engineering', 'zain', 'PR for mobile drag & drop is up — would love eyes on the long-press handling @sara', { h: 3 });
    msg('engineering', 'sara', 'On it after lunch. Will test on Android + iPhone 12.', { h: 2.5 });
    msg('engineering', 'azam', '@mansoor brief is approved — go ahead with sprint 1 🚀 @fatima please move the card.', { h: 1.2, react: [['🙏', ['mansoor']]] });
    msg('engineering', null, '**Summary of the last 12 messages in #engineering**\n• Participants: Fatima Latif, Mansoor Ali, Hina Raza, Usman Tariq, Bilal Hussain, Zain Malik, Sara Qureshi, Azam Khan\n• Decisions: Zenara sprint 1 approved; advisor API on staging, prod tomorrow 11 am\n• Action items:\n   – Sara: test mobile drag & drop on Android + iOS\n   – Fatima: move the Zenara card to PROGRESS', { h: 1, type: 'ai', ai: true, meta: { agent: 'Echo' } });
    // #design-crit
    msg('design', 'maria', 'New advisor orb animation — thoughts? Link in the Drive folder.', { h: 30, react: [['😍', ['zain', 'fatima']]] });
    msg('design', 'zain', 'Love it. Can we slow the pulse a bit on idle?', { h: 29 });
    msg('design', 'maria', 'Apex brand refresh is waiting on client feedback since last week 😬 @ayesha can you nudge them?', { h: 50 });
    // #devops-alerts
    msg('devops', 'bilal', 'Prod deploy of advisor API failed on health check — rolled back automatically. Investigating.', { h: 8, key: 'prodfail', react: [['👀', ['usman', 'fatima']]] });
    msg('devops', 'usman', 'Looks like a missing env var (REDIS_URL). Fixing in the manifest.', { h: 7.5, parent: 'prodfail' });
    msg('devops', null, '🔥 **Blaze** opened incident “Deploy AI Advisor API → production failed” (critical) → @bilal', { h: 7.9, type: 'system' });
    // #woocommerce
    msg('woo', 'ayesha', 'Glow Beauty called again — checkout is still slow on mobile. @omar can we prioritise today?', { h: 28 });
    msg('woo', 'omar', 'Yes — culprit is a heavy reviews plugin + no object cache. Enabling Redis cache and lazy-loading reviews.', { h: 27 });
    msg('woo', 'omar', 'Checkout down from 7 s → 2.1 s on staging 🎉', { h: 4, react: [['🎉', ['ayesha', 'sara', 'azam']]] });
    msg('woo', 'sara', 'Tested on Samsung A14 — smooth. One issue: coupon field overlaps on small screens.', { h: 3 });
    // #zenara-client
    msg('zenaraClient', 'nate', 'Hi team, attached the brand guide and product list. When can we see first screens?', { h: 48 });
    msg('zenaraClient', 'mansoor', 'Thanks Nate! First catalogue screens by next Wednesday. @maria is finalising the design system.', { h: 47 });
    msg('zenaraClient', 'maria', 'Sharing the colour palette for approval 🎨', { h: 30 });
    msg('zenaraClient', 'nate', 'Looks great. Please use the darker teal for CTAs.', { h: 12 });
    // #leadership
    msg('leadership', 'azam', 'Q3 revenue on track. Zenara contract signed for 6 sprints.', { h: 40 });
    msg('leadership', 'ayesha', 'Two new WooCommerce leads this week (Bloom Florist, Karachi Kicks).', { h: 30 });
    msg('leadership', 'admin', 'Reminder: I’ve granted board access for the FGV team. Ping me for any access changes.', { h: 10 });
    // #random
    msg('random', 'usman', 'Who’s up for cricket on Saturday? 🏏', { h: 16, react: [['🙋', ['bilal', 'zain', 'omar', 'mansoor']]] });
    msg('random', 'maria', 'Biryani Friday again? 😋', { h: 5, react: [['😋', ['hina', 'sara', 'ayesha']]] });
    // other companies
    msg('oseGeneral', 'azam', 'OmniSphere kickoff went well — data access expected next week.', { h: 70 });
    msg('oseData', 'hina', 'Source inventory draft is on the board. @usman can you validate the ERP tables?', { h: 20 });
    msg('fgvGeneral', 'zain', 'Homepage build is 60% done. Sharing preview link tomorrow.', { h: 15 });
    msg('addGeneral', 'omar', 'Real-estate valuation API v2 in progress — @hina the lead scoring needs a review.', { h: 25 });
    msg('ncsGeneral', 'bilal', 'Auth service migration is overdue; waiting on security review.', { h: 60 });
    // DMs
    msg('dmFatimaMaria', 'fatima', 'Can you share the advisor UI mock in dark mode?', { h: 9 });
    msg('dmFatimaMaria', 'maria', 'Uploaded to the card attachments 👍', { h: 8.5 });
    msg('dmAzamAdmin', 'azam', 'Please give Nate viewer access to the Zenara board only.', { h: 50 });
    msg('dmAzamAdmin', 'admin', 'Done ✅ He’s a guest with viewer role on Zenara Mobile App.', { h: 49 });
    msg('dmAzamMansoor', 'mansoor', 'Salam Azam bhai, any update on the brief?', { h: 23 });
    msg('dmAdminBilal', 'bilal', 'Can you enable auto-incident on the prod deploy pipeline?', { h: 70 });
    msg('dmAdminBilal', 'admin', 'Enabled. Blaze will file incidents on Ops & Incidents.', { h: 69 });
    // board log channels
    msg('log:ai', 'fatima', '✅ **Fatima Latif** moved “AI Business Strategy Advisor” from *PROGRESS 🖌️* to *ON REVIEW 😵*', { h: 30, type: 'system', card: 'advisor' });
    msg('log:ai', 'maria', 'Advisor review build is ready — please test the voice flow on mobile.', { h: 12, card: 'advisor' });
    msg('log:ai', 'sara', 'Found an issue: orb doesn’t stop listening after 60 s on Safari. Logged under requirements.', { h: 6, card: 'advisor' });
    msg('log:ai', 'azam', '@hina can we get the real-estate valuation demo for Thursday?', { h: 4, card: 'aiRealEstate' });
    msg('log:zenara', 'mansoor', 'Catalogue screens merged to develop. Build 0.3.1 on TestFlight.', { h: 18 });
    msg('log:ops', null, '💥 Pipeline **Deploy AI Advisor API → production** failed (4.1s) — Step "Health check" failed on prod-api.zynexvision.dev (exit code 1)', { h: 8, type: 'system' });

    // ---------------- Pinned chats (8 for admin, like the reference header) ----------------
    const pinsFor = (un, items) => items.forEach(([chKey, msgKey], i) => insert('az_pinned_item', { id: uuid(), user_id: U[un].id, channel_id: msgKey ? null : (CH[chKey]?.id || channelIds[chKey]), message_id: msgKey ? MSG[msgKey].id : null, created_at: ago(0, i + 1) }));
    pinsFor('admin', [['general'], ['engineering'], ['leadership'], ['devops'], ['woo'], ['dmAzamAdmin'], [null, 'allhands'], [null, 'prodfail']]);
    pinsFor('azam', [['engineering'], ['zenaraClient'], ['leadership'], [null, 'awaitAzam']]);
    pinsFor('fatima', [['engineering'], ['dmFatimaMaria'], ['log:ai'], [null, 'deploy']]);

    // ---------------- Pipelines, runs, alerts, metrics ----------------
    const PL = {};
    const pipe = (key, o) => { PL[key] = insert('az_pipeline', { id: uuid(), status: o.status || 'success', last_run_at: ago(0, rnd() * 20), created_at: ago(90), ...o, company_id: C[o.company].id, company: undefined }); };
    pipe('advStaging', { name: 'Deploy AI Advisor API → staging', type: 'deploy', company: 'ZVL', board_id: B.ai.id, target: 'staging-api.zynexvision.dev', schedule: 'on push to develop', config: { fail_rate: 0.1 } });
    pipe('advProd', { name: 'Deploy AI Advisor API → production', type: 'deploy', company: 'ZVL', board_id: B.ops.id, target: 'prod-api.zynexvision.dev', schedule: 'manual approval', config: { fail_rate: 0.3, auto_incident: true }, status: 'failed' });
    pipe('zenaraBuild', { name: 'Zenara app build (Android + iOS)', type: 'deploy', company: 'ZVL', board_id: B.zenara.id, target: 'Play Console internal track / TestFlight', schedule: 'nightly', config: { fail_rate: 0.15 } });
    pipe('wooDeploy', { name: 'WooCommerce sites → production (rsync)', type: 'deploy', company: 'ZVL', board_id: B.woo.id, target: 'prod — cPanel cluster', schedule: 'manual', config: { fail_rate: 0.1 } });
    pipe('memMon', { name: 'Monitor: host memory', type: 'monitor', company: 'ZVL', board_id: B.ops.id, target: 'api-gateway', schedule: 'continuous', config: { metric: 'mem_used_pct', threshold: 95, severity: 'warning', auto_resolve: true } });
    pipe('lagMon', { name: 'Monitor: event-loop lag', type: 'monitor', company: 'ZVL', board_id: B.ops.id, target: 'api-gateway', schedule: 'continuous', config: { metric: 'event_loop_ms', threshold: 250, severity: 'critical', auto_resolve: true } });
    pipe('dbMon', { name: 'Monitor: SQLite database size', type: 'monitor', company: 'ZVL', board_id: B.ops.id, target: 'workflow.db', schedule: 'hourly', config: { metric: 'db_size_kb', threshold: 512000, severity: 'warning' } });
    pipe('backup', { name: 'Nightly SQLite backup', type: 'backup', company: 'ZVL', board_id: B.ops.id, target: 'data/workflow.db.bak', schedule: '02:00 daily', config: { fail_rate: 0.05 } });
    pipe('terraform', { name: 'Cloud migration — terraform apply', type: 'deploy', company: 'NCS', board_id: B.cloud.id, target: 'eks-prod-eu', schedule: 'manual', config: { fail_rate: 0.25 } });
    pipe('fgvDeploy', { name: 'FGV website → Vercel', type: 'deploy', company: 'FGV', board_id: B.fgv.id, target: 'fgv-global.vercel.app', schedule: 'on push to main', config: { fail_rate: 0.1 } });
    for (const p of Object.values(PL)) {
      const n = p.type === 'monitor' ? 6 : 10 + Math.floor(rnd() * 10);
      const failRate = (typeof p.config === 'string' ? JSON.parse(p.config) : p.config || {}).fail_rate ?? 0.1;
      for (let i = 0; i < n; i++) {
        const st = ago(rnd() * 30);
        const ok = rnd() > failRate;
        const dur = Math.floor(2000 + rnd() * 5000);
        insert('az_pipeline_run', { id: uuid(), pipeline_id: p.id, status: ok ? 'success' : 'failed', triggered_by: pick([U.bilal.id, U.usman.id, 'scheduler']), started_at: st, finished_at: new Date(new Date(st).getTime() + dur).toISOString(), duration_ms: dur, logs: ok ? '▶ Checkout source…\n✓ done\n▶ Build artefacts…\n✓ done\n▶ Deploy to target…\n✓ done\nPipeline finished successfully' : '▶ Checkout source…\n✓ done\n▶ Health check…\n✗ Step "Health check" failed (exit code 1)' });
      }
    }
    const alert = (o) => insert('az_alert', { id: uuid(), status: 'open', ...o });
    alert({ pipeline_id: PL.advProd.id, company_id: C.ZVL.id, severity: 'critical', source: PL.advProd.name, title: 'Deploy AI Advisor API → production failed', message: 'Step "Health check" failed on prod-api.zynexvision.dev (exit code 1)', status: 'acknowledged', acknowledged_by: U.bilal.id, card_id: null, created_at: ago(0, 8) });
    alert({ pipeline_id: PL.lagMon.id, company_id: C.ZVL.id, severity: 'warning', source: 'api-gateway', title: 'p95 latency above 800 ms on advisor API', message: 'p95 = 912 ms for 10 min', status: 'open', created_at: ago(0, 3) });
    alert({ pipeline_id: PL.zenaraBuild.id, company_id: C.ZVL.id, severity: 'warning', source: PL.zenaraBuild.name, title: 'iOS build signing certificate expires in 7 days', message: 'Renew the Apple distribution certificate.', status: 'open', created_at: ago(1) });
    alert({ pipeline_id: PL.terraform.id, company_id: C.NCS.id, severity: 'critical', source: PL.terraform.name, title: 'terraform apply failed — IAM policy conflict', message: 'Error: EntityAlreadyExists', status: 'open', created_at: ago(2) });
    for (let i = 0; i < 9; i++) {
      const created = ago(3 + rnd() * 25);
      alert({ pipeline_id: pick([PL.memMon.id, PL.backup.id, PL.advStaging.id, PL.wooDeploy.id]), company_id: C.ZVL.id, severity: pick(['info', 'warning', 'warning', 'critical']), source: 'scheduler', title: pick(['Backup exceeded window', 'Staging deploy failed', 'Memory above threshold', 'WooCommerce rsync timeout', 'Disk usage 85% on db-01']), message: 'Auto-resolved after mitigation.', status: 'resolved', acknowledged_by: U.bilal.id, resolved_at: new Date(new Date(created).getTime() + (0.3 + rnd() * 6) * 36e5).toISOString(), created_at: created });
    }
    // resource metrics are real samples collected by the scheduler (none seeded)

    // ---------------- AI crew ----------------
    const AG = {};
    for (const [role, name, avatar, goal] of [
      ['planner', 'Atlas', '🧭', 'Break every task into concrete, verb-first subtasks so work can start immediately.'],
      ['triage', 'Sentinel', '🛡️', 'Set priority, pick the best-fit assignee by skill and workload, and propose a due date.'],
      ['qa', 'Quill', '✒️', 'Write Given/When/Then acceptance criteria and attach them as task requirements.'],
      ['incident', 'Blaze', '🔥', 'Turn failing pipelines and alerts into incident tasks with a runbook, and page the right people.'],
      ['scribe', 'Echo', '📝', 'Summarise channels into decisions, open questions and action items.'],
    ]) AG[role] = insert('az_ai_agent', { id: uuid(), name, role, avatar, goal, backstory: `${name} is part of the Zynex AI crew.`, is_active: 1, created_at: ago(60) });
    const aiRun = (role, cardKey, output, h) => insert('az_ai_run', { id: uuid(), agent_id: AG[role].id, card_id: cardKey ? CARD[cardKey].id : null, triggered_by: U.fatima.id, input: cardKey ? CARD[cardKey].title : null, output, engine: 'heuristic', status: 'success', created_at: ago(0, h), finished_at: ago(0, h - 0.01) });
    aiRun('planner', 'taskMgmt', 'Created 5 subtasks for “Task Management system”.', 70);
    aiRun('triage', 'zenaraCard', 'Priority → high · Assignee → Mansoor Ali (@mansoor, Mobile Developer (Flutter), 3 open tasks)', 40);
    aiRun('qa', 'advisor', 'Added acceptance criteria as a text requirement.', 30);
    aiRun('incident', null, 'Filed incident task on “Ops & Incidents”', 8);
    aiRun('scribe', null, 'Summary of the last 12 messages in #engineering', 1);

    // ---------------- Saved reports ----------------
    const rep = (name, description, config) => insert('az_report', { id: uuid(), name, description, config, is_shared: 1, created_by: U.azam.id, created_at: ago(20), updated_at: ago(2) });
    rep('Open tasks by assignee', 'Workload balance across the team', { source: 'tasks', dimension: 'assignee', metrics: ['open', 'overdue'], chart: 'bar', filters: {} });
    rep('Weekly throughput', 'Created vs completed per week', { source: 'tasks', dimension: 'created_week', metrics: ['count', 'completed'], chart: 'line', filters: {} });
    rep('Aging work-in-progress', 'How long open tasks have been waiting', { source: 'tasks', dimension: 'age', metrics: ['open'], chart: 'bar', filters: {} });
    rep('Tasks by priority (ZVL)', 'Zynex Vision priority mix', { source: 'tasks', dimension: 'priority', metrics: ['count'], chart: 'pie', filters: { company_id: C.ZVL.id } });
    rep('Chat activity by channel', 'Where conversations happen', { source: 'messages', dimension: 'channel', metrics: ['count', 'threads'], chart: 'bar', filters: {} });
    rep('Alert MTTR by source', 'Mean time to resolve alerts', { source: 'alerts', dimension: 'source', metrics: ['count', 'mttr_hours'], chart: 'table', filters: {} });

    // ---------------- Notifications ----------------
    const note = (un, type, title, body, link, actor, h, read = 0) => insert('az_notification', { id: uuid(), user_id: U[un].id, type, title, body, link, actor_id: actor ? U[actor].id : null, is_read: read, created_at: ago(0, h) });
    note('azam', 'mention', 'Mansoor Ali mentioned you in #engineering', '@azam awaiting the project brief for Zenara Peptides…', `/chat/${CH.engineering.id}?m=${MSG.awaitAzam.id}`, 'mansoor', 22);
    note('azam', 'mention', 'Fatima Latif replied in a thread in #engineering', 'Following — @azam this is blocking two devs.', `/chat/${CH.engineering.id}?m=${MSG.awaitAzam.id}`, 'fatima', 21);
    note('admin', 'alert', '🚨 Deploy AI Advisor API → production failed', 'Step "Health check" failed on prod-api.zynexvision.dev', '/ops', null, 8);
    note('admin', 'alert', '🚨 terraform apply failed — IAM policy conflict', 'Error: EntityAlreadyExists', '/ops', null, 48);
    note('admin', 'access', 'Azam Khan requested board access for Nate Paul', 'Zenara Mobile App — viewer', `/admin`, 'azam', 50, 1);
    note('maria', 'assign', 'Azam Khan assigned you “AI Business Strategy Advisor”', 'AI Board Development › ON REVIEW 😵', `/board/${B.ai.id}?card=${CARD.advisor.id}`, 'azam', 60);
    note('mansoor', 'mention', 'Azam Khan mentioned you in #engineering', '@mansoor brief is approved — go ahead with sprint 1 🚀', `/chat/${CH.engineering.id}`, 'azam', 1.2);
    note('sara', 'mention', 'Zain Malik mentioned you in #engineering', 'PR for mobile drag & drop is up…', `/chat/${CH.engineering.id}`, 'zain', 3);

    // ---------------- Activity log (audit trail) ----------------
    // the audit trail is append-only: resolve unit/company at insert time (no later UPDATE)
    const scopeOf = (boardId) => get('SELECT b.workspace_id, w.company_id FROM az_board b JOIN az_workspace w ON w.id = b.workspace_id WHERE b.id = ?', boardId) || {};
    for (const a of activityRows) insert('az_activity_log', { id: uuid(), board_id: a.card.board_id, workspace_id: scopeOf(a.card.board_id).workspace_id || null, company_id: scopeOf(a.card.board_id).company_id || null, actor_id: U[a.actor].id, type: a.type, entity_type: 'card', entity_id: a.card.id, details: a.details, ip: '10.0.0.' + Math.floor(rnd() * 200 + 10), created_at: a.at });
    for (let i = 0; i < 40; i++) {
      const un = pick(USERS)[0];
      insert('az_activity_log', { id: uuid(), actor_id: U[un].id, type: 'auth.login', entity_type: 'user', entity_id: U[un].id, details: null, ip: '10.0.0.' + Math.floor(rnd() * 200 + 10), created_at: ago(rnd() * 30) });
    }
    insert('az_activity_log', { id: uuid(), actor_id: U.admin.id, type: 'board.access_granted', entity_type: 'board', entity_id: B.zenara.id, board_id: B.zenara.id, workspace_id: scopeOf(B.zenara.id).workspace_id, company_id: scopeOf(B.zenara.id).company_id, details: { userId: U.nate.id, role: 'viewer' }, created_at: ago(2) });
    insert('az_activity_log', { id: uuid(), actor_id: U.admin.id, type: 'admin.user_created', entity_type: 'user', entity_id: U.nate.id, details: { username: 'nate', role: 'guest' }, created_at: ago(2, 1) });

    // ---------------- A little version history (real trigger-written versions) ----------------
    const change = (table, id, patch, by, note) => {
      const keys = Object.keys(patch);
      run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, changed_by = ?, change_note = ?, change_id = ? WHERE id = ?`, ...keys.map((k) => patch[k]), U[by].id, note, `seed.${++seq}`, id);
    };
    const adv = CARD.advisor; const advLists = L.ai;
    change('az_card', adv.id, { priority: 'high', assignee_id: U.usman.id, list_id: advLists[1].id }, 'fatima', 'Backend hand-off for the voice pipeline');
    change('az_card', adv.id, { due_date: ahead(6), estimate_hours: 60 }, 'fatima', 'Re-planned after sprint review');
    change('az_card', adv.id, { priority: adv.priority, assignee_id: adv.assignee_id, list_id: adv.list_id }, 'azam', 'Client moved the investor demo forward — design review before release');
    change('az_company', C.ZVL.id, { description: 'Flagship software house — AI, mobile, web & cloud' }, 'admin', 'Service catalogue now includes cloud');
    const advisorProject = get('SELECT id FROM az_project WHERE title = ?', 'AI Business Strategy Advisor');
    if (advisorProject) change('az_project', advisorProject.id, { end_date: ahead(45) }, 'azam', 'Scope extended with the voice module');
  });
  const counts = Object.fromEntries(['users', 'az_company', 'az_workspace', 'az_project', 'az_board', 'az_card', 'az_subtask', 'az_task_requirement', 'az_attachment', 'az_message', 'az_pipeline', 'az_alert'].map((t) => [t, get(`SELECT COUNT(*) AS n FROM ${t}`).n]));
  if (!quiet) {
    console.log('• Seed complete:', counts);
    console.log('  Sign in as  admin / admin123  (super admin)  or  azam, fatima, maria, mansoor … / password123');
  }
}
