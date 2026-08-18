# sync-server

Yjs WebSocket relay and sandbox shell proxy for CoForge. Keeps every connected
client's Y.Doc in sync and bridges the browser to the sandbox-runner's PTY shell
with bidirectional file sync.

## Endpoints

| Path | Protocol | Purpose |
|---|---|---|
| `ws://localhost:3001/<sessionId>` | Yjs binary (y-protocols) | CRDT document sync + awareness |
| `ws://localhost:3001/sandbox/<sessionId>` | JSON / binary | Sandbox shell relay (PTY I/O + file sync) |
| `GET /sync/files/:sessionId` | HTTP REST | Read the session's file map from the in-memory Y.Doc |
| `PUT /sync/files/:sessionId` | HTTP REST | Write files into the Y.Doc (used by agent-service) |
| `POST /sync/apply/:sessionId` | HTTP REST | Apply a Yjs update bundle to the doc |
| `socket.io /agent` | Socket.IO | Agent event stream (planner/coder progress, tool calls) |

## Development

```bash
pnpm install
pnpm start:dev          # http://localhost:3001
```

## How it works

- In-memory `Y.Doc` per session; Yjs sync protocol handles conflict-free merge
- `/sandbox/<id>` path dispatches to `SandboxRelay`, which proxies to
  sandbox-runner (`:3004`) and writes file changes back into the Y.Doc
- Socket.IO (`/agent` namespace) broadcasts real-time agent pipeline events
  to the frontend

## Env

| Variable | Default |
|---|---|
| `PORT` | `3001` |
| `SANDBOX_RUNNER_URL` | `http://localhost:3004` |
| `JWT_SECRET` | (must match core-api) |
| `FRONTEND_URL` | `http://localhost:3000` |
