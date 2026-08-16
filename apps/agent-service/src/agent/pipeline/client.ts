import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type LlmProvider = "nvidia";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

// A per-request override lets the UI supply a client-side API key or model for a
// single invocation without storing keys on the server. Omitting it uses the
// server's configured NVIDIA NIM key/model.
export interface LlmOverride {
  apiKey?: string;
  model?: string;
}

export interface ChatCompletion {
  text: string;
}

interface ProviderModels {
  planner: string;
  coder: string;
  memory: string;
  chat: string;
}

const DEFAULT_MODEL = "z-ai/glm-5.2";
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Transient-failure retries (5xx, timeout, network blip, empty body).
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

// 429 rate-limit handling: the free tier throttles per minute, so back off
// patiently — honoring retry-after — for up to ~2 minutes before giving up.
// This is deliberately far more attempts/backoff than the transient case.
const MAX_RATE_LIMIT_ATTEMPTS = 7;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

// Global pacing: serialize LLM calls and keep a minimum gap between the starts
// of consecutive requests. A single agent run makes several calls in a row
// (planner → coder → validator feedback → memory), and a burst of them is what
// trips the free tier's per-minute quota in the first place.
const DEFAULT_MIN_REQUEST_GAP_MS = 1_200;

// Single provider client for the GLM-5.2 Free API on NVIDIA NIM
// (OpenAI-compatible chat completions). The whole agent pipeline — planner,
// coder, memory writer, small-talk chat — talks to one endpoint:
//
//   Base URL: https://integrate.api.nvidia.com/v1
//   Model:    z-ai/glm-5.2
//   Auth:     Authorization: Bearer $NVIDIA_API_KEY
//
// NVIDIA NIM's free tier rate-limits hard (429 Too Many Requests) and
// occasionally returns transient 5xx / empty bodies under load, and reasoning
// models can run long, so every call is:
//   1. Paced — no two requests in flight at once, with a minimum gap between
//      them so a run's sequential calls can't burst past the quota.
//   2. Retried — 429s wait out the limit (retry-after or up to 60s backoff, ~7
//      attempts); 5xx/timeouts/network blips get shorter exponential backoff.
//   3. Cancel-aware — an aborted request is never retried.
// Hard 4xx errors (bad key, bad model) fail fast.
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  private readonly serverKey: string | null;
  private readonly baseUrl: string;
  private readonly models: ProviderModels;
  private readonly llmTimeoutMs: number;
  private readonly minRequestGapMs: number;

  // Global pacing state shared across all threads/calls.
  private inFlight = 0;
  private lastRequestAt = 0;

  constructor(config: ConfigService) {
    this.serverKey = config.get("NVIDIA_API_KEY") || null;
    this.baseUrl = config.get("NVIDIA_BASE_URL") ?? DEFAULT_BASE_URL;

    this.models = {
      planner:
        config.get("PLANNER_MODEL") ??
        config.get("NVIDIA_PLANNER_MODEL") ??
        DEFAULT_MODEL,
      coder:
        config.get("CODER_MODEL") ??
        config.get("NVIDIA_CODER_MODEL") ??
        DEFAULT_MODEL,
      memory:
        config.get("MEMORY_MODEL") ??
        config.get("NVIDIA_MEMORY_MODEL") ??
        DEFAULT_MODEL,
      chat:
        config.get("CHAT_MODEL") ??
        config.get("NVIDIA_CHAT_MODEL") ??
        DEFAULT_MODEL,
    };

    const configuredTimeout = Number(config.get("LLM_TIMEOUT_MS"));
    this.llmTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 300_000;

    const configuredGap = Number(config.get("NVIDIA_MIN_REQUEST_GAP_MS"));
    this.minRequestGapMs =
      Number.isFinite(configuredGap) && configuredGap >= 0
        ? configuredGap
        : DEFAULT_MIN_REQUEST_GAP_MS;
  }

  async complete(params: {
    model?: "planner" | "coder" | "memory" | "chat";
    system: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    override?: LlmOverride;
    signal?: AbortSignal;
    onChunk?: (chunk: string) => void;
  }): Promise<ChatCompletion> {
    const model =
      params.override?.model ??
      (params.model === "coder"
        ? this.models.coder
        : params.model === "memory"
          ? this.models.memory
          : params.model === "chat"
            ? this.models.chat
            : this.models.planner);

    // An override key rejected with 401/403 falls back to the server key (a
    // browser-supplied key can be stale while the server's is still valid).
    let apiKey = params.override?.apiKey ?? this.serverKey;
    if (!apiKey) {
      throw new Error(
        "No NVIDIA_API_KEY configured (get a free key from https://build.nvidia.com)",
      );
    }
    let switchedToServerKey = false;

    await this.acquireSlot(params.signal);
    try {
      for (let attempt = 0; attempt < MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
        if (params.signal?.aborted) throw new Error("request aborted");

        // Per-attempt deadline so a slow response can be retried rather than
        // killing the whole run. The caller's cancel signal is combined in so a
        // user cancel still aborts the in-flight request immediately.
        const timeoutSignal = AbortSignal.timeout(this.llmTimeoutMs);
        const signal = params.signal
          ? AbortSignal.any([timeoutSignal, params.signal])
          : timeoutSignal;

        try {
          const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              stream: !!params.onChunk,
              max_tokens: params.maxTokens ?? 4096,
              temperature: params.temperature,
              messages: [
                { role: "system", content: params.system },
                ...params.messages,
              ],
            }),
            signal,
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");

            // Auth failure with a user-supplied override key — retry with the
            // server key (once) instead of failing the whole request.
            const isAuthFailure = res.status === 401 || res.status === 403;
            if (
              isAuthFailure &&
              !switchedToServerKey &&
              params.override?.apiKey &&
              this.serverKey &&
              this.serverKey !== apiKey
            ) {
              switchedToServerKey = true;
              apiKey = this.serverKey;
              this.logger.warn(
                `NVIDIA override key rejected (${res.status}) — falling back to server key`,
              );
              await this.sleep(300);
              continue;
            }

            // Rate limit / quota exhaustion. Wait it out patiently — free-tier
            // throttles are per-minute, so short retries just burn attempts.
            if (res.status === 429) {
              if (attempt < MAX_RATE_LIMIT_ATTEMPTS - 1) {
                const retryAfterMs = this.parseRetryAfterMs(res);
                const waitMs =
                  retryAfterMs ??
                  Math.min(RATE_LIMIT_MAX_WAIT_MS, 2_000 * 2 ** attempt);
                this.logger.warn(
                  `NVIDIA rate limited (429) — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 2}/${MAX_RATE_LIMIT_ATTEMPTS}`,
                );
                await this.sleep(waitMs);
                continue;
              }
              throw new Error(
                "NVIDIA rate limit exceeded (429) — the free tier is throttled. Wait a minute, then try again.",
              );
            }

            const retryable = res.status >= 500 && attempt < MAX_ATTEMPTS - 1;
            if (retryable) {
              await this.sleep(
                Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt),
              );
              continue;
            }
            throw new Error(
              `NVIDIA API error (${res.status}): ${body.slice(0, 500) || res.statusText}`,
            );
          }

          if (params.onChunk) {
            return await this.readStream(res, params);
          }

          const raw = await res.text().catch(() => "");
          if (!raw.trim()) {
            if (attempt < MAX_ATTEMPTS - 1) {
              await this.sleep(500 * 2 ** attempt);
              continue;
            }
            throw new Error(
              `NVIDIA API returned an empty response (${res.status} ${res.statusText})`,
            );
          }

          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            throw new Error(
              `NVIDIA API returned non-JSON response (${res.status}): ${raw.slice(0, 300)}`,
            );
          }

          const msg = data?.choices?.[0]?.message;
          let text =
            typeof msg?.content === "string" && msg.content ? msg.content : "";
          if (!text && typeof msg?.reasoning_content === "string") {
            text = msg.reasoning_content;
          }
          if (!text) {
            throw new Error(
              `NVIDIA API returned no text: ${JSON.stringify(data).slice(0, 300)}`,
            );
          }
          return { text };
        } catch (e) {
          // A user cancel aborts via the caller's signal — propagate it so the
          // run reports `cancelled`; never retry a cancelled request.
          if (params.signal?.aborted) throw e;
          // Timeouts (slow reasoning model, overloaded endpoint) and network
          // blips are transient — retry with backoff before giving up.
          const timedOut = timeoutSignal.aborted;
          const networkFailure =
            e instanceof TypeError ||
            (e instanceof Error && /fetch failed/i.test(e.message));
          if ((timedOut || networkFailure) && attempt < MAX_ATTEMPTS - 1) {
            await this.sleep(
              Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt),
            );
            continue;
          }
          throw e;
        }
      }
    } finally {
      this.releaseSlot();
    }

    throw new Error("NVIDIA API request failed after retries");
  }

  // Reads an SSE `data:` stream from a streaming completion, invoking the
  // caller's onChunk for each content delta as it arrives and returning the
  // full accumulated text when the stream ends. A network/parse failure throws
  // so the caller can retry — but a partial stream still surfaced chunks live,
  // so the UI never stalls even when the final answer is lost.
  private async readStream(
    res: Response,
    params: {
      onChunk?: (chunk: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<ChatCompletion> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("NVIDIA streaming response has no body");

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          !trimmed ||
          trimmed.startsWith(":") ||
          !trimmed.startsWith("data:")
        ) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let data: any;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        // Reasoning models may stream CoT into `delta.reasoning_content` (or
        // `delta.reasoning`) and the answer into `delta.content` — relay
        // whichever is present so the pipeline gets the full output.
        const delta = data?.choices?.[0]?.delta;
        const piece = typeof delta?.content === "string" ? delta.content : "";
        const reasoning =
          typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        const altReasoning =
          typeof delta?.reasoning === "string" ? delta.reasoning : "";
        const chunk = piece || reasoning || altReasoning;
        if (chunk) {
          text += chunk;
          params.onChunk?.(chunk);
        }
      }
    }

    if (!text) {
      throw new Error("NVIDIA API streaming returned no text");
    }
    return { text };
  }

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("request aborted");
      if (
        this.inFlight === 0 &&
        Date.now() - this.lastRequestAt >= this.minRequestGapMs
      ) {
        break;
      }
      const gapWait = this.lastRequestAt + this.minRequestGapMs - Date.now();
      await this.sleep(this.inFlight > 0 ? 250 : Math.max(gapWait, 50));
    }
    this.inFlight++;
    this.lastRequestAt = Date.now();
  }

  private releaseSlot(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  private parseRetryAfterMs(res: Response): number | null {
    const header = res.headers.get("retry-after");
    if (!header) return null;
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) {
      return Math.min(Math.round(secs * 1000), RATE_LIMIT_MAX_WAIT_MS);
    }
    // HTTP-date form (rare): retry after that instant.
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      const ms = date - Date.now();
      if (ms > 0) return Math.min(ms, RATE_LIMIT_MAX_WAIT_MS);
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
