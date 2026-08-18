# sandbox-runner

Docker-based sandbox orchestrator for CoForge. Manages per-session containers,
syncs editor files to disk, executes commands with PTY support, and streams
stdout/stderr back via NDJSON or WebSocket.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/sandbox/health` | Health check |
| `GET` | `/sandbox/:sessionId/files` | List files in the session workspace |
| `PUT` | `/sandbox/:sessionId/files` | Sync files into the workspace (partial diff) |
| `POST` | `/sandbox/:sessionId/touch` | Provision / warm the container |
| `POST` | `/sandbox/:sessionId/exec` | One-shot command execution (NDJSON stream) |
| `GET` | `/sandbox/:sessionId/preview` | List published preview ports |
| `POST` | `/sandbox/:sessionId/preview` | Open a port for preview |
| `DELETE` | `/sandbox/:sessionId/preview` | Close preview ports |
| `DELETE` | `/sandbox/:sessionId` | Destroy the session container |
| `WS` | `/sandbox/:sessionId/shell` | Interactive PTY shell + file watcher |

## Development

```bash
pnpm install
pnpm start:dev          # http://localhost:3004
```

Requires Docker Engine running (Docker Desktop with WSL2 backend on Windows).

## How it works

- One Docker container per session (`node:20-slim`, no network, memory/CPU limits)
- Containers are **never** auto-removed; only destroyed on explicit `DELETE` or session cleanup
- Files are synced to a bind-mounted workspace dir and watched with chokidar for
  reverse sync (disk changes pushed back to the editor via Y.Doc)
- `POST /exec` streams `{"stream":"stdout","chunk":"…"}` NDJSON lines, ending
  with `{"stream":"exit","exitCode":0}`
- The shell WebSocket exposes a full PTY (`node-pty`) with resize support

## Env

See `.env.example` for the full list.

| Variable | Default |
|---|---|
| `PORT` | `3004` |
| `DOCKER_HOST` | platform default (Docker socket) |
| `SANDBOX_CONTAINER_MEMORY_MB` | `2048` |
| `SANDBOX_CONTAINER_CPUS` | `2` |
| `SANDBOX_WORKSPACE_ROOT` | `os.tmpdir()/coforge-sandboxes` |
