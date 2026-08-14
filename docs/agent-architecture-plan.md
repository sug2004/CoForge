# CoForge — AI Agent Architecture

> **Status:** the design below is now **implemented** end-to-end. Sections note where
> the shipped code differs from the original plan and what remains as Phase 3.

This extends `COFORGE_SPEC.md` §6 (MCP Agent Service), which originally assumed **one shared
agent chat per session**. CoForge instead uses:

1. **Per-user private agent threads** — one per `(sessionId, userId)`.
2. **Context memory** — the agent sees live editor focus + working memory + project memory.
3. **A real pipeline** (Planner → Coder → Validator → Applier) so code is tested before it's
   proposed, not after.

Everything builds on the services that already exist (`sync-server`, `core-api`,
`sandbox-runner`) plus one new **`agent-service`** (port `3005`). The "multi-agent system"
is implemented as distinct phases inside `agent-service`, not five microservices.

---

## 1. What changed vs. the current spec

| | Current spec (§6) | Shipped implementation |
|---|---|---|
| Chat scope | One thread per `sessionId`, shared | One thread per `(sessionId, userId)` — private by default |
| Agent loop | Single call + tool loop, then reply | Planner → Coder → Validator → Applier phases, all in `agent-service` |
| Context | Prompt + `ydocSnapshot` | Live editor focus + working memory (last ~20 turns, truncated) + project memory |
| Testing | `run_tests` is a tool the model *may* call | Validator phase runs the detected test/build command automatically in a sandbox |
| Sandbox | One container per `sessionId` | One container per `(sessionId, userId, "agent")` — teammate runs can't stomp each other |
| Edit application | `agent:edit_proposed`, human accepts | Same, plus `risk`-gated auto-apply (`AGENT_AUTO_APPLY`) for low-risk validated diffs |
| Invocation | Blocking request/response | **Fire-and-forget** `POST /agent/invoke` + streamed socket events + terminal `agent:done` |
| Interrupt | — | `POST /agent/stop` aborts the in-flight run via an `AbortSignal` threaded through the pipeline |

---

## 2. High-level architecture

```
                              ┌─────────────────────────────────────────────┐
                              │                  web (Next.js)                │
                              │  Editor (Monaco+Yjs)   Per-user Agent Panel   │
                              │  reports focus ──────┐  (own chat, own tab)   │
                              └───────────────────────┼───────────────────────┘
                                       │ CRDT (raw ws)  │ agent:* (Socket.io, private room)
                                       ▼                ▼
                              ┌─────────────────────────────────────────────┐
                              │                 sync-server                   │
                              │  Y.Doc per session (shared source of truth)  │
                              │  /agent Socket.io namespace (JWT auth)       │
                              │  room session:<id>:user:<userId>             │
                              │  POST /agent/emit ← agent-service bridges    │
                              └───────────────────────┬───────────────────────┘
                                                       │ POST /agent/invoke {sessionId,userId,threadId,prompt,focus}
                                                       ▼
                              ┌─────────────────────────────────────────────┐
                              │                agent-service (:3005)          │
                              │  ┌───────────┐ ┌────────┐ ┌───────────┐      │
                              │  │  Planner  │→│ Coder  │→│ Validator │→Applier│
                              │  └───────────┘ └────────┘ └───────────┘      │
                              │  Context Memory (working + project + user)   │
                              │  /agent/apply · /agent/stop · /agent/reject  │
                              └─────┬───────────────────────────┬─────────────┘
                                     │                            │
                                     ▼                            ▼
                        ┌─────────────────────┐      ┌───────────────────────────┐
                        │  sandbox-runner      │      │ core-api (Postgres)        │
                        │  :<sid>-<uid>-agent  │      │ AgentThread, AgentMessage, │
                        │  exec: NDJSON stream │      │ ContextSnapshot, ProjectMemory, SessionEvent
                        └─────────────────────┘      └───────────────────────────┘
```

### 2.1 Realtime channel (sync-server)

Option A from the original plan was chosen. `sync.gateway.ts` (previously dead CRDT-relay
code) is now a Socket.io gateway:

- **Namespace `/agent`**, JWT-authenticated. Client connects with
  `auth: { token }` and `query: { sessionId }`; the gateway derives the user id from the
  token (`payload.sub` / `userId`) and joins room `session:<sessionId>:user:<userId>`.
- Broadcast events (`agent:edit_applied`, `session:activity`) target the whole-session room
  `session:<sessionId>` so everyone sees code land, without seeing the private chat.
- `agent-service` never talks to the client directly — it calls
  `POST /agent/emit { sessionId, userId, threadId, event, data, broadcast }` on sync-server,
  which re-emits on the socket.

### 2.2 Invocation model (agent-service)

`POST /agent/invoke` is **fire-and-forget**:

- The controller returns `{ success: true, async: true }` immediately; the pipeline runs in
  the background and streams progress over the socket. This is what fixed the original
  client/proxy timeouts (the HTTP response is only an acknowledgement).
- The client applies a 30s ack timeout on the HTTP call and a 600s client-side watchdog;
  the socket **`agent:done`** event is the terminal signal that releases the UI.
- One in-flight run per thread: a duplicate invoke for the same thread is rejected (an
  `agent:done` error is emitted rather than running two pipelines against one sandbox).

### 2.3 Events (extended §4 contract)

```ts
// Client → Server (Socket.io /agent namespace)
"agent:invoke"           { threadId, prompt }              // ack: agent:invoke:ack
"agent:context_update"   { threadId, focusFileId, cursor, selection, openFileIds }  // ~1/s, ack: agent:context_update:ack

// Server → Client (private room session:<id>:user:<uid>)
"agent:phase_started"    { threadId, phase: "planning"|"coding"|"validating"|"applying", stepIndex?, attempt? }
"agent:plan"             { threadId, steps: [{ description, files }], risk?, summary?, clarification?, needsClarification? }
"agent:message"          { threadId, text }
"agent:tool_started"     { threadId, toolCallId, toolName, args }
"agent:tool_chunk"       { threadId, toolCallId, chunk }   // live terminal output, batched ~120ms / 8KB
"agent:tool_result"      { threadId, toolCallId, result, isError }
"agent:edit_proposed"    { threadId, fileId, diff, oldContent, newContent, toolCallId }  // diff = quick hint, old/new = full Monaco diff
"agent:done"             { threadId, success, error?, autoApplied?, pendingApply?, cancelled? }  // terminal event

// Server → all clients in the session (code state changed)
"agent:edit_applied"     { threadId, userId, fileId, toolCallId }
"session:activity"       { type, actorId, summary }
```

---

## 3. Per-user agent threads

### 3.1 Why per-user, not per-session

Two people in one session are frequently doing unrelated work. A shared chat means noise in
your feed, diluted context, and no way to run two agent jobs at once without them fighting
over the same sandbox. A private thread per `(sessionId, userId)` fixes all three while the
**code itself stays fully shared** — the agent still edits the one shared `Y.Doc`, and
proposed edits are visible to everyone (§6). Only the conversation is private.

### 3.2 Data model (core-api / Prisma — implemented)

All five models from the plan exist in `apps/core-api/prisma/schema.prisma`:

```prisma
model AgentThread {         // id, sessionId, userId, title, createdAt, archivedAt
  @@unique([sessionId, userId, id]) @@index([sessionId, userId])
}
model AgentMessage {        // threadId, role: "user"|"planner"|"coder"|"validator"|"applier"|"assistant", content Json
}
model ContextSnapshot {     // threadId, focusFileId, cursor Json?, selection Json?, openFileIds String[]
}
model ProjectMemory {       // projectId @unique, summary (living agent-maintained doc), updatedAt
}
model UserProjectPreference { // projectId+userId @unique, notes
}
```

`SessionEvent` stays as the shared **audit/activity feed** (visible to the whole team,
read-only). The Applier writes `agent_edit_applied` events there.

---

## 4. Context memory (implemented)

### 4.1 Live editor focus (ephemeral, per request)
The web client reports focus on every invoke and periodically via `agent:context_update`
(throttled to ~1/sec). Stored as a `ContextSnapshot` row attached to the thread.

### 4.2 Working memory (per-thread, short-term)
`context.ts` pulls the thread's messages and keeps the last **~20 turns**, truncating any
message over ~4K chars before sending it to the model. (The planned token-budget
summarization into `role: "summary"` is not yet implemented.)

### 4.3 Project memory (per-project, long-term)
- `ProjectMemory.summary` is fetched per request and injected into the Planner/Coder system
  prompts.
- After a successful apply, `updateProjectMemory()` asks the model whether the change is
  worth remembering and appends/edits the summary (best effort).
- `search_codebase` (Qdrant/pgvector) remains **Phase 3** — not implemented.

### 4.4 User memory (per user, per project)
`UserProjectPreference.notes` is fetched and injected into the Coder system prompt for that
user's threads only.

### 4.5 What actually gets sent to the model, per request
```
system prompt
  + ProjectMemory.summary (project-wide)
  + UserProjectPreference.notes (this user only)
working memory
  + last ~20 turns of this AgentThread (truncated at ~4K chars each)
this request
  + live focus snapshot (open file, cursor, selection)
  + the user's prompt
```

---

## 5. The pipeline: Planner → Coder → Validator → Applier

Each phase is a distinct LLM call with its own system prompt and (optionally) its own model
(`PLANNER_MODEL` / `CODER_MODEL` / `MEMORY_MODEL`), orchestrated inside `agent-service`.
Phase transitions drive `agent:phase_started` events.

### 5.1 Planner
- Input: prompt + context stack (§4.5). Job: decide *what* — no code.
- Outputs a JSON plan: `{ steps: [{description, files}], needsClarification, risk }`.
- If `needsClarification`, stops and asks the user instead of guessing.
- If the plan is empty, replies with `plan.summary` only.
- Emits `agent:plan` so the user sees the plan before code moves.

### 5.2 Coder
- Input: one plan step at a time + relevant file contents + memory.
- Tool loop (max 15 iterations) with six tools: `run_terminal`, `read_file`, `list_files`,
  `grep`, `write_file`, `delete_file`. Everything writes to an in-memory **staging map**
  (`{filePath: content}`), never the live `Y.Doc`.
- `run_terminal` output is streamed to the UI as `agent:tool_chunk` events (batched
  server-side ~120ms / 8KB; client caps stored output at 120KB).
- Each step is validated before the next; each step retries up to **3 times** with the
  failing test output fed back before giving up.

### 5.3 Validator
- Applies base files + staged diff into the per-thread sandbox, then runs the detected
  test/build command (`timeoutMs: 120000`) and parses pass/fail.
- On failure loops back to Coder (bounded by retries), then surfaces
  `agent:message` + returns `success: false` if the step can't be completed.

### 5.4 Applier
- Emits `agent:edit_proposed` per file (with `oldContent`/`newContent` for the real Monaco
  diff view), then either waits for the human or auto-applies.
- Apply writes to the shared `Y.Doc` via sync-server `POST /sync/apply` and broadcasts
  `agent:edit_applied` to the whole session.
- On apply: writes a `SessionEvent`, updates `ProjectMemory` (best effort), clears the
  server-side pending entry.
- **Auto-apply policy:** `AGENT_AUTO_APPLY=true` + plan `risk === "low"` skips the manual
  click. `medium`/`high` always requires the manual click.

### 5.5 Cancellation / lifecycle
- `POST /agent/stop` aborts the thread's in-flight run. An `AbortSignal` is threaded through
  the LLM client (Anthropic + NVIDIA), the sandbox client, the tools, and every phase; a
  `throwIfAborted()` guard runs at each step boundary.
- Aborted runs emit `agent:message` ("Run cancelled.") and `agent:done` with `cancelled: true`.
- `POST /agent/reject` clears the server-side pending entry so a stale plan can't be applied
  later, and the web panel clears the review UI when a new run starts.
- If a new proposal lands while the user still has an unreviewed one, the Applier emits a
  notice that the earlier proposal is superseded (it is not silently clobbered).

---

## 6. Sandbox isolation per thread

`sandbox-runner` keys containers by arbitrary `[a-zA-Z0-9_-]+` ids, so the naming convention
is purely a call-site choice:

- **Live/manual execution** (someone hits Run): `${sessionId}` — unchanged, one shared
  container per session.
- **Agent terminal + validation runs**: `${sessionId}-${userId}-agent`
  (`validator.sandboxKey()`), shared by the whole pipeline for that thread.
- Files pushed to this container are a **snapshot of the shared `Y.Doc` with the staged diff
  applied on top** — never the live workspace.
- `POST /sandbox/:id/exec` streams NDJSON (`stdout`/`stderr`/`exit`); there is a
  one-in-flight guard per container and a hard timeout (kills the process tree via a nested
  exec). When a client aborts the stream mid-run, the controller kills the running exec
  (`SandboxService.abortExec`) so the busy slot is freed instead of staying locked until
  timeout.

---

## 7. Frontend changes (web — implemented)

- **Per-user Agent panel**: sidebar listing *this user's* threads, chat view, plan checklist,
  proposed-edit review, model-provider settings.
- **Focus reporter hook** (`useAgentContextReporter`): watches Monaco cursor/selection/active
  model and emits `agent:context_update`, throttled (~1/sec, trailing-edge).
- **Plan view**: renders `agent:plan` as a checklist that fills in live from
  `agent:phase_started` events.
- **Live tool output**: `agent:tool_chunk` events render as an auto-scrolling terminal block
  under the tool call, cleared on `agent:done`/thread switch.
- **Diff review**: `agent:edit_proposed` bubbles and the review panel render a **real Monaco
  diff** (`DiffEditor`, side-by-side, syntax-highlighted by file extension) using
  `oldContent`/`newContent` — the +/- hint text is only a fallback for old messages.
- **Stop button**: shown in the panel header while a run is active; calls `/agent/stop`.
- **Apply / Reject**: Reject also calls `/agent/reject` so the server-side pending is cleared.
- **Shared activity feed** (implied by `SessionEvent`): `agent_edit_applied` is logged; a
  dedicated activity panel is not yet built.

---

## 8. Build order — status

| # | Milestone | Status |
|---|---|---|
| 5a | AgentThread/AgentMessage/ContextSnapshot schema + CRUD on core-api; web lists/creates threads | ✅ done |
| 5b | `/agent` Socket.io namespace (sync.gateway.ts) + single-phase agent-service round trip | ✅ done (evolved into full pipeline) |
| 5c | Context reporter hook + ContextSnapshot capture + inject into system prompt | ✅ done |
| 5d | Planner → Coder split; `agent:plan` rendered in the UI | ✅ done |
| 5e | Validator wired to sandbox-runner with `${sessionId}-${userId}-agent` naming + retry loop | ✅ done |
| 5f | Applier: edit_proposed → accept → Y.Doc transaction → edit_applied broadcast; activity feed | ✅ done (edit_applied broadcast + SessionEvent; dedicated feed panel not yet) |
| 5g | ProjectMemory + UserProjectPreference: summary generation after apply, injected into prompts | ✅ done |
| 5h | Auto-apply policy + risk classification | ✅ done (`AGENT_AUTO_APPLY` + Planner risk) |
| 5i | `search_codebase` (Qdrant/pgvector) as a Planner/Coder tool | ⏳ Phase 3 — not implemented |

Plus, beyond the original plan: fire-and-forget invoke, `agent:done` terminal event,
cancellation (`/agent/stop` + AbortSignal), reject-clears-server-pending, real Monaco diff
view, and live tool-output streaming.

---

## 9. Open questions / remaining work

- **Summarization budget**: working memory is capped at ~20 truncated turns; the planned
  token-budget summarization into a `role: "summary"` message is not yet implemented.
- **Concurrent threads per user**: one in-flight run per thread is enforced, but two
  different threads of the same user each get the *same* `${sessionId}-${userId}-agent`
  sandbox, so they can't run simultaneously (409 on exec). If concurrent runs across threads
  are wanted, add a third segment to the sandbox key (`${threadId}`).
- **Cross-thread awareness**: not addressed — each thread stages against the last-applied
  shared state (kept simple by design).
- **Git integration**: intentionally deferred. `git init`/commit/show/revert tooling for the
  workspace is the next planned feature.
- **Cost/rate limiting**: per-user thread creation needs caps (N active threads,
  M requests/hour) before broad shipping; belongs in core-api's auth layer.
- **Sandbox abort nuance**: cancelling aborts the agent's request and kills the exec
  process, but any files staged inside the sandbox workspace are discarded with the run
  (staging is in-memory anyway, so nothing is lost).
