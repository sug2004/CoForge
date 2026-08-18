# Agent Refactoring — DeepSeek Harness Pattern Adoption

> Status: **PLANNING**
>
> Goal: refactor `agent-service` from a monolithic pipeline into a plugin-based
> architecture inspired by DeepSeek Harness (dsh), without rewriting the whole
> service. Each phase is independently shippable and backward-compatible.

---

## Why

The current `agent-service` works but has structural limits:

| Problem | Impact |
|---|---|
| Tools are a switch statement in `AgentTools.run()` | Adding a tool means editing the core class; no external extensibility |
| LLM client is hardcoded to NVIDIA NIM | Can't swap to DeepSeek, Anthropic, or local models without forking |
| System prompt is string-concatenated in each phase | Prompt sections can't be composed from plugins |
| No session event log | Runs aren't replayable; context is lost on restart |
| No compaction | Long conversations hit the context window and degrade |
| Pipeline is a single 726-line function | Hard to add phases, intercept steps, or compose custom flows |
| No tool lifecycle hooks | Can't add pre/post-execution logic (approval, logging, rate limiting) |

DeepSeek Harness solves all of these with **capability seams** (Service Definition → Provider → Consumer), **event-driven extension points**, and a **plugin registry**. We adopt the patterns, not the framework.

---

## Architecture

### Current state

```
AgentService (monolith)
  ├── LlmClient (hardcoded NVIDIA NIM)
  ├── ContextService (manual string assembly)
  ├── Planner (hardcoded system prompt)
  ├── Coder (hardcoded tool loop)
  ├── Validator (hardcoded sandbox exec)
  ├── Applier (hardcoded Y.Doc write)
  ├── AgentTools (switch statement)
  ├── AgentEmitter (Socket.IO bridge)
  └── Chat (small talk)
```

### Target state

```
AgentHost (lightweight orchestrator)
  ├── PluginRegistry
  │   ├── llm/        → NvidiaProvider, DeepSeekProvider, OpenAIProvider, ...
  │   ├── tools/      → RunTerminal, ReadFile, Glob, Grep, WriteFile, DeleteFile, SearchCodebase, ...
  │   ├── prompts/    → ProjectContext, WorkingMemory, UserPreferences, ToolDocs, ...
  │   ├── phases/     → PlannerPhase, CoderPhase, ValidatorPhase, ApplierPhase
  │   ├── sandbox/    → DockerSandboxProvider, E2BSandboxProvider, LocalSandboxProvider
  │   └── lifecycle/  → CompactionPlugin, SessionLogPlugin, ApprovalPlugin
  ├── SessionLog (append-only JSONL per thread)
  ├── EventBus (typed events with waterfall hooks)
  └── AgentRunner (turn/step loop, delegates to plugins)
```

---

## 1. Capability Seam Interface

**What:** Extract a `Capability` interface that every tool, LLM provider, and
sandbox backend implements. This is the core abstraction from dsh.

```ts
// apps/agent-service/src/agent/capability.ts

export interface Capability {
  /** Unique name (e.g. "run_terminal", "nvidia-nim", "docker-sandbox") */
  name: string;
  /** Capabilities declare what they provide */
  provides: string[];  // e.g. ["tool", "llm", "sandbox"]
  /** Lifecycle hooks */
  init?(ctx: AgentContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

**Tool seam:**

```ts
export interface ToolDefinition {
  name: string;
  description: string;          // shown to the model
  schema: Record<string, any>;  // JSON Schema for args
}

export interface ToolProvider extends Capability {
  provides: ["tool"];
  definition: ToolDefinition;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  sandboxId: string;
  staged: Record<string, string>;
  signal?: AbortSignal;
  onChunk?: ToolChunkHandler;
}
```

**LLM seam:**

```ts
export interface LlmProvider extends Capability {
  provides: ["llm"];
  complete(params: LlmParams): Promise<ChatCompletion>;
  supports(model: string): boolean;
}

export interface LlmParams {
  system: string;
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}
```

**Sandbox seam:**

```ts
export interface SandboxProvider extends Capability {
  provides: ["sandbox"];
  run(id: string, command: string, opts: RunOpts): Promise<RunResult>;
  pushFiles(id: string, files: Record<string, string>, deleted?: string[]): Promise<void>;
  touch(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}
```

**Phase seam** (the pipeline steps):

```ts
export interface PhaseDefinition {
  name: string;  // "planning" | "coding" | "validating" | "applying"
}

export interface PhaseProvider extends Capability {
  provides: ["phase"];
  definition: PhaseDefinition;
  execute(input: PhaseInput, ctx: PhaseContext): Promise<PhaseOutput>;
}

export interface PhaseContext {
  llm: LlmProvider;
  tools: ToolProvider[];
  sandbox: SandboxProvider;
  emitter: AgentEmitter;
  sessionLog: SessionLog;
  signal?: AbortSignal;
}
```

---

## 2. Plugin Registry

**What:** A central registry where capabilities are registered and resolved by
name. Inspired by dsh's Cordis `ctx` keys.

```ts
// apps/agent-service/src/agent/registry.ts

export class PluginRegistry {
  private readonly capabilities = new Map<string, Capability[]>();

  register(cap: Capability): void {
    for (const key of cap.provides) {
      const list = this.capabilities.get(key) ?? [];
      list.push(cap);
      this.capabilities.set(key, list);
    }
  }

  get<T extends Capability>(kind: string, name?: string): T {
    const list = this.capabilities.get(kind) ?? [];
    const found = name
      ? list.find(c => c.name === name)
      : list[0];
    if (!found) throw new Error(`No ${kind} provider${name ? ` "${name}"` : ""} registered`);
    return found as T;
  }

  getAll<T extends Capability>(kind: string): T[] {
    return (this.capabilities.get(kind) ?? []) as T[];
  }
}
```

**Usage in the runner:**

```ts
const tools = registry.getAll<ToolProvider>("tool");
const llm = registry.get<LlmProvider>("llm");
const sandbox = registry.get<SandboxProvider>("sandbox");
const phases = registry.getAll<PhaseProvider>("phase");
```

---

## 3. Tool Registry (replaces switch statement)

**What:** Convert the 7 hardcoded tools into registered `ToolProvider`
implementations. The coder's tool loop calls `registry.getAll<ToolProvider>("tool")`
instead of a switch.

```ts
// apps/agent-service/src/agent/tools/run-terminal.tool.ts

@Injectable()
export class RunTerminalTool implements ToolProvider {
  name = "run_terminal";
  provides = ["tool"] as const;

  definition: ToolDefinition = {
    name: "run_terminal",
    description: "Run a shell command in the sandbox...",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeoutMs: { type: "number", description: "Timeout in ms (max 300000)" },
        cwd: { type: "string", description: "Working directory (relative to /workspace)" },
      },
      required: ["command"],
    },
  };

  constructor(private readonly sandbox: SandboxProvider) {}

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    // ... implementation (moved from AgentTools.runTerminal)
  }
}
```

The coder generates tool docs dynamically from registered definitions:

```ts
function buildToolDoc(tools: ToolProvider[]): string {
  return tools
    .map(t => `- ${t.definition.name} ${JSON.stringify(t.definition.schema.properties)}`)
    .join("\n");
}
```

---

## 4. Prompt Sections (replaces string concatenation)

**What:** Each plugin registers prompt sections that get assembled into the
system prompt. Inspired by dsh's `systemPrompt` plugin.

```ts
// apps/agent-service/src/agent/prompt-sections.ts

export interface PromptSection {
  name: string;
  priority: number;  // lower = earlier in prompt
  render(ctx: AgentContext): string;
}

// Example sections:
// - "project-memory"  → renders ProjectMemory.summary
// - "tool-docs"       → renders tool schemas from registry
// - "project-layout"  → renders describeWorkspace()
// - "instructions"    → renders AGENTS.md / CLAUDE.md
// - "user-preferences"→ renders UserProjectPreference.notes
```

Each phase assembles its prompt from registered sections:

```ts
const sections = registry.getAll<PromptSection>("prompt")
  .sort((a, b) => a.priority - b.priority);

const system = sections.map(s => s.render(context)).join("\n\n");
```

---

## 5. Event Bus (typed events with waterfall hooks)

**What:** A lightweight event system for tool lifecycle, phase transitions, and
interception. Not Socket.IO — this is internal to the agent pipeline.

```ts
// apps/agent-service/src/agent/events.ts

export type AgentEventMap = {
  "tool:pre-execute": { tool: ToolProvider; args: Record<string, any>; ctx: ToolContext };
  "tool:post-execute": { tool: ToolProvider; result: ToolResult; ctx: ToolContext };
  "phase:start": { phase: PhaseDefinition; input: PhaseInput };
  "phase:end": { phase: PhaseDefinition; output: PhaseOutput };
  "step:start": { index: number; plan: Plan };
  "step:end": { index: number; result: CoderOutput };
  "turn:start": { prompt: string };
  "turn:end": { success: boolean };
};

// Waterfall: listeners call `next()` to delegate; returning without it
// short-circuits the chain (can reject, modify args, etc.)
export type EventHandler<T> = (event: T, next: () => Promise<void>) => Promise<void>;
```

**Use case — approval gate:**

```ts
eventBus.on("tool:pre-execute", async (event, next) => {
  if (event.tool.name === "delete_file" && event.args.path.includes("src/")) {
    // Could prompt the user for approval here
    console.log(`Approval requested for deleting ${event.args.path}`);
  }
  await next();
});
```

---

## 6. Session Event Log

**What:** Append-only log per thread so runs are replayable and context can be
recovered. Written to JSONL files on disk (not just Prisma rows).

```ts
// apps/agent-service/src/agent/session-log.ts

export type SessionEventType =
  | "turn:start"
  | "turn:end"
  | "step:start"
  | "step:end"
  | "user:message"
  | "assistant:message"
  | "tool:call"
  | "tool:result"
  | "plan:produced"
  | "edit:proposed"
  | "edit:applied";

export interface SessionEvent {
  type: SessionEventType;
  timestamp: number;
  threadId: string;
  data: Record<string, any>;
}

export class SessionLog {
  constructor(private readonly logDir: string) {}

  append(event: SessionEvent): void {
    // Append to thread-specific JSONL file
    const file = path.join(this.logDir, `${event.threadId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  }

  read(threadId: string, opts?: { since?: number; limit?: number }): SessionEvent[] {
    // Read back events for replay / context reconstruction
  }

  fork(sourceThreadId: string, childThreadId: string): void {
    // Copy events up to a boundary into a child thread
  }
}
```

---

## 7. Compaction

**What:** Summarize old turns when the context window fills up. Currently
the coder just truncates messages and loses context.

```ts
// apps/agent-service/src/agent/compaction.ts

export class CompactionPlugin implements Capability {
  name = "compaction";
  provides = ["lifecycle"];

  constructor(private readonly llm: LlmProvider) {}

  async compact(messages: LlmMessage[], budget: number): Promise<LlmMessage[]> {
    const total = messages.reduce((s, m) => s + m.content.length, 0);
    if (total <= budget) return messages;

    // Keep the last 4 turns intact; summarize everything before them
    const keep = messages.splice(-8);
    const toSummarize = messages;

    const summary = await this.llm.complete({
      system: "Summarize this conversation concisely, preserving key decisions and file changes.",
      messages: toSummarize.map(m => ({ role: m.role, content: m.content })),
      maxTokens: 1024,
    });

    return [
      { role: "user", content: `[Conversation summary]\n${summary.text}` },
      ...keep,
    ];
  }
}
```

---

## 8. Refactored Agent Runner

**What:** Replace the monolithic `AgentService.runPipeline()` with a clean
turn/step loop that delegates to plugins.

```ts
// apps/agent-service/src/agent/runner.ts

export class AgentRunner {
  constructor(
    private readonly registry: PluginRegistry,
    private readonly sessionLog: SessionLog,
    private readonly eventBus: AgentEventMap,
  ) {}

  async run(request: InvokeRequest, signal?: AbortSignal): Promise<InvokeResponse> {
    const phases = this.registry.getAll<PhaseProvider>("phase");
    const llm = this.registry.get<LlmProvider>("llm");
    const compaction = this.registry.get<CompactionPlugin>("lifecycle");

    // Build context
    let context = await this.buildContext(request);
    let messages = this.sessionLog.read(request.threadId).map(/* ... */);

    // Compaction check
    if (compaction) {
      messages = await compaction.compact(messages, MAX_CONTEXT_CHARS);
    }

    // Execute phases in order
    const phaseCtx: PhaseContext = {
      llm,
      tools: this.registry.getAll<ToolProvider>("tool"),
      sandbox: this.registry.get<SandboxProvider>("sandbox"),
      emitter: /* ... */,
      sessionLog: this.sessionLog,
      signal,
    };

    for (const phase of phases) {
      const input = { context, messages, prompt: request.prompt };
      const output = await phase.execute(input, phaseCtx);
      messages.push(/* ... */);
    }
  }
}
```

---

## 9. NestJS Integration

Keep NestJS as the host framework. Plugins are registered at module init:

```ts
// apps/agent-service/src/agent/agent.module.ts

@Module({
  providers: [
    PluginRegistry,
    SessionLog,
    AgentRunner,
    // Tools
    RunTerminalTool,
    ReadFileTool,
    GlobTool,
    GrepTool,
    ListFilesTool,
    WriteFileTool,
    DeleteFileTool,
    // LLM
    NvidiaLlmProvider,
    // Sandbox
    DockerSandboxProvider,
    // Phases
    PlannerPhase,
    CoderPhase,
    ValidatorPhase,
    ApplierPhase,
    // Prompt sections
    ProjectMemorySection,
    ToolDocsSection,
    WorkspaceLayoutSection,
    // Lifecycle
    CompactionPlugin,
    SessionLogPlugin,
  ],
})
export class AgentModule {}
```

---

## 10. Migration Strategy

### Phase 1 — Interfaces only (no behavior change)

Extract interfaces from existing code. The monolith still works, but now
conforms to `ToolProvider`, `LlmProvider`, etc.

| File | Change |
|---|---|
| `capability.ts` | NEW — all interfaces |
| `registry.ts` | NEW — plugin registry |
| `events.ts` | NEW — event bus |
| `client.ts` | `LlmClient` implements `LlmProvider` |
| `tools.ts` | `AgentTools` wraps a `PluginRegistry` internally |
| `types.ts` | Add `ToolContext`, `ToolResult` interfaces |

**Test:** existing tests pass, no behavior change.

### Phase 2 — Tool extraction

Split `AgentTools` switch into individual classes. Register them in the
module. The coder reads tool definitions from the registry.

| File | Change |
|---|---|
| `tools/run-terminal.tool.ts` | NEW — extracted from `AgentTools.runTerminal` |
| `tools/read-file.tool.ts` | NEW — extracted from `AgentTools.readFile` |
| `tools/glob.tool.ts` | NEW — extracted from `AgentTools.glob` |
| `tools/grep.tool.ts` | NEW — extracted from `AgentTools.grep` |
| `tools/list-files.tool.ts` | NEW — extracted from `AgentTools.listFiles` |
| `tools/write-file.tool.ts` | NEW — extracted from `AgentTools.writeFile` |
| `tools/delete-file.tool.ts` | NEW — extracted from `AgentTools.deleteFile` |
| `coder.ts` | Read tools from registry instead of `AgentTools` |

**Test:** tool execution tests pass; new unit tests per tool.

### Phase 3 — Prompt sections

Extract hardcoded strings from `Planner` and `Coder` into registered
prompt sections.

| File | Change |
|---|---|
| `prompts/project-memory.ts` | NEW |
| `prompts/tool-docs.ts` | NEW |
| `prompts/workspace-layout.ts` | NEW |
| `prompts/instructions.ts` | NEW |
| `prompts/user-preferences.ts` | NEW |
| `planner.ts` | Assemble system prompt from sections |
| `coder.ts` | Assemble system prompt from sections |

**Test:** planner/coder output unchanged (snapshot test).

### Phase 4 — LLM provider abstraction

Make `LlmClient` implement the `LlmProvider` interface with a factory
that selects the provider from config.

| File | Change |
|---|---|
| `llm/nvidia.provider.ts` | Rename from `client.ts` |
| `llm/factory.ts` | NEW — selects provider from `LLM_PROVIDER` env |
| `.env.example` | Add `LLM_PROVIDER=nvidia` |

**Test:** existing LLM tests pass.

### Phase 5 — Session log

Add JSONL-based session log alongside existing Prisma storage.

| File | Change |
|---|---|
| `session-log.ts` | NEW |
| `agent.service.ts` | Log events on every phase transition and tool call |
| `agent.module.ts` | Register SessionLog |

**Test:** log files written correctly; events readable.

### Phase 6 — Compaction

Add compaction to replace the hardcoded truncation in `coder.ts`.

| File | Change |
|---|---|
| `compaction.ts` | NEW |
| `coder.ts` | Use compaction instead of `trimContext` |

**Test:** long conversations stay within budget.

### Phase 7 — Event bus + lifecycle hooks

Add the event bus for tool pre/post hooks.

| File | Change |
|---|---|
| `events.ts` | NEW — already defined in step 1, now wired |
| `coder.ts` | Emit `tool:pre-execute` / `tool:post-execute` events |

**Test:** event handlers fire on tool calls.

---

## 11. New file structure

```
apps/agent-service/src/
  main.ts
  app.module.ts
  agent/
    capability.ts              # interfaces (ToolProvider, LlmProvider, ...)
    registry.ts                # PluginRegistry
    events.ts                  # AgentEventMap + EventEmitter
    runner.ts                  # AgentRunner (replaces runPipeline)
    session-log.ts             # append-only JSONL log
    compaction.ts              # context summarization
    agent.controller.ts        # HTTP endpoints (unchanged)
    agent.module.ts            # NestJS module (registers all plugins)
    agent.service.ts           # thin controller → delegates to runner
    pipeline/
      types.ts                 # Plan, CoderOutput, EditorFocus, ...
      context.ts               # buildContext (unchanged for now)
      emitter.ts               # AgentEmitter → Socket.IO (unchanged)
      workspace.ts             # describeWorkspace (unchanged)
      discovery.ts             # discoverProject (unchanged)
      json.ts                  # extractJson helpers (unchanged)
      chat.ts                  # small talk (unchanged)
      http.ts                  # fetchWithTimeout (unchanged)
    llm/
      nvidia.provider.ts       # NVIDIA NIM (extracted from client.ts)
      openai-compat.ts         # base class for OpenAI-compatible providers
    tools/
      run-terminal.tool.ts     # extracted from AgentTools
      read-file.tool.ts
      list-files.tool.ts
      glob.tool.ts
      grep.tool.ts
      write-file.tool.ts
      delete-file.tool.ts
    prompts/
      project-memory.ts        # PromptSection
      tool-docs.ts
      workspace-layout.ts
      instructions.ts
      user-preferences.ts
    phases/
      planner.phase.ts         # extracted from Planner
      coder.phase.ts           # extracted from Coder
      validator.phase.ts       # extracted from Validator
      applier.phase.ts         # extracted from Applier
```

---

## 12. Backward compatibility

Every phase is backward-compatible:

- **No new dependencies** — only TypeScript interfaces and refactoring
- **Socket.IO events unchanged** — the emitter stays the same
- **HTTP API unchanged** — controller endpoints are identical
- **Prisma schema unchanged** — session log is additive (JSONL files, not
  replacing AgentMessage rows)
- **Config unchanged** — existing env vars work; new `LLM_PROVIDER` is
  optional with default `nvidia`
- **Tests pass at every phase** — each step is a refactor, not a rewrite

---

## 13. Future extensibility

After this refactoring:

| Want to... | How |
|---|---|
| Add a new tool | Implement `ToolProvider`, register in module. Done. |
| Swap LLM provider | Implement `LlmProvider`, set `LLM_PROVIDER=deepseek` |
| Add a new phase | Implement `PhaseProvider`, register in module |
| Intercept tool calls | `eventBus.on("tool:pre-execute", ...)` |
| Add approval gates | Plugin on `tool:pre-execute` that blocks on user response |
| Run code search | Register a `SearchCodebaseTool` that hits pgvector/Qdrant |
| Add subagents | Implement a `SubagentProvider` with its own `AgentRunner` |
| Add git integration | Register `GitCommitTool`, `GitDiffTool`, etc. |
| Support E2B sandbox | Implement `SandboxProvider` for E2B API |
| Add workflow orchestration | Register a `WorkflowPhase` that chains multiple plans |

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Breaking existing tests during refactor | Each phase is a standalone PR; run tests before merge |
| Performance overhead from abstraction | Negligible — registry is a Map lookup, events are sync |
| Over-engineering for current scale | Interfaces are thin; the registry is 40 lines. Can simplify later |
| Session log disk usage | JSONL is compact; add retention policy (keep last 100 threads) |
| Compaction quality | Start with simple truncation+summarize; iterate on prompt |

---

## 15. Out of scope

This refactoring does **not** change:

- The NestJS framework or HTTP API
- The Socket.IO event contract with the frontend
- The Prisma data model or core-api
- The sandbox-runner Docker infrastructure
- The Y.Doc sync layer
- The web frontend
