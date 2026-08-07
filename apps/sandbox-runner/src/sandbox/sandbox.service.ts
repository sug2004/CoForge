import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PassThrough } from 'stream';
import { Response } from 'express';
import {
  CONTAINER_IMAGE,
  CONTAINER_NAME_PREFIX,
  CONTAINER_MEMORY,
  CONTAINER_CPUS,
  CONTAINER_PIDS_LIMIT,
  WORKSPACE_DIR,
  DEFAULT_RUN_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_CONTAINERS,
  DEFAULT_IDLE_TIMEOUT_MS,
  SWEEPER_INTERVAL_MS,
  IGNORED_DIRS,
  MAX_FILE_BYTES,
} from './constants';
import { writeNdjson } from './ndjson';

interface SandboxEntry {
  container: Docker.Container;
  containerId: string;
  workspaceDir: string;
  createdAt: number;
  lastUsedAt: number;
  running: { exec: Docker.Exec; timeout: NodeJS.Timeout } | null;
}

@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SandboxService.name);
  private readonly docker: Docker;
  private readonly entries = new Map<string, SandboxEntry>();
  private readonly pendingCreates = new Map<string, Promise<SandboxEntry>>();
  private readonly maxContainers: number;
  private readonly idleTimeoutMs: number;
  private readonly workspaceRoot: string;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService) {
    this.maxContainers = parseInt(
      config.get('MAX_CONTAINERS') ?? `${DEFAULT_MAX_CONTAINERS}`,
      10,
    );
    this.idleTimeoutMs = parseInt(
      config.get('CONTAINER_IDLE_TIMEOUT_MS') ?? `${DEFAULT_IDLE_TIMEOUT_MS}`,
      10,
    );
    this.workspaceRoot =
      config.get('SANDBOX_WORKSPACE_ROOT') ??
      path.join(os.tmpdir(), 'coforge-sandboxes');

    if (process.env.DOCKER_HOST) {
      this.docker = new Docker();
    } else if (process.platform === 'win32') {
      this.docker = new Docker({ socketPath: '\\\\.\\pipe\\docker_engine' });
    } else {
      this.docker = new Docker();
    }
  }

  async onModuleInit() {
    this.sweeper = setInterval(() => {
      this.sweep().catch((e) => this.log.error('sweep error', e));
    }, SWEEPER_INTERVAL_MS);
    this.sweeper.unref();
    try {
      await this.docker.info();
      this.log.log('Docker daemon connected');
    } catch {
      this.log.warn(
        'Docker daemon not reachable — containers will fail to create',
      );
    }
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  async exec(
    sessionId: string,
    command: string | undefined,
    files: Record<string, string> | undefined,
    timeoutMs: number | undefined,
    res: Response,
  ) {
    if (!command?.trim()) throw new BadRequestException('command is required');

    const entry = await this.ensureContainer(sessionId);
    if (entry.running) throw new ConflictException('busy');

    entry.lastUsedAt = Date.now();

    if (files && Object.keys(files).length > 0) {
      await this.syncFiles(entry, files);
    }

    const exec = await entry.container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: 'node',
      WorkingDir: WORKSPACE_DIR,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const execId = exec.id;

    let timedOut = false;
    let ended = false;
    let exitCode: number | null = null;
    let exitCodeRead = false;

    const timeoutMsValue = timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS;

    async function gracefulFinish() {
      if (ended) return;
      ended = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (entry.running?.exec === exec) entry.running = null;

      if (!exitCodeRead) {
        exitCodeRead = true;
        try {
          const info = await exec.inspect();
          exitCode = info.ExitCode;
        } catch {
          // exec may already be gone — exitCode stays null
        }
      }

      if (!res.writableEnded) {
        writeNdjson(res, { stream: 'exit', exitCode, timeout: timedOut });
        res.end();
      }
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Write exit event and close response BEFORE killing the exec,
      // so the client receives a clean response before the hijacked stream is torn down.
      void gracefulFinish().finally(() => {
        this.killExec(execId).catch(() => {});
      });
    }, timeoutMsValue);
    timeoutHandle.unref();
    entry.running = { exec, timeout: timeoutHandle };

    res.on('close', () => {
      if (!ended) this.killExec(execId).catch(() => {});
    });

    const relabel = (streamType: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (ended) return;
      writeNdjson(res, { stream: streamType, chunk: chunk.toString() });
    };

    stdout.on('data', relabel('stdout'));
    stderr.on('data', relabel('stderr'));

    const onStreamDone = () => {
      void gracefulFinish();
    };
    stream.on('close', onStreamDone);
    stream.on('end', onStreamDone);
    stream.on('error', onStreamDone);

    stdout.on('end', () => {
      if (stderr.destroyed) void gracefulFinish();
    });
  }

  private async ensureContainer(sessionId: string): Promise<SandboxEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      try {
        const info = await existing.container.inspect();
        if (!info.State.Running) {
          await existing.container.start();
        }
        return existing;
      } catch (e) {
        const statusCode = (e as { statusCode?: number })?.statusCode;
        if (statusCode === 404) this.entries.delete(sessionId);
        else throw e;
      }
    }

    let pending = this.pendingCreates.get(sessionId);
    if (!pending) {
      pending = this.createContainer(sessionId)
        .then((entry) => {
          this.pendingCreates.delete(sessionId);
          return entry;
        })
        .catch((err) => {
          this.pendingCreates.delete(sessionId);
          throw err;
        });
      this.pendingCreates.set(sessionId, pending);
    }
    return pending;
  }

  private async createContainer(sessionId: string): Promise<SandboxEntry> {
    const name = `${CONTAINER_NAME_PREFIX}${sessionId}`;
    const workspaceDir = path.join(this.workspaceRoot, sessionId);
    await fs.mkdir(workspaceDir, { recursive: true });

    const container = await this.docker.createContainer({
      name,
      Image: CONTAINER_IMAGE,
      Cmd: ['sleep', 'infinity'],
      User: 'node',
      WorkingDir: WORKSPACE_DIR,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        Memory: CONTAINER_MEMORY,
        NanoCpus: CONTAINER_CPUS * 1e9,
        PidsLimit: CONTAINER_PIDS_LIMIT,
        NetworkMode: 'none',
        Binds: [`${workspaceDir}:${WORKSPACE_DIR}`],
      },
    });
    await container.start();
    const info = await container.inspect();

    this.log.log(
      `Created container ${name} (${info.Id.slice(0, 12)}) for session ${sessionId}`,
    );

    const entry: SandboxEntry = {
      container,
      containerId: info.Id,
      workspaceDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      running: null,
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  private async syncFiles(entry: SandboxEntry, files: Record<string, string>) {
    // Write all files from the Y.Doc into the workspace
    for (const [relPath, content] of Object.entries(files)) {
      const safe = this.sanitizeRelPath(relPath);
      const full = path.join(entry.workspaceDir, safe);
      try {
        if (relPath.endsWith('/')) {
          // empty-directory marker → ensure the directory exists
          await fs.mkdir(full, { recursive: true });
          continue;
        }
        await fs.mkdir(path.dirname(full), { recursive: true });
        // guard against EISDIR: if the path is currently a directory, remove it first
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
        await fs.writeFile(full, content, 'utf-8');
      } catch {
        // skip the problematic file rather than aborting the whole sync
      }
    }
    // Delete workspace files that are no longer in the Y.Doc
    const current = await this.readWorkspace(entry.workspaceDir, '');
    for (const relPath of Object.keys(current)) {
      if (relPath.endsWith('/')) continue; // empty-dir marker — not a target for unlink
      if (!(relPath in files)) {
        await fs.unlink(path.join(entry.workspaceDir, relPath)).catch(() => {});
      }
    }
  }

  async listFiles(sessionId: string): Promise<Record<string, string>> {
    const entry = await this.ensureContainer(sessionId);
    return this.readWorkspace(entry.workspaceDir, '');
  }

  private async readWorkspace(
    dir: string,
    base: string,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const subFiles = await this.readWorkspace(full, rel);
        if (Object.keys(subFiles).length === 0) {
          // empty directory — represent as a trailing-slash marker
          files[`${rel}/`] = '';
        } else {
          Object.assign(files, subFiles);
        }
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        try {
          const content = await fs.readFile(full, 'utf-8');
          if (content.includes('\u0000')) continue;
          files[rel] = content;
        } catch {
          // skip unreadable files
        }
      }
    }
    return files;
  }

  private sanitizeRelPath(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/\\/g, '/');
    if (
      normalized.startsWith('../') ||
      normalized === '..' ||
      path.isAbsolute(normalized)
    ) {
      throw new BadRequestException(`Invalid file path: ${relPath}`);
    }
    return normalized;
  }

  private async sweep() {
    const now = Date.now();

    const idle: string[] = [];
    for (const [id, entry] of this.entries) {
      if (!entry.running && now - entry.lastUsedAt > this.idleTimeoutMs) {
        idle.push(id);
      }
    }
    for (const id of idle) {
      const entry = this.entries.get(id)!;
      if (entry.running) continue;
      this.log.log(`Evicting idle container for session ${id}`);
      await this.destroyEntry(entry);
      this.entries.delete(id);
    }

    while (this.entries.size > this.maxContainers) {
      const candidates = [...this.entries.entries()]
        .filter(([, e]) => !e.running)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      if (candidates.length === 0) break;
      const [id, entry] = candidates[0];
      this.log.log(
        `Evicting oldest container for session ${id} (${this.entries.size} > ${this.maxContainers})`,
      );
      await this.destroyEntry(entry);
      this.entries.delete(id);
    }
  }

  private killExec(execId: string): Promise<void> {
    return new Promise((resolve) => {
      const modem = this.docker.modem as unknown as {
        dial(opts: Record<string, unknown>, cb: () => void): void;
      };
      modem.dial(
        {
          path: `/exec/${execId}/kill`,
          method: 'POST',
          body: JSON.stringify({ signal: 'SIGKILL' }),
          statusCodes: { 200: true, 204: true, 404: true, 409: true },
        },
        () => resolve(),
      );
    });
  }

  private async destroyEntry(entry: SandboxEntry) {
    try {
      await entry.container.stop({ t: 1 });
    } catch {
      // container may already be stopped
    }
    try {
      await entry.container.remove({ force: true });
    } catch {
      // container may already be gone
    }
  }
}
