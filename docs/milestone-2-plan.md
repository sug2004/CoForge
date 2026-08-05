# Milestone 2 — Auth + Workspaces: Plan & Approach

## Status: 🔲 IN PROGRESS

---

## Goal
GitHub OAuth end-to-end, JWT issuance and validation, Workspace/Project/Session CRUD with Postgres via Prisma, and JWT-gated WebSocket connections on sync-server.

After this milestone:
- Users can sign in with GitHub
- Users can create workspaces, add members, create projects and sessions
- sync-server rejects WebSocket connections without a valid JWT
- The editor at `/session/:id` requires auth — no more anonymous access

---

## 1. What We Are Building

```
Browser                        core-api :3002              sync-server :3001
   |                               |                              |
   |-- GET /auth/github ---------->|                              |
   |<- redirect to GitHub OAuth ---|                              |
   |                               |                              |
   |-- GitHub callback ----------->|                              |
   |   ?code=&state=               |-- upsert User (Postgres) --->|
   |                               |-- issue JWT ---------------->|
   |<- { accessToken, user } ------|                              |
   |                               |                              |
   |-- POST /workspaces ---------->|                              |
   |   Bearer: <JWT>               |-- INSERT Workspace --------->|
   |<- Workspace ------------------|                              |
   |                               |                              |
   |-- POST /projects/:id/sessions>|                              |
   |<- Session + joinToken --------|                              |
   |                               |                              |
   |-- WS connect ws://..?token=<JWT>                             |
   |                               |-- verify JWT --------------->|
   |                               |-- check WorkspaceMember ---->|
   |<-------------------------------- room joined / rejected ------|
```

---

## 2. Services Involved

| Service | Role | Port |
|---|---|---|
| `apps/core-api` | NestJS + Prisma — auth, CRUD, JWT | 3002 |
| `apps/sync-server` | JWT verification on WS handshake | 3001 |
| `apps/web` | Login page, auth state, protected routes | 3000 |
| PostgreSQL | Persistent storage via Prisma ORM | 5432 |

---

## 3. Tech Choices & Why

| Choice | Reason |
|---|---|
| `@nestjs/passport` + `passport-github2` | Standard NestJS OAuth strategy, minimal boilerplate |
| `@nestjs/jwt` | JWT sign/verify integrated with NestJS guards |
| Prisma ORM | Type-safe DB client, migration tooling, schema-first |
| PostgreSQL | Relational — workspaces/members/projects/sessions have clear FK relationships |
| `cookie-parser` + httpOnly cookie | Safer JWT storage than localStorage — XSS resistant |
| `jsonwebtoken` in sync-server | Lightweight verify-only, no full Passport needed |
| Next.js middleware | Protect `/session/*` and `/dashboard/*` routes server-side |

---

## 4. Data Model (Prisma Schema)

```prisma
model User {
  id          String   @id @default(uuid())
  githubId    String   @unique
  username    String
  email       String?
  avatarUrl   String?
  createdAt   DateTime @default(now())
  memberships WorkspaceMember[]
}

model Workspace {
  id        String   @id @default(uuid())
  name      String
  ownerId   String
  createdAt DateTime @default(now())
  members   WorkspaceMember[]
  projects  Project[]
}

model WorkspaceMember {
  id          String    @id @default(uuid())
  workspaceId String
  userId      String
  role        Role      @default(EDITOR)
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  user        User      @relation(fields: [userId], references: [id])
  @@unique([workspaceId, userId])
}

enum Role {
  OWNER
  EDITOR
  VIEWER
}

model Project {
  id            String    @id @default(uuid())
  workspaceId   String
  name          String
  repoUrl       String?
  defaultBranch String    @default("main")
  createdAt     DateTime  @default(now())
  workspace     Workspace @relation(fields: [workspaceId], references: [id])
  sessions      Session[]
}

model Session {
  id        String    @id @default(uuid())
  projectId String
  createdBy String
  startedAt DateTime  @default(now())
  endedAt   DateTime?
  ydocState Bytes?
  project   Project   @relation(fields: [projectId], references: [id])
  events    SessionEvent[]
}

model SessionEvent {
  id        String   @id @default(uuid())
  sessionId String
  type      String
  actorId   String
  payload   Json
  createdAt DateTime @default(now())
  session   Session  @relation(fields: [sessionId], references: [id])
}
```

---

## 5. REST API Endpoints (core-api)

### Auth
```
GET  /auth/github              → redirect to GitHub OAuth
GET  /auth/github/callback     → exchange code, upsert user, set JWT cookie → redirect to /dashboard
GET  /auth/logout              → clear cookie
GET  /me                       → User  (requires JWT)
```

### Workspaces
```
POST   /workspaces                        { name } → Workspace
GET    /workspaces                        → Workspace[]  (member of)
POST   /workspaces/:id/members            { userId, role } → WorkspaceMember
DELETE /workspaces/:id/members/:userId    → 204
```

### Projects
```
POST  /workspaces/:id/projects   { name, repoUrl? } → Project
GET   /projects/:id              → Project
```

### Sessions
```
POST  /projects/:id/sessions     → Session  (creates DB row, returns joinToken)
GET   /sessions/:id              → Session
GET   /sessions/:id/events       ?since=<iso> → SessionEvent[]
```

JWT passed as:
- `Authorization: Bearer <token>` on core-api REST calls
- `?token=<token>` query param on sync-server WebSocket connection URL

---

## 6. Auth Flow (detailed)

```
1. Browser → GET /auth/github
   core-api generates GitHub OAuth URL with state param (CSRF protection)
   redirects browser to GitHub

2. GitHub → GET /auth/github/callback?code=&state=
   core-api verifies state
   exchanges code for GitHub access token
   fetches GitHub user profile (id, login, email, avatar_url)
   upserts User row (githubId as unique key)
   signs JWT: { sub: userId, username, iat, exp: +7d }
   sets httpOnly cookie: token=<JWT>; Path=/; SameSite=Lax
   redirects to /dashboard

3. All subsequent core-api requests
   NestJS JwtAuthGuard reads cookie (or Authorization header)
   verifies signature with JWT_SECRET
   attaches user to request

4. sync-server WebSocket handshake
   client passes token as query param: ws://localhost:3001/<sessionId>?token=<JWT>
   sync-server reads token from req.url query string
   verifies JWT with same JWT_SECRET
   queries core-api GET /sessions/:id to confirm user is WorkspaceMember
   if invalid → ws.close(4001, 'Unauthorized')
   if valid → proceed with room join
```

---

## 7. JWT Validation in sync-server

sync-server does NOT use Passport or NestJS guards — it's a raw ws.Server.
Validation happens inside `handleConnection` before room join:

```
ws connect with ?token=<JWT>
  → parse token from URL
  → jsonwebtoken.verify(token, JWT_SECRET)
  → if invalid → ws.close(4001) + return
  → attach decoded { userId, username } to connection context
  → proceed with Yjs sync protocol
```

WorkspaceMember check deferred to when session lookup is available (core-api must be running).
For MVP: JWT validity alone gates the connection.

---

## 8. Web — Auth UI

### Pages / Routes

```
app/
  page.tsx                    # redirects to /dashboard if authed, else /login
  login/
    page.tsx                  # "Sign in with GitHub" button → GET /auth/github
  dashboard/
    page.tsx                  # workspace list, create workspace
    layout.tsx                # protected layout — redirects to /login if no token
  session/[id]/
    page.tsx                  # protected — requires valid session membership
```

### Auth State
- JWT stored in httpOnly cookie (set by core-api)
- Next.js middleware reads cookie to protect `/dashboard/*` and `/session/*`
- `GET /me` called on app load to hydrate user context

---

## 9. Folder Structure (new files)

```
CoForge/
  apps/
    core-api/
      src/
        main.ts                        # bootstrap on port 3002
        app.module.ts
        auth/
          auth.module.ts
          auth.controller.ts           # /auth/github, /auth/github/callback, /auth/logout
          auth.service.ts              # upsert user, sign JWT
          github.strategy.ts           # passport-github2 strategy
          jwt.strategy.ts              # passport-jwt strategy
          jwt-auth.guard.ts            # NestJS guard for protected routes
        users/
          users.module.ts
          users.service.ts             # findById, upsertFromGithub
        workspaces/
          workspaces.module.ts
          workspaces.controller.ts     # CRUD endpoints
          workspaces.service.ts
        projects/
          projects.module.ts
          projects.controller.ts
          projects.service.ts
        sessions/
          sessions.module.ts
          sessions.controller.ts
          sessions.service.ts
        prisma/
          prisma.module.ts
          prisma.service.ts            # PrismaClient singleton
          schema.prisma                # full data model
      .env                             # DATABASE_URL, GITHUB_*, JWT_SECRET
      package.json

    sync-server/
      src/
        main.ts                        # + JWT verify on WS connect

    web/
      app/
        login/page.tsx                 # GitHub OAuth entry point
        dashboard/
          layout.tsx                   # auth guard
          page.tsx                     # workspace list
      middleware.ts                    # Next.js middleware — protect routes
      lib/
        auth.ts                        # getUser(), isAuthed() helpers
```

---

## 10. Build Order

```
[ ] Step 1  — scaffold core-api (NestJS via nest new)
[ ] Step 2  — install deps (Prisma, Passport, JWT, passport-github2)
[ ] Step 3  — write Prisma schema + run first migration
[ ] Step 4  — PrismaService singleton
[ ] Step 5  — GitHub OAuth strategy + auth controller + auth service
[ ] Step 6  — JwtAuthGuard + JWT strategy
[ ] Step 7  — UsersService (upsertFromGithub, findById)
[ ] Step 8  — WorkspacesController + WorkspacesService (CRUD)
[ ] Step 9  — ProjectsController + ProjectsService (CRUD)
[ ] Step 10 — SessionsController + SessionsService (CRUD + joinToken)
[ ] Step 11 — JWT verify in sync-server WS handshake
[ ] Step 12 — web: login page + dashboard layout + middleware
[ ] Step 13 — wire /me endpoint + user context in web
[ ] Step 14 — protect /session/:id route
```

---

## 11. Environment Variables

```bash
# core-api
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/coforge
GITHUB_CLIENT_ID=<from GitHub OAuth App>
GITHUB_CLIENT_SECRET=<from GitHub OAuth App>
GITHUB_CALLBACK_URL=http://localhost:3002/auth/github/callback
JWT_SECRET=supersecretchangeme
FRONTEND_URL=http://localhost:3000

# sync-server
JWT_SECRET=supersecretchangeme   # must match core-api
CORE_API_URL=http://localhost:3002
```

---

## 12. Prerequisites Before Starting

- [ ] PostgreSQL running locally (or Docker: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`)
- [ ] GitHub OAuth App created at https://github.com/settings/developers
  - Homepage URL: `http://localhost:3000`
  - Callback URL: `http://localhost:3002/auth/github/callback`
- [ ] `.env` file in `apps/core-api/` with all vars filled

---

## 13. Acceptance Criteria

| Test | Expected Result |
|---|---|
| GET /auth/github | Redirects to GitHub OAuth page |
| Complete GitHub OAuth | Redirected to /dashboard, JWT cookie set |
| GET /me with valid cookie | Returns `{ id, username, email, avatarUrl }` |
| GET /me without cookie | 401 Unauthorized |
| POST /workspaces | Creates workspace, returns it |
| POST /workspaces/:id/projects | Creates project under workspace |
| POST /projects/:id/sessions | Creates session, returns joinToken |
| WS connect with valid JWT | Room joined, editor loads |
| WS connect without JWT | Connection closed with 4001 |
| WS connect with expired JWT | Connection closed with 4001 |
| /dashboard without auth | Redirected to /login |
| /session/:id without auth | Redirected to /login |

---

## 14. Out of Scope (deferred)

- Refresh tokens — single 7-day JWT for MVP
- WorkspaceMember role enforcement beyond OWNER/EDITOR/VIEWER check — Milestone 4
- Session invite links / join by URL — post-MVP
- Presence UI (cursors, avatars) — deferred, awareness protocol already in place from M1
- `SessionEvent` logging — schema ready, writes added in Milestone 4
