# core-api

NestJS + Prisma (PostgreSQL) REST API for CoForge. Owns identity, workspaces,
projects, sessions, agent threads, and project memory.

## Endpoints (highlights)

- `GET /auth/github`, `GET /auth/github/callback` — GitHub OAuth login, issues a JWT
- `GET /me/token` — fresh socket-auth token for the agent connection
- `/workspaces`, `/projects`, `/sessions` — CRUD for the collaboration tree
- `/sessions/:id/agent-threads/:threadId` — agent chat threads + messages + context snapshots
- `/projects/:id/memory`, `/projects/:id/preferences` — agent context (never `null` — defaults to empty objects)
- `/sessions/:id/events` — shared audit trail (e.g. `agent_edit_applied`)

## Development

```bash
pnpm install
npx prisma migrate deploy   # apply schema to Postgres
pnpm start:dev              # http://localhost:3002
```

## Env

`DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`
(keep `JWT_SECRET` in sync with the sync-server process env).
