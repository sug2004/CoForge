import { Injectable, Logger } from "@nestjs/common";
import { SandboxClient, SandboxRunResult } from "./sandbox-client";
import { ValidationResult, throwIfAborted } from "./types";

@Injectable()
export class Validator {
  private readonly logger = new Logger(Validator.name);

  constructor(private readonly sandbox: SandboxClient) {}

  // The agent's terminal/tool calls and validation run in the SAME container as
  // the user's UI terminal (the session's sandbox). Work the agent does in the
  // sandbox — scaffolding, installs, edits, created files — shows up live in the
  // user's actual terminal, and the two stay in sync on one filesystem.
  sandboxKey(sessionId: string): string {
    return sessionId;
  }

  // Base files (shared Y.Doc) + the staged diff on top. Never touches the live
  // shared state — validation happens in the private per-thread sandbox.
  async validate(
    sessionId: string,
    baseFiles: Record<string, string>,
    staged: Record<string, string>,
    testCommand: string | null,
    signal?: AbortSignal,
  ): Promise<ValidationResult> {
    if (!testCommand) {
      return {
        passed: true,
        output: "",
        command: null,
        reason: "no test/build command detected — skipped validation",
      };
    }

    const sandboxId = this.sandboxKey(sessionId);
    const workspace = { ...baseFiles, ...staged };
    const timeoutMs = 300_000;

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

    // node_modules is never in the pushed file set, so a fresh container has no
    // deps and `npm run build`/`npm test` fails with "X: not found". Install
    // them before validating; the sandbox persists across steps, so this is a
    // one-time cost per container.
    const install = await this.installDependencies(
      sandboxId,
      workspace,
      signal,
    );
    if (install.failed) {
      this.logger.warn(
        `dependency install failed: ${install.output.slice(0, 500)}`,
      );
      return {
        passed: false,
        output: `could not install dependencies: ${install.output.slice(0, 4000)}`,
        command: testCommand,
      };
    }

    throwIfAborted(signal);
    // A slow/cold container (provisioning, apt install) or a flaky sandbox
    // runner must NOT kill the whole agent run — turn a transport error into a
    // failed validation so the coder gets feedback and retries. Only a genuine
    // user cancel propagates.
    let result: SandboxRunResult;
    try {
      result = await this.sandbox.run(
        sandboxId,
        testCommand,
        timeoutMs,
        undefined,
        signal,
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      this.logger.warn(`validation run failed: ${(e as Error).message}`);
      return {
        passed: false,
        output: `validation command could not run: ${(e as Error).message}`,
        command: testCommand,
      };
    }
    throwIfAborted(signal);
    // Trim long outputs to something the coder can still act on. The tail is
    // the interesting part (the actual error message), so keep the END rather
    // than the head; also keep it small — it's replayed verbatim into the
    // coder's prompt on retry, and the free Groq tier rejects oversized prompts.
    const output =
      result.output.length > 4_000
        ? `… (output truncated)\n${result.output.slice(-4_000)}`
        : result.output;

    return {
      passed: result.exitCode === 0 && !result.timedOut,
      output,
      command: testCommand,
      reason: result.timedOut
        ? `command timed out after ${timeoutMs}ms`
        : result.exitCode === null
          ? "command exited without a reported code"
          : result.exitCode !== 0
            ? `command exited with code ${result.exitCode}`
            : undefined,
    };
  }

  // Installs project dependencies inside the sandbox before validation. Picks
  // the package manager from the lockfiles present in the file set (pnpm >
  // yarn > npm), else falls back to plain `npm install`. Also handles Python
  // (requirements.txt / pyproject.toml / setup.py), Go (go.mod) and Rust
  // (Cargo.toml) projects. Skips the work when the deps already exist (the
  // sandbox persists across steps).
  private async installDependencies(
    sandboxId: string,
    workspace: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ failed: boolean; output: string }> {
    const plan = this.installPlan(workspace);
    if (!plan) return { failed: false, output: "" };

    const { dir, installer, marker } = plan;
    const prefix = dir ? `cd ${dir} && ` : "";

    try {
      const already = await this.sandbox.run(
        sandboxId,
        `test -e ${marker} && echo present || echo missing`,
        15_000,
      );
      if (already.exitCode === 0 && already.output.includes("present")) {
        return { failed: false, output: "(deps already installed)" };
      }
    } catch {
      // proceed to install — the check is best-effort
    }

    throwIfAborted(signal);
    try {
      const res = await this.sandbox.run(
        sandboxId,
        `${prefix}${installer}`,
        300_000,
        undefined,
        signal,
      );
      if (res.exitCode !== 0 && !res.timedOut) {
        return { failed: true, output: res.output };
      }
      return { failed: false, output: res.output };
    } catch (e) {
      return { failed: true, output: (e as Error).message };
    }
  }

  // Decides what (if anything) to install and how, based on the manifests in
  // the file set. Returns null when the project needs no dependency install.
  // `marker` is a path whose presence means deps are already in place.
  private installPlan(workspace: Record<string, string>): {
    dir: string;
    installer: string;
    marker: string;
  } | null {
    const pkgPaths = Object.keys(workspace).filter(
      (p) => p === "package.json" || p.endsWith("/package.json"),
    );
    if (pkgPaths.length > 0) {
      const dir =
        pkgPaths[0] === "package.json"
          ? ""
          : pkgPaths[0].slice(0, pkgPaths[0].lastIndexOf("/"));
      const marker = dir ? `${dir}/node_modules` : "node_modules";
      // npm is always present in the base image; pnpm/yarn shims may not be, so
      // install with npm regardless of which lockfile the project uses. The coder
      // can switch to the project's native manager via the terminal if needed.
      return { dir, installer: "npm install", marker };
    }

    const nonJs: Array<{
      manifest: string;
      installer: string;
      marker: string;
    }> = [
      {
        manifest: "requirements.txt",
        installer: "python3 -m pip install -r requirements.txt",
        marker: "deps_done",
      },
      {
        manifest: "pyproject.toml",
        installer: "python3 -m pip install -e .",
        marker: "deps_done",
      },
      {
        manifest: "setup.py",
        installer: "python3 -m pip install -e .",
        marker: "deps_done",
      },
      { manifest: "go.mod", installer: "go mod download", marker: "go.sum" },
      {
        manifest: "Cargo.toml",
        installer: "cargo fetch",
        marker: "Cargo.lock",
      },
    ];
    for (const { manifest, installer, marker } of nonJs) {
      const hit = Object.keys(workspace).find(
        (p) => p === manifest || p.endsWith(`/${manifest}`),
      );
      if (!hit) continue;
      const dir = hit === manifest ? "" : hit.slice(0, hit.lastIndexOf("/"));
      const markerPath = dir ? `${dir}/${marker}` : marker;
      return { dir, installer, marker: markerPath };
    }
    return null;
  }
}
