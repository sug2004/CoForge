import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as chokidar from 'chokidar';
import WebSocket, { WebSocketServer } from 'ws';
import { AppModule } from './app.module';
import { SandboxService, ShellSession } from './sandbox/sandbox.service';
import { IGNORED_DIRS } from './sandbox/constants';

const REVERSE_DEBOUNCE_MS = 300;

function watchWorkspace(
  workspaceDir: string,
  send: (frame: string) => void,
): () => void {
  const pending = new Map<string, 'file' | 'delete'>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const flush = async () => {
    timer = null;
    if (closed || pending.size === 0) return;
    const changes: Record<string, string> = {};
    const deleted: string[] = [];
    for (const [rel, kind] of pending) {
      if (kind === 'delete') {
        deleted.push(rel);
        continue;
      }
      const full = path.join(workspaceDir, rel);
      try {
        const content = await fs.readFile(full, 'utf-8');
        if (content.includes('\u0000')) continue; // binary — skip
        changes[rel] = content;
      } catch {
        // file vanished between event and read — treat as deleted
        deleted.push(rel);
      }
    }
    pending.clear();
    if (Object.keys(changes).length > 0 || deleted.length > 0) {
      send(`\u0000${JSON.stringify({ type: 'files', changes, deleted })}`);
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, REVERSE_DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(workspaceDir, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = path.relative(workspaceDir, p);
      const parts = rel.split(/[\\/]/);
      return parts.some((part) => IGNORED_DIRS.has(part));
    },
    usePolling: process.platform === 'win32',
    interval: 300,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });

  watcher.on('add', (p) => {
    pending.set(toRel(workspaceDir, p), 'file');
    schedule();
  });
  watcher.on('change', (p) => {
    pending.set(toRel(workspaceDir, p), 'file');
    schedule();
  });
  watcher.on('unlink', (p) => {
    pending.set(toRel(workspaceDir, p), 'delete');
    schedule();
  });
  watcher.on('unlinkDir', (p) => {
    const rel = toRel(workspaceDir, p);
    if (rel) {
      pending.set(`${rel}/`, 'delete');
      schedule();
    }
  });
  watcher.on('error', () => {
    // watcher errors are non-fatal — keep the terminal alive
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    void watcher.close();
  };
}

function toRel(workspaceDir: string, fullPath: string): string {
  const rel = path.relative(workspaceDir, fullPath);
  return rel.replace(/\\/g, '/');
}

async function handleShell(
  sandbox: SandboxService,
  ws: WebSocket,
  sessionId: string,
) {
  let shell: ShellSession;
  try {
    shell = await sandbox.openShell(sessionId);
  } catch (e) {
    ws.send(
      JSON.stringify({
        error: (e as Error)?.message ?? 'failed to open shell',
      }),
    );
    ws.close();
    return;
  }
  const stream = shell.stream;

  const onWsMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) {
      const text = (data as Buffer).toString('utf-8');
      if (text.startsWith('\u0000')) {
        // control frame
        try {
          const ctrl = JSON.parse(text.slice(1)) as {
            type?: string;
            cols?: number;
            rows?: number;
          };
          if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
            void sandbox.resizeShell(sessionId, ctrl.cols, ctrl.rows);
          }
        } catch {
          // malformed control frame — ignore
        }
        return;
      }
      stream.write(text);
      return;
    }
    stream.write(data);
  };

  const onStreamData = (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk, { binary: true });
    }
  };

  const onShellClosed = () => {
    sandbox.shellClosed(sessionId, stream);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };

  const detach = () => {
    stream.off('data', onStreamData);
    stream.off('error', onShellClosed);
    stream.off('close', onShellClosed);
  };

  let paused = false;
  const maybePause = () => {
    if (ws.bufferedAmount > 256 * 1024 && !paused) {
      paused = true;
      stream.pause();
    } else if (ws.bufferedAmount <= 256 * 1024 && paused) {
      paused = false;
      stream.resume();
    }
  };

  const stopWatch = watchWorkspace(shell.workspaceDir, (frame) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  });

  const drainTimer = setInterval(maybePause, 200);

  ws.on('message', onWsMessage);
  ws.on('close', () => {
    stopWatch();
    detach();
    if (paused) stream.resume();
    clearInterval(drainTimer);
  });
  ws.on('error', () => {
    stopWatch();
    detach();
    if (paused) stream.resume();
    clearInterval(drainTimer);
  });
  stream.on('data', onStreamData);
  stream.on('error', onShellClosed);
  stream.on('close', onShellClosed);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({ limit: '50mb' }));
  app.enableCors();

  const httpServer = http.createServer(
    app.getHttpAdapter().getInstance() as http.RequestListener,
  );
  await app.init();

  const sandbox = app.get(SandboxService);

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    const m = pathname.match(/^\/sandbox\/([^/]+)\/shell$/);
    if (!m) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, m[1]);
    });
  });

  wss.on(
    'connection',
    (ws: WebSocket, _req: http.IncomingMessage, sessionId: string) => {
      void handleShell(sandbox, ws, sessionId);
    },
  );

  const port = process.env.PORT ?? 3004;
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      console.log(`sandbox-runner running on http://localhost:${port}`);
      resolve();
    });
  });
}
void bootstrap();
