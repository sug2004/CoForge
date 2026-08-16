# CoForge — Setup & Run

Step-by-step guide to get all services running locally.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20+ | Runtime |
| pnpm | 9+ | Package manager |
| Docker Desktop | running | Postgres, Redis, sandbox containers |

Verify before starting:

```bash
node -v
pnpm -v
docker info --format '{{.ServerVersion}}'
```

---

## 1. Install dependencies

Run from the repo root:

```bash
cd apps/core-api      && pnpm install && cd ../..
cd apps/sync-server   && pnpm install && cd ../..
cd apps/sandbox-runner && pnpm install && cd ../..
cd apps/web           && pnpm install && cd ../..
```

Each app is a standalone pnpm project (no workspace file at root).

---

## 2. Start infrastructure

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL 16** on `localhost:5432` (user: `postgres`, pass: `postgres`, db: `coforge`)
- **Redis 7** on `localhost:6379` (not yet used, reserved for BullMQ/Socket.io adapter)

---

## 3. Configure environment variables

Each app reads its own `.env` file. Existing files:

| App | Config file | Status |
|---|---|---|
| `apps/core-api` | `.env` | Pre-configured for local dev |
| `apps/sync-server` | none (uses defaults) | Optional — see below |
| `apps/sandbox-runner` | none (uses defaults) | Optional — see below |
| `apps/web` | `.env.local` | Pre-configured (`NEXT_PUBLIC_CORE_API_URL=http://localhost:3002`) |

### sync-server (optional `.env`)

Create `apps/sync-server/.env` only if you changed `JWT_SECRET` in core-api or run sandbox-runner on a non-default port:

```env
JWT_SECRET=supersecretchangeme   # must match core-api's JWT_SECRET
SANDBOX_RUNNER_URL=http://localhost:3004
```

### sandbox-runner (optional `.env`)

Create `apps/sandbox-runner/.env` only on non-Windows or if Docker uses a non-default socket:

```env
DOCKER_HOST=                     # empty = auto-detect (named pipe on Windows, /var/run/docker.sock on Linux)
MAX_CONTAINERS=10
CONTAINER_IDLE_TIMEOUT_MS=900000
PORT=3004
```

---

## 4. Run database migrations

```bash
cd apps/core-api
npx prisma migrate deploy
cd ../..
```

This applies all Prisma migrations to the `coforge` database.

---

## 5. Start services

Open **4 terminal tabs** (or use background processes) and start each service:

### Terminal 1 — core-api (`:3002`)

```bash
cd apps/core-api
pnpm start:dev
```

Verify: `curl http://localhost:3002/sandbox/health` should 404 (correct — no `/sandbox` on core-api).

### Terminal 2 — sync-server (`:3001`)

```bash
cd apps/sync-server
pnpm start:dev
```

Verify: check for `sync-server running on ws://localhost:3001` in the output.

### Terminal 3 — sandbox-runner (`:3004`)

```bash
cd apps/sandbox-runner
pnpm start:dev
```

Verify: `curl http://localhost:3004/sandbox/health` → `{"ok":true}`.

### Terminal 4 — web (`:3000`)

```bash
cd apps/web
pnpm dev
```

Verify: open `http://localhost:3000` in a browser.

---

## 6. Verify the full stack

### Login
1. Open `http://localhost:3000`
2. Register an account or sign in with GitHub (requires `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `apps/core-api/.env`)
3. You should land on the dashboard

### Create workspace → project → session
1. Dashboard → create a workspace
2. Open the workspace → create a project (optionally provide a GitHub repo URL)
3. Start a new session
4. You should land in the collaborative editor

### Test real-time sync
1. Open the same session URL in a **second browser tab**
2. Type in one tab → changes appear in the other

### Test the sandbox
1. In the editor's **Terminal** panel at the bottom, click into the terminal and type a command (e.g. `echo hello`)
2. Press Enter — this is a real PTY shell, so `cd`, `export`, Ctrl+C, and long-running processes like `npm run dev` all work
3. Output (colors, spinners, progress bars) streams live to all connected clients
4. Files produced in the sandbox (lockfiles, build output) appear in the file tree automatically

---

## Service URLs

| Service | URL | Role |
|---|---|---|
| web | `http://localhost:3000` | Editor UI |
| sync-server | `ws://localhost:3001` | Yjs CRDT relay + sandbox relay |
| core-api | `http://localhost:3002` | Auth, CRUD, JWT |
| sandbox-runner | `http://localhost:3004` | Docker container execution |
| PostgreSQL | `localhost:5432` | Database |
| Redis | `localhost:6379` | Reserved (BullMQ, Socket.io adapter) |

---

## Quick smoke test (no browser)

```bash
# Health check
curl http://localhost:3004/sandbox/health

# Run a command via sandbox-runner directly
node -e "
fetch('http://localhost:3004/sandbox/test/exec', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command: 'echo sandbox works' })
}).then(r => r.body.getReader()).then(async r => {
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    process.stdout.write(new TextDecoder().decode(value));
  }
});
"
```

Expected output:
```
{"stream":"stdout","chunk":"sandbox works\n"}
{"stream":"exit","exitCode":0,"timeout":false}
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `sandbox-runner`: "Docker daemon not reachable" | Start Docker Desktop |
| `sandbox-runner`: container creation fails | Ensure `node:20-slim` image is pulled: `docker pull node:20-slim` |
| `web`: 401 on `/me` | Core-api not running or JWT cookie expired — re-login |
| `sync-server`: ws connections rejected 4001 | JWT_SECRET mismatch — ensure sync-server's JWT_SECRET matches core-api |
| `core-api`: PrismaClient not found | Run `npx prisma generate` in `apps/core-api` |
| Port conflict | Check `lsof -i :3000` (or equivalent) for conflicting processes |
