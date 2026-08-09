# CoForge Sandbox — Fix Plan: Real IDE Terminal Behavior

## Root causes

Both symptoms trace back to one architectural choice: **every command is a
one-shot, non-interactive `docker exec` into a network-isolated container**,
not a real shell session.

- **npm / framework commands don't work** → `HostConfig.NetworkMode: 'none'`
  in `sandbox.service.ts`'s `createContainer`. `npm install`, `npx create-*`,
  `git clone` — anything hitting a registry — has zero network access. It's
  not a logic bug, the container physically cannot reach the internet.

- **Not synced with the editor** → files are pushed Y.Doc → container only
  right before a command runs, and pulled container → Y.Doc only right after
  it exits (`syncFiles` / `syncBackFiles` in the relay). Nothing keeps them
  live while a dev server is running, and the sync-back only *adds* new keys
  — it never updates existing ones.

- **Doesn't feel like a real terminal** → `exec.start({ Tty: false })`, no
  stdin attached, one exec per command. No persistent cwd/env across
  commands, no ANSI rendering (progress bars/spinners come out as garbage),
  no way to answer an interactive prompt, and a 5-minute hard timeout kills
  anything long-running like `next dev`.

- **Bonus bug found while re-reading it**: `syncFiles` deletes any workspace
  file not present in the current Y.Doc snapshot. Files like
  `package-lock.json` / `pnpm-lock.yaml` that exceed `MAX_FILE_BYTES` (1MB)
  get silently skipped on sync-back, so they never make it into the Y.Doc —
  meaning the *next* command's `syncFiles` call deletes them again.
  Lockfiles will thrash on every run.

---

## Phased fix

### Phase 1 — Enable real network egress
Drop `NetworkMode: 'none'`. Create a dedicated bridge network
(`coforge-sandbox-net`) at module init so containers get NAT'd internet
access for npm/git, while staying isolated from each other and from the
host's internal service ports (core-api/sync-server are not attached to
this network, so a sandboxed process can't reach them directly).

Also bump the base image setup: `node:20-slim` ships without `git` or build
tools, so `npx create-*` / native npm modules will still fail. Run a
one-time `apt-get install -y git python3 make g++ curl` as part of container
creation (as root), then drop to the unprivileged `node` user for everything
the session actually runs.

### Phase 2 — Replace one-shot exec with a persistent PTY shell per container
Instead of a fresh `docker exec -c "<command>"` per run, create **one
long-lived bash exec** with `Tty: true` and stdin attached when a session's
terminal is opened, and keep it alive for the container's lifetime. This
gives:
- real cwd/env persistence across commands (`cd`, `export`, `nvm use`, etc.)
- `npm run dev` keeps running in the background while you type other
  commands in the same shell, or open a second one
- Ctrl+C and interactive prompts work (npm init, git credential helper,
  y/n confirmations)
- correct ANSI rendering (colors, spinners, progress bars)

No more global per-container `busy` flag / `ConflictException('busy')` —
concurrency is handled the way a real terminal handles it (you can background
a process or open another tab).

### Phase 3 — Proxy raw bytes, not NDJSON-per-command
Add a raw WebSocket endpoint on `sandbox-runner` at `/sandbox/:id/shell`
that pipes the docker exec stream directly (mirrors the raw `ws` server
`sync-server` already runs for the Yjs room). `sync-server`'s `SandboxRelay`
becomes a thin duplex byte proxy between the browser and this socket,
instead of parsing per-command NDJSON. A small JSON control frame
(`{"type":"resize", cols, rows}`) is used for terminal resize; everything
else is raw keystrokes/output.

### Phase 4 — Swap the terminal UI for xterm.js
Replace `SandboxPanel`'s line-by-line stdout/stderr log with a real
`xterm.js` instance bound to the raw socket. This is what actually delivers
spinners, colors, cursor movement, and live typed input — the current
`<input>` + line-array UI structurally can't represent a PTY session.

### Phase 5 — Fix the file-sync model
Stop diffing the whole workspace against the Y.Doc on every exec (root cause
of the lockfile-deletion bug). Instead:
- **Forward (editor → disk):** sync the full Y.Doc snapshot to disk once
  when the shell is attached, then push only *changed* files on every Y.Doc
  update, debounced ~300ms — so a running dev server hot-reloads on edits.
- **Reverse (disk → editor):** watch the bind-mounted host directory with
  `chokidar` and push new/changed files (lockfiles, build output, git
  metadata) into the Y.Doc as they appear. Skip files the editor currently
  has open for editing, so a background process never clobbers an active
  edit.

### Phase 6 — Expose the dev server for preview
Publish a container port (or run a small per-session reverse proxy) so
`npm run dev` / `next dev` can be rendered in an iframe/preview panel
instead of only ever showing raw logs.

---

## Suggested implementation order

1+2+3+4 together first — this is the core structural fix and directly
resolves both reported symptoms (network access unblocks npm; the
persistent PTY shell + raw byte proxy + xterm.js is what makes it *feel*
like a real terminal). These four are tightly coupled and should land as
one change.
2. Phase 5 next — fixes the lockfile-thrash bug and gets live hot-reload
   working.
3. Phase 6 last — nice-to-have, not blocking terminal usability.

## Also worth doing alongside this
Carried over from the earlier review: neither `sync-server`'s WebSocket
upgrade nor `sandbox-runner`'s HTTP endpoints verify the JWT that
`core-api` already issues. Once a real shell with real network access is in
place, an unauthenticated `/sandbox/:id/shell` is a bigger exposure than the
current one-shot exec was — worth adding JWT verification on the WS upgrade
before this leaves localhost.

---

## Implementation approach (concrete)

### New dependencies

| App | Package | Used for |
|---|---|---|
| `sandbox-runner` | `ws` (+ `@types/ws` dev) | raw shell WebSocket server |
| `sandbox-runner` | `chokidar` | reverse file sync (Phase 5) |
| `web` | `@xterm/xterm`, `@xterm/addon-fit` | real terminal UI (Phase 4) |
| `sync-server` | — (already has `ws`) | outbound ws client to runner |

### Phase 1 — network egress (`apps/sandbox-runner`)

1. `SandboxService.onModuleInit`: idempotently create bridge network
   `coforge-sandbox-net` (`docker.createNetwork({..., CheckDuplicate: true })`,
   swallow "already exists").
2. `createContainer()`: remove `NetworkMode: 'none'`; set
   `NetworkingConfig: { EndpointsConfig: { 'coforge-sandbox-net': {} } }`.
   Services (core-api/sync-server) are host-published on ports, **not** on
   this network → containers still can't reach them.
3. Image setup: after `container.start()`, one root `docker exec`
   `apt-get update && apt-get install -y --no-install-recommends git python3 make g++ curl`
   (run once, cached in a `Map` per container so re-attach skips it). Keep
   `User: 'node'` for everything session code runs.

### Phase 2 — persistent PTY shell (`apps/sandbox-runner`)

Replace `exec()` one-shot with a per-container long-lived shell:

- `openShell(sessionId)`: `container.exec({ Cmd: ['/bin/bash'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color'] })` + `exec.start({ Tty: true, stdin: true, hijack: true })` → returns the duplex hijack stream. Cache in `Map<sessionId, { stream, exec }>`; close on sweeper eviction.
- `writeShell(sessionId, buf)`, `resizeShell(sessionId, cols, rows)` (dockerode `exec.resize`).
- Delete the global `busy` flag / `ConflictException('busy')` / per-command timeout kill from the exec path (interactive shell owns control now). The 5-min kill only made sense for one-shot execs.
- v1: one shell per container (two browser tabs share one shell's output); multi-shell per container is a later extension.

### Phase 3 — raw byte proxy (`sandbox-runner` + `sync-server`)

- `sandbox-runner`: attach a `ws` `WebSocketServer` to a manually created `http.createServer` (same pattern as sync-server's `main.ts`). Route `/sandbox/:id/shell`: pipe `ws` ↔ shell hijack stream bidirectionally.
- Framing: raw bytes always **binary** frames; control frames are **text** frames starting with `\u0000` → `\u0000{"type":"resize","cols":80,"rows":24}`. Backpressure: pause/resume the hijack stream when ws buffers grow.
- `sync-server` `SandboxRelay`: convert from NDJSON parsing to a thin duplex proxy — browser `ws://localhost:3001/sandbox/<id>` → outbound `ws://localhost:3004/sandbox/<id>/shell` (with reconnect/backoff), forwarding binary data both ways and translating the resize control frame. Browser disconnect → close outbound ws (shell keeps running in container).
- Keep `GET /sandbox/:sessionId/files` and the relay's Y.Doc access (Phase 5 needs both). Remove the old exec/NDJSON event paths once the proxy ships.

### Phase 4 — xterm.js (`apps/web`)

- Rework `SandboxPanel`: mount xterm `Terminal` + `FitAddon` into the existing panel container (theme-mapped to the app palette). `term.onData → ws.send`; `ws.onmessage → term.write`; `term.onResize → debounced resize control frame`; FitAddon on mount/panel resize.
- Replace `lib/sandbox.ts`'s NDJSON `SandboxChannel` with a raw duplex channel (same sessionId, no token — per earlier decision). "Stop" button sends Ctrl+C (`\x03`); keep command input only as an xterm affordance.

### Phase 5 — file-sync model (`sandbox-runner` + `sync-server`)

- **Forward (editor → disk):** relay pushes full Y.Doc `files` snapshot once at shell attach, then observes the map and pushes a debounced (~300ms) **diff** (new/changed keys + deleted keys) to a new `PUT /sandbox/:id/files` endpoint that writes/`fs.unlink`s per key. Drop the whole-workspace read-then-delete step in `syncFiles` (fixes lockfile thrash: nothing gets deleted just for being absent).
- **Reverse (disk → editor):** `chokidar` watches `entry.workspaceDir` in sandbox-runner (ignore `node_modules`/`.git`/ignored dirs; `usePolling: true` fallback on Windows). On debounced change → send `\u0000{"type":"files","changes":{path:content}}` over the open shell ws → relay writes into the Y.Doc in a transaction. Skip keys the relay has *pushed forward recently* (file is being edited) so background processes never clobber active edits. Bump/remove `MAX_FILE_BYTES` for sync-back (lockfiles must round-trip).
- Empty-dir markers (`src/`) keep round-tripping via the same forward/reverse paths.

### Phase 6 — preview panel (stretch, not blocking)

Per-session host-port allocation + tiny TCP reverse proxy in sandbox-runner so `next dev` output can render in an iframe. Skip until M1/M2 are stable.

### Milestone order

1. **M1 — Phases 1+2+3+4 as one change** (network, PTY shell, raw proxy, xterm). Verify: `npm install` succeeds; `cd`/`export` persist; Ctrl+C works; `next dev` runs in background; colors/spinners render. — **DONE**
2. **M2 — Phase 5** (chokidar reverse sync, forward diff sync, lockfile fix). Verify: lockfile appears in tree after `npm install`; editor edit hot-reloads a running dev server; editor delete removes the file on disk. — **DONE**
3. **M3 — Phase 6 preview + hardening + env-gated JWT.** — **MOSTLY DONE**, see status below.

### Current status (M3)

**Preview (Phase 6) — shipped.**
- Containers publish a preset set of dev ports (`3000, 3001, 5173, 8080, 8000, 5000, 4000, 4173, 9000, 8008`) to random `127.0.0.1` host ports at creation (`PREVIEW_PORTS` in `constants.ts`).
- `GET /sandbox/:id/preview` lists every published forward (`{port, hostPort, url}`) for the Preview tab cards.
- `POST /sandbox/:id/preview` returns the URL to load. It **always uses an exec-bridge** (a `docker exec node -e` per connection that pipes bytes to `127.0.0.1:<port>` inside the container), because:
  - Docker Desktop hosts cannot reach bridge-network container IPs — a host-side TCP proxy to the container IP can never work.
  - Vite (and other dev servers) bind to localhost only by default; the published port path (`docker-proxy` → container IP) refuses those connections. A connectivity probe is useless — Docker's userland proxy accepts the TCP handshake even when the container-side listener is absent.
  - The bridge connects to the container's own localhost, so it works for both `0.0.0.0`-bound and localhost-bound servers.
- Web: Preview tab (alongside Terminal) lists all forwards as cards; clicking one resolves the bridge URL and loads it in an iframe; a port input + Open button covers arbitrary ports; `↗` opens the published URL directly.
- Dev-server lifecycle note: the workspace (app + `node_modules`) is bind-mounted and survives container recreation, but running processes (the dev server) do not — a runner restart or container eviction requires re-running `npm run dev`.

**Delete-cascade container cleanup — shipped.**
- `DELETE /sandbox/:sessionId` on the runner (`destroyContainer`) stops/removes the container (adopting it by name if the runner restarted), closes preview bridges, and deletes the host workspace dir.
- core-api fires that call (best effort) from session delete, project delete (all its sessions), and workspace delete (all projects → sessions).

**Hardening found while shipping — shipped.**
- `HostConfig.Init: true` (tini as PID 1) so exited execs (shells, bridges, builds) get reaped instead of accumulating as zombies against the 128 pids limit — a zombie pile-up was crashing esbuild/Vite with `newosproc` EAGAIN.
- Container-name 409 conflict: adopt a stale container on create; if it predates the network fix (not on `coforge-sandbox-net`), remove and recreate it.
- Avoid `container.start()` on an already-running adopted container (HTTP 304).
- Web `apiFetch` handles 204/empty delete responses (fixes `JSON.parse: unexpected end of data` after clicking Delete).
- Monaco LSP: ambient `react` / `react/jsx-runtime` shim so `.tsx`/`.jsx` in the sandbox stop reporting error 2875 (the sandbox's `node_modules` isn't visible to Monaco's TS worker).
- Explorer header: explicit `+ File` / `+ Folder` buttons replacing the subtle emoji-only ones.

**Remaining — env-gated JWT on the shell ws (decision pending).** Neither `sync-server`'s WS upgrade nor `sandbox-runner`'s shell/files/preview endpoints verify the core-api JWT. Now that the shell has real network access and the preview can reach running dev servers, an unauthenticated `/sandbox/:id/shell` is a bigger exposure than the original one-shot exec. Recommended before this leaves localhost: verify the `Authorization: Bearer <token>` header on the WS upgrade (and optionally on the runner HTTP endpoints), env-gated on/off with a default of on outside `NODE_ENV=development`.

### Risks / decisions

- `exec.resize` requires `Tty: true` — satisfied by design.
- Docker Desktop on Windows: bind-mount event latency → chokidar `usePolling: true`.
- Two tabs sharing one shell (v1) is acceptable; note it in the UI.
- **Decision needed:** re-add JWT on the shell ws (env-gated, default off) to honor the earlier "no token" preference while closing the security note above.
