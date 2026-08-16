import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LlmClient, LlmOverride } from "./pipeline/client";
import { ContextService } from "./pipeline/context";
import { Planner } from "./pipeline/planner";
import { Coder } from "./pipeline/coder";
import { Validator } from "./pipeline/validator";
import { SandboxClient } from "./pipeline/sandbox-client";
import { Applier } from "./pipeline/applier";
import { AgentEmitter } from "./pipeline/emitter";
import { Chat } from "./pipeline/chat";
import {
  AgentCancelledError,
  EditorFocus,
  PendingApply,
  throwIfAborted,
} from "./pipeline/types";
import { fetchWithTimeout } from "./pipeline/http";

export interface InvokeRequest {
  sessionId: string;
  userId: string;
  threadId: string;
  prompt: string;
  focus?: EditorFocus;
  token?: string;
  llm?: LlmOverride;
}

export interface InvokeResponse {
  success: boolean;
  message?: string;
  error?: string;
  autoApplied?: boolean;
  pendingApply?: boolean;
  cancelled?: boolean;
}

const MAX_RETRIES = 2;
const SANDBOX_KEEPALIVE_INTERVAL_MS = 60_000;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly coreApiUrl: string;
  private readonly syncServerUrl: string;
  private readonly autoApply: boolean;

  // One in-flight invocation per thread. Aborting the controller lets the
  // pipeline cancel its in-flight LLM calls / sandbox runs; the entry is
  // removed in `invoke`'s finally block.
  private readonly runs = new Map<string, AbortController>();

  constructor(
    private readonly config: ConfigService,
    private readonly llm: LlmClient,
    private readonly context: ContextService,
    private readonly planner: Planner,
    private readonly coder: Coder,
    private readonly validator: Validator,
    private readonly sandbox: SandboxClient,
    private readonly applier: Applier,
    private readonly emitter: AgentEmitter,
    private readonly chat: Chat,
  ) {
    this.coreApiUrl = config.get("CORE_API_URL") ?? "http://localhost:3002";
    this.syncServerUrl =
      config.get("SYNC_SERVER_URL") ?? "http://localhost:3001";
    this.autoApply = config.get("AGENT_AUTO_APPLY") === "true";
  }

  // Entry point. The controller fire-and-forgets this: the pipeline runs in the
  // background and streams every intermediate event plus a terminal `agent:done`
  // over the agent socket. The HTTP response is only an acknowledgement, so long
  // runs can no longer trip client/proxy timeouts while waiting for a response.
  async invoke(request: InvokeRequest): Promise<InvokeResponse> {
    const { sessionId, userId, threadId } = request;
    const startTime = Date.now();

    if (this.runs.has(threadId)) {
      this.logger.warn(
        `invoke thread=${threadId} already running — ignoring duplicate`,
      );
      const message = "An agent run is already in progress for this thread.";
      await this.emitter
        .user(sessionId, userId, threadId, "agent:done", {
          success: false,
          error: message,
        })
        .catch(() => {});
      return { success: false, error: message };
    }

    const controller = new AbortController();
    this.runs.set(threadId, controller);

    let result: InvokeResponse;
    try {
      result = await this.runPipeline(request, controller.signal);
    } catch (error) {
      // The SDK can surface an abort as a generic request error, so rely on the
      // signal state (not just AgentCancelledError) to mark the run cancelled.
      if (controller.signal.aborted || error instanceof AgentCancelledError) {
        result = { success: false, error: "cancelled", cancelled: true };
      } else {
        this.logger.error("Agent invocation failed", error);
        const message =
          error instanceof Error ? error.message : "Unknown error";
        result = { success: false, error: message };
      }
    } finally {
      this.runs.delete(threadId);
    }

    if (result.cancelled) {
      await this.emitter
        .user(sessionId, userId, threadId, "agent:message", {
          text: "Run cancelled.",
        })
        .catch(() => {});
    }

    await this.emitter
      .user(sessionId, userId, threadId, "agent:done", {
        success: result.success,
        error: result.error,
        autoApplied: result.autoApplied,
        pendingApply: result.pendingApply,
        cancelled: result.cancelled,
        elapsedMs: Date.now() - startTime,
      })
      .catch(() => {});
    return result;
  }

  // Aborts the in-flight run for a thread, if any. Returns whether one was
  // active; the pipeline turns the abort into a `cancelled` agent:done event.
  async cancel(threadId: string): Promise<boolean> {
    const controller = this.runs.get(threadId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // The user rejected a proposed edit set — clear the server-side pending entry
  // so a later proposal doesn't overwrite it or try to apply a stale plan.
  async rejectPending(threadId: string): Promise<void> {
    this.applier.clearPending(threadId);
  }

  private async runPipeline(
    request: InvokeRequest,
    signal?: AbortSignal,
  ): Promise<InvokeResponse> {
    const { sessionId, userId, threadId, prompt, focus, token, llm } = request;
    this.logger.log(`invoke thread=${threadId} session=${sessionId}`);

    try {
      throwIfAborted(signal);
      await this.saveMessage(
        threadId,
        sessionId,
        "user",
        { text: prompt },
        token,
      );

      // Pure social small-talk ("hey", "thanks", "who are you") never touches
      // the coding pipeline — reply conversationally and return, like a real
      // chat. This must run before `phase_started planning` so the UI doesn't
      // flash "Planning…" for a casual message.
      const trimmed = prompt.trim();
      if (this.chat.isSmallTalk(trimmed)) {
        const reply = await this.chat.respond(trimmed, llm, signal);
        await this.saveMessage(
          threadId,
          sessionId,
          "assistant",
          { text: reply },
          token,
        );
        await this.emitter.user(sessionId, userId, threadId, "agent:message", {
          text: reply,
        });
        return { success: true };
      }

      await this.emitter.user(
        sessionId,
        userId,
        threadId,
        "agent:phase_started",
        {
          phase: "planning",
        },
      );

      const ctx = await this.context.buildContext({
        sessionId,
        userId,
        threadId,
        prompt,
        focus,
        token,
      });

      // The agent's terminal + tester share the user's actual session container,
      // so scaffolding/commands run in the same sandbox the UI terminal shows.
      const sandboxId = this.validator.sandboxKey(sessionId);

      const plan = await this.planner.plan(
        ctx,
        prompt,
        llm,
        signal,
        this.streamRelay(sessionId, userId, threadId),
      );

      if (plan.needsClarification && plan.clarification) {
        await this.emitter.user(sessionId, userId, threadId, "agent:plan", {
          steps: [],
          clarification: plan.clarification,
          needsClarification: true,
        });
        const clarificationText = `${plan.clarification}\n\nReply with your answer and I'll continue.`;
        await this.saveMessage(
          threadId,
          sessionId,
          "planner",
          { text: clarificationText, plan: { needsClarification: true } },
          token,
        );
        await this.emitter.user(sessionId, userId, threadId, "agent:message", {
          text: clarificationText,
        });
        return { success: true };
      }

      if (plan.steps.length === 0) {
        await this.emitter.user(sessionId, userId, threadId, "agent:plan", {
          steps: [],
          summary: plan.summary,
        });
        await this.saveMessage(
          threadId,
          sessionId,
          "planner",
          { text: plan.summary, plan: { steps: [], risk: plan.risk } },
          token,
        );
        await this.emitter.user(sessionId, userId, threadId, "agent:message", {
          text: plan.summary,
        });
        return { success: true };
      }

      await this.emitter.user(sessionId, userId, threadId, "agent:plan", {
        steps: plan.steps,
        risk: plan.risk,
        summary: plan.summary,
      });
      await this.saveMessage(
        threadId,
        sessionId,
        "planner",
        { text: plan.summary, plan: { steps: plan.steps, risk: plan.risk } },
        token,
      );

      let staged: Record<string, string> = {};
      let lastExplanation: string | undefined;

      // Warm the per-thread sandbox (create + apt-provision) in the background
      // so the coder's first terminal call doesn't stall on package install,
      // and ping it on a timer so the idle reaper / capacity eviction can't
      // destroy the container while the model is thinking (which would force a
      // slow recreate + re-provision on the next tool call).
      let touchInFlight: Promise<void> | null = null;
      const touchSandbox = () => {
        if (touchInFlight) return;
        touchInFlight = this.sandbox
          .touch(sandboxId)
          .catch((e) =>
            this.logger.warn(
              `sandbox touch failed for ${sandboxId}: ${(e as Error).message}`,
            ),
          )
          .finally(() => {
            touchInFlight = null;
          });
      };
      touchSandbox();
      const keepalive = setInterval(
        touchSandbox,
        SANDBOX_KEEPALIVE_INTERVAL_MS,
      );

      try {
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i];

          throwIfAborted(signal);
          await this.emitter.user(
            sessionId,
            userId,
            threadId,
            "agent:phase_started",
            {
              phase: "coding",
              stepIndex: i,
            },
          );

          let stepFiles: Record<string, string> = {};
          let validated = false;
          let feedback: string | undefined;

          for (
            let attempt = 0;
            attempt < MAX_RETRIES && !validated;
            attempt++
          ) {
            const output = await this.coder.writeStep(
              ctx,
              step,
              { ...staged, ...stepFiles },
              {
                sessionId,
                userId,
                threadId,
                sandboxId,
                failureFeedback: feedback,
                override: llm,
                signal,
                onChunk: this.streamRelay(sessionId, userId, threadId),
              },
            );
            lastExplanation = output.explanation;
            stepFiles = output.files;

            if (Object.keys(stepFiles).length === 0) {
              validated = true;
              break;
            }

            const mergedStaged = { ...staged, ...stepFiles };
            await this.saveMessage(
              threadId,
              sessionId,
              "coder",
              { text: output.explanation, files: stepFiles },
              token,
            );

            await this.emitter.user(
              sessionId,
              userId,
              threadId,
              "agent:phase_started",
              {
                phase: "validating",
                stepIndex: i,
                attempt,
              },
            );

            const toolCallId = `validate-${i}-${attempt}`;
            await this.emitter.user(
              sessionId,
              userId,
              threadId,
              "agent:tool_started",
              {
                toolCallId,
                toolName: "run_tests",
                args: { command: ctx.testCommand, step: i },
              },
            );

            const validation = await this.validator.validate(
              sessionId,
              ctx.files,
              mergedStaged,
              ctx.testCommand,
              signal,
            );

            await this.saveMessage(
              threadId,
              sessionId,
              "validator",
              {
                passed: validation.passed,
                output: validation.output,
                command: validation.command,
                reason: validation.reason,
              },
              token,
            );

            await this.emitter.user(
              sessionId,
              userId,
              threadId,
              "agent:tool_result",
              {
                toolCallId,
                result: {
                  passed: validation.passed,
                  output: validation.output,
                  reason: validation.reason,
                },
                isError: !validation.passed,
              },
            );

            if (validation.passed) {
              validated = true;
              staged = mergedStaged;
            } else if (attempt < MAX_RETRIES - 1) {
              feedback = validation.output;
            }
          }

          if (!validated) {
            const msg = `Step ${i + 1} ("${step.description}") could not be completed after ${MAX_RETRIES} attempts. See the failed test output above.`;
            await this.emitter.user(
              sessionId,
              userId,
              threadId,
              "agent:message",
              { text: msg },
            );
            await this.saveMessage(
              threadId,
              sessionId,
              "assistant",
              { text: msg },
              token,
            );
            return { success: false, error: msg };
          }
        }

        if (Object.keys(staged).length === 0) {
          const msg =
            lastExplanation && lastExplanation.trim()
              ? lastExplanation.trim()
              : "No file changes were produced for this request.";
          await this.emitter.user(
            sessionId,
            userId,
            threadId,
            "agent:message",
            {
              text: msg,
            },
          );
          await this.saveMessage(
            threadId,
            sessionId,
            "assistant",
            { text: msg },
            token,
          );
          return { success: true };
        }

        await this.emitter.user(
          sessionId,
          userId,
          threadId,
          "agent:phase_started",
          {
            phase: "applying",
          },
        );

        const toolCallId = `apply-${Date.now()}`;
        const pending = await this.applier.propose(
          sessionId,
          userId,
          threadId,
          toolCallId,
          staged,
          ctx.files,
          plan.risk,
        );

        const fileCount = Object.keys(staged).length;
        const changed = Object.keys(staged)
          .sort()
          .map((f) => `- \`${f}\``)
          .join("\n");

        if (this.autoApply && plan.risk === "low") {
          await this.apply(pending, token);
          const summary = `Done — applied ${fileCount} file${fileCount === 1 ? "" : "s"} (auto-applied, low risk).\n\nChanged files:\n${changed}`;
          await this.emitter
            .user(sessionId, userId, threadId, "agent:message", {
              text: summary,
            })
            .catch(() => {});
          await this.saveMessage(
            threadId,
            sessionId,
            "assistant",
            { text: summary },
            token,
          );
          return { success: true, autoApplied: true };
        }

        const summary = `Done — ${fileCount} file${fileCount === 1 ? "" : "s"} ready for review.\n\nChanged files:\n${changed}\n\nReview the proposed edits below, then Apply or Reject.`;
        await this.emitter
          .user(sessionId, userId, threadId, "agent:message", { text: summary })
          .catch(() => {});
        await this.saveMessage(
          threadId,
          sessionId,
          "assistant",
          { text: summary },
          token,
        );
        return { success: true, pendingApply: true };
      } finally {
        clearInterval(keepalive);
      }
    } catch (error) {
      if (signal?.aborted || error instanceof AgentCancelledError) {
        return { success: false, error: "cancelled", cancelled: true };
      }
      this.logger.error("Agent invocation failed", error);
      this.logger.error(
        `invoke stack: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      const message = error instanceof Error ? error.message : "Unknown error";
      await this.emitter
        .user(sessionId, userId, threadId, "agent:message", {
          text: `Error: ${message}`,
        })
        .catch(() => {});
      return { success: false, error: message };
    }
  }

  // Streams the model's live token output to the UI as coalesced `agent:stream`
  // events. Chunks are batched (~120ms / 8KB) so a fast model doesn't spam the
  // socket one token per POST; the client renders them as the agent "thinking"
  // so the chat never sits on a static phase label while a call is in flight.
  private streamRelay(
    sessionId: string,
    userId: string,
    threadId: string,
  ): (chunk: string) => void {
    let buffer = "";
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (!buffer) return;
      const payload = buffer;
      buffer = "";
      void this.emitter
        .user(sessionId, userId, threadId, "agent:stream", { chunk: payload })
        .catch(() => {});
    };
    return (chunk: string) => {
      buffer += chunk;
      if (buffer.length >= 8_000) flush();
      else if (!timer) timer = setTimeout(flush, 120);
    };
  }

  // Human (or auto-apply) accepted the proposed edits — apply them to the
  // shared Y.Doc and log to the activity feed.
  async applyPending(
    threadId: string,
    sessionId: string,
    userId: string,
    token?: string,
  ): Promise<void> {
    const pending = this.applier.getPending(threadId);
    if (!pending)
      throw new NotFoundException("No pending agent changes for this thread");
    await this.apply(pending, token);
  }

  private async apply(pending: PendingApply, token?: string): Promise<void> {
    const { sessionId, userId, threadId, toolCallId, files } = pending;

    const res = await fetchWithTimeout(
      `${this.syncServerUrl}/sync/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          threadId,
          userId,
          toolCallId,
          files,
        }),
      },
      60_000,
    );
    if (!res.ok) {
      throw new Error(`apply failed with status ${res.status}`);
    }

    this.applier.clearPending(threadId);

    // Shared audit trail (SessionEvent).
    await this.saveEvent(
      sessionId,
      userId,
      "agent_edit_applied",
      { threadId, toolCallId, files: Object.keys(files) },
      token,
    ).catch(() => {});

    // Project memory update — best effort.
    await this.updateProjectMemory(
      sessionId,
      userId,
      threadId,
      files,
      token,
    ).catch((e) =>
      this.logger.warn(`project memory update failed: ${(e as Error).message}`),
    );
  }

  private async updateProjectMemory(
    sessionId: string,
    userId: string,
    threadId: string,
    files: Record<string, string>,
    token?: string,
  ) {
    const projectId = await this.context.getProjectId(sessionId, token);
    if (!projectId) return;
    const current = await this.context.getProjectMemory(projectId, token);

    const { text: summary } = await this.llm.complete({
      model: "memory",
      system:
        "You maintain a living project memory document for a codebase. Given the previous summary and a set of just-applied file changes, decide whether any of the changes are worth remembering (architecture, conventions, gotchas, key modules). If yes, return the updated summary text (bounded to ~1500 chars, editing the existing text). If nothing is worth remembering, return exactly: NO_UPDATE",
      messages: [
        {
          role: "user",
          content: `Previous summary:\n${current || "(empty)"}\n\nChanges applied:\n${Object.entries(
            files,
          )
            .map(([p, c]) => `### ${p}\n${c.slice(0, 2000)}`)
            .join("\n\n")}`,
        },
      ],
      maxTokens: 1024,
    });

    if (summary && summary.trim() !== "NO_UPDATE") {
      await fetchWithTimeout(
        `${this.coreApiUrl}/projects/${encodeURIComponent(projectId)}/memory`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ summary }),
        },
        10_000,
      );
    }
  }

  private async saveMessage(
    threadId: string,
    sessionId: string,
    role: string,
    content: any,
    token?: string,
  ): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.coreApiUrl}/sessions/${encodeURIComponent(sessionId)}/agent-threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ role, content }),
        },
        10_000,
      );
    } catch (e) {
      this.logger.warn(`failed to save message: ${(e as Error).message}`);
    }
  }

  private async saveEvent(
    sessionId: string,
    userId: string,
    type: string,
    payload: any,
    token?: string,
  ): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.coreApiUrl}/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ type, payload }),
        },
        10_000,
      );
    } catch (e) {
      this.logger.warn(`failed to save session event: ${(e as Error).message}`);
    }
  }
}
