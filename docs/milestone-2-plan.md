# Milestone 2 — Auth + Workspaces: Plan & Approach

## Status: 🟡 MOSTLY COMPLETE

Auth, JWT, and Workspace/Project/Session CRUD are **implemented and working**. The original goal also included JWT-gated WebSocket connections on sync-server — **that part is NOT implemented** (see §7) and is deferred to Milestone 3.

---

## Goal

GitHub OAuth end-to-end, JWT issuance and validation, Workspace/Project/Session CRUD with Postgres via Prisma, and JWT-gated WebSocket connections on sync-server.

**As built:**

- Users can sign in with **GitHub OAuth** or **email/password** (added beyond original plan)
- Users can create workspaces, add members, create projects and sessions
- Users can share a session link — joining auto-adds them to the workspace as EDITOR and records them as a participant
- Users can clone a Git repo into the session editor
- core-api routes are JWT-guarded (httpOnly cookie or Bearer token)
- The editor at `/session/:id` is route-protected by Next.js middleware
- ❌ **NOT built:** sync-server does NOT yet verify JWTs — any client can open a WebSocket by room name

---

## 1. What We Built

```
Browser                        core-api :3002              sync-server :3001
   |                               |                              |
   |-- GET /auth/github ---------->|                              |
   |<- redirect to GitHub OAuth ---|                              |
   |                               |                              |
   |-- GitHub callback ----------->|                              |
   |   ?code=&state=               |-- upsert User (Postgres) --->|
   |                               |-- issue JWT (httpOnly) ----->|
   |<- redirect /dashboard --------|                              |
   |                               |                              |
   |-- POST /auth/register ------->|  (email/password + bcrypt)   |
   |   or POST /auth/login ------->|-- issue JWT (httpOnly) ----->|
   |                               |                              |
   |-- POST /workspaces ---------->|                              |
   |   (cookie: token=<JWT>)       |-- INSERT Workspace --------->|
   |<- Workspace ------------------|                              |
   |                               |                              |
   |-- POST /projects/:id/sessions>|                              |
   |<- Session --------------------|                              |
   |                               |                              |
   |-- POST /sessions/:id/join --->|-- auto-add WS member + ----->|
   |                               |   upsert SessionParticipant  |
   |                               |                              |
   |-- WS connect ws://localhost:3001/<sessionId>                  |
   |<-------------------------------- NO JWT CHECK (deferred M3) --|
```

### Auth flows (as built)

1. **GitHub OAuth** — `GET /auth/github` → GitHub authorize → `GET /auth/github/callback` → upsert/link User → JWT set as httpOnly cookie → redirect `/dashboard`
2. **Email/password** — `POST /auth/register` (bcrypt hash) / `POST /auth/login` (bcrypt compare) → JWT cookie
3. **Account linking** — `GET /auth/github/link` requires an existing session (JwtAuthGuard) and links GitHub to the logged-in user
4. **Logout** — `GET /auth/logout` clears the cookie

### Session join flow (as built)

- `POST /sessions/:id/join` — any authenticated user can join by link
- Auto-adds the user to the workspace as `EDITOR` if they aren't a member (invite-link flow)
- Upserts a `SessionParticipant` row (`@@unique([sessionId, userId])`)
- Returns the full session with creator + participants

### Git clone flow (as built)

- `POST /sessions/:id/clone` — `simple-git` shallow-clones `project.repoUrl` into `os.tmpdir()/coforge-<sessionId>`
- Reuses an existing clone if present
- Flattens files to `{ relPath: content }` with ignores (`.git`, `node_modules`, `.next`, `dist`, `build`, `__pycache__`, `.DS_Store`), caps at 500KB/file and 200 files, skips binary
- Browser writes the result into the session `Y.Doc` `files` map (see `Editor.tsx handleClone`)

---

## 2. Services Involved

| Service | Role | Port |
|---|---|---|
| `apps/core-api` | NestJS + Prisma — auth, CRUD, JWT, session join, git clone | 3002 |
| `apps/sync-server` | Yjs relay — **no auth yet** | 3001 |
| `apps/web` | Login page, auth state, protected routes, dashboard, editor | 3000 |
| PostgreSQL | Persistent storage via Prisma ORM | 5432 |

---

## 3. Tech Choices & Why (as built)

| Choice | Reason |
|---|---|
| `@nestjs/passport` + `passport-github2` | Standard NestJS OAuth strategy, minimal boilerplate |
| `@nestjs/jwt` | JWT sign/verify integrated with NestJS guards |
| Email/password with `bcrypt` | Added beyond plan — allows sign-up without GitHub |
| Prisma v7 + `@prisma/adapter-pg` | Driver-adapter setup; generated client in `generated/prisma` (new generator syntax) |
| PostgreSQL | Relational — workspaces/members/projects/sessions have clear FK relationships |
| `cookie-parser` + httpOnly cookie | Safer JWT storage than localStorage — XSS resistant |
| `simple-git` | Git clone for the "Load Git" editor feature |
| Next.js middleware | Protect `/session/*` and `/dashboard/*` routes server-side |

---

## 4. Data Model (Prisma Schema — as built)

```prisma
enum Role {
  OWNER
  EDITOR
  VIEWER
}

model User {
  id        String  @id @default(uuid())
  githubId  String? @unique
  username  String
  email     String? @unique
  password  String?                    // bcrypt hash — email/password auth (added)
  avatarUrl String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  memberships     WorkspaceMember[]
  ownedWorkspaces Workspace[]          @relation("WorkspaceOwner")
  sessions        Session[]            @relation("SessionCreator")
  participations  SessionParticipant[]
  events          SessionEvent[]       @relation("EventActor")
}

model Workspace {
  id   String @id @default(uuid())
  name String
  ownerId String
  owner   User   @relation("WorkspaceOwner", fields: [ownerId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  members  WorkspaceMember[]
  projects Project[]
}

model WorkspaceMember {
  id String @id @default(uuid())
  workspaceId String
  userId      String
  role Role @default(EDITOR)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  joinedAt DateTime @default(now())
  @@unique([workspaceId, userId])
}

model Project {
  id String @id @default(uuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name          String
  repoUrl       String?
  defaultBranch String  @default("main")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  sessions Session[]
}

model Session {
  id String @id @default(uuid())
  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  createdBy String
  creator   User   @relation("SessionCreator", fields: [createdBy], references: [id])
  startedAt DateTime  @default(now())
  endedAt   DateTime?
  ydocState    Bytes?
  events       SessionEvent[]
  participants SessionParticipant[]    // added
}

model SessionParticipant {             // added
  id        String   @id @default(uuid())
  sessionId String
  userId    String
  joinedAt  DateTime @default(now())
  session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([sessionId, userId])
}

model SessionEvent {
  id String @id @default(uuid())
  sessionId String
  session   Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  actorId String
  actor   User   @relation("EventActor", fields: [actorId], references: [id])
  type    String
  payload Json
  createdAt DateTime @default(now())
}
```

Deviations from the original plan:
- `password String?` added for email/password auth
- `SessionParticipant` model added (invite-link join tracking)
- `updatedAt` fields and `onDelete: Cascade` relations added
- `Workspace.owner` is now an explicit relation (was a plain `ownerId` column)

---

## 5. REST API Endpoints (core-api — as built)

All routes below are behind `JwtAuthGuard` **except** register/login/logout/github flow.

### Auth
```
POST /auth/register             { username, email, password } → sets JWT cookie, { user }
POST /auth/login                { email, password }           → sets JWT cookie, { user }
GET  /auth/github               → redirect to GitHub OAuth
GET  /auth/github/callback      → exchange code, upsert/link user, set JWT cookie → redirect /dashboard
GET  /auth/github/link          (JWT required) → redirect to GitHub OAuth
GET  /auth/github/link/callback (JWT required) → link GitHub account to logged-in user
GET  /auth/logout               → clear cookie → redirect /login
GET  /me                        → User (requires JWT)
```

### Workspaces
```
POST   /workspaces                      { name } → Workspace (creator added as OWNER member)
GET    /workspaces                      → Workspace[] (member of, includes members + projects)
DELETE /workspaces/:id                  → 204 (owner only)
POST   /workspaces/:id/members          { userId, role: EDITOR|VIEWER } → WorkspaceMember (owner only)
DELETE /workspaces/:id/members/:userId  → 204 (owner only)
```

### Projects
```
POST  /workspaces/:id/projects   { name, repoUrl? } → Project (any member)
GET   /projects/:id              → Project (includes sessions → creator + participants)
DELETE /projects/:id             → 204 (OWNER or EDITOR)
```

### Sessions
```
POST  /projects/:id/sessions     → Session (member only)
GET   /sessions/:id              → Session (includes creator + participants)
POST  /sessions/:id/join         → Session (auto-adds workspace member EDITOR + SessionParticipant)
DELETE /sessions/:id             → 204 (any member)
POST  /sessions/:id/clone        → { files: Record<relPath, content> } (member only, git clone)
GET   /sessions/:id/events       ?since=<iso> → SessionEvent[]
```

JWT is read from:
- httpOnly `token` cookie (primary — `ExtractJwt.fromExtractors`)
- `Authorization: Bearer <token>` (fallback)

Note: the original plan had `POST /projects/:id/sessions` return a `joinToken`. As built, `create()` returns a plain `Session` — join is a separate public endpoint (`POST /sessions/:id/join`).

---

## 6. sync-server — JWT Gate: ⚠️ NOT IMPLEMENTED (deferred to M3)

This was a core part of the milestone goal and **has not been built**.

`apps/sync-server/src/main.ts`:
- Creates a raw `ws.Server` attached to the NestJS HTTP server
- Uses the URL path as the room name: `roomName = (req.url ?? '/').slice(1) || 'default'`
- Runs the Yjs sync protocol (step1/step2/update + awareness broadcast)
- **No JWT verification, no user identity, no WorkspaceMember check**

`apps/web/lib/ydoc.ts` connects anonymously:
```ts
const provider = new WebsocketProvider('ws://localhost:3001', sessionId, ydoc);
```

**Original plan (not done):**
```
ws connect with ?token=<JWT>
  → jsonwebtoken.verify(token, JWT_SECRET)
  → if invalid → ws.close(4001) + return
  → attach decoded { userId, username } to connection context
  → proceed with Yjs sync protocol
```

**Why deferred:** the app currently relies on Next.js middleware + JwtAuthGuard for access control, and the sync channel itself carries no sensitive data yet. Gating WS joins (JWT verify + membership check via core-api) belongs with Milestone 3, when sandbox execution makes the session channel security-relevant.

**Dead code note:** `apps/sync-server/src/sync/sync.gateway.ts` (a Socket.io gateway) exists from the original spike but is **not registered** — `sync/sync.module.ts` is `@Module({})`. It is unused and should be removed or repurposed for agent events in Milestone 4.

---

## 7. Web — Auth UI & Dashboard (as built)

```
app/
  page.tsx                     # redirects → /dashboard if authed (cookie exists), else /login
  layout.tsx                   # global layout + CSS variables (dark theme)
  login/
    page.tsx                   # "Continue with GitHub" + email/password tabs
  middleware.ts                # protects /dashboard/* and /session/* (cookie presence only)
  dashboard/
    page.tsx                   # overview: stats, workspaces table (CRUD), quick actions, mock right panel
    workspaces/page.tsx        # workspace cards (CRUD)
    projects/page.tsx          # project cards (CRUD), workspace filter, repo URL input
    sessions/page.tsx          # session list (all/live/past filter), join/delete
    [workspaceId]/page.tsx     # workspace detail (projects grid)
    [workspaceId]/[projectId]/page.tsx  # project detail — live/past sessions, start/join/delete
  session/[id]/
    page.tsx                   # server component → EditorWrapper
```

- Auth state: JWT lives in the httpOnly `token` cookie set by core-api
- Middleware checks only **cookie presence** — it does not validate the JWT signature
- `GET /me` hydrates user context (via `lib/auth.ts` / `lib/api.ts`, `credentials: 'include'`)
- `AppShell.tsx` renders sidebar + topbar; `editorMode` hides the topbar for `/session/*`
- The editor (`Editor.tsx`) calls `POST /sessions/:id/join` on mount, shows participants from DB + awareness, and supports "Load Git" (clone into Y.Doc)

Note: `dashboard/page.tsx` still contains **hardcoded mock data** (Online Collaborators, Recent Commits, Upcoming Tasks) — to be replaced with real data in a later milestone.

---

## 8. Folder Structure (as built)

```
CoForge/
  apps/
    core-api/
      src/
        main.ts                        # bootstrap on 3002, cookie-parser, CORS (credentials)
        app.module.ts                  # ConfigModule(global), Prisma, Auth, Workspaces, Projects, Sessions
        auth/
          auth.module.ts               # PassportModule + JwtModule.registerAsync (7d expiry)
          auth.controller.ts           # /auth/register|login|github|github/callback|github/link|logout, /me
          auth.service.ts              # bcrypt hash/compare, sign JWT, validateGithubUser, linkGithub
          github/github.strategy.ts    # passport-github2 (scope: user:email)
          github/github-auth.guard.ts
          jwt/jwt.strategy.ts          # cookie first, Bearer fallback
          jwt/jwt-auth.guard.ts
        workspaces/                    # controller + service (owner checks)
        projects/                      # controller + service (membership checks)
        sessions/                      # controller + service (create/join/clone/events/delete)
        prisma/
          prisma.module.ts             # @Global() provider
          prisma.service.ts            # PrismaClient + @prisma/adapter-pg
      prisma/
        schema.prisma                  # data model (prisma-client generator → generated/prisma)
        migrations/                    # 3 migrations (init, password+github optional, session participants)
      .env                             # DATABASE_URL, GITHUB_*, JWT_SECRET, FRONTEND_URL
      package.json

    sync-server/
      src/
        main.ts                        # raw ws.Server + Yjs sync protocol — NO JWT check yet
        sync/
          sync.module.ts               # EMPTY — Socket.io gateway NOT registered (dead code)
          sync.gateway.ts              # unused Socket.io gateway from M1 spike
      package.json

    web/
      middleware.ts                    # route protection (cookie presence)
      lib/
        auth.ts                        # getUser(cookie)
        api.ts                         # typed fetch client (credentials: include)
        ydoc.ts                        # WebsocketProvider → ws://localhost:3001 (no auth param)
      components/
        AppShell.tsx                   # sidebar + topbar shell
        EditorWrapper.tsx              # dynamic Editor, ssr:false
        Editor.tsx                     # Monaco + Yjs binding, file tree, awareness, join, clone
      app/
        page.tsx / login / dashboard/… / session/[id]/
      .env.local                       # NEXT_PUBLIC_CORE_API_URL
```

---

## 9. Build Order — Results

```
[x] Step 1  — scaffold core-api (NestJS)
[x] Step 2  — install deps (Prisma, Passport, JWT, passport-github2, bcrypt, simple-git)
[x] Step 3  — Prisma schema + migrations (init → password/github optional → participants)
[x] Step 4  — PrismaService singleton (@Global, adapter-pg)
[x] Step 5  — GitHub OAuth strategy + auth controller + auth service
[x] Step 6  — JwtAuthGuard + JWT strategy (cookie + Bearer)
[x] Step 7  — WorkspacesController + WorkspacesService (CRUD + owner checks)
[x] Step 8  — ProjectsController + ProjectsService (CRUD + membership checks)
[x] Step 9  — SessionsController + SessionsService (create/findOne/join/clone/events/delete)
[ ] Step 10 — JWT verify in sync-server WS handshake  ← NOT DONE, deferred to M3
[x] Step 11 — web: login page (GitHub + email/password) + middleware + protected routes
[x] Step 12 — /me endpoint + user context in web
[x] Step 13 — protect /session/:id route (middleware)
[x] Step 14 — dashboard: workspaces, projects, sessions, project detail pages
```

---

## 10. Environment Variables

```bash
# core-api (.env in apps/core-api/)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coforge
GITHUB_CLIENT_ID=<from GitHub OAuth App>
GITHUB_CLIENT_SECRET=<from GitHub OAuth App>
GITHUB_CALLBACK_URL=http://localhost:3002/auth/github/callback
JWT_SECRET=supersecretchangeme
FRONTEND_URL=http://localhost:3000

# web (.env.local in apps/web/)
NEXT_PUBLIC_CORE_API_URL=http://localhost:3002
```

Note: `sync-server` still has no env requirement — JWT_SECRET/CORE_API_URL are **not used yet** (no auth). They become required in Milestone 3 when WS auth lands.

---

## 11. Acceptance Criteria — Results

| Test | Expected Result | Actual |
|---|---|---|
| GET /auth/github | Redirects to GitHub OAuth | ✅ |
| Complete GitHub OAuth | Redirected to /dashboard, JWT cookie set | ✅ |
| POST /auth/register | Creates user (bcrypt), sets JWT cookie | ✅ (added) |
| POST /auth/login | Verifies password, sets JWT cookie | ✅ (added) |
| GET /me with valid cookie | Returns `{ id, username, email, avatarUrl }` | ✅ |
| GET /me without cookie | 401 Unauthorized | ✅ |
| POST /workspaces | Creates workspace + OWNER member | ✅ |
| POST /workspaces/:id/members | Adds member (owner only) | ✅ |
| POST /workspaces/:id/projects | Creates project under workspace | ✅ |
| POST /projects/:id/sessions | Creates session | ✅ |
| POST /sessions/:id/join | Auto-adds member + participant, returns session | ✅ (added) |
| POST /sessions/:id/clone | Returns flattened repo files | ✅ (added) |
| WS connect with valid JWT | Room joined, editor loads | ⚠️ connects WITHOUT any auth |
| WS connect without JWT | Connection closed with 4001 | ❌ — accepted |
| WS connect with expired JWT | Connection closed with 4001 | ❌ — accepted |
| /dashboard without auth | Redirected to /login | ✅ (middleware) |
| /session/:id without auth | Redirected to /login | ✅ (middleware) |

---

## 12. Deviations from Original Plan (summary)

| Original plan | As built |
|---|---|
| GitHub OAuth only | + email/password (bcrypt), account linking |
| `joinToken` returned from session create | Plain session + separate `POST /sessions/:id/join` |
| Workspace/Project/Session CRUD (create/list) | + delete, member add/remove, session clone, events |
| Standard Prisma client | Prisma v7 + `@prisma/adapter-pg`, generated client |
| No `SessionParticipant` | Added (invite-link join tracking) |
| sync-server verifies JWT on WS connect | ❌ **Not implemented** — deferred to M3 |
| `ws://…/sessionId?token=<JWT>` | `ws://…/sessionId` — no token |

---

## 13. Out of Scope (deferred)

- **sync-server JWT gate** (verify + WorkspaceMember check) — Milestone 3, when session channel becomes security-relevant
- Refresh tokens — single 7-day JWT for MVP
- `SessionEvent` writes — schema ready, writes added in Milestone 4 (agent events)
- Presence cursors/avatars UI — awareness protocol already in place from M1
- Replace dashboard mock data (collaborators/commits/tasks) with real data
- Remove dead `sync.gateway.ts` / repurpose for Milestone 4 agent events
- `y-redis` multi-instance sync-server scaling — post-MVP
