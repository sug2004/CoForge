# CoForge

Real-time collaborative code editor with an MCP-connected AI agent as a session participant.
Multiple developers edit code together live — the AI agent joins the session, runs commands, searches the codebase, explains code, and proposes edits.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER CLIENTS                                │
│                                                                             │
│   ┌──────────────────────┐          ┌──────────────────────┐               │
│   │      Tab / User 1    │          │      Tab / User 2    │               │
│   │                      │          │                      │               │
│   │  ┌────────────────┐  │          │  ┌────────────────┐  │               │
│   │  │  Monaco Editor │  │          │  │  Monaco Editor │  │               │
│   │  │  + Yjs Y.Doc   │  │          │  │  + Yjs Y.Doc   │  │               │
│   │  │  + y-websocket │  │          │  │  + y-websocket │  │               │
│   │  └───────┬────────┘  │          │  └───────┬────────┘  │               │
│   └──────────┼───────────┘          └──────────┼───────────┘               │
│              │  raw WebSocket                   │  raw WebSocket            │
└──────────────┼──────────────────────────────────┼───────────────────────────┘
               │                                  │
               ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           sync-server  :3001                                │
│                         NestJS + ws.Server                                  │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  Room Manager                                                       │  │
│   │  Map<sessionId, { Y.Doc, Awareness, Set<WebSocket> }>               │  │
│   │                                                                     │  │
│   │  Sync Protocol (y-protocols)                                        │  │
│   │  • step1 / step2 handshake on connect                               │  │
│   │  • update broadcast to all conns in room                            │  │
│   │  • awareness relay                                                  │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                    │                        │                               │
│              JWT verify               Socket.io (M4+)                      │
└────────────────────┼────────────────────────┼───────────────────────────────┘
                     │                        │
          ┌──────────┘                        └──────────────┐
          ▼                                                  ▼
┌──────────────────────────┐              ┌──────────────────────────────────┐
│    core-api  :3002       │              │      agent-service  :3003        │
│    NestJS + Prisma       │              │      MCP Server                  │
│                          │              │                                  │
│  • GitHub OAuth          │              │  ┌────────────────────────────┐  │
│  • JWT issue/verify      │              │  │  Anthropic API             │  │
│  • Workspace CRUD        │◄────────────►│  │  Tool-calling loop (≤8)    │  │
│  • Project CRUD          │  REST calls  │  │                            │  │
│  • Session CRUD          │              │  │  Tools:                    │  │
│  • SessionEvent log      │              │  │  • run_command             │  │
│  • Git ops               │              │  │  • run_tests               │  │
│    (diff/commit/PR)      │              │  │  • search_codebase         │  │
│                          │              │  │  • git_diff                │  │
│  ┌────────────────────┐  │              │  │  • explain_code            │  │
│  │  PostgreSQL         │  │              │  └──────────────┬─────────────┘  │
│  │  (Prisma ORM)       │  │              └─────────────────┼────────────────┘
│  └────────────────────┘  │                                │
│                          │                                │ exec requests
│  ┌────────────────────┐  │              ┌─────────────────▼────────────────┐
│  │  Redis             │  │              │    sandbox-runner  :3004         │
│  │  • BullMQ jobs     │  │              │    Docker orchestration          │
│  │  • Socket.io adapt │  │              │                                  │
│  └────────────────────┘  │              │  • 1 container per session       │
│                          │              │  • --memory=512m --cpus=1        │
│  ┌────────────────────┐  │              │  • --network=none                │
│  │  Qdrant / pgvector │  │              │  • 30s / 120s timeouts           │
│  │  (Phase 3 RAG)     │  │              │  • streams stdout/stderr         │
│  └────────────────────┘  │              └──────────────────────────────────┘
└──────────────────────────┘
```

---

## System Flow — Key Scenarios

### 1. User edits code (real-time sync)
```
User keystroke
  → Monaco onDidChangeContent
  → Y.Text.insert / delete (via ydoc.transact)
  → y-websocket encodes CRDT update
  → WebSocket → sync-server
  → sync-server applies to server Y.Doc
  → sync-server broadcasts to all other conns in room
  → Other tabs receive update → Yjs merges → Monaco applyEdits
```

### 2. GitHub OAuth + session start
```
Browser → GET /auth/github  (core-api)
  → GitHub OAuth authorize URL
  → GitHub callback → core-api exchanges code
  → core-api upserts User, issues JWT
  → Browser stores JWT
  → POST /projects/:id/sessions  (core-api)
  → core-api creates Session row, returns join token
  → Browser connects to sync-server WebSocket with JWT
  → sync-server verifies JWT + WorkspaceMember role
  → Room created, editor loads
```

### 3. Agent invocation
```
User types @agent <prompt>
  → Browser emits agent:invoke { sessionId, prompt }  (Socket.io)
  → sync-server → POST /invoke  (agent-service)
  → agent-service calls Anthropic API with tool definitions
  → Anthropic returns tool_use block
  → agent-service emits agent:tool_started → sync-server → all clients
  → agent-service executes tool:
      run_command / run_tests  → sandbox-runner POST /sandbox/:id/exec
      search_codebase          → Qdrant vector query
      git_diff                 → core-api GET /projects/:id/git/diff
      explain_code             → reads Y.Text from ydoc snapshot
  → agent-service emits agent:tool_result → sync-server → all clients
  → tool_result sent back to Anthropic (multi-turn loop, max 8 iterations)
  → Final text → agent:message → all clients
  → If edit proposed → agent:edit_proposed → accept/reject UI
  → On accept → Y.Text transaction with origin { actor: 'agent', toolCallId }
  → All events persisted as SessionEvent rows
```

### 4. Sandbox execution
```
agent-service POST /sandbox/:sessionId/exec { command }
  → sandbox-runner checks if container exists for session
  → if not: docker run node:20-slim --memory=512m --cpus=1 --network=none
  → serialize Y.Doc files map → write to /workspace bind mount
  → exec command in container
  → stream { stream: stdout|stderr, chunk } back to agent-service
  → agent-service relays via sync-server → sandbox:output → all clients
  → on exit → sandbox:exit { exitCode }
  → container reused for session lifetime, destroyed on idle (15min)
```

---

## Monorepo Structure

```
CoForge/
  apps/
    web/              Next.js 16 — Monaco editor, Yjs client, presence UI, agent panel
    sync-server/      NestJS — Yjs CRDT relay, Socket.io for agent/presence events
    core-api/         NestJS + Prisma — auth, workspaces, projects, sessions, git
    agent-service/    MCP server — Anthropic tool-calling loop, tool implementations
    sandbox-runner/   Docker orchestration — ephemeral containers per session
  packages/
    shared-types/     Zod schemas + TypeScript types shared across apps
    ui/               Shared React components
  docs/
    milestone-1-plan.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Monaco Editor, Tailwind CSS |
| Real-time sync | Yjs (CRDT), y-websocket, y-protocols |
| Backend framework | NestJS |
| Database | PostgreSQL via Prisma ORM |
| Cache / Queue | Redis — BullMQ jobs + Socket.io multi-instance adapter |
| Vector store | Qdrant or pgvector (Phase 3) |
| AI | Anthropic Claude via MCP tool-calling |
| Containers | Docker (sandbox-runner) |
| Monorepo | pnpm workspaces |
| Language | TypeScript throughout |

---

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Sync spike — Monaco + Yjs, two tabs converge | ✅ Complete |
| 2 | Auth + workspaces — GitHub OAuth, JWT, CRUD | 🔲 Next |
| 3 | Sandbox + first tool — `run_command` end-to-end | 🔲 |
| 4 | Agent invocation loop — full tool-calling round-trip | 🔲 |
| 5 | Git integration — diff, commit, PR | 🔲 |
| 6 | RAG — `search_codebase`, BullMQ indexing | 🔲 |
| 7 | Agent-authored edits — accept/reject UI | 🔲 |
| 8 | Session replay — scrub through event log | 🔲 |

---

## Getting Started (Milestone 1)

### Prerequisites
- Node.js 20+
- pnpm 9+

### Run sync-server
```bash
cd apps/sync-server
pnpm install
pnpm start:dev
# ws://localhost:3001
```

### Run web
```bash
cd apps/web
pnpm install
pnpm dev
# http://localhost:3000
```

Open `http://localhost:3000/session/demo` in two browser tabs.
Type in one — changes appear in the other in real-time.

---

## Environment Variables

```bash
# core-api (Milestone 2+)
DATABASE_URL=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
JWT_SECRET=
REDIS_URL=

# agent-service (Milestone 4+)
ANTHROPIC_API_KEY=
QDRANT_URL=
SANDBOX_RUNNER_URL=

# sandbox-runner (Milestone 3+)
DOCKER_HOST=
MAX_CONTAINERS=
CONTAINER_IDLE_TIMEOUT_MS=

# sync-server (Milestone 2+)
CORE_API_URL=
AGENT_SERVICE_URL=
JWT_SECRET=
```
