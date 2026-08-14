import { Injectable, Logger } from '@nestjs/common';
import { SandboxClient } from './sandbox-client';
import { ValidationResult, throwIfAborted } from './types';

@Injectable()
export class Validator {
  private readonly logger = new Logger(Validator.name);

  constructor(private readonly sandbox: SandboxClient) {}

  // Per-thread sandbox namespace: `${sessionId}-${userId}-agent` — a separate
  // container per user's agent thread so teammate runs can't stomp each other.
  // The agent's terminal/tool calls share this same sandbox.
  sandboxKey(sessionId: string, userId: string): string {
    return `${sessionId}-${userId}-agent`;
  }

  // Base files (shared Y.Doc) + the staged diff on top. Never touches the live
  // shared state — validation happens in the private per-thread sandbox.
  async validate(
    sessionId: string,
    userId: string,
    baseFiles: Record<string, string>,
    staged: Record<string, string>,
    testCommand: string | null,
    signal?: AbortSignal,
  ): Promise<ValidationResult> {
    if (!testCommand) {
      return {
        passed: true,
        output: '',
        command: null,
        reason: 'no test/build command detected — skipped validation',
      };
    }

    const sandboxId = this.sandboxKey(sessionId, userId);
    const workspace = { ...baseFiles, ...staged };
    const timeoutMs = 120_000;

    try {
      await this.sandbox.pushFiles(sandboxId, workspace);
    } catch (e) {
      this.logger.warn(`sandbox file push failed: ${(e as Error).message}`);
      return {
        passed: false,
        output: `could not prepare validation sandbox: ${(e as Error).message}`,
        command: testCommand,
      };
    }

    throwIfAborted(signal);
    const result = await this.sandbox.run(sandboxId, testCommand, timeoutMs, undefined, signal);
    throwIfAborted(signal);
    // Trim long outputs to something the coder can still act on.
    const output =
      result.output.length > 12_000
        ? `${result.output.slice(0, 12_000)}\n… (output truncated)`
        : result.output;

    return {
      passed: result.exitCode === 0 && !result.timedOut,
      output,
      command: testCommand,
      reason:
        result.timedOut
          ? `command timed out after ${timeoutMs}ms`
          : result.exitCode === null
            ? 'command exited without a reported code'
            : result.exitCode !== 0
              ? `command exited with code ${result.exitCode}`
              : undefined,
    };
  }
}
