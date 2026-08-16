import { Injectable, Logger } from "@nestjs/common";
import { LlmClient, LlmMessage, LlmOverride } from "./client";
import {
  AgentCancelledError,
  AgentContext,
  CoderOutput,
  PlanStep,
  throwIfAborted,
} from "./types";
import { extractJson, extractJsonObjects } from "./json";
import { AgentEmitter } from "./emitter";
import { AgentTools } from "./tools";
import { describeWorkspace } from "./workspace";
import { discoverProject } from "./discovery";

export interface CoderOptions {
  sessionId: string;
  userId: string;
  threadId: string;
  sandboxId: string;
  failureFeedback?: string;
  override?: LlmOverride;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

const MAX_TOOL_ITERATIONS = 24;
const MAX_CONTEXT_MESSAGES = 30;
// Total character budget for the messages array sent to the model. Keeps the
// request bounded so it stays comfortably under the provider's token budget;
// older turns (and oversized tool results) are trimmed to fit.
const MAX_CONTEXT_CHARS = 16_000;
const STEP_CONTENT_CAP = 4_000;
const TOOL_RESULT_CAP = 2_500;

const TOOL_DOC = `You have these tools:
- run_terminal {"command": "...", "timeoutMs": 60000, "cwd": "app"}
    Run any shell command (node, npm, tsc, git, python, ls, etc.). The result
    includes the output and exit code. Use this to inspect state, install deps,
    run the build/tests, and debug. Optional "cwd" runs the command from that
    directory (relative to /workspace, e.g. "app" — no cd needed). It is a
    one-shot call: the command is killed after timeoutMs (max 300s), so do NOT
    use it to run a long-lived dev server. To start a server, launch it in the
    background and return immediately:
    run_terminal {"command": "nohup npm run dev >/dev/null 2>&1 &", "timeoutMs": 15000}
    The terminal starts in /workspace; your project may be in a subdirectory
    (e.g. /workspace/app). Run "ls" / list_files first to find where
    package.json lives, and use "cwd" (or cd) before running npm/pnpm/yarn
    commands. Dependencies are NOT pre-installed: if the project has a
    package.json, run "npm install" (or the project's package manager) in the
    project directory before running any build/test/dev command, or you will
    see "X: not found".
- read_file {"path": "src/foo.ts"}
    Print a file's current contents (capped). Reflects every edit you have made.
- list_files {"path": "src", "recursive": true}
    List a directory's contents (capped at 200 entries; add "recursive": true to
    see the full tree under the path, capped at 300 entries).
- glob {"pattern": "**/*.ts"}
    Find files matching a glob pattern (supports **, *, ?), skipping
    node_modules/.git/dist/.next. Use to locate files by name across the repo.
- grep {"pattern": "someText", "path": ".", "regex": false}
    Search across files (line numbers included). By default a case-sensitive
    fixed-string search; set "regex": true to use a regular expression.
- write_file {"path": "src/foo.ts", "content": "<full new contents>"}
    Create or overwrite a file. Write COMPLETE contents — never ellipses or
    "// rest unchanged". The change takes effect immediately.
- delete_file {"path": "src/old.ts"}
    Delete a file.

When the step is done, respond with a JSON "done" object:
{"done": true, "explanation": "short note on what you changed and why", "files": {"relative/path.ts": "complete new contents"}}
Files you already wrote with write_file do NOT need to be repeated in "files" —
the done object merges over them.`;

@Injectable()
export class Coder {
  private readonly logger = new Logger(Coder.name);

  constructor(
    private readonly llm: LlmClient,
    private readonly emitter: AgentEmitter,
    private readonly tools: AgentTools,
  ) {}

  async writeStep(
    context: AgentContext,
    step: PlanStep,
    staged: Record<string, string>,
    opts: CoderOptions,
  ): Promise<CoderOutput> {
    const { sandboxId, failureFeedback, override } = opts;
    const discovery = discoverProject(context.files);

    // Files the coder may touch = step files + already-staged files; resolve
    // against current content so the model sees up-to-date source.
    const relevantPaths = new Set([
      ...step.files,
      ...Object.keys(staged),
      context.focus.focusFileId ?? "",
    ]);
    relevantPaths.delete("");

    const currentContent: Record<string, string> = {};
    for (const p of relevantPaths) {
      const base = context.files[p] ?? "";
      const stagedContent = staged[p];
      currentContent[p] = stagedContent ?? base;
    }

    const contentBlocks = Object.entries(currentContent)
      .map(
        ([p, c]) => `### ${p}\n\`\`\`\n${c.slice(0, STEP_CONTENT_CAP)}\n\`\`\``,
      )
      .join("\n\n");

    // Seed the sandbox with the known workspace so the agent's terminal, grep
    // and file tools operate on the real code. Best effort — if the push fails
    // the model can still read known files in-memory and run commands.
    await this.tools
      .ensureWorkspace(sandboxId, { ...context.files, ...staged })
      .catch((e) =>
        this.logger.warn(
          `workspace seed failed for sandbox ${sandboxId}: ${(e as Error).message}`,
        ),
      );

    const system = `You are the coding phase of a code agent. You implement ONE step of an approved plan by exploring the project with terminal commands and editing files. You work directly on the project's real files: write_file/delete_file changes are staged immediately, and every read_file/list_files/grep/run_terminal reflects the latest state.

${TOOL_DOC}

Approach:
0. EXPLORE FIRST, act second. Before touching any file, run list_files (recursive) on the project root and read the key config/manifest files (package.json, tsconfig, etc.) so you know the real structure, framework and routing conventions. Never guess a file path — verify it exists first (e.g. read_file the target, or list_files the containing directory).
1. Read the relevant files first (read_file or grep) to understand the current code before editing.
2. If the project has a package.json, install dependencies first (npm/pnpm/yarn install in the project dir — the sandbox has none, and it has no package manager preference; use the lockfile's manager if present). Then use run_terminal to discover and run the project's build/test command; iterate until it passes.
3. Write each changed file in full with write_file, or list them in the final "files" object.

Project memory:
${context.projectMemory || "(none yet)"}

User preferences:
${context.userPreferences || "(none)"}

Project instructions (AGENTS.md / CLAUDE.md / editor rules — follow these):
${context.instructions || "(none)"}

Project summary:
${context.projectSummary || "(none)"}

${discovery ? `${discovery}\n` : ""}The project's test/build command is: ${context.testCommand || "none detected — run_terminal to discover it"}

Rules:
- Respond with ONLY one JSON object per turn: a tool call {"tool":{"name":"...","args":{...}}}, or the done object.
- Never use ellipses or "// rest unchanged" — write complete file contents.
- Do not ask the user questions. Resolve ambiguities yourself using the terminal.
- After changing files, run the project's verification (lint / typecheck) if present, then the test/build command, and iterate until they pass.
- Prefer small, targeted edits.
- Empty directories cannot be tracked — to "create a folder", write a placeholder file inside it (e.g. a .gitkeep file). Never rely on mkdir alone; the new folder only becomes part of the change via a file inside it.
- If list_files shows the workspace is empty (no package.json, no source files), you have no project files to run or edit. Stop and say so in the done object instead of running commands against an empty workspace.
- If you determine this step needs no file changes (the answer is a command, a one-off terminal action, or an explanation), do NOT run the terminal and do NOT edit files. Respond with the done object: {"done": true, "explanation": "<the complete, direct answer for the user>", "files": {}}. The explanation is shown to the user verbatim — make it the full answer, not a summary of what you did.`;

    const stepInstruction = `${describeWorkspace(context.files)}

Step to implement:
${step.description}

Files listed by the step: ${step.files.join(", ") || "(none)"}

Current contents of the relevant files:
${contentBlocks || "(no relevant files yet — create new files as needed)"}
${failureFeedback ? `\nThe previous attempt failed validation. Here is the failure output — fix the cause before finishing:\n${failureFeedback}` : ""}

Proceed. Respond with a tool call or the done object.`;

    const messages: LlmMessage[] = [
      ...context.workingMemory.slice(-6).map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      })),
      { role: "user", content: stepInstruction },
    ];

    let currentStaged = { ...staged };

    for (let iter = 1; iter <= MAX_TOOL_ITERATIONS; iter++) {
      throwIfAborted(opts.signal);
      let text: string;
      try {
        const { text: t } = await this.llm.complete({
          model: "coder",
          system,
          messages,
          // GLM-5.2 is a reasoning model: it spends tokens thinking before
          // emitting the small JSON tool-call object, so give it enough headroom
          // to finish the answer instead of truncating mid-JSON (which the
          // extractor then repairs on retry).
          maxTokens: 4096,
          temperature: 0.2,
          override,
          signal: opts.signal,
          onChunk: opts.onChunk,
        });
        text = t;
        throwIfAborted(opts.signal);
      } catch (e) {
        // User cancelled mid-call (or the SDK rejected the aborted request) —
        // propagate so the run reports `cancelled`.
        if (e instanceof AgentCancelledError || opts.signal?.aborted) {
          throw new AgentCancelledError();
        }
        // Hard failure on the first call aborts the step; later failures fall
        // back to what was staged so far rather than losing the work.
        if (iter === 1)
          throw new Error(`Coder failed: ${(e as Error).message}`);
        return {
          files: currentStaged,
          explanation: `Tool loop ended early (${(e as Error).message})`,
        };
      }

      let objects: any[];
      try {
        objects = extractJsonObjects(text);
      } catch {
        objects = [];
      }
      if (objects.length === 0) {
        try {
          objects = [extractJson(text)];
        } catch {
          objects = [];
        }
      }

      if (objects.length === 0) {
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content:
            "Your reply did not contain a valid JSON object. Respond with exactly one JSON object: a tool call or the done object.",
        });
        continue;
      }

      // The model may emit several tool calls (or a tool call plus the done
      // object) in one reply — execute each in order so none are dropped.
      // The full raw reply is pushed once as the assistant turn, then each
      // executed tool gets its own follow-up user turn with that tool's result.
      messages.push({ role: "assistant", content: text });
      let toolIndex = 0;
      for (const parsed of objects) {
        // Done — the model reports the step complete with its file changes.
        // Only treat it as done when `done` is true, or when the reply is a
        // bare non-empty `files` map. A tool call that also carries a `files`
        // key must run the tool, not end the step.
        const hasFiles =
          parsed &&
          parsed.files &&
          typeof parsed.files === "object" &&
          !Array.isArray(parsed.files) &&
          Object.keys(parsed.files).length > 0;
        if (parsed && (parsed.done === true || (hasFiles && !parsed.tool))) {
          const files =
            parsed.files &&
            typeof parsed.files === "object" &&
            !Array.isArray(parsed.files)
              ? parsed.files
              : {};
          const merged = { ...currentStaged, ...files };
          if (Object.keys(files).length > 0) {
            await this.tools
              .ensureWorkspace(sandboxId, files)
              .catch((e) =>
                this.logger.warn(
                  `final file push failed: ${(e as Error).message}`,
                ),
              );
          }
          return {
            files: merged,
            explanation: parsed.explanation || step.description,
          };
        }

        // Tool call — execute, stream the result to the UI, feed it back.
        if (parsed && parsed.tool && typeof parsed.tool.name === "string") {
          toolIndex++;
          const name = parsed.tool.name;
          const args =
            parsed.tool.args &&
            typeof parsed.tool.args === "object" &&
            !Array.isArray(parsed.tool.args)
              ? parsed.tool.args
              : {};

          const toolCallId = `coder-${Date.now()}-${iter}-${toolIndex}`;
          await this.emitter
            .user(
              opts.sessionId,
              opts.userId,
              opts.threadId,
              "agent:tool_started",
              {
                toolCallId,
                toolName: name,
                args,
              },
            )
            .catch(() => {});

          // Stream the command's output to the UI as `agent:tool_chunk` events.
          // Chunks are coalesced every ~120ms (or 8KB) so a chatty command like
          // `npm install` doesn't spam the socket one tiny write at a time.
          let chunkBuffer = "";
          let chunkTimer: NodeJS.Timeout | null = null;
          const flushChunks = () => {
            chunkTimer = null;
            if (!chunkBuffer) return;
            const payload = chunkBuffer;
            chunkBuffer = "";
            void this.emitter
              .user(
                opts.sessionId,
                opts.userId,
                opts.threadId,
                "agent:tool_chunk",
                {
                  toolCallId,
                  chunk: payload,
                },
              )
              .catch(() => {});
          };
          const relayChunk = (chunk: string) => {
            chunkBuffer += chunk;
            if (chunkBuffer.length >= 8_000) flushChunks();
            else if (!chunkTimer) chunkTimer = setTimeout(flushChunks, 120);
          };

          const result = await this.tools.run(
            sandboxId,
            name,
            args,
            currentStaged,
            (chunk) => relayChunk(chunk),
            opts.signal,
          );
          flushChunks();
          throwIfAborted(opts.signal);
          if (result.staged) currentStaged = result.staged;

          await this.emitter
            .user(
              opts.sessionId,
              opts.userId,
              opts.threadId,
              "agent:tool_result",
              {
                toolCallId,
                result: { output: result.output, exitCode: result.exitCode },
                isError: result.isError,
              },
            )
            .catch(() => {});

          messages.push({
            role: "user",
            content:
              `Tool "${name}" ${result.isError ? "FAILED" : "succeeded"}` +
              `${result.exitCode !== undefined && result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}:\n` +
              result.output.slice(0, TOOL_RESULT_CAP) +
              `\n\nFiles staged so far: ${Object.keys(currentStaged).join(", ") || "none"}`,
          });
          // Bound context growth: drop the oldest turns once we exceed the cap.
          if (messages.length > MAX_CONTEXT_MESSAGES) {
            messages.splice(messages.length - MAX_CONTEXT_MESSAGES);
          }
          trimContext(messages);
          continue;
        }

        // Recognized JSON but not a tool call or done object — ignore it within
        // a multi-object reply rather than erroring the whole iteration.
        messages.push({
          role: "user",
          content:
            'Unrecognized JSON. Respond with either {"tool":{"name":"...","args":{...}}} or {"done":true,"explanation":"...","files":{...}}.',
        });
      }
    }

    // The tool budget ran out, but the model may have already done all the real
    // work — scaffolding, installs and builds legitimately need many tool calls,
    // so a hard failure here would just discard a finished step. Give it a
    // couple of final chances to emit the done object (no more tools), then fall
    // back to finishing with whatever is staged. The validator is the real gate
    // for whether the work is good.
    const wrapPrompt =
      "Tool-call limit reached. Finalize now: respond with ONLY the done object " +
      '{"done": true, "explanation": "what was done", "files": {}} (no tool calls). ' +
      'If you created or changed files via the terminal, include the important ones (package.json, configs, source) in "files" so they can be saved.';
    for (let wrap = 0; wrap < 2; wrap++) {
      throwIfAborted(opts.signal);
      try {
        messages.push({ role: "user", content: wrapPrompt });
        const { text: t } = await this.llm.complete({
          model: "coder",
          system,
          messages,
          maxTokens: 4096,
          temperature: 0.2,
          override,
          signal: opts.signal,
          onChunk: opts.onChunk,
        });
        messages.push({ role: "assistant", content: t });
        let objects: any[];
        try {
          objects = extractJsonObjects(t);
        } catch {
          objects = [];
        }
        if (objects.length === 0) {
          try {
            objects = [extractJson(t)];
          } catch {
            objects = [];
          }
        }
        for (const parsed of objects) {
          const files =
            parsed &&
            parsed.files &&
            typeof parsed.files === "object" &&
            !Array.isArray(parsed.files)
              ? parsed.files
              : {};
          if (parsed?.done === true) {
            const merged = { ...currentStaged, ...files };
            if (Object.keys(files).length > 0) {
              await this.tools
                .ensureWorkspace(sandboxId, files)
                .catch((e) =>
                  this.logger.warn(
                    `final file push failed: ${(e as Error).message}`,
                  ),
                );
            }
            return {
              files: merged,
              explanation: parsed.explanation || step.description,
            };
          }
        }
      } catch (e) {
        if (e instanceof AgentCancelledError || opts.signal?.aborted) {
          throw new AgentCancelledError();
        }
        break;
      }
    }

    return {
      files: currentStaged,
      explanation: `Finished after ${MAX_TOOL_ITERATIONS} tool iterations (no explicit done object).`,
    };
  }
}

// Keep the whole messages array under MAX_CONTEXT_CHARS so the coder request
// stays within the provider's token budget. Drops the oldest turns first, then
// truncates the longest tool-result payloads.
function trimContext(messages: LlmMessage[]): void {
  let total = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (total <= MAX_CONTEXT_CHARS) return;

  // 1) Drop oldest messages (but never the opening step instruction) until we
  //    fit, always keeping the latest turn.
  while (messages.length > 1 && total > MAX_CONTEXT_CHARS) {
    const removed = messages[1];
    messages.splice(1, 1);
    total -= removed?.content.length ?? 0;
  }

  // 2) If still over budget, shorten the largest tool-result payloads.
  if (total > MAX_CONTEXT_CHARS) {
    const trimFloor = 400;
    for (const m of [...messages].reverse()) {
      if (total <= MAX_CONTEXT_CHARS) break;
      const content = m.content;
      // Only truncate the synthetic tool-result turns, never the raw model
      // output (which may still contain the JSON object we need to parse).
      if (
        !content.startsWith('Tool "') &&
        !content.startsWith("Your reply did")
      ) {
        continue;
      }
      if (content.length <= trimFloor) continue;
      const kept = Math.max(
        trimFloor,
        content.length - (total - MAX_CONTEXT_CHARS),
      );
      m.content = `${content.slice(0, kept)}\n… (result truncated)`;
      total = total - content.length + m.content.length;
    }
  }
}
