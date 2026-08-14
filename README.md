# CoForge

Real-time collaborative code editor with an AI agent that works alongside human developers — reading, editing, testing, and debugging the shared codebase like a teammate.

Multiple developers edit code together live in a shared Yjs document. The agent joins each session as a participant: it plans changes, explores the code with terminal + file tools, stages edits, runs the test suite, and proposes changes for human review — or auto-applies low-risk ones.

---

## Key features

- **Live collaborative editing** — Monaco + Yjs CRDT over WebSocket; every keystroke converges across all connected tabs.
- **AI agent as a session participant** — ask it to implement, explain, fix, or debug code in plain language.
- **Planner → Coder → Tester pipeline** — the agent plans in small testable steps, implements each one, and validates against the project's real test/build command.
- **Terminal + file tool-calling (Claude-Code-style)** — the agent reads files, greps, lists directories, and runs arbitrary shell commands in a private per-thread sandbox to debug and iterate.
- **Sandboxed execution** — every agent run and human terminal lives in an ephemeral Docker container (`node:20-slim`) with memory/CPU/pid limits and idle eviction.
- **Human review of edits** — file changes are proposed as diffs and applied to the shared document only on accept (or auto-applied when low-risk).
- **Project memory & preferences** — the agent carries architecture notes and per-user preferences across sessions, updated after each applied change.
- **Multi-thread agent conversations** — separate chat threads per task, each with its own sandbox and message history.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER  (:3000)                            │
│   Monaco + Yjs  ·  file explorer  ·  terminal  ·  agent chat panel  │
└────────┬──────────────────────────┬────────────────────────┬────────┘
         │  Yjs (y-websocket)       │  Socket.io             │  REST + SSE
         ▼                          ▼                        ▼
┌─────────────────┐   ┌───────────────────────┐   ┌────────────────────────┐
│  sync-server    │   │  sync-server          │   │  agent-service  :3005   │
│  :3001          │   │  /agent namespace     │   │  planner → coder →      │
│  Yjs CRDT room  │◄──►│  agent:phase_started  │   │  tester → applier       │
│  per session    │   │  agent:tool_started   │◄──►│  (LlmClient: NVIDIA or  │
│  sandbox shell  │   │  agent:tool_result    │   │   Anthropic)            │
│  WS :3001       │   │  agent:message        │   └───────────┬────────────┘
└────────┬────────┘   │  agent:edit_proposed  │               │ tools / exec
         │            └───────────┬───────────┘               ▼
         │                        │              ┌──────────────────────────┐
         │    REST                │ REST         │  sandbox-runner  :3004   │
         ▼                        ▼              │  Docker (dockerode)       │
┌─────────────────┐   ┌───────────────────┐     │  · per-thread agent       │
│  core-api :3002  │◄──►│  agent-service    │     │    container             │
│  GitHub OAuth    │   │  sync/apply       │     │  · per-session human      │
│  JWT auth        │   │  sync/files       │     │    terminal container     │
│  workspaces      │   └───────────────────┘     │  · file push + exec       │
│  projects        │                              │  · preview ports          │
│  sessions        │                              └──────────────────────────┘
│  agent threads   │
│  project memory  │
│  PostgreSQL      │
│  (Prisma + pg)   │
└─────────────────┘
```

### Service map

| Service | Port | Role |
|---|---|---|
| `web` | 3000 | Next.js UI — Monaco editor, terminal, agent chat panel |
| `sync-server` | 3001 | Yjs CRDT relay, `/agent` Socket.io namespace, sandbox shell WS |
| `core-api` | 3002 | GitHub OAuth, JWT, workspaces, projects, sessions, agent threads, memory |
| `sandbox-runner` | 3004 | Docker orchestration — ephemeral containers, file push, exec streaming |
| `agent-service` | 3005 | The agent — planning, tool-calling coder loop, testing, applying |

### The agent pipeline (`apps/agent-service/src/agent/pipeline`)

```
User prompt
  → ContextService   loads project memory, preferences, conversation, files
  → Planner          emits a JSON plan (steps, risk, clarification) — JSON is
                     repaired/strict-retried when the model mangles it
  → Coder            agentic tool loop per step (max 25 tool iterations):
                        read_file / list_files / grep / run_terminal /
                        write_file / delete_file
  → Validator (tester) runs the project's test/build command in the sandbox;
                     failure output is fed back to the coder (up to 3 retries)
  → Applier          proposes diffs; human accepts/rejects in the UI, or
                     low-risk edits auto-apply (AGENT_AUTO_APPLY=true)
  → project memory   updated (best-effort) after applied edits
```

Progress streams live to the chat panel as `agent:phase_started`, `agent:tool_started`,
`agent:tool_result`, `agent:plan`, and `agent:message` events.

---

## Monorepo structure

```
CoForge/
  apps/
    web/               Next.js 16 + React 19 — Monaco editor, Yjs client, terminal, agent panel
    sync-server/       NestJS — Yjs CRDT relay, Socket.io agent events, sandbox shell gateway
    core-api/          NestJS + Prisma — GitHub OAuth, JWT, workspaces, projects, sessions,
                       agent threads, project memory/preferences
    agent-service/     NestJS — planner / coder / tester / applier pipeline, LLM client,
                       sandbox tool execution
    sandbox-runner/    NestJS + dockerode — ephemeral Docker containers, file sync, exec streaming
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Monaco Editor, xterm.js, Tailwind CSS |
| Real-time sync | Yjs (CRDT), y-websocket, Socket.io |
| Backend | NestJS (all services) |
| Database | PostgreSQL via Prisma (with `@prisma/adapter-pg`) |
| Sandboxing | Docker via dockerode (`node:20-slim`, memory/cpu/pid limits) |
| AI providers | NVIDIA NIM (OpenAI-compatible, default) or Anthropic Claude |
| Language | TypeScript throughout |

---

## Getting started

### Prerequisites

- Node.js 20+
- pnpm (v11+) and npm
- Docker (PostgreSQL + Redis-free; sandbox containers)

### Run the stack (services in separate terminals)

Start each service in its own terminal:

1. **Infra** — `docker compose up -d postgres` and wait for PostgreSQL.
2. **Database** — `pnpm migrate:deploy` in core-api.
3. **Services** — run each app in its own terminal (see below).
4. Open **http://localhost:3000**.

### Run services individually

```bash
cd apps/core-api       && pnpm install && pnpm start:dev    # :3002
cd apps/sync-server    && pnpm install && pnpm start:dev    # :3001
cd apps/sandbox-runner && pnpm install && pnpm start:dev    # :3004
cd apps/agent-service  && pnpm install && pnpm start:dev    # :3005
cd apps/web            && pnpm install && pnpm dev          # :3000
```

> sync-server reads `JWT_SECRET` from the process environment; set it to the same
> value as `apps/core-api/.env`.

### Model provider for the agent

The agent reads `apps/agent-service/.env` (gitignored). Two providers are supported via `LLM_PROVIDER`:

- `nvidia` (default) — NVIDIA NIM OpenAI-compatible endpoint.
  `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, plus `NVIDIA_PLANNER_MODEL` / `NVIDIA_CODER_MODEL` / `NVIDIA_MEMORY_MODEL`.
- `anthropic` — `ANTHROPIC_API_KEY`, plus `PLANNER_MODEL` / `CODER_MODEL` / `MEMORY_MODEL`.

Users can also pick a provider and paste their own API key per request from the
Agent panel ⚙ menu (stored in the browser, sent with that request only). A stale
override key is automatically ignored in favor of the server key when the provider
rejects it (401/403).

---

## Environment variables

```bash
# core-api  (apps/core-api/.env)
DATABASE_URL=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
JWT_SECRET=                       # keep in sync with sync-server process env

# agent-service  (apps/agent-service/.env)
LLM_PROVIDER=nvidia|anthropic
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_PLANNER_MODEL=
NVIDIA_CODER_MODEL=
NVIDIA_MEMORY_MODEL=
ANTHROPIC_API_KEY=
PLANNER_MODEL=
CODER_MODEL=
MEMORY_MODEL=
CORE_API_URL=http://localhost:3002
SYNC_SERVER_URL=http://localhost:3001
SANDBOX_RUNNER_URL=http://localhost:3004
AGENT_AUTO_APPLY=true             # auto-apply low-risk edits without review

# sandbox-runner
DOCKER_HOST=                      # default: Docker Desktop named pipe on Windows
MAX_CONTAINERS=10
CONTAINER_IDLE_TIMEOUT_MS=900000  # idle containers evicted after 15 min
SANDBOX_WORKSPACE_ROOT=
```

---

## Current status

Working end-to-end:

- Live Yjs collaborative editing across tabs.
- GitHub OAuth + JWT session auth; workspaces, projects, sessions.
- Human terminal (xterm.js) backed by a per-session sandbox container.
- Agent chat threads with message history and per-thread sandboxes.
- Planner → coder → tester → applier pipeline with terminal + file tool calling.
- Project memory and user preferences fed into every agent invocation.
- Agent-proposed edits streamed as diffs with accept/reject (or auto-apply for low-risk).
