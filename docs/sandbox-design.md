# Sandbox Execution — Design & Implementation

## Status: ✅ COMPLETE

---

## Goal

End-to-end code execution: a user types a command in the editor UI, it runs
inside an isolated Docker container for that session, and live output streams
to all connected clients in real-time with full PTY terminal behavior.

After implementation:
- `sandbox-runner` (:3004) manages one Docker container per session with a
  persistent PTY shell, bidirectional file sync, and preview port forwarding
- `sync-server` relays shell I/O over WebSocket with bidirectional file sync
  via Y.Doc
- The web editor has an xterm.js terminal, file explorer with live hot-reload,
  and a dev-server preview panel

---

## 1. Architecture

```
Browser (Tab 1)                     sync-server :3001                sandbox-runner :3004         Docker
      |                                  |                                |                        |
      |-- ws://…/sandbox/<sessionId> --->|                                |                        |
      |   (raw binary shell I/O)         |-- ws://…/shell/<sessionId> --->|                        |
      |                                  |   (thin duplex byte proxy)     |-- PTY exec ---------->|
      |                                  |                                |   bash (Tty: true)    |
      |<-- raw stdout/stderr ------------|<-- raw bytes -----------------|                        |
      |                                  |                                |                        |
      |   Y.Doc <── chokidar ───────────|── PUT /files (diff) ──────────>|── fs.write ──────────>|
      |   (live hot-reload)              |<── \u0000{type:files} ────────|<── chokidar watch ────|
      |                                  |                                |                        |
```

### Data flow — run a command
1. User types in xterm.js → raw bytes sent over the shell WebSocket
2. sync-server proxies bytes to sandbox-runner's shell WebSocket
3. sandbox-runner writes to the PTY exec stream → bash processes it
4. Output streams back through the same WebSocket chain to xterm.js

### File sync flow
- **Forward (editor → disk):** Y.Doc snapshot pushed once at shell attach,
  then debounced diffs (~300ms) on every Y.Doc update
- **Reverse (disk → editor):** chokidar watches the workspace, pushes
  new/changed/deleted files as control frames through the shell WebSocket
- Skips files the editor currently has open to prevent clobbering active edits

---

## 2. Services

| Service | Role | Port |
|---|---|---|
| `apps/sandbox-runner` | Docker orchestration, PTY shells, file sync, preview | 3004 |
| `apps/sync-server` | Shell relay (raw byte proxy) + Y.Doc sync | 3001 |
| `apps/core-api` | Token bootstrap, membership check | 3002 |
| `apps/web` | xterm.js terminal, file explorer, preview panel | 3000 |
| `apps/agent-service` | Agent pipeline (sandbox commands) | 3005 |
| Docker Engine | Runs the sandbox containers | — |

---

## 3. Tech Choices

| Choice | Reason |
|---|---|
| `dockerode` | Official Node Docker API client — exec hijack streaming, inspect, kill |
| `node:20-slim` base image | Matches the app's Node 20 runtime |
| `ws` (raw WebSocket) | Thin byte proxy; no NDJSON parsing overhead |
| `chokidar` | Cross-platform file watcher for reverse sync (polling on Windows) |
| `@xterm/xterm` | Real terminal UI with ANSI rendering, cursor, colors |
| `node-pty` (inside container) | Persistent shell with cwd/env persistence |
| Bridge network (`coforge-sandbox-net`) | NAT'd internet for npm/git; containers isolated from each other and host services |
| `--memory=2g --cpus=2` | Per-container resource limits |
| `--user node` | Non-root execution inside container |

---

## 4. Container Lifecycle

State kept **in-memory**: `Map<sessionId, { containerId, workspaceDir, shell?, previews? }>`.

### Create (first connection for a session)
```
docker create
  --name coforge-sandbox-<sessionId>
  --memory=2g --cpus=2
  --network coforge-sandbox-net
  --user node
  --init                              # tini as PID 1 (zombie reaping)
  -v <workspaceRoot>/<sessionId>:/workspace
  node:20-slim
  sleep infinity                      # keep-alive entrypoint
```

After start: one root exec installs `git python3 make g++ curl` (cached per
container so re-attach skips it).

### Shell session
- `openShell(sessionId)`: creates a long-lived `bash` exec with `Tty: true`,
  stdin attached, `TERM=xterm-256color`
- One shell per container (v1); two browser tabs share one shell's output
- Shell stays alive for the container's lifetime; closed on sweeper eviction

### Preview
- Dev ports (`3000, 3001, 5173, 8080, 8000, 5000, 4000, 4173, 9000, 8008`)
  published to random `127.0.0.1` host ports at container creation
- `POST /sandbox/:id/preview` opens an exec-bridge (docker exec piping to
  `127.0.0.1:<port>` inside the container) — works for both `0.0.0.0` and
  localhost-bound servers

### Destroy
- `DELETE /sandbox/:sessionId` stops/removes the container, closes preview
  bridges, deletes the host workspace dir
- core-api fires this (best effort) on session/project/workspace delete

---

## 5. API Contract

### sandbox-runner HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sandbox/health` | Health check |
| `GET` | `/sandbox/:sessionId/files` | List workspace files |
| `PUT` | `/sandbox/:sessionId/files` | Sync files (partial diff) |
| `POST` | `/sandbox/:sessionId/touch` | Provision container |
| `POST` | `/sandbox/:sessionId/exec` | One-shot NDJSON exec (agent-service) |
| `GET` | `/sandbox/:sessionId/preview` | List published preview ports |
| `POST` | `/sandbox/:sessionId/preview` | Open preview port |
| `DELETE` | `/sandbox/:sessionId/preview` | Close preview ports |
| `DELETE` | `/sandbox/:sessionId` | Destroy container + workspace |

### WebSocket endpoints

| Path | Server | Protocol | Purpose |
|---|---|---|---|
| `/sandbox/<sessionId>/shell` | sandbox-runner | Raw binary + `\u0000` control frames | PTY shell I/O |
| `/sandbox/<sessionId>` | sync-server | Raw binary | Browser ↔ shell relay |

### Control frames (text, prefixed with `\u0000`)

```ts
// Browser → server
\u0000{"type":"resize","cols":80,"rows":24}

// Server → browser (file sync)
\u0000{"type":"files","changes":{"src/index.ts":"…"},"deleted":["old.ts"]}
```

### One-shot exec (for agent-service)

```
POST /sandbox/:sessionId/exec
Body: { "command": "npm test", "timeoutMs": 30000 }
Response: NDJSON stream
  {"stream":"stdout","chunk":"…"}
  {"stream":"stderr","chunk":"…"}
  {"stream":"exit","exitCode":0}
  {"stream":"exit","exitCode":null,"timeout":true}
```

---

## 6. sync-server Relay

The `SandboxRelay` is a thin duplex byte proxy:

- Browser `ws://localhost:3001/sandbox/<id>` ↔ outbound `ws://localhost:3004/sandbox/<id>/shell`
- Binary frames forwarded both ways; text frames starting with `\u0000` handled
  as control (resize, file sync)
- On shell WebSocket open: pushes full Y.Doc `files` snapshot to disk
- Observes Y.Doc `update` events → debounced diff push (~300ms)
- Handles reverse sync: file control frames written into Y.Doc in a transaction
- Tracks recently-forwarded keys to prevent clobbering active edits
- Browser disconnect → close outbound ws (shell keeps running in container)

---

## 7. JWT Gate

Sandbox execution makes the session channel security-relevant: anyone who can
reach :3001 could run commands.

### core-api additions
```
GET /me/token                 → { accessToken }
GET /sessions/:id/membership  → { isMember }
```

### sync-server changes
- `handleConnection`: parse `?token=<JWT>` from URL → verify → close `4001` on failure
- Membership check via core-api before allowing room join / sandbox runs

### Status
Remaining — env-gated on/off, default off in `NODE_ENV=development`.

---

## 8. Terminal Fix — Root Causes (Original Design Issues)

The initial one-shot exec design had four problems:

1. **No network** — `NetworkMode: 'none'` blocked npm, git, anything hitting a registry
2. **Not synced** — files pushed Y.Doc → container only before exec, pulled back only
   after; nothing live during a running dev server
3. **Not interactive** — `exec.start({ Tty: false })`, no stdin, one exec per command.
   No cwd/env persistence, no Ctrl+C, broken ANSI rendering
4. **Lockfile thrash** — `syncFiles` deleted workspace files not in Y.Doc snapshot;
   lockfiles > `MAX_FILE_BYTES` skipped on sync-back, so next exec deleted them again

---

## 9. Terminal Fix — Phased Approach

### Phase 1 — Network egress
- Drop `NetworkMode: 'none'`, create `coforge-sandbox-net` bridge network
- Containers get NAT'd internet; host services not on this network → still isolated
- Install `git python3 make g++ curl` in container (cached per container)

### Phase 2 — Persistent PTY shell
- One long-lived `bash` exec with `Tty: true`, stdin attached
- Cwd/env persistence across commands, Ctrl+C, interactive prompts, ANSI rendering
- No more global `busy` flag or per-command timeout kill

### Phase 3 — Raw byte proxy
- sandbox-runner: `ws` server at `/sandbox/:id/shell` piping to PTY exec stream
- sync-server: `SandboxRelay` becomes thin duplex proxy (no more NDJSON parsing)
- Binary frames for I/O, `\u0000`-prefixed text frames for control

### Phase 4 — xterm.js
- Replace line-by-line stdout/stderr log with real `xterm.js` terminal
- `FitAddon` for auto-resize, theme mapped to app palette
- "Stop" button sends Ctrl+C (`\x03`)

### Phase 5 — File-sync model
- **Forward:** diff-based sync on Y.Doc updates (not whole-workspace)
- **Reverse:** chokidar watches workspace, pushes changes as control frames
- Skip recently-forwarded keys (active edits); no more `MAX_FILE_BYTES` for sync-back

### Phase 6 — Preview panel
- Per-session host-port allocation + exec-bridge for dev server rendering
- Preview tab in web UI with iframe + arbitrary port input

---

## 10. Implementation Order

| Milestone | Phases | Status |
|---|---|---|
| M1 — Network + PTY + proxy + xterm | Phases 1+2+3+4 | ✅ DONE |
| M2 — File sync model | Phase 5 | ✅ DONE |
| M3 — Preview + hardening + JWT | Phase 6 + cleanup | ✅ DONE |

---

## 11. Hardening (shipped)

- `HostConfig.Init: true` (tini as PID 1) — zombie reaping for exec processes
- Container-name 409 conflict — adopt stale containers, recreate if pre-network-fix
- Avoid `container.start()` on already-running adopted container (HTTP 304)
- Web `apiFetch` handles 204/empty delete responses
- Monaco LSP: ambient `react`/`react/jsx-runtime` shim for sandbox `.tsx`/`.jsx`

---

## 12. Environment Variables

```bash
# sandbox-runner (.env in apps/sandbox-runner/)
DOCKER_HOST=                          # platform default
SANDBOX_CONTAINER_MEMORY_MB=2048
SANDBOX_CONTAINER_CPUS=2
SANDBOX_WORKSPACE_ROOT=               # default: os.tmpdir()/coforge-sandboxes

# sync-server (.env in apps/sync-server/)
SANDBOX_RUNNER_URL=http://localhost:3004
JWT_SECRET=                           # must match core-api
CORE_API_URL=http://localhost:3002
```

---

## 13. Prerequisites

- Docker Engine running (Docker Desktop with WSL2 backend on Windows)
- `node:20-slim` image pullable
- core-api (:3002) + Postgres, sync-server (:3001), web (:3000) running

---

## 14. Acceptance Criteria

| Test | Expected Result |
|---|---|
| `npm install` in sandbox | Succeeds (network egress works) |
| `cd src && export FOO=bar` | Cwd/env persist across commands |
| Ctrl+C during long process | Process killed, shell returns |
| `npm run dev` background | Dev server stays running |
| Colors/spinners render | ANSI output correct in xterm.js |
| Editor edit → running dev server | Hot-reloads live |
| `npm install` → lockfile appears | Lockfile syncs back to Y.Doc |
| Editor delete → file on disk | Removed from workspace |
| Preview `next dev` | Renders in iframe |
| Delete session | Container + workspace cleaned up |
| Phase C: ws connect without token | Connection closed with `4001` |

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Windows bind-mount path quirks | `os.tmpdir()`-based workspace root |
| Docker Desktop can't reach bridge IPs | Exec-bridge approach for preview |
| `--network=none` → no npm | Resolved: bridge network with NAT |
| Vite binds localhost only | Exec-bridge connects to container's own localhost |
| Two tabs sharing one shell (v1) | Acceptable; noted in UI |
| JWT not yet enforced | Env-gated, default off in dev; recommended before leaving localhost |

---

## 16. Out of Scope

- `run_tests` tool + 120s default timeout — Milestone 4
- Anthropic tool-calling loop — Milestone 4
- `search_codebase` (RAG/Qdrant) — Milestone 6
- `sandbox:output` persistence as `SessionEvent` rows — Milestone 4
- Sandbox session-replay — Milestone 8
- Multi-shell per container — later extension
