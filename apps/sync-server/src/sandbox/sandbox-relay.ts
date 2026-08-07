import WebSocket from 'ws';
import * as Y from 'yjs';

interface SandboxRoom {
  conns: Set<WebSocket>;
  run: AbortController | null;
}

interface RunnerEvent {
  stream?: 'stdout' | 'stderr' | 'exit' | 'error';
  chunk?: string;
  exitCode?: number | null;
  timeout?: boolean;
  message?: string;
}

interface ClientMessage {
  type?: string;
  command?: string;
  timeoutMs?: number;
}

export class SandboxRelay {
  private rooms = new Map<string, SandboxRoom>();
  private readonly runnerUrl: string;

  constructor(
    private readonly getDoc: (sessionId: string) => Y.Doc,
    runnerUrl = process.env.SANDBOX_RUNNER_URL ?? 'http://localhost:3004',
  ) {
    this.runnerUrl = runnerUrl;
  }

  handleConnection(ws: WebSocket, sessionId: string) {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = { conns: new Set(), run: null };
      this.rooms.set(sessionId, room);
    }
    room.conns.add(ws);

    ws.on('message', (raw) => {
      void this.handleMessage(sessionId, room, raw);
    });

    ws.on('close', () => {
      room.conns.delete(ws);
    });
  }

  private rawToString(raw: WebSocket.RawData): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw).toString();
    if (raw instanceof ArrayBuffer)
      return Buffer.from(new Uint8Array(raw)).toString();
    return Buffer.from(raw).toString();
  }

  private async handleMessage(
    sessionId: string,
    room: SandboxRoom,
    raw: WebSocket.RawData,
  ) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(this.rawToString(raw)) as ClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'sandbox:run') {
      await this.run(sessionId, room, msg.command, msg.timeoutMs);
    } else if (msg.type === 'sandbox:stop') {
      if (room.run) room.run.abort();
    }
  }

  private async run(
    sessionId: string,
    room: SandboxRoom,
    command: string | undefined,
    timeoutMs: number | undefined,
  ) {
    if (!command?.trim()) {
      this.broadcast(room, {
        type: 'sandbox:error',
        message: 'command is required',
      });
      return;
    }
    if (room.run) {
      this.broadcast(room, { type: 'sandbox:error', message: 'busy' });
      return;
    }

    const controller = new AbortController();
    room.run = controller;

    try {
      const res = await fetch(
        `${this.runnerUrl}/sandbox/${encodeURIComponent(sessionId)}/exec`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command,
            files: this.serializeFiles(sessionId),
            timeoutMs,
          }),
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        this.broadcast(room, {
          type: 'sandbox:error',
          message: body.error ?? `runner responded ${res.status}`,
        });
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: RunnerEvent;
          try {
            event = JSON.parse(line) as RunnerEvent;
          } catch {
            continue;
          }
          this.relay(room, event);
        }
      }
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        this.broadcast(room, {
          type: 'sandbox:exit',
          exitCode: null,
          timeout: false,
          stopped: true,
        });
      } else {
        this.broadcast(room, {
          type: 'sandbox:error',
          message: err.message ?? 'sandbox runner error',
        });
      }
    } finally {
      room.run = null;
      await this.syncBackFiles(sessionId);
    }
  }

  private async syncBackFiles(sessionId: string) {
    try {
      const res = await fetch(
        `${this.runnerUrl}/sandbox/${encodeURIComponent(sessionId)}/files`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { files?: Record<string, string> };
      const doc = this.getDoc(sessionId);
      const filesMap = doc.getMap<Y.Text>('files');
      doc.transact(() => {
        for (const [key, content] of Object.entries(body.files ?? {})) {
          if (filesMap.has(key)) continue; // don't clobber editor content
          const text = new Y.Text();
          text.insert(0, content);
          filesMap.set(key, text);
        }
      });
    } catch {
      // best effort — file read-back failures are non-fatal
    }
  }

  private relay(room: SandboxRoom, event: RunnerEvent) {
    if (event.stream === 'stdout' || event.stream === 'stderr') {
      this.broadcast(room, {
        type: 'sandbox:output',
        stream: event.stream,
        chunk: event.chunk ?? '',
      });
    } else if (event.stream === 'exit') {
      this.broadcast(room, {
        type: 'sandbox:exit',
        exitCode: event.exitCode ?? null,
        timeout: !!event.timeout,
      });
    } else if (event.stream === 'error') {
      this.broadcast(room, {
        type: 'sandbox:error',
        message: event.message ?? 'sandbox runner error',
      });
    }
  }

  private serializeFiles(sessionId: string): Record<string, string> {
    const doc = this.getDoc(sessionId);
    const filesMap = doc.getMap<Y.Text>('files');
    const files: Record<string, string> = {};
    for (const [key, text] of filesMap) {
      files[key] = text.toJSON();
    }
    return files;
  }

  private broadcast(room: SandboxRoom, msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    for (const conn of room.conns) {
      if (conn.readyState === WebSocket.OPEN) conn.send(data);
    }
  }
}
