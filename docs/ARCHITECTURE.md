# Workflow Hub — architecture & flows

## Service communication
```mermaid
flowchart TB
  subgraph Clients
    W[React + Vite PWA<br/>desktop & mobile]:::c
    F[Field teams<br/>offline outbox]:::c
    A[Admins]:::c
  end
  W -- REST /api + JWT --> G
  F -- replay with X-Op-Id --> G
  A -- SSE locally / poll /api/events on Vercel --> G
  G[server/app.js<br/>local: server/index.js · Vercel: api/index.js]:::g
  G --> AU[Auth] & OR[Org] & BO[Boards] & TA[Tasks] & CH[Chat] & SE[Search] & RE[Reports] & AI[AI crew] & OP[Ops] & AD[Admin]
  AU & OR & BO & TA & CH & SE & RE & AI & OP & AD --> DB[(SQLite locally<br/>PostgreSQL on Vercel)]:::d
  BO & TA & CH & OP & AI --> RT[Real-time hub<br/>SSE fan-out]
  RT -. events .-> W
  OP --> SCH[Scheduler<br/>30s timer locally · Vercel Cron]
  AI -. optional .-> CL[Claude API]
  TA -. links only .-> GD[Google Drive]
  classDef c fill:#1e3a8a,color:#fff; classDef g fill:#4c1d95,color:#fff; classDef d fill:#065f46,color:#fff;
```

## Organisation hierarchy
```mermaid
flowchart LR
  Group --> Company --> Unit["Unit (az_workspace)"] --> Project --> Board --> List --> Task["Task (az_card)"]
  Task --> Subtask & Requirement["Requirement<br/>text/pdf/media/link"] & Attachment["Attachment<br/>Drive link"] & Comment
  Board --- LogChannel["Board chat channel"]
  User -- "az_board_member (admin/member/viewer)" --> Board
  User -- "az_workspace_member" --> Unit
  User -- "profiles.role → az_role → az_permission" --> Permissions
```

## Moving a task (request + real-time)
```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Gateway
  participant S as Boards service
  participant D as SQLite
  participant R as Realtime hub
  participant O as Other clients
  B->>B: optimistic reorder
  B->>G: POST /api/cards/:id/move (JWT, X-Op-Id)
  G->>G: verify JWT, load role perms, check op id
  G->>S: handler(ctx)
  S->>S: assertBoard(user, 'edit')
  S->>D: BEGIN · reindex lists · completed_at · COMMIT
  S->>D: az_activity_log + system message in board channel
  S->>R: board:changed → board audience
  R-->>O: SSE event
  O->>G: GET /api/boards/:id (refetch)
```

## Offline sync
```mermaid
sequenceDiagram
  participant U as User (no signal)
  participant C as App (cache + outbox)
  participant G as Gateway
  U->>C: create task / move / comment
  C->>C: client UUID, optimistic UI, outbox.push({opId})
  Note over C: navigator.onLine → true (or every 15s)
  loop in order
    C->>G: replay request with X-Op-Id
    G->>G: az_sync_op seen? → {duplicate:true}
    G-->>C: 200 / error (shown to user)
  end
```

## AI crew
```mermaid
flowchart LR
  T[Task] --> S1[Sentinel · triage<br/>priority, assignee by skill+load, due] --> S2[Atlas · plan<br/>subtasks] --> S3[Quill · QA<br/>acceptance criteria]
  P[Pipeline failure] --> AL[Alert → admins notified] --> BZ[Blaze · incident task + runbook]
  CHN[Channel] -- "@ai summarize" --> EC[Echo · summary]
  S1 & S2 & S3 & BZ & EC --> LOG[(az_ai_run + audit)]
```

## Local vs Vercel
```mermaid
flowchart LR
  subgraph Local["Your machine"]
    V[Vite :5173] -- /api proxy --> N[server/index.js :4000]
    N --> APP1[server/app.js]
    APP1 --> SQ[(data/workflow.db)]
    N -- SSE --> V
  end
  subgraph Vercel
    CDN[dist/ on CDN] -. /api/* rewrite .-> F[api/index.js]
    F --> APP2[server/app.js]
    APP2 --> PG[(Postgres · DATABASE_URL)]
    APP2 --> EV[(az_event)]
    CDN -. poll /api/events .-> F
    CR[Vercel Cron] --> C[api/cron/ops.js]
    H[api/health.js]
  end
  SQ -- npm run db:push --> PG
  PG -- npm run db:pull --> SQ
```

## Enterprise data model: versioning, no-delete, MDM

Every business table is registered in `server/db/versioning.js`. Triggers generated from that registry, on PostgreSQL and SQLite, enforce these rules:

- Every insert or business change appends a version to `az_version`, recording the snapshot, the changed fields, who made the change, why, and the pinned versions of any referenced master data.
- `DELETE` is refused. Records are retired instead (`is_active = 0`).
- Business keys and document numbers are immutable.
- New references to retired data are refused.
- `az_version` and `az_activity_log` are append-only.

```mermaid
flowchart LR
  UI[Record page<br/>VersionPanel] -->|PATCH + base_version + change_note| APP[server/app.js<br/>withChange ctx]
  APP --> SVC[services + lib/mdm.js<br/>retire · reactivate · purge]
  SVC -->|UPDATE stamped| BASE[(base table<br/>= current version)]
  BASE -->|trigger| VER[(az_version<br/>append-only)]
  VER -->|history · as-of · pins| UI
  ENV[lib/environment.js] -.guards.-> DB[(Neon main = prod<br/>Neon development)]
```

See [MDM_VERSIONING.md](MDM_VERSIONING.md) for the full design: all 14 points, including Neon branches and the table of every replaced UPDATE/DELETE.
