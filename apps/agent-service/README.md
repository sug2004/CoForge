# agent-service

AI agent backend for CoForge. Runs a multi-phase pipeline (Planner, Coder,
Validator, Applier) that takes a user prompt, edits files in a session sandbox,
streams progress over Socket.IO, and optionally auto-applies changes.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/invoke` | Fire-and-forget: start an agent run (streams via Socket.IO) |
| `POST` | `/agent/apply` | Apply pending agent edits to the Y.Doc |
| `POST` | `/agent/stop` | Cancel an in-flight agent run |
| `POST` | `/agent/reject` | Discard pending agent edits |
| `GET` | `/health` | Health check |

## Development

```bash
pnpm install
pnpm start:dev          # http://localhost:3005
```

## How it works

1. `invoke` receives a prompt + session/thread IDs and kicks off the pipeline
2. **Planner** calls the LLM to generate a structured edit plan
3. **Coder** calls the LLM to produce file diffs for each planned step
4. **Validator** runs sandbox commands (syntax checks, tests) to verify edits
5. **Applier** writes validated edits to the session via sync-server's REST API
6. Progress, tool calls, and final results are emitted as Socket.IO events on
   the `/agent` namespace (consumed by the web frontend)

All LLM calls use an OpenAI-compatible API (NVIDIA NIM / GLM-5.2 by default).

## Env

See `.env.example` for the full list.

| Variable | Default |
|---|---|
| `PORT` | `3005` |
| `NVIDIA_API_KEY` | (required) |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | `z-ai/glm-5.2` |
| `CORE_API_URL` | `http://localhost:3002` |
| `SYNC_SERVER_URL` | `http://localhost:3001` |
| `SANDBOX_RUNNER_URL` | `http://localhost:3004` |
| `AGENT_AUTO_APPLY` | `false` |
