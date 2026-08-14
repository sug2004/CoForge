# web

Next.js 16 frontend for CoForge. The collaborative editor: Monaco + Yjs for live
multi-user editing, an xterm.js terminal backed by the session sandbox, and the
agent chat panel where the AI agent streams its plan, tool calls, and results.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

## What lives here

- `components/` — editor, sandbox terminal panel, agent chat panel, project/session UI
- `lib/` — `api` (core-api client), `ydoc` (Yjs session wiring), `sandbox` (shell WS), `preview` (sandbox preview ports)
- Editor content is stored in a Yjs `Y.Map<Y.Text>` synced over the y-websocket connection (see `lib/ydoc.ts`)

## Env

| Variable | Default |
|---|---|
| `NEXT_PUBLIC_AGENT_SERVICE_URL` | `http://localhost:3005` |
| `NEXT_PUBLIC_SANDBOX_RUNNER_URL` | `http://localhost:3004` |
| `NEXT_PUBLIC_SANDBOX_WS_URL` | `ws://localhost:3001` |
