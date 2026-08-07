# Milestone 3 — Sandbox + First Tool (`run_command`): Plan & Approach

## Status: 🔲 NOT STARTED

---

## Goal

End-to-end code execution: a user types a command in the editor UI, it runs inside an isolated Docker container for that session, and live stdout/stderr streams to **all** connected clients.

After this milestone:
- `sandbox-runner` (:3004) creates/reuses/destroys one Docker container per session
- `sync-server` relays `sandbox:run` / `sandbox:output` / `sandbox:exit` over WebSocket
- The web editor has a command bar + live output terminal
- **Bonus (deferred from M2):** sync-server finally verifies JWTs — the session channel becomes security-relevant now that it can execute code

Out of scope (Milestone 4+): the Anthropic tool-calling loop, other tools (`run_tests`, `search_codebase`, `git_diff`, `explain_code`), agent-authored edits.

---

## 1. What We Are Building

```
Browser (Tab 1)                     sync-server :3001                sandbox-runner :3004         Docker
      |                                  |                                |                        |
      |-- ws://…/sandbox/<sessionId> --->|                                |                        |
      |   { type:'sandbox:run',          |                                |                        |
      |     command:'npm test' }         |                                |                        |
      |                                  |-- serialize Y.Doc files ------->|                        |
      |                                  |   POST /sandbox/<id>/exec ----->|                        |
      |                                  |     { command, files, timeout } |-- ensure container --->|
      |                                  |                                |   (create / reuse)     |
      |                                  |                                |-- write files ------>| (bind mount)
      |                                  |                                |-- docker exec ------->|
      |                                  |<-- NDJSON stream --------------|-- demux stdout/stderr |
      |                                  |                                |                        |
      |-- sandbox:output {stream,chunk}->| (broadcast to ALL clients)     |                        |
      |<-- sandbox:exit {exitCode} ------|                                |                        |
```

### Data flow — run a command
1. User clicks **Run** in the editor → sends `{ type: 'sandbox:run', command, timeoutMs? }` on the sandbox WebSocket channel
2. sync-server serializes the session's `Y.Doc` `files` map (`fileId → content`)
3. sync-server → sandbox-runner: `POST /sandbox/:sessionId/exec { command, files, timeoutMs }`
4. sandbox-runner ensures the session's container exists (created once, reused), writes `files` into the `/workspace` bind mount, runs the command via Docker exec
5. sandbox-runner streams back **NDJSON** (`{"stream":"stdout","chunk":"…"}` / `{"stream":"stderr","chunk":"…"}` / `{"stream":"exit","exitCode":0}`), hard-killing on timeout
6. sync-server relays each chunk as `sandbox:output` to **every** connected client in the session; terminal event as `sandbox:exit`
7. UI renders a live terminal (stdout/stderr color-coded) + exit code

### Why NDJSON over the wire (sandbox-runner → sync-server)
Simple to parse line-by-line on the relay, easy to test with curl, no SSE/Socket.io dependency. We switch to Socket.io in M4 when agent events arrive anyway.

### Why a second WebSocket channel (client → sync-server)
The existing connection is the raw **Yjs binary protocol** (`y-protocols`). Mixing JSON control frames into it is fragile. A dedicated path `ws://…/sandbox/<sessionId>` with JSON messages keeps the Yjs relay untouched and is testable in isolation. Socket.io consolidation comes in M4.

---

## 2. Services Involved

| Service | Role | Port |
|---|---|---|
| `apps/sandbox-runner` | NEW — Docker orchestration, container lifecycle, exec streaming | 3004 |
| `apps/sync-server` | Sandbox relay (JSON ws channel) + Yjs relay | 3001 |
| `apps/core-api` | (+ 2 endpoints for Phase C: token bootstrap, membership check) | 3002 |
| `apps/web` | Command bar + live output terminal | 3000 |
| `apps/agent-service` | NEW (scaffold only) — `run_command` tool impl, Anthropic loop in M4 | 3003 |
| Docker Engine | Runs the sandbox containers (Docker Desktop / daemon) | — |

---

## 3. Tech Choices & Why

| Choice | Reason |
|---|---|
| `dockerode` | Official Node Docker API client — exec hijack streaming, inspect, kill |
| `node:20-slim` base image | Spec's MVP image; matches the app's Node 20 runtime |
| NDJSON streaming (HTTP) | Line-delimited, trivially parsed by the relay, curl-testable |
| Raw `ws` JSON channel on sync-server | Reuses existing `ws.Server`; no Socket.io until M4 |
| `--memory=512m --cpus=1 --pids-limit=128 --network=none` | Hard resource + no-egress isolation per spec §7 |
| `--user node` | Run as non-root inside container (node image ships `node` user) |
| `jsonwebtoken` in sync-server | Verify-only JWT check (Phase C), same lib pattern as core-api |
| NestJS for sandbox-runner | Matches the monorepo's existing service scaffolding |

---

## 4. Container Lifecycle (sandbox-runner)

State kept **in-memory**: `Map<sessionId, { containerId, createdAt, lastUsedAt }>`.

### Create (first exec for a session)
```
docker create
  --name coforge-sandbox-<sessionId>
  --memory=512m --cpus=1 --pids-limit=128
  --network=none
  --user node
  -v <workspaceRoot>/<sessionId>:/workspace
  node:20-slim
  sleep infinity          # keep-alive entrypoint so exec works
```

### Exec (every run)
1. Write `files` map to `<workspaceRoot>/<sessionId>` (idempotent sync; optimization: skip if unchanged)
2. `container.exec({ Cmd: ['sh','-c', command], AttachStdout: true, AttachStderr: true, Tty: false })`
3. `exec.start({ hijack: true, stdin: false })` → demux Docker's multiplexed frames via `modem.demuxStream` → stdout/stderr chunks
4. On stream end → `exec.inspect()` → `ExitCode` → send `exit` event
5. On timeout → `exec.kill()` → send `exit` event with `timeout: true`

### Reuse / destroy
- Container is **reused** for the session's lifetime
- One running command per session at a time — concurrent `exec` returns `409 { error: 'busy' }`
- Idle sweeper (interval): remove containers idle > `CONTAINER_IDLE_TIMEOUT_MS` (default 15 min)
- `MAX_CONTAINERS` (default 10): LRU eviction (stop + remove oldest) when exceeded

### Hardening notes (MVP vs later)
- MVP: no `ReadonlyRootfs` (node needs writeable tmp); relies on `--network=none` + limits + `--user node`
- Later: read-only rootfs + tmpfs for `/tmp`, package-install egress allowlist, seccomp profile

---

## 5. API Contract — `POST /sandbox/:sessionId/exec`

```
POST /sandbox/:sessionId/exec
Content-Type: application/json

Body:
{
  "command": "npm test",        // required — shell command ('sh -c')
  "files":   { "src/a.ts": "…" }, // optional — full session file map to sync into /workspace
  "timeoutMs": 30000              // optional — default 30000 (run_command); 120000 for run_tests (M4)
}

Response: 200 text/event-stream-like NDJSON stream
  {"stream":"stdout","chunk":"…"}
  {"stream":"stderr","chunk":"…"}
  {"stream":"exit","exitCode":0}             // normal
  {"stream":"exit","exitCode":null,"timeout":true}   // killed on timeout
  {"stream":"error","message":"…"}           // container create / filesync failure

Errors:
  404 session container state unknown / session not found
  409 { error: "busy" }          // a command is already running for this session
  500 { error: "…" }             // docker daemon errors
```

### Timeouts
- `run_command` default: **30s** — `run_tests` default **120s** (wired in M4)
- Hard-kill via `exec.kill()` on timeout, then report `timeout: true`

---

## 6. sync-server — Sandbox Relay

### New JSON WebSocket channel
```
ws://localhost:3001/sandbox/<sessionId>        (JSON messages)
ws://localhost:3001/<sessionId>                (existing Yjs binary — unchanged)
```
Dispatch on URL path in `main.ts` (`/sandbox/<id>` → JSON handler, otherwise Yjs handler).

### Client → server
```ts
{ "type": "sandbox:run", "command": "ls -la", "timeoutMs": 30000 }
{ "type": "sandbox:stop" }                     // kills the current run
```

### Server → client (broadcast to all conns in the room)
```ts
{ "type": "sandbox:output", "stream": "stdout", "chunk": "…" }
{ "type": "sandbox:exit",   "exitCode": 0, "timeout": false }
{ "type": "sandbox:error",  "message": "…" }
```

### Relay behavior
- On `sandbox:run`: serialize the session's Y.Doc `files` map → `POST /sandbox/:sessionId/exec` (via Node `fetch`, reading the NDJSON body chunk-by-chunk) → forward each line as `sandbox:output` to the whole room
- Terminal line → `sandbox:exit`
- Only one in-flight run per session (proxy the runner's 409 as `sandbox:error`)
- Extract this into a `SandboxRelay` service instead of growing `main.ts` (testability)

---

## 7. Phase C — JWT Gate (deferred from M2, recommended)

Sandbox execution makes the session channel security-relevant: **anyone who can reach :3001 could run commands.** Recommended within M3 as a separate phase (can be dropped/split if desired).

### core-api additions
```
GET /me/token                 → { accessToken }   // JWT-guarded; lets the browser get the token for ws URLs
                              (httpOnly cookie means JS can't read it directly)
GET /sessions/:id/membership  → { isMember }      // JWT-guarded; sync-server uses it with the client's token
```

### sync-server changes
- `handleConnection`: parse `?token=<JWT>` from URL → `jsonwebtoken.verify(token, JWT_SECRET)` → close `4001` on failure
- Membership check: call core-api `GET /sessions/:id/membership` with the client's Bearer token before allowing room join / sandbox runs

### web changes
- Fetch `/me/token` once, pass `?token=<JWT>` on **both** ws URLs (Yjs + sandbox)
- Update `lib/ydoc.ts` accordingly

---

## 8. web — Sandbox UI

### New component: `SandboxPanel`
- Command input (mono font, ↑ history), **Run** / **Stop** buttons
- Live terminal: stdout (default) / stderr (red) lines, exit code badge, `timeout` indicator
- Connects to `ws://…/sandbox/<sessionId>` (token appended in Phase C)
- Rendered below the editor in the session layout (replaces the empty editorMode bottom area)

### Files
```
components/SandboxPanel.tsx    # command bar + terminal UI + ws hook
lib/sandbox.ts                 # SandboxChannel class — ws connect, send sandbox:run/stop, event callbacks
components/Editor.tsx          # host SandboxPanel; disable run while busy
```

---

## 9. Folder Structure (new files)

```
CoForge/
  apps/
    sandbox-runner/                      # NEW — nest new sandbox-runner
      src/
        main.ts                          # bootstrap :3004, CORS
        app.module.ts
        sandbox/
          sandbox.module.ts
          sandbox.controller.ts          # POST /sandbox/:sessionId/exec
          sandbox.service.ts             # container lifecycle + file sync
          exec-runner.ts                 # dockerode exec hijack + demux + timeout kill
          ndjson.ts                      # stream encoder (stdout/stderr/exit/error)
          constants.ts                   # limits, timeouts, ignored dirs
      .env                               # DOCKER_HOST, MAX_CONTAINERS, …
      package.json

    sync-server/
      src/
        sandbox/
          sandbox.module.ts
          sandbox-relay.service.ts       # JSON ws handler, proxies to sandbox-runner
          sandbox-relay.controller.ts    # (empty/health)
        main.ts                          # path dispatch: /sandbox/<id> vs Yjs room
                                          # + JWT verify on connect (Phase C)
      package.json                       # + jsonwebtoken, @types/jsonwebtoken (Phase C)

    core-api/
      src/
        auth/…                           # + GET /me/token (Phase C)
        sessions/…                       # + GET /sessions/:id/membership (Phase C)

    agent-service/                       # NEW — minimal scaffold (optional in M3)
      src/
        main.ts                          # bootstrap :3003, /health
        tools/
          tools.registry.ts              # run_command JSON schema (spec §6.1)
          run-command.tool.ts            # executor: HTTP POST → sandbox-runner
      package.json                       # + @nestjs/*, no Anthropic yet (M4)

    web/
      components/SandboxPanel.tsx
      lib/sandbox.ts
      components/Editor.tsx              # + SandboxPanel
      lib/ydoc.ts                        # + ?token= (Phase C)
```

---

## 10. Build Order

```
Phase A — sandbox-runner core (testable with curl, no UI)
[ ] Step 1  — scaffold sandbox-runner (NestJS) + dockerode
[ ] Step 2  — Docker health check on boot (Docker.info), fail fast if daemon down
[ ] Step 3  — container lifecycle service (create/reuse/evict/cleanup sweeper)
[ ] Step 4  — workspace file sync (write `files` map → bind mount dir)
[ ] Step 5  — POST /sandbox/:sessionId/exec — exec + demux + NDJSON stream
[ ] Step 6  — timeout kill + concurrent-run 409 + MAX_CONTAINERS eviction
[ ] Step 7  — unit tests (mock dockerode) + manual curl acceptance

Phase B — sync-server relay
[ ] Step 8  — sandbox JSON ws channel with path dispatch in main.ts
[ ] Step 9  — serialize Y.Doc files map on sandbox:run
[ ] Step 10 — relay to sandbox-runner, stream sandbox:output / sandbox:exit to room
[ ] Step 11 — busy guard (409 → sandbox:error)

Phase C — JWT gate (deferred from M2)
[ ] Step 12 — core-api: GET /me/token + GET /sessions/:id/membership
[ ] Step 13 — sync-server: verify JWT + membership on both ws channels
[ ] Step 14 — web: token bootstrap + ?token= on ws URLs

Phase D — web UI
[ ] Step 15 — lib/sandbox.ts SandboxChannel
[ ] Step 16 — SandboxPanel component (run/stop, terminal, exit code)
[ ] Step 17 — host in Editor + multi-tab acceptance test

Phase E — agent-service scaffold (optional, unblocks M4)
[ ] Step 18 — scaffold agent-service + tools registry + run_command executor
[ ] Step 19 — unit tests against mock sandbox-runner
[ ] Step 20 — (M4) Anthropic tool-calling loop wires run_command in
```

---

## 11. Environment Variables

```bash
# sandbox-runner (.env in apps/sandbox-runner/)
DOCKER_HOST=                     # empty → platform default (npipe://./pipe/docker_engine on Windows,
                                 # /var/run/docker.sock on Linux)
MAX_CONTAINERS=10
CONTAINER_IDLE_TIMEOUT_MS=900000
SANDBOX_WORKSPACE_ROOT=          # empty → os.tmpdir()/coforge-sandboxes

# sync-server (.env in apps/sync-server/)
SANDBOX_RUNNER_URL=http://localhost:3004
JWT_SECRET=supersecretchangeme   # Phase C — must match core-api
CORE_API_URL=http://localhost:3002   # Phase C
```

---

## 12. Prerequisites

- [ ] Docker Engine running (Windows: Docker Desktop with WSL2 backend)
- [ ] `node:20-slim` image pull-able (`docker pull node:20-slim`)
- [ ] M2 stack up: core-api (:3002) + postgres, sync-server (:3001), web (:3000)
- [ ] Postgres + Redis from `docker-compose.yml` (Redis not strictly needed in M3)

---

## 13. Acceptance Criteria

| Test | Expected Result |
|---|---|
| `POST /sandbox/:id/exec { command: "echo hello" }` | Streams `{"stream":"stdout","chunk":"hello\n"}`, exit 0 |
| Exec `ls /workspace` after sending `files` | Sees the synced files — file sync works |
| Exec `sleep 100` (default 30s timeout) | Killed at ~30s, `{"stream":"exit","timeout":true}` |
| Concurrent exec while one is running | `409 { error: "busy" }` |
| Two execs on same session | Same container reused (verify container id) |
| UI: type `echo hi` → Run | Output streams to **both** tabs in real-time |
| UI: Stop button | Kills current run, shows exit/killed state |
| Container idle > 15 min | Removed by sweeper |
| More sessions than `MAX_CONTAINERS` | Oldest container evicted |
| Memory guard: run `node -e` allocating 600MB | Process OOM-killed, exit event reported |
| Phase C: ws connect without token | Connection closed with `4001` |
| Phase C: ws connect with non-member token | Connection rejected (membership check) |

---

## 14. Risks / Open Questions

| Risk / Question | Mitigation / Decision |
|---|---|
| Windows bind-mount path quirks (dockerode `C:\…` escaping) | Use `os.tmpdir()`-based workspace root; verify with a real container early (Step 4) |
| `--network=none` blocks `npm install` | MVP accepts it (pre-installed deps or committed node_modules); egress allowlist later |
| Docker exec demux complexity | `modem.demuxStream` (Tty:false); fallback `Tty:true` merges streams if it misbehaves |
| sandbox escape hardening | MVP: `--user node`, network none, pids/mem/cpu caps; read-only rootfs + seccomp later |
| `files` map rewrite on every exec (perf) | Acceptable for MVP; skip-if-unchanged optimization later |
| JWT gate scope — gate only sandbox, or also Yjs doc access? | **Recommended: both** (uniform). Confirm during Phase C |
| Agent-service scaffold worth it in M3? | Optional Phase E — M3 acceptance does not require it; can slide to M4 |

---

## 15. Out of Scope (deferred)

- `run_tests` tool + 120s default — Milestone 4 (same exec path, different timeout)
- Anthropic tool-calling loop, `agent:invoke`/`agent:message` events — Milestone 4
- `search_codebase` (RAG/Qdrant) — Milestone 6
- Socket.io consolidation of ws channels — Milestone 4 (agent events)
- `sandbox:output` persistence as `SessionEvent` rows — Milestone 4
- Sandbox session-replay of command output — Milestone 8
