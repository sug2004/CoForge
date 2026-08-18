# Milestone 1 — Sync Spike: Plan & Approach

## Status: ✅ COMPLETE

---

## Goal
Two browser tabs editing the same file with changes converging in real-time.
Language selection synced across all tabs.
No auth, no persistence, no agent — pure CRDT sync proof of concept.

---

## 1. What We Built

```
Browser Tab 1                    Browser Tab 2
  Next.js (web)                    Next.js (web)
  Monaco Editor                    Monaco Editor
  Manual Yjs↔Monaco binding        Manual Yjs↔Monaco binding
  Yjs Y.Doc                        Yjs Y.Doc
  y-websocket provider             y-websocket provider
        |                                |
        |-------- raw WebSocket ---------|
                      |
              sync-server (NestJS)
              ws.Server (raw WebSocket)
              Yjs Y.Doc per room (in-memory)
              y-protocols sync step 1/2 + update relay
              room = sessionId (from URL path)
```

### Data Flow — Text Edits
1. User types in Tab 1 → Monaco `onDidChangeContent` fires
2. Change written to `Y.Text` via `ydoc.transact()`
3. Yjs encodes delta as binary CRDT update
4. `y-websocket` provider sends update to sync-server over raw WebSocket
5. sync-server receives sync message → applies to server `Y.Doc` → broadcasts raw message to all other conns in room
6. Tab 2 receives update → Yjs merges → `yObserver` fires → `model.applyEdits()` updates Monaco

### Data Flow — Language Change
1. User changes dropdown in Tab 1 → writes `language` to `ydoc.getMap('fileMeta')`
2. Yjs syncs `fileMeta` update to server → server broadcasts to all conns
3. All tabs (including Tab 1) receive update via `fileMeta.observe(metaObserver)`
4. `metaObserver` calls `applyLanguage(lang)` → `setLanguage()` + `monaco.editor.setModelLanguage()`

---

## 2. Services

| Service | Role | Port |
|---|---|---|
| `apps/web` | Next.js — Monaco editor UI | 3000 |
| `apps/sync-server` | NestJS — Yjs relay + room management | 3001 |

---

## 3. Final Tech Choices

| Choice | Reason |
|---|---|
| Yjs | CRDT library, conflict-free merges |
| y-websocket | Client-side WebSocket provider (v3 — client only, no server utility) |
| y-protocols + lib0 | Manual sync protocol implementation (step1/step2/update + awareness) |
| `ws` package | Raw WebSocket server in NestJS — y-websocket client requires raw WS not Socket.io |
| Manual Yjs↔Monaco binding | `y-monaco` dropped — broken ESM import incompatible with Turbopack |
| `@monaco-editor/react` | React wrapper for Monaco, handles dynamic loading |
| `dynamic(() => import(...), { ssr: false })` in a client component wrapper | Required by Next.js App Router — `ssr:false` not allowed in Server Components |
| pnpm workspaces | Monorepo tooling |

---

## 4. Yjs Document Structure (as built)

```ts
ydoc.getMap('files')      // Y.Map<string, Y.Text>  — fileId -> content
                          // 'main' key used for the single file in this milestone

ydoc.getMap('fileMeta')   // Y.Map<string, string>
                          // 'language' key stores current editor language
                          // synced across all tabs in real-time
```

`openFiles` (Y.Array) deferred to Milestone 7 when multi-file support is added.

---

## 5. Sync Protocol (manual implementation)

`y-websocket` v3 ships client-only — no `setupWSConnection` server utility.
Implemented manually in `sync-server/src/main.ts` using `y-protocols` + `lib0`:

```
Client connects
  <- server sends MESSAGE_SYNC + writeSyncStep1 (state vector)

Client receives step1
  -> sends MESSAGE_SYNC + syncStep2 (missing updates) back to server
  server applies step2 to Y.Doc, replies if encoder has content

Client makes an edit
  -> sends MESSAGE_SYNC + update
  server applies update to Y.Doc
  server broadcasts raw message to all other conns in room

Awareness
  -> client sends MESSAGE_AWARENESS
  server applies + broadcasts to all other conns
```

Broadcast logic: `readSyncMessage` return value checked against
`messageYjsSyncStep2` and `messageYjsUpdate` to identify update messages
before broadcasting — step1 replies are NOT broadcast to other clients.

---

## 6. Final Folder Structure

```
CoForge/
  apps/
    web/
      app/
        page.tsx                    # redirects / -> /session/demo
        session/[id]/
          page.tsx                  # server component, uses EditorWrapper
      components/
        EditorWrapper.tsx           # 'use client' wrapper — holds dynamic import with ssr:false
        Editor.tsx                  # Monaco + manual Yjs binding + language sync
      lib/
        ydoc.ts                     # creates Y.Doc + WebsocketProvider
      next.config.ts                # turbopack: {} to silence webpack conflict warning
      package.json

    sync-server/
      src/
        main.ts                     # NestJS + ws.Server + manual Yjs sync protocol
        app.module.ts
        sync/
          sync.module.ts
      package.json

  docs/
    crdt-sync-plan.md             # this file
```

---

## 7. Key Files & Responsibilities

### sync-server

| File | Responsibility |
|---|---|
| `main.ts` | NestJS bootstrap, `ws.Server` attached to http server, `handleConnection` per room, full sync protocol |
| `app.module.ts` | Imports `SyncModule` only |
| `sync/sync.module.ts` | Empty NestJS module (protocol lives in main.ts) |

### web

| File | Responsibility |
|---|---|
| `lib/ydoc.ts` | Creates `Y.Doc` + `WebsocketProvider`, returns `{ ydoc, provider }` |
| `components/Editor.tsx` | Monaco mount, waits for provider sync, binds `Y.Text` to model, syncs language via `fileMeta` |
| `components/EditorWrapper.tsx` | Client component wrapper for `dynamic(Editor, { ssr: false })` |
| `app/session/[id]/page.tsx` | Server component, renders `EditorWrapper` with `sessionId` |
| `app/page.tsx` | Redirects `/` to `/session/demo` |

---

## 8. Issues Encountered & How They Were Resolved

| Issue | Root Cause | Fix |
|---|---|---|
| `y-websocket/bin/utils` not found | v3 exports client only, no server utility | Implemented sync protocol manually with `y-protocols` + `lib0` |
| `y-monaco` module not found (Turbopack) | `y-monaco` hardcodes `monaco-editor/esm/vs/editor/editor.api.js` — Turbopack can't resolve it | Dropped `y-monaco`, wrote manual 60-line Yjs↔Monaco binding |
| `ssr: false` not allowed in Server Component | Next.js App Router rule | Created `EditorWrapper.tsx` as a `'use client'` component to hold the dynamic import |
| Changes only appear after reload | Server was broadcasting sync step2 replies to other clients, corrupting their decoder | Fixed: only broadcast messages where `readSyncMessage` returns `messageYjsUpdate` or `messageYjsSyncStep2` |
| `hello` mirrored as `olleh` in same tab | `yObserver` was firing for local transactions | Added `if (transaction.local) return` guard in observer |
| Language change not syncing | `cleanupRef` was overwritten, breaking the `metaObserver` chain | Split into `textCleanupRef` + `metaCleanupRef`, made `metaObserver` the single source of truth |
| Language change not applying locally | `monacoInstance` from `useMonaco()` was null when observer fired | Replaced with `monaco` param from `onMount`, stored in `monacoRef` |
| `Unexpected end of array` on connect | Server was broadcasting raw `data` buffer (including step2 replies) to other clients | Removed doc update event handler, broadcast only inside message handler |
| `pnpm-workspace.yaml` in `apps/web` | `create-next-app` created it, conflicting with root workspace | Deleted it, added `turbopack: {}` to `next.config.ts` |
| NestJS scaffold `pnpm install` failed | `unrs-resolver` build scripts blocked by pnpm security policy | Ran `pnpm approve-builds` |

---

## 9. Acceptance Criteria — Results

| Test | Result |
|---|---|
| Open `/session/demo` in two tabs | ✅ Both load Monaco editor |
| Type in Tab 1 | ✅ Appears in Tab 2 in real-time |
| Type in Tab 2 | ✅ Appears in Tab 1 in real-time |
| Simultaneous edits | ✅ No data loss, CRDT merges correctly |
| Refresh a tab | ✅ Content persists (in-memory on server) |
| Open `/session/other` | ✅ Isolated document, no bleed from `demo` |
| Change language in Tab 1 | ✅ Dropdown + Monaco LSP updates in Tab 2 instantly |

---

## 10. Out of Scope (deferred)

- Auth / JWT — Milestone 2
- Presence / cursors / awareness UI — Milestone 2
- File tree / multiple files — Milestone 7
- Agent integration — Milestone 4
- Persistence to database — Milestone 2
- `openFiles` Yjs array — Milestone 7
- Socket.io — Milestone 4 (agent events)
- Multi-instance sync-server scaling (`y-redis`) — post-MVP
