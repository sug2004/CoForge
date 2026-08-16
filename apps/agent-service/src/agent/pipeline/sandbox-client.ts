import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithTimeout } from "./http";

export interface SandboxRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

interface NdjsonFrame {
  stream?: "stdout" | "stderr" | "status" | "exit" | "error";
  chunk?: string;
  exitCode?: number | null;
  timeout?: boolean;
  error?: string;
}

// Thin client for the sandbox-runner's file-push and one-shot exec endpoints.
// Used by both the Validator (test command gate) and AgentTools (terminal +
// file access for the agent's tool loop).
@Injectable()
export class SandboxClient {
  private readonly logger = new Logger(SandboxClient.name);
  private readonly runnerUrl: string;

  constructor(config: ConfigService) {
    this.runnerUrl =
      config.get("SANDBOX_RUNNER_URL") ?? "http://localhost:3004";
  }

  async pushFiles(
    sandboxId: string,
    files: Record<string, string>,
    deleted: string[] = [],
  ): Promise<void> {
    const res = await fetchWithTimeout(
      `${this.runnerUrl}/sandbox/${encodeURIComponent(sandboxId)}/files`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, deleted }),
      },
      60_000,
    );
    if (!res.ok)
      throw new Error(`failed to push files to sandbox (${res.status})`);
  }

  // Keeps the container alive (and provisions it if needed) without running a
  // command. Called during planning and on a keepalive timer while the agent
  // runs, so the idle reaper / capacity eviction can't destroy it mid-run.
  // Provisioning (image pull + apt-get install) can take a couple of minutes on
  // a fresh container, so the fetch window is generous — a short timeout here
  // would abort mid-provision and leave the coder's first exec stalling behind
  // provisioning, failing with a confusing "timed out".
  async touch(sandboxId: string): Promise<void> {
    const res = await fetchWithTimeout(
      `${this.runnerUrl}/sandbox/${encodeURIComponent(sandboxId)}/touch`,
      { method: "POST" },
      300_000,
    );
    if (!res.ok) throw new Error(`failed to touch sandbox (${res.status})`);
  }

  // Runs `sh -c command` in the sandbox and collects demuxed stdout/stderr,
  // exit code, and timeout state from the NDJSON stream. When `onChunk` is
  // provided it is invoked with every decoded chunk as it arrives, so callers
  // can stream live output to the UI instead of waiting for the whole result.
  async run(
    sandboxId: string,
    command: string,
    timeoutMs: number,
    onChunk?: (chunk: string, stream: "stdout" | "stderr") => void,
    signal?: AbortSignal,
    cwd?: string,
  ): Promise<SandboxRunResult> {
    const res = await fetchWithTimeout(
      `${this.runnerUrl}/sandbox/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, timeoutMs, ...(cwd ? { cwd } : {}) }),
        signal,
      },
      // The runner enforces the exec's own timeoutMs internally; the HTTP
      // stream must stay open through it, and provisioning (image pull +
      // apt-get on a cold container) happens before the exec starts, so give
      // it a generous margin on top.
      timeoutMs + 120_000,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        `sandbox exec failed (${res.status}): ${err?.error ?? "unknown error"}`,
      );
    }

    const output: string[] = [];
    let exitCode: number | null = null;
    let timedOut = false;

    const reader = res.body?.getReader();
    if (!reader) {
      return {
        exitCode: null,
        output: "no response body from sandbox",
        timedOut: false,
      };
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame: NdjsonFrame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.stream === "stdout" || frame.stream === "stderr") {
          if (frame.chunk) {
            output.push(frame.chunk);
            onChunk?.(frame.chunk, frame.stream);
          }
        } else if (frame.stream === "status") {
          if (frame.chunk) {
            output.push(frame.chunk);
            onChunk?.(frame.chunk, "stdout");
          }
        } else if (frame.stream === "exit") {
          exitCode = frame.exitCode ?? null;
          timedOut = !!frame.timeout;
        } else if (frame.stream === "error") {
          output.push(`sandbox error: ${frame.error ?? "unknown"}`);
          exitCode = exitCode ?? 1;
        }
      }
    }

    return { exitCode, output: output.join(""), timedOut };
  }
}
