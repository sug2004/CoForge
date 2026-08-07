export type SandboxStream = 'stdout' | 'stderr';

export type SandboxEvent =
  | { type: 'sandbox:output'; stream: SandboxStream; chunk: string }
  | { type: 'sandbox:exit'; exitCode: number | null; timeout?: boolean; stopped?: boolean }
  | { type: 'sandbox:error'; message: string };

const SANDBOX_WS = process.env.NEXT_PUBLIC_SANDBOX_WS_URL ?? 'ws://localhost:3001';

export class SandboxChannel {
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: SandboxEvent) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly sessionId: string) {}

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = `${SANDBOX_WS}/sandbox/${this.sessionId}`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      try {
        this.emit(JSON.parse(e.data as string) as SandboxEvent);
      } catch {}
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      if (!this.closed && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, 2000);
      }
    };
  }

  on(cb: (e: SandboxEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  run(command: string, timeoutMs?: number) {
    this.ws?.send(JSON.stringify({ type: 'sandbox:run', command, timeoutMs }));
  }

  stop() {
    this.ws?.send(JSON.stringify({ type: 'sandbox:stop' }));
  }

  close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private emit(e: SandboxEvent) {
    for (const cb of this.listeners) cb(e);
  }
}
