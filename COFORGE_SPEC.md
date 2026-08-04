# CoForge — Technical Specification

Real-time collaborative code editor with an MCP-connected AI agent as a session participant. This document is the build spec — schemas, contracts, and task breakdown — intended to be handed to a coding agent for implementation.

---

## 1. System Overview

Five services:

1. **web** — Next.js client. Editor (Monaco), Yjs client, presence UI, agent activity panel.
2. **sync-server** — NestJS + `y-websocket`/Socket.io. Owns Yjs document state per room, broadcasts CRDT updates and agent events.
3. **core-api** — NestJS. Auth, workspaces, projects, sessions, permissions, git operations. Postgres via Prisma.
4. **agent-service** — Hosts the MCP server + tool implementations. Receives invocation requests from sync-server, calls the Anthropic API with tool definitions, streams tool_use/tool_result events back.
5. **sandbox-runner** — Spins up ephemeral Docker containers per session for code execution, enforces resource/time limits, streams stdout/stderr back to agent-service.

Shared infra: PostgreSQL (core-api), Redis (BullMQ jobs + Socket.io adapter for multi-instance scaling), Qdrant or pgvector (Phase 3, codebase embeddings).

```
apps/
  web/              # Next.js
  sync-server/       # NestJS + Yjs
  core-api/          # NestJS + Prisma
  agent-service/     # Node MCP server
  sandbox-runner/    # Docker orchestration service
packages/
  shared-types/      # Zod schemas / TS types shared across apps
  ui/                 # Shared React components
```

---

## 2. Data Model (Prisma / PostgreSQL — core-api)

```prisma
model User {
  id            String   @id @default(uuid())
  githubId      String   @unique
  username      String
  email         String?
  avatarUrl     String?
  createdAt     DateTime @default(now())
  memberships   WorkspaceMember[]
}

model Workspace {
  id          String   @id @default(uuid())
  name        String
  ownerId     String
  createdAt   DateTime @default(now())
  members     WorkspaceMember[]
  projects    Project[]
}

model WorkspaceMember {
  id          String   @id @default(uuid())
  workspaceId String
  userId      String
  role        Role     @default(EDITOR)
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
  id            String   @id @default(uuid())
  workspaceId   String
  name          String
  repoUrl       String?
  defaultBranch String   @default("main")
  createdAt     DateTime @default(now())
  workspace     Workspace @relation(fields: [workspaceId], references: [id])
  sessions      Session[]
}

model Session {
  id          String   @id @default(uuid())
  projectId   String
  createdBy   String
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  ydocState   Bytes?    // periodic snapshot of Yjs doc (binary update)
  project     Project   @relation(fields: [projectId], references: [id])
  events      SessionEvent[]
}

model SessionEvent {
  id          String   @id @default(uuid())
  sessionId   String
  type        String   // "edit" | "join" | "leave" | "agent_tool_call" | "agent_tool_result" | "git_commit"
  actorId     String   // userId or "agent"
  payload     Json
  createdAt   DateTime @default(now())
  session     Session  @relation(fields: [sessionId], references: [id])
}
```

`SessionEvent` is the append-only log used for both the live activity feed and Phase-4 session replay.

---

## 3. Core API — REST Endpoints (core-api, NestJS)

```
POST   /auth/github/callback          -> { accessToken, user }
GET    /me                            -> User

POST   /workspaces                    -> Workspace
GET    /workspaces                    -> Workspace[]
POST   /workspaces/:id/members        { userId, role } -> WorkspaceMember
DELETE /workspaces/:id/members/:userId

POST   /workspaces/:id/projects       { name, repoUrl } -> Project
GET    /projects/:id                  -> Project

POST   /projects/:id/sessions         -> Session   (creates room, returns join token)
GET    /sessions/:id                  -> Session
GET    /sessions/:id/events           ?since=<ts> -> SessionEvent[]

GET    /projects/:id/git/diff         ?base=&head= -> { diff: string }
POST   /projects/:id/git/commit       { message, files } -> { sha }
POST   /projects/:id/git/pr           { title, body, base, head } -> { url }
```

Auth: JWT in `Authorization: Bearer`, issued after GitHub OAuth callback. `sync-server` validates the same JWT on WebSocket connection (passed as a query param or in the initial handshake payload).

---

## 4. Realtime Sync — WebSocket Contract (sync-server)

Transport: Socket.io namespace per session, room = `session:<sessionId>`.

### Client → Server events

```ts
"doc:update"      { sessionId: string, update: Uint8Array }        // Yjs binary update
"presence:update" { sessionId: string, cursor: {file, line, col}, selection?: Range }
"agent:invoke"    { sessionId: string, prompt: string, contextFileIds?: string[] }
"sandbox:run"     { sessionId: string, command: string, entrypointFile: string }
```

### Server → Client events

```ts
"doc:update"       { update: Uint8Array }                          // relay to all other clients
"presence:sync"    { userId, cursor, selection, color }[]
"agent:tool_started" { toolCallId, toolName, args }
"agent:tool_result"  { toolCallId, toolName, result, isError }
"agent:message"      { text }                                       // agent's natural-language reply
"agent:edit_proposed" { fileId, diff, toolCallId }                  // MVP: proposal, not auto-applied
"sandbox:output"     { stream: "stdout"|"stderr", chunk: string }
"sandbox:exit"       { exitCode: number }
"session:participant_joined" { userId, username }
"session:participant_left"   { userId }
```

CRDT sync itself should use the standard `y-websocket` sync protocol (sync step 1/2 + awareness) rather than hand-rolling `doc:update` if using the `y-websocket` provider directly — listed above as the logical contract if implementing the relay manually inside NestJS instead of using `y-websocket`'s server.

---

## 5. CRDT Document Structure (Yjs)

One `Y.Doc` per session. Structure:

```ts
ydoc.getMap('files')        // Y.Map<string, Y.Text>  — fileId -> file content
ydoc.getMap('fileMeta')     // Y.Map<string, {name, language, path}>
ydoc.getArray('openFiles')  // Y.Array<string> — ordered tab list
```

Agent-authored edits: applied via `Y.Text.applyDelta` inside a `ydoc.transact(fn, origin)` call with `origin = { actor: 'agent', toolCallId }`. Clients read `transaction.origin` to render agent edits with a distinct highlight (e.g., amber background, fading after N seconds) versus human edits (per-user color from presence awareness).

Awareness (presence/cursors): use Yjs's built-in `Awareness` protocol, not a custom presence system — avoids a second consistency mechanism.

---

## 6. MCP Agent Service

The agent-service hosts an MCP server exposing tools, and separately acts as an MCP **client** calling the Anthropic API with those tool definitions.

### 6.1 Tool Definitions (JSON Schema, passed to the model)

```json
[
  {
    "name": "run_tests",
    "description": "Run the project's test suite inside the session sandbox and return results.",
    "input_schema": {
      "type": "object",
      "properties": {
        "testPattern": { "type": "string", "description": "Optional glob/pattern to scope tests" }
      }
    }
  },
  {
    "name": "run_command",
    "description": "Run an arbitrary shell command inside the sandboxed container for this session.",
    "input_schema": {
      "type": "object",
      "properties": {
        "command": { "type": "string" }
      },
      "required": ["command"]
    }
  },
  {
    "name": "search_codebase",
    "description": "Semantic search over the current project's indexed files.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "topK": { "type": "integer", "default": 5 }
      },
      "required": ["query"]
    }
  },
  {
    "name": "git_diff",
    "description": "Return the current diff between working state and the base branch.",
    "input_schema": {
      "type": "object",
      "properties": { "base": { "type": "string", "default": "main" } }
    }
  },
  {
    "name": "explain_code",
    "description": "Return an explanation of a specific file or code range.",
    "input_schema": {
      "type": "object",
      "properties": {
        "fileId": { "type": "string" },
        "startLine": { "type": "integer" },
        "endLine": { "type": "integer" }
      },
      "required": ["fileId"]
    }
  }
]
```

### 6.2 Invocation Sequence

```
1. sync-server receives "agent:invoke" { sessionId, prompt }
2. sync-server -> agent-service: POST /invoke { sessionId, prompt, ydocSnapshot }
3. agent-service calls Anthropic API:
     messages: [{ role: "user", content: prompt }]
     tools: [<tool definitions above>]
4. On each tool_use block in the response:
     a. agent-service emits "agent:tool_started" via sync-server -> all clients
     b. agent-service executes the tool (calls sandbox-runner / vector store / git API)
     c. agent-service emits "agent:tool_result" via sync-server -> all clients
     d. agent-service sends the tool_result back to Anthropic API (multi-turn tool loop)
5. Final text response emitted as "agent:message"
6. If the agent's response includes a proposed edit, emit "agent:edit_proposed"
   (MVP: human must accept before it's applied as a Y.Text transaction)
7. Every event is also persisted as a SessionEvent row for replay/audit
```

### 6.3 Tool Implementations (backing systems)

- `run_tests`, `run_command` → sandbox-runner (Section 7)
- `search_codebase` → Qdrant/pgvector query scoped by `projectId` (Phase 3)
- `git_diff` → core-api `/projects/:id/git/diff`
- `explain_code` → reads current Y.Text content for `fileId` directly from the ydoc snapshot, no external call needed

---

## 7. Sandbox Execution Spec (sandbox-runner)

- One ephemeral container per session, created on first `sandbox:run` or `run_command`/`run_tests` tool call, reused for the session's lifetime, destroyed on session end or idle timeout (e.g. 15 min).
- Base images per language (start with `node:20-slim` for MVP).
- Resource limits: `--memory=512m --cpus=1 --pids-limit=128`, no network egress (`--network=none`) except an explicit allowlist if package installation is needed.
- Filesystem: session workspace mounted as a bind volume synced from the current Yjs file state before execution (serialize `files` map to disk), read-only outside `/workspace`.
- Execution API (internal, called by agent-service):

```
POST /sandbox/:sessionId/exec   { command: string, timeoutMs?: number }
  -> streams { stream: "stdout"|"stderr", chunk }, then { exitCode }
```

- Timeout default: 30s for `run_command`, 120s for `run_tests`. Hard-kill container process group on timeout.

---

## 8. Auth Flow

```
1. Client redirects to GitHub OAuth authorize URL (core-api generates it, includes state)
2. GitHub redirects back to core-api /auth/github/callback?code=&state=
3. core-api exchanges code for GitHub access token, fetches GitHub user profile
4. core-api upserts User row, issues app JWT (short-lived access + refresh)
5. Client stores JWT, sends it as Bearer token on core-api requests
   and as an auth payload on sync-server WebSocket connection
6. sync-server verifies JWT signature + checks WorkspaceMember role
   before allowing room join
```

---

## 9. Build Order (concrete tasks, replaces "phases")

### Milestone 1 — Sync spike
- [ ] `sync-server`: NestJS gateway wrapping `y-websocket`'s server, room = sessionId
- [ ] `web`: Monaco + `y-monaco` binding to a Yjs doc over the websocket provider
- [ ] Two browser tabs editing the same file, changes converge — acceptance test

### Milestone 2 — Auth + workspaces
- [ ] GitHub OAuth flow end-to-end (core-api)
- [ ] Workspace/Project/Session CRUD + Prisma migrations
- [ ] JWT validation on both core-api and sync-server WebSocket handshake

### Milestone 3 — Sandbox + first tool
- [ ] sandbox-runner: container lifecycle (create/exec/destroy), `/sandbox/:sessionId/exec`
- [ ] agent-service: MCP tool `run_command` wired to sandbox-runner
- [ ] sync-server: `sandbox:run` / `sandbox:output` / `sandbox:exit` relay
- [ ] Acceptance: typing a command from the UI streams live stdout to all connected clients

### Milestone 4 — Agent invocation loop
- [ ] agent-service: Anthropic API tool-calling loop (Section 6.2)
- [ ] `agent:invoke` → `agent:tool_started` → `agent:tool_result` → `agent:message` full round-trip
- [ ] Live agent activity panel in `web`
- [ ] Acceptance: `@agent run this command` produces a visible tool call + result to all participants, not just the requester

### Milestone 5 — Git integration
- [ ] core-api git endpoints (diff, commit, PR) via `simple-git` + GitHub API
- [ ] `git_diff` MCP tool wired to core-api
- [ ] UI: diff viewer + commit panel in session

### Milestone 6 — RAG (search_codebase)
- [ ] Indexing job (BullMQ): chunk + embed project files into Qdrant/pgvector on project creation and on commit
- [ ] `search_codebase` MCP tool
- [ ] Acceptance: `@agent where is X implemented` returns relevant file/line citations

### Milestone 7 — Agent-authored edits
- [ ] `agent:edit_proposed` → accept/reject UI
- [ ] On accept: apply as tagged `Y.Text` transaction (Section 5), attributed styling
- [ ] Acceptance: accepted agent edit appears live to all clients, tagged distinctly from human edits

### Milestone 8 — Session replay
- [ ] Persist `SessionEvent` log (already schema'd in Section 2)
- [ ] Replay UI: scrub through session timeline, reconstruct doc state at any point via ordered Yjs updates

---

## 10. Environment Variables

```
# core-api
DATABASE_URL=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
JWT_SECRET=
REDIS_URL=

# agent-service
ANTHROPIC_API_KEY=
QDRANT_URL=
SANDBOX_RUNNER_URL=

# sandbox-runner
DOCKER_HOST=              # or default unix socket
MAX_CONTAINERS=
CONTAINER_IDLE_TIMEOUT_MS=

# sync-server
CORE_API_URL=
AGENT_SERVICE_URL=
JWT_SECRET=                # must match core-api
```

---

## 11. Open Design Questions (resolve before Milestone 4)

- Multi-instance `sync-server` scaling requires the Yjs Redis pub/sub adapter (`y-redis`) — needed once more than one sync-server instance runs behind a load balancer. Not needed for MVP single-instance.
- Tool loop turn limit — cap agent tool-calling loop (Section 6.2 step 4) at e.g. 8 iterations to prevent runaway loops before a final text response.
- Conflict UI for rejected agent edits — decide whether a rejected `agent:edit_proposed` needs to notify other participants or silently disappear for the requester only.
