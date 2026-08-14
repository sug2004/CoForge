import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type LlmProvider = 'anthropic' | 'nvidia';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmOverride {
  provider?: LlmProvider;
  apiKey?: string;
}

export interface ChatCompletion {
  text: string;
}

// Unified client for the two supported model providers:
//  - anthropic — official SDK, chosen by LLM_PROVIDER=anthropic (default)
//  - nvidia    — NIM OpenAI-compatible endpoint, LLM_PROVIDER=nvidia
// A per-request `override` lets the UI supply a provider + API key for a single
// invocation without storing keys on the server.
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  private readonly anthropic: Anthropic | null;
  private readonly anthropicKey: string | null;
  private readonly nvidiaKey: string | null;
  private readonly nvidiaBaseUrl: string;
  private readonly defaultProvider: LlmProvider;

  private readonly plannerModel: string;
  private readonly coderModel: string;
  private readonly memoryModel: string;

  constructor(config: ConfigService) {
    this.defaultProvider =
      (config.get('LLM_PROVIDER') ?? 'anthropic').toLowerCase() === 'nvidia'
        ? 'nvidia'
        : 'anthropic';

    this.anthropicKey = config.get('ANTHROPIC_API_KEY') || null;
    this.anthropic = this.anthropicKey
      ? new Anthropic({ apiKey: this.anthropicKey })
      : null;
    this.nvidiaKey = config.get('NVIDIA_API_KEY') || null;
    this.nvidiaBaseUrl =
      config.get('NVIDIA_BASE_URL') ?? 'https://integrate.api.nvidia.com/v1';

    const planner =
      config.get('PLANNER_MODEL') ??
      config.get('NVIDIA_PLANNER_MODEL') ??
      'nvidia/llama-3.3-nemotron-super-49b-v1';
    const coder =
      config.get('CODER_MODEL') ??
      config.get('NVIDIA_CODER_MODEL') ??
      'nvidia/llama-3.3-nemotron-super-49b-v1';
    const memory =
      config.get('MEMORY_MODEL') ??
      config.get('NVIDIA_MEMORY_MODEL') ??
      'nvidia/llama-3.3-nemotron-super-49b-v1';

    if (this.defaultProvider === 'nvidia') {
      this.plannerModel = planner;
      this.coderModel = coder;
      this.memoryModel = memory;
    } else {
      this.plannerModel = config.get('PLANNER_MODEL') ?? 'claude-3-5-haiku-20241022';
      this.coderModel = config.get('CODER_MODEL') ?? 'claude-3-5-sonnet-20241022';
      this.memoryModel = config.get('MEMORY_MODEL') ?? 'claude-3-5-haiku-20241022';
    }
  }

  async complete(params: {
    model?: 'planner' | 'coder' | 'memory';
    system: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    override?: LlmOverride;
    signal?: AbortSignal;
  }): Promise<ChatCompletion> {
    const provider = params.override?.provider ?? this.defaultProvider;

    if (provider === 'nvidia') {
      return this.completeNvidia(params);
    }
    return this.completeAnthropic(params);
  }

  private async completeAnthropic(params: {
    model?: 'planner' | 'coder' | 'memory';
    system: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    override?: LlmOverride;
    signal?: AbortSignal;
  }): Promise<ChatCompletion> {
    const apiKey = params.override?.apiKey ?? this.anthropicKey;
    if (!apiKey) throw new Error('No ANTHROPIC_API_KEY configured');
    const client = this.anthropic ?? new Anthropic({ apiKey });

    const model =
      params.model === 'coder'
        ? this.coderModel
        : params.model === 'memory'
          ? this.memoryModel
          : this.plannerModel;

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: params.maxTokens ?? 4096,
          temperature: params.temperature,
          system: params.system,
          messages: params.messages,
        },
        { signal: params.signal },
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      return { text };
    } catch (e) {
      // A browser-supplied override key can be stale/expired while the server's
      // configured key is still valid. On an auth failure, retry once with the
      // server key instead of failing the whole request.
      const status = (e as any)?.status;
      const isAuthFailure = status === 401 || status === 403;
      if (
        isAuthFailure &&
        params.override?.apiKey &&
        this.anthropicKey &&
        this.anthropicKey !== params.override.apiKey
      ) {
        this.logger.warn(
          `Anthropic override key rejected (${status}) — falling back to server key`,
        );
        return this.completeAnthropic({
          ...params,
          override: { provider: 'anthropic' },
        });
      }
      throw e;
    }
  }

  private async completeNvidia(params: {
    model?: 'planner' | 'coder' | 'memory';
    system: string;
    messages: LlmMessage[];
    maxTokens?: number;
    temperature?: number;
    override?: LlmOverride;
    signal?: AbortSignal;
  }): Promise<ChatCompletion> {
    const apiKey = params.override?.apiKey ?? this.nvidiaKey;
    if (!apiKey) throw new Error('No NVIDIA_API_KEY configured');

    const model =
      params.model === 'coder'
        ? this.coderModel
        : params.model === 'memory'
          ? this.memoryModel
          : this.plannerModel;

    // NVIDIA NIM occasionally returns 200 with an empty body or a transient 5xx
    // under load. Retry a couple of times with a short backoff; hard 4xx errors
    // (bad key, bad model) are not retried.
    const attempts = 3;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetch(`${this.nvidiaBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            stream: false,
            max_tokens: params.maxTokens ?? 4096,
            temperature: params.temperature,
            messages: [
              { role: 'system', content: params.system },
              ...params.messages,
            ],
          }),
          // Combine the 120s hard deadline with the caller's cancel signal so
          // a cancelled run aborts the in-flight request immediately.
          signal: AbortSignal.any([
            AbortSignal.timeout(120_000),
            ...(params.signal ? [params.signal] : []),
          ]),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // A browser-supplied override key can be stale/expired while the
          // server's configured key is still valid. On an auth failure, retry
          // once with the server key instead of failing the whole request.
          const isAuthFailure = res.status === 401 || res.status === 403;
          if (
            isAuthFailure &&
            params.override?.apiKey &&
            this.nvidiaKey &&
            this.nvidiaKey !== params.override.apiKey
          ) {
            this.logger.warn(
              `NVIDIA override key rejected (${res.status}) — falling back to server key`,
            );
            return this.completeNvidia({
              ...params,
              override: { provider: 'nvidia' },
            });
          }
          const retryable =
            res.status >= 500 && attempt < attempts - 1;
          if (retryable) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error(
            `NVIDIA API error (${res.status}): ${body.slice(0, 500) || res.statusText}`,
          );
        }

        const raw = await res.text().catch(() => '');
        if (!raw.trim()) {
          if (attempt < attempts - 1) {
            await sleep(500 * 2 ** attempt);
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

        // Nemotron-3 Ultra is a reasoning model: it streams CoT into
        // `reasoning_content` and the final answer into `content`. If the request
        // was truncated mid-reasoning, `content` may be null — fall back to the
        // reasoning text so the JSON extractors can still make an attempt.
        const msg = data?.choices?.[0]?.message;
        let text =
          typeof msg?.content === 'string' && msg.content
            ? msg.content
            : '';
        if (!text && typeof msg?.reasoning_content === 'string') {
          text = msg.reasoning_content;
        }
        if (!text) {
          throw new Error(
            `NVIDIA API returned no text: ${JSON.stringify(data).slice(0, 300)}`,
          );
        }
        return { text };
      } catch (e) {
        const networkFailure =
          e instanceof TypeError ||
          (e instanceof Error && /fetch failed/i.test(e.message));
        if (networkFailure && attempt < attempts - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw e;
      }
    }

    throw new Error('NVIDIA API request failed after retries');
  }
}
