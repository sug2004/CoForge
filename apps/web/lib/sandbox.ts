export type SandboxData = string | Uint8Array;

const SANDBOX_WS = process.env.NEXT_PUBLIC_SANDBOX_WS_URL ?? 'ws://localhost:3001';

export class SandboxChannel {
  private ws: WebSocket | null = null;
  private dataListeners = new Set<(d: SandboxData) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
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
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.openListeners.forEach((cb) => cb());
    };
    this.ws.onmessage = (e) => {
      const data: SandboxData =
        typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
      this.dataListeners.forEach((cb) => cb(data));
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this.closeListeners.forEach((cb) => cb());
      if (!this.closed && !this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, 2000);
      }
    };
  }

  send(data: SandboxData) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as string | ArrayBuffer);
  }

  sendResize(cols: number, rows: number) {
    this.send(`\u0000${JSON.stringify({ type: 'resize', cols, rows })}`);
  }

  stop() {
    this.send('\u0003');
  }

  onData(cb: (d: SandboxData) => void): () => void {
    this.dataListeners.add(cb);
    return () => {
      this.dataListeners.delete(cb);
    };
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => {
      this.openListeners.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }
}
