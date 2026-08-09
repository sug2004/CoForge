import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { Duplex } from 'stream';
import {
  CONTAINER_IMAGE,
  CONTAINER_NAME_PREFIX,
  CONTAINER_MEMORY,
  CONTAINER_CPUS,
  CONTAINER_PIDS_LIMIT,
  WORKSPACE_DIR,
  SANDBOX_NETWORK_NAME,
  SETUP_PACKAGES,
  DEFAULT_MAX_CONTAINERS,
  DEFAULT_IDLE_TIMEOUT_MS,
  SWEEPER_INTERVAL_MS,
  IGNORED_DIRS,
  PREVIEW_PORTS,
} from './constants';

export interface FileDiff {
  files?: Record<string, string>;
  deleted?: string[];
}

export interface ShellSession {
  exec: Docker.Exec;
  stream: Duplex;
  workspaceDir: string;
}

interface SandboxEntry {
  container: Docker.Container;
  containerId: string;
  workspaceDir: string;
  createdAt: number;
  lastUsedAt: number;
  provisioned: boolean;
  shell: ShellSession | null;
}

interface PreviewBridge {
  server: net.Server;
  hostPort: number;
}

// Runs inside the sandbox container: pipes a TCP connection to the app's
// localhost port so the runner can reach servers that bind only to 127.0.0.1
// (e.g. Vite's default). Uses stdin/stdout over the exec hijack stream.
const BRIDGE_SCRIPT = `
const net = require('net');
const port = parseInt(process.argv[1], 10);
const sock = net.connect(port, '127.0.0.1');
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on('error', () => process.exit(1));
process.stdin.on('error', () => process.exit(1));
`;

@Injectable()
export class SandboxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SandboxService.name);
  private readonly docker: Docker;
  private readonly entries = new Map<string, SandboxEntry>();
  private readonly pendingCreates = new Map<string, Promise<SandboxEntry>>();
  private readonly previewBridges = new Map<string, PreviewBridge>();
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
    try {
      await this.docker.createNetwork({
        Name: SANDBOX_NETWORK_NAME,
        Driver: 'bridge',
        CheckDuplicate: true,
      });
      this.log.log(`Created network ${SANDBOX_NETWORK_NAME}`);
    } catch (e) {
      const statusCode = (e as { statusCode?: number })?.statusCode;
      if (statusCode !== 409) {
        this.log.warn(`create network failed: ${(e as Error)?.message}`);
      }
    }
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const key of [...this.previewBridges.keys()]) {
      const bridge = this.previewBridges.get(key);
      this.previewBridges.delete(key);
      try {
        bridge?.server.close();
      } catch {
        // ignore
      }
    }
    for (const entry of this.entries.values()) {
      try {
        entry.shell?.stream.destroy();
      } catch {
        // ignore
      }
    }
  }

  async openShell(sessionId: string): Promise<ShellSession> {
    const entry = await this.ensureContainer(sessionId);
    entry.lastUsedAt = Date.now();
    if (!entry.provisioned) await this.provision(entry);

    // share the live shell — a reconnect or second tab attaches to the same
    // bash so cwd/env and background processes persist across disconnects
    if (entry.shell && !entry.shell.stream.destroyed) {
      return entry.shell;
    }

    const exec = await entry.container.exec({
      Cmd: ['/bin/bash'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'node',
      WorkingDir: WORKSPACE_DIR,
      Env: ['TERM=xterm-256color'],
    });
    const stream = await exec.start({ Tty: true, stdin: true, hijack: true });
    entry.shell = { exec, stream, workspaceDir: entry.workspaceDir };
    return entry.shell;
  }

  shellClosed(sessionId: string, stream: Duplex) {
    const entry = this.entries.get(sessionId);
    if (entry?.shell?.stream === stream) entry.shell = null;
  }

  async resizeShell(sessionId: string, cols: number, rows: number) {
    const entry = this.entries.get(sessionId);
    if (!entry?.shell) return;
    const h = Math.max(2, Math.round(rows || 24));
    const w = Math.max(2, Math.round(cols || 80));
    try {
      await entry.shell.exec.resize({ h, w });
    } catch {
      // container may be gone
    }
  }

  async writeFiles(sessionId: string, diff: FileDiff) {
    const entry = await this.ensureContainer(sessionId);
    await this.applyFileDiff(entry, diff);
  }

  // ── preview (published container port → host port) ────────────────────────
  // Dev-server ports are published to random 127.0.0.1 host ports at container
  // creation (see createContainer). Docker Desktop hosts cannot reach bridge
  // network container IPs, so we resolve the host port via the Docker API
  // instead of running a host-side TCP proxy.

  async openPreview(
    sessionId: string,
    containerPort: number,
  ): Promise<{ hostPort: number }> {
    const entry = await this.ensureContainer(sessionId);
    // Always use the exec bridge: it connects to 127.0.0.1 *inside* the
    // container, so it works whether the app binds to 0.0.0.0 or only to
    // localhost (Vite's default). A connectivity probe of the published port
    // can't work — Docker's userland proxy accepts the TCP handshake even
    // when the container-side listener is absent.
    const hostPort = await this.startExecBridge(entry, containerPort);
    return { hostPort };
  }

  async listPublishedPorts(
    sessionId: string,
  ): Promise<Array<{ port: number; hostPort: number; url: string }>> {
    const entry = await this.ensureContainer(sessionId);
    const info = await entry.container.inspect();
    const ports: Array<{ port: number; hostPort: number; url: string }> = [];
    for (const p of PREVIEW_PORTS) {
      const published =
        info.NetworkSettings?.Ports?.[`${p}/tcp`] ?? [];
      const binding =
        published.find((b) => b.HostIp === '127.0.0.1') ?? published[0];
      if (binding?.HostPort) {
        const hostPort = Number.parseInt(binding.HostPort, 10);
        ports.push({ port: p, hostPort, url: `http://localhost:${hostPort}` });
      }
    }
    return ports;
  }

  closePreview(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    for (const [key, bridge] of [...this.previewBridges]) {
      if (key.startsWith(`${entry.containerId}:`)) {
        this.previewBridges.delete(key);
        try {
          bridge.server.close();
        } catch {
          // already closed
        }
      }
    }
  }

  private async startExecBridge(
    entry: SandboxEntry,
    containerPort: number,
  ): Promise<number> {
    const key = `${entry.containerId}:${containerPort}`;
    const existing = this.previewBridges.get(key);
    if (existing) return existing.hostPort;

    const server = net.createServer((socket) => {
      let closed = false;
      let execStream: Duplex | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        try {
          execStream?.destroy();
        } catch {
          // ignore
        }
      };

      const run = async () => {
        try {
          const exec = await entry.container.exec({
            Cmd: ['node', '-e', BRIDGE_SCRIPT, String(containerPort)],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            User: 'node',
          });
          execStream = await exec.start({ hijack: true, stdin: true });

          // docker exec with Tty:false multiplexes stdout/stderr as frames:
          // [type:1B, 0,0,0, size:4B BE][payload]
          let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          execStream.on('data', (chunk: Buffer) => {
            pending = pending.length
              ? Buffer.concat([pending, chunk])
              : chunk;
            while (pending.length >= 8) {
              const type = pending[0];
              const size = pending.readUInt32BE(4);
              if (pending.length < 8 + size) break;
              const payload = pending.subarray(8, 8 + size);
              pending = pending.subarray(8 + size);
              if (type === 1 && !closed) socket.write(payload);
            }
          });
          execStream.on('end', close);
          execStream.on('close', close);
          execStream.on('error', close);

          socket.on('data', (d) => {
            if (execStream && !closed) execStream.write(d);
          });
          socket.on('close', close);
          socket.on('error', close);
        } catch {
          close();
        }
      };
      void run();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const hostPort = (server.address() as net.AddressInfo).port;
    this.previewBridges.set(key, { server, hostPort });
    return hostPort;
  }

  async listFiles(sessionId: string): Promise<Record<string, string>> {
    const entry = await this.ensureContainer(sessionId);
    return this.readWorkspace(entry.workspaceDir, '');
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

    const spec = () => ({
      name,
      Image: CONTAINER_IMAGE,
      Cmd: ['sleep', 'infinity'],
      User: 'node',
      WorkingDir: WORKSPACE_DIR,
      Tty: false,
      OpenStdin: false,
      NetworkingConfig: {
        EndpointsConfig: { [SANDBOX_NETWORK_NAME]: {} },
      },
      HostConfig: {
        // tini as PID 1 so exited exec processes (shells, bridges, builds)
        // get reaped instead of piling up as zombies against the pids limit
        Init: true,
        Memory: CONTAINER_MEMORY,
        NanoCpus: CONTAINER_CPUS * 1e9,
        PidsLimit: CONTAINER_PIDS_LIMIT,
        Binds: [`${workspaceDir}:${WORKSPACE_DIR}`],
        PortBindings: Object.fromEntries(
          PREVIEW_PORTS.map((p) => [
            `${p}/tcp`,
            [{ HostIp: '127.0.0.1', HostPort: '' }],
          ]),
        ),
      },
      ExposedPorts: Object.fromEntries(
        PREVIEW_PORTS.map((p) => [`${p}/tcp`, {}]),
      ),
    });

    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(spec());
      await container.start();
    } catch (e) {
      const statusCode = (e as { statusCode?: number })?.statusCode;
      if (statusCode !== 409) throw e;
      // a container from a previous process still holds the name
      const stale = this.docker.getContainer(name);
      const staleInfo = await stale.inspect();
      const networks = Object.keys(staleInfo.NetworkSettings?.Networks ?? {});
      if (!networks.includes(SANDBOX_NETWORK_NAME)) {
        // stale container predates the network fix — drop it and recreate
        await stale.remove({ force: true });
        container = await this.docker.createContainer(spec());
        await container.start();
      } else {
        container = stale;
        if (!staleInfo.State.Running) {
          await container.start();
        }
      }
    }
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
      provisioned: false,
      shell: null,
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  private async provision(entry: SandboxEntry) {
    const cmd = `apt-get update -qq && apt-get install -y -qq --no-install-recommends ${SETUP_PACKAGES} && rm -rf /var/lib/apt/lists/*`;
    try {
      const exec = await entry.container.exec({
        Cmd: ['sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: 'root',
      });
      const stream = await exec.start({ hijack: false, stdin: false });
      let out = '';
      stream.on('data', (c: Buffer) => {
        out += c.toString();
      });
      await new Promise<void>((resolve, reject) => {
        stream.on('end', () => resolve());
        stream.on('close', () => resolve());
        stream.on('error', reject);
      });
      const info = await exec.inspect();
      if (info.ExitCode !== 0) {
        this.log.warn(
          `provision failed (exit ${info.ExitCode}): ${out.slice(-2000)}`,
        );
      } else {
        entry.provisioned = true;
        this.log.log(
          `Provisioned tools for container ${entry.containerId.slice(0, 12)}`,
        );
      }
    } catch (e) {
      this.log.warn(`provision error: ${(e as Error)?.message}`);
    }
  }

  private async applyFileDiff(entry: SandboxEntry, diff: FileDiff) {
    // Write only the keys in the diff — never sweep the whole workspace, so
    // files produced by the sandbox (lockfiles, build output) survive until
    // they are explicitly deleted from the Y.Doc.
    for (const [relPath, content] of Object.entries(diff.files ?? {})) {
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
    for (const relPath of diff.deleted ?? []) {
      const safe = this.sanitizeRelPath(relPath);
      const full = path.join(entry.workspaceDir, safe);
      await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }
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
      if (now - entry.lastUsedAt > this.idleTimeoutMs) {
        idle.push(id);
      }
    }
    for (const id of idle) {
      const entry = this.entries.get(id)!;
      this.log.log(`Evicting idle container for session ${id}`);
      await this.destroyEntry(entry);
      this.entries.delete(id);
    }

    while (this.entries.size > this.maxContainers) {
      const candidates = [...this.entries.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      );
      if (candidates.length === 0) break;
      const [id, entry] = candidates[0];
      this.log.log(
        `Evicting oldest container for session ${id} (${this.entries.size} > ${this.maxContainers})`,
      );
      await this.destroyEntry(entry);
      this.entries.delete(id);
    }
  }

  private async destroyEntry(entry: SandboxEntry) {
    try {
      entry.shell?.stream.destroy();
    } catch {
      // ignore
    }
    try {
      await entry.container.stop({ t: 3 });
    } catch {
      // container may already be stopped
    }
    try {
      await entry.container.remove({ force: true });
    } catch {
      // already gone
    }
  }

  // Called when the session/project is deleted: removes the container (even
  // if it was adopted after a runner restart) plus the host workspace dir.
  async destroyContainer(sessionId: string) {
    const entry = this.entries.get(sessionId);
    if (entry) {
      await this.destroyEntry(entry);
      this.entries.delete(sessionId);
      this.pendingCreates.delete(sessionId);
    } else {
      try {
        const container = this.docker.getContainer(
          `${CONTAINER_NAME_PREFIX}-${sessionId}`,
        );
        const info = await container.inspect();
        if (info) {
          try {
            await container.stop({ t: 3 });
          } catch {
            // already stopped
          }
          try {
            await container.remove({ force: true });
          } catch {
            // already gone
          }
        }
      } catch {
        // no container for this session — nothing to do
      }
    }
    for (const key of [...this.previewBridges.keys()]) {
      const bridge = this.previewBridges.get(key);
      if (bridge && key.startsWith(entry?.containerId ?? `${CONTAINER_NAME_PREFIX}-${sessionId}:`)) {
        this.previewBridges.delete(key);
        try {
          bridge.server.close();
        } catch {
          // already closed
        }
      }
    }
    const wsDir = path.join(this.workspaceRoot, sessionId);
    try {
      await fs.rm(wsDir, { recursive: true, force: true });
    } catch {
      // dir may already be gone
    }
    this.log.log(`Destroyed sandbox for session ${sessionId}`);
  }
}
