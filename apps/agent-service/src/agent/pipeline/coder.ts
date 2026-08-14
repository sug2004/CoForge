import { Injectable, Logger } from '@nestjs/common';
import { LlmClient, LlmMessage, LlmOverride } from './client';
import { AgentCancelledError, AgentContext, CoderOutput, PlanStep, throwIfAborted } from './types';
import { extractJson } from './json';
import { AgentEmitter } from './emitter';
import { AgentTools } from './tools';
import { describeWorkspace } from './workspace';

export interface CoderOptions {
  sessionId: string;
  userId: string;
  threadId: string;
  sandboxId: string;
  failureFeedback?: string;
  override?: LlmOverride;
  signal?: AbortSignal;
}

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONTEXT_MESSAGES = 40;
const STEP_CONTENT_CAP = 8_000;
const TOOL_RESULT_CAP = 6_000;

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
    commands.
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

    // Files the coder may touch = step files + already-staged files; resolve
    // against current content so the model sees up-to-date source.
    const relevantPaths = new Set([
      ...step.files,
      ...Object.keys(staged),
      context.focus.focusFileId ?? '',
    ]);
    relevantPaths.delete('');

    const currentContent: Record<string, string> = {};
    for (const p of relevantPaths) {
      const base = context.files[p] ?? '';
      const stagedContent = staged[p];
      currentContent[p] = stagedContent ?? base;
    }

    const contentBlocks = Object.entries(currentContent)
      .map(([p, c]) => `### ${p}\n\`\`\`\n${c.slice(0, STEP_CONTENT_CAP)}\n\`\`\``)
      .join('\n\n');

    // Seed the sandbox with the known workspace so the agent's terminal, grep
    // and file tools operate on the real code. Best effort — if the push fails
    // the model can still read known files in-memory and run commands.
    await this.tools
      .ensureWorkspace(sandboxId, { ...context.files, ...staged })
      .catch((e) =>
        this.logger.warn(`workspace seed failed for sandbox ${sandboxId}: ${(e as Error).message}`),
      );

    const system = `You are the coding phase of a code agent. You implement ONE step of an approved plan by exploring the project with terminal commands and editing files. You work directly on the project's real files: write_file/delete_file changes are staged immediately, and every read_file/list_files/grep/run_terminal reflects the latest state.

${TOOL_DOC}

Approach:
1. Read the relevant files first (read_file or grep) to understand the current code before editing.
2. Use run_terminal to discover and run the project's build/test command; iterate until it passes.
3. Write each changed file in full with write_file, or list them in the final "files" object.

Project memory:
${context.projectMemory || '(none yet)'}

User preferences:
${context.userPreferences || '(none)'}

Project instructions (AGENTS.md / CLAUDE.md / editor rules — follow these):
${context.instructions || '(none)'}

Project summary:
${context.projectSummary || '(none)'}

The project's test/build command is: ${context.testCommand || 'none detected — run_terminal to discover it'}

Rules:
- Respond with ONLY one JSON object per turn: a tool call {"tool":{"name":"...","args":{...}}}, or the done object.
- Never use ellipses or "// rest unchanged" — write complete file contents.
- Do not ask the user questions. Resolve ambiguities yourself using the terminal.
- After changing files, run the project's verification (lint / typecheck) if present, then the test/build command, and iterate until they pass.
- Prefer small, targeted edits.
- Empty directories cannot be tracked — to "create a folder", write a placeholder file inside it (e.g. a .gitkeep file). Never rely on mkdir alone; the new folder only becomes part of the change via a file inside it.
- If list_files shows the workspace is empty (no package.json, no source files), you have no project files to run or edit. Stop and say so in the done object instead of running commands against an empty workspace.`;

    const stepInstruction = `${describeWorkspace(context.files)}

Step to implement:
${step.description}

Files listed by the step: ${step.files.join(', ') || '(none)'}

Current contents of the relevant files:
${contentBlocks || '(no relevant files yet — create new files as needed)'}
${failureFeedback ? `\nThe previous attempt failed validation. Here is the failure output — fix the cause before finishing:\n${failureFeedback}` : ''}

Proceed. Respond with a tool call or the done object.`;

    const messages: LlmMessage[] = [
      ...context.workingMemory.slice(-6).map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      })),
      { role: 'user', content: stepInstruction },
    ];

    let currentStaged = { ...staged };
    let parsed: any;

    for (let iter = 1; iter <= MAX_TOOL_ITERATIONS; iter++) {
      throwIfAborted(opts.signal);
      let text: string;
      try {
        const { text: t } = await this.llm.complete({
          model: 'coder',
          system,
          messages,
          maxTokens: 4096,
          temperature: 0.2,
          override,
          signal: opts.signal,
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
        if (iter === 1) throw new Error(`Coder failed: ${(e as Error).message}`);
        return {
          files: currentStaged,
          explanation: `Tool loop ended early (${(e as Error).message})`,
        };
      }

      try {
        parsed = extractJson(text);
      } catch {
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            'Your reply did not contain a valid JSON object. Respond with exactly one JSON object: a tool call or the done object.',
        });
        continue;
      }

      // Done — the model reports the step complete with its file changes.
      if (parsed.done === true || parsed.files) {
        const files =
          parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
            ? parsed.files
            : {};
        const merged = { ...currentStaged, ...files };
        if (Object.keys(files).length > 0) {
          await this.tools
            .ensureWorkspace(sandboxId, files)
            .catch((e) => this.logger.warn(`final file push failed: ${(e as Error).message}`));
        }
        return {
          files: merged,
          explanation: parsed.explanation || step.description,
        };
      }

      // Tool call — execute, stream the result to the UI, feed it back.
      const tool = parsed.tool;
      if (tool && typeof tool.name === 'string') {
        const name = tool.name;
        const args =
          tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)
            ? tool.args
            : {};

        const toolCallId = `coder-${Date.now()}-${iter}`;
        await this.emitter
          .user(opts.sessionId, opts.userId, opts.threadId, 'agent:tool_started', {
            toolCallId,
            toolName: name,
            args,
          })
          .catch(() => {});

        // Stream the command's output to the UI as `agent:tool_chunk` events.
        // Chunks are coalesced every ~120ms (or 8KB) so a chatty command like
        // `npm install` doesn't spam the socket one tiny write at a time.
        let chunkBuffer = '';
        let chunkTimer: NodeJS.Timeout | null = null;
        const flushChunks = () => {
          chunkTimer = null;
          if (!chunkBuffer) return;
          const payload = chunkBuffer;
          chunkBuffer = '';
          void this.emitter
            .user(opts.sessionId, opts.userId, opts.threadId, 'agent:tool_chunk', {
              toolCallId,
              chunk: payload,
            })
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
          .user(opts.sessionId, opts.userId, opts.threadId, 'agent:tool_result', {
            toolCallId,
            result: { output: result.output, exitCode: result.exitCode },
            isError: result.isError,
          })
          .catch(() => {});

        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content:
            `Tool "${name}" ${result.isError ? 'FAILED' : 'succeeded'}` +
            `${result.exitCode !== undefined && result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}:\n` +
            result.output.slice(0, TOOL_RESULT_CAP) +
            `\n\nFiles staged so far: ${Object.keys(currentStaged).join(', ') || 'none'}`,
        });
        // Bound context growth: drop the oldest turns once we exceed the cap.
        if (messages.length > MAX_CONTEXT_MESSAGES) {
          messages.splice(messages.length - MAX_CONTEXT_MESSAGES);
        }
        continue;
      }

      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content:
          'Unrecognized JSON. Respond with either {"tool":{"name":"...","args":{...}}} or {"done":true,"explanation":"...","files":{...}}.',
      });
    }

    throw new Error(
      `Step could not be completed after ${MAX_TOOL_ITERATIONS} tool iterations`,
    );
  }
}
