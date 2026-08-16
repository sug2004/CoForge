import { Injectable } from "@nestjs/common";
import { SandboxClient } from "./sandbox-client";

export interface ToolArgs {
  [key: string]: any;
}

export interface ToolResult {
  output: string;
  exitCode?: number | null;
  isError: boolean;
  // For write_file/delete_file: the full updated staged map (all files staged
  // so far, including from earlier steps). Undefined for read-only tools.
  staged?: Record<string, string>;
}

// Receives each decoded stdout/stderr chunk as the command runs, so long-lived
// commands (npm install, test suites, dev servers) can be streamed live.
export type ToolChunkHandler = (
  chunk: string,
  stream: "stdout" | "stderr",
) => void;

const TOOL_TIMEOUT_MS = 300_000;

// Node script that walks the sandbox filesystem and prints paths matching a
// glob pattern. Kept as plain double-quoted string lines so no backticks or
// template interpolation leak into the heredoc. `**` crosses directories;
// `*`/`?` match within a single path segment. Skips VCS/dependency/build dirs.
const GLOB_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const base = process.argv[2];",
  "const pat = process.argv[3];",
  "const nl = String.fromCharCode(10);",
  "const skip = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.cache', '__pycache__']);",
  "let re;",
  "try {",
  "  const out = [];",
  "  function segToRe(s) {",
  "    return s.split('').map(function (ch) {",
  "      if (ch === '*') return '[^/]*';",
  "      if (ch === '?') return '[^/]';",
  "      if ('\\\\^$.|?*+()[]{}'.indexOf(ch) >= 0) return '\\\\' + ch;",
  "      return ch;",
  "    }).join('');",
  "  }",
  "  pat.split('/').forEach(function (s) {",
  "    if (s === '') return;",
  "    if (s === '**') { out.push('(?:.*/)*'); return; }",
  "    if (out.length > 0 && out[out.length - 1] !== '(?:.*/)*') out.push('/');",
  "    out.push(segToRe(s));",
  "  });",
  "  re = new RegExp('^' + out.join('') + '$');",
  "} catch (e) {",
  "  console.error('bad glob pattern: ' + e.message);",
  "  process.exit(1);",
  "}",
  "const out = [];",
  "function walk(d, rel) {",
  "  let es;",
  "  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return; }",
  "  for (const e of es) {",
  "    if (skip.has(e.name)) continue;",
  "    const r = rel ? rel + '/' + e.name : e.name;",
  "    if (e.isDirectory()) { walk(path.join(d, e.name), r); }",
  "    else if (re.test(r)) { out.push(r); if (out.length >= 300) { console.log(out.join(nl)); process.exit(0); } }",
  "  }",
  "}",
  "walk(base, '');",
  "console.log(out.join(nl));",
].join("\n");

// Single-quote a shell argument so user/model-provided strings can't break out
// of the `sh -c` command line.
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function trimTo(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n… (output truncated)`;
}

// Executes the agent's tool calls against the per-thread sandbox. `run_terminal`
// is the "real terminal" the agent shares with the tester — commands run in the
// same container that holds the staged project files, so writes, reads, greps
// and terminal output all see a single consistent state.
@Injectable()
export class AgentTools {
  constructor(private readonly sandbox: SandboxClient) {}

  // Push a set of files (or the whole known workspace) into the sandbox so
  // terminal/read/grep tools operate on the real, current code.
  async ensureWorkspace(
    sandboxId: string,
    files: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(files).length === 0) return;
    await this.sandbox.pushFiles(sandboxId, files);
  }

  async run(
    sandboxId: string,
    name: string,
    args: ToolArgs,
    staged: Record<string, string>,
    onChunk?: ToolChunkHandler,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    switch (name) {
      case "run_terminal":
        return this.runTerminal(sandboxId, args, onChunk, signal);
      case "read_file":
        return this.readFile(sandboxId, args);
      case "list_files":
        return this.listFiles(sandboxId, args);
      case "glob":
        return this.glob(sandboxId, args);
      case "grep":
        return this.grep(sandboxId, args);
      case "write_file":
        return this.writeFile(sandboxId, args, staged);
      case "delete_file":
        return this.deleteFile(sandboxId, args, staged);
      default:
        return { output: `unknown tool: ${name}`, isError: true };
    }
  }

  private async runTerminal(
    sandboxId: string,
    args: ToolArgs,
    onChunk?: ToolChunkHandler,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const command = String(args?.command ?? "").trim();
    if (!command) return { output: "command is required", isError: true };
    const timeoutMs = Math.min(
      Math.max(Number(args?.timeoutMs) || 60_000, 1_000),
      TOOL_TIMEOUT_MS,
    );
    const cwd = args?.cwd ? String(args.cwd).trim() : undefined;
    try {
      const r = await this.sandbox.run(
        sandboxId,
        command,
        timeoutMs,
        onChunk,
        signal,
        cwd,
      );
      return {
        output: trimTo(r.output, 12_000) || "(no output)",
        exitCode: r.exitCode,
        isError: r.exitCode !== 0 || r.timedOut,
      };
    } catch (e) {
      return { output: `exec failed: ${(e as Error).message}`, isError: true };
    }
  }

  private async readFile(
    sandboxId: string,
    args: ToolArgs,
  ): Promise<ToolResult> {
    const p = String(args?.path ?? "").trim();
    if (!p) return { output: "path is required", isError: true };
    try {
      const r = await this.sandbox.run(sandboxId, `cat -- ${shq(p)}`, 15_000);
      if (r.exitCode !== 0) {
        return { output: `no such file: ${p}`, isError: true };
      }
      return {
        output: trimTo(r.output, 24_000) || "(empty file)",
        isError: false,
      };
    } catch (e) {
      return { output: `read failed: ${(e as Error).message}`, isError: true };
    }
  }

  private async listFiles(
    sandboxId: string,
    args: ToolArgs,
  ): Promise<ToolResult> {
    const p = String(args?.path ?? ".").trim() || ".";
    const recursive = args?.recursive === true;
    try {
      const cmd = recursive
        ? `find ${shq(p)} -maxdepth 4 \\( -name node_modules -o -name .git -o -name dist -o -name .next \\) -prune -o -print 2>/dev/null | head -n 300`
        : `ls -la -- ${shq(p)} 2>&1 | head -n 200`;
      const r = await this.sandbox.run(sandboxId, cmd, 15_000);
      return {
        output: trimTo(r.output, 8_000) || "(empty)",
        exitCode: r.exitCode,
        isError: r.exitCode !== 0,
      };
    } catch (e) {
      return { output: `list failed: ${(e as Error).message}`, isError: true };
    }
  }

  private async grep(sandboxId: string, args: ToolArgs): Promise<ToolResult> {
    const pattern = String(args?.pattern ?? "").trim();
    const p = String(args?.path ?? ".").trim() || ".";
    if (!pattern) return { output: "pattern is required", isError: true };
    const regex = args?.regex === true;
    try {
      const cmd =
        `grep -r${regex ? "E" : "F"}nI --exclude-dir=node_modules --exclude-dir=.git ` +
        `--exclude-dir=dist --exclude-dir=.next --exclude-dir=coverage ` +
        `-- ${shq(pattern)} ${shq(p)} 2>/dev/null | head -n 200`;
      const r = await this.sandbox.run(sandboxId, cmd, 20_000);
      return {
        output: trimTo(r.output, 8_000) || "(no matches)",
        exitCode: r.exitCode,
        isError: r.exitCode !== 0,
      };
    } catch (e) {
      return { output: `grep failed: ${(e as Error).message}`, isError: true };
    }
  }

  // Runs a Node glob walker inside the sandbox: node is always present in the
  // base image, and a heredoc avoids shell-quoting the pattern/script.
  private async glob(sandboxId: string, args: ToolArgs): Promise<ToolResult> {
    const pattern = String(args?.pattern ?? "").trim();
    const base = String(args?.path ?? ".").trim() || ".";
    if (!pattern) return { output: "pattern is required", isError: true };
    try {
      const cmd = `node - ${shq(base)} ${shq(pattern)} <<'GLOBEOF'\n${GLOB_SCRIPT}\nGLOBEOF`;
      const r = await this.sandbox.run(sandboxId, cmd, 20_000);
      return {
        output: trimTo(r.output, 8_000) || "(no matches)",
        exitCode: r.exitCode,
        isError: r.exitCode !== 0,
      };
    } catch (e) {
      return { output: `glob failed: ${(e as Error).message}`, isError: true };
    }
  }

  private async writeFile(
    sandboxId: string,
    args: ToolArgs,
    staged: Record<string, string>,
  ): Promise<ToolResult> {
    const p = String(args?.path ?? "").trim();
    if (!p) return { output: "path is required", isError: true };
    const content =
      typeof args?.content === "string"
        ? args.content
        : String(args?.content ?? "");
    const next = { ...staged, [p]: content };
    try {
      await this.sandbox.pushFiles(sandboxId, { [p]: content });
      return {
        output: `wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${p}`,
        isError: false,
        staged: next,
      };
    } catch (e) {
      return {
        output: `write failed: ${(e as Error).message}`,
        isError: true,
        staged,
      };
    }
  }

  private async deleteFile(
    sandboxId: string,
    args: ToolArgs,
    staged: Record<string, string>,
  ): Promise<ToolResult> {
    const p = String(args?.path ?? "").trim();
    if (!p) return { output: "path is required", isError: true };
    const next = { ...staged };
    delete next[p];
    try {
      await this.sandbox.pushFiles(sandboxId, {}, [p]);
      return { output: `deleted ${p}`, isError: false, staged: next };
    } catch (e) {
      return {
        output: `delete failed: ${(e as Error).message}`,
        isError: true,
        staged,
      };
    }
  }
}
