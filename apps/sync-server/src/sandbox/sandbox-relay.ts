import WebSocket from 'ws';
import * as Y from 'yjs';

const FORWARD_DEBOUNCE_MS = 300;
const FORWARD_SKIP_MS = 5000;

export class SandboxRelay {
  private readonly runnerUrl: string;
  private readonly runnerWsUrl: string;

  private readonly sessionRefs = new Map<string, number>();
  private readonly forwardHandlers = new Map<string, () => void>();
  private readonly pushTimers = new Map<string, NodeJS.Timeout>();
  private readonly snapshots = new Map<string, Record<string, string>>();
  // content the relay itself wrote into the Y.Doc from disk — the forward
  // observer must not push these straight back (breaks the sync loop)
  private readonly lastWrittenFromDisk = new Map<
    string,
    Record<string, string>
  >();
  // keys pushed forward recently — reverse sync must not clobber an active edit
  private readonly forwardedRecently = new Map<
    string,
    Record<string, number>
  >();

  constructor(
    private readonly getDoc: (sessionId: string) => Y.Doc,
    runnerUrl = process.env.SANDBOX_RUNNER_URL ?? 'http://localhost:3004',
  ) {
    this.runnerUrl = runnerUrl;
    this.runnerWsUrl = runnerUrl.replace(/^http/, 'ws');
  }

  handleConnection(ws: WebSocket, sessionId: string) {
    let closed = false;
    let outbound: WebSocket | null = null;

    this.acquireSession(sessionId);

    const closeAll = () => {
      if (closed) return;
      closed = true;
      try {
        outbound?.close();
      } catch {
        // ignore
      }
      this.releaseSession(sessionId);
      void this.syncBackFiles(sessionId).finally(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    };

    const sock = new WebSocket(
      `${this.runnerWsUrl}/sandbox/${encodeURIComponent(sessionId)}/shell`,
    );
    outbound = sock;

    sock.on('open', () => {
      // initial forward sync — write the current Y.Doc snapshot into the workspace
      void this.pushFiles(sessionId);
    });
    sock.on('message', (data, isBinary) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      if (!isBinary) {
        const text = (data as Buffer).toString('utf-8');
        if (text.startsWith('\u0000')) {
          this.handleControl(sessionId, text);
          return;
        }
      }
      ws.send(data, { binary: isBinary });
    });
    sock.on('error', () => {
      // runner unreachable — the browser ws will be closed below, and the
      // client's reconnect loop brings the session back when the runner returns
    });
    sock.on('close', () => {
      if (!closed) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    });

    ws.on('message', (data, isBinary) => {
      if (!outbound || outbound.readyState !== WebSocket.OPEN) return;
      outbound.send(data, { binary: isBinary });
    });
    ws.on('close', closeAll);
    ws.on('error', closeAll);
  }

  // ── forward sync (editor → disk) ─────────────────────────────────────────

  private snapshot(sessionId: string): Record<string, string> {
    const doc = this.getDoc(sessionId);
    const filesMap = doc.getMap<Y.Text>('files');
    const files: Record<string, string> = {};
    for (const [key, text] of filesMap) {
      files[key] = text.toJSON();
    }
    return files;
  }

  private acquireSession(sessionId: string) {
    const refs = (this.sessionRefs.get(sessionId) ?? 0) + 1;
    this.sessionRefs.set(sessionId, refs);
    if (refs === 1) {
      const doc = this.getDoc(sessionId);
      const handler = () => this.scheduleForwardPush(sessionId);
      this.forwardHandlers.set(sessionId, handler);
      doc.on('update', handler);
    }
  }

  private releaseSession(sessionId: string) {
    const refs = (this.sessionRefs.get(sessionId) ?? 1) - 1;
    if (refs > 0) {
      this.sessionRefs.set(sessionId, refs);
      return;
    }
    this.sessionRefs.delete(sessionId);
    const handler = this.forwardHandlers.get(sessionId);
    if (handler) {
      this.getDoc(sessionId).off('update', handler);
      this.forwardHandlers.delete(sessionId);
    }
    const timer = this.pushTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pushTimers.delete(sessionId);
    }
    this.snapshots.delete(sessionId);
    this.lastWrittenFromDisk.delete(sessionId);
    this.forwardedRecently.delete(sessionId);
  }

  private scheduleForwardPush(sessionId: string) {
    const existing = this.pushTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pushTimers.delete(sessionId);
      void this.pushDiff(sessionId);
    }, FORWARD_DEBOUNCE_MS);
    this.pushTimers.set(sessionId, timer);
  }

  private async pushFiles(sessionId: string) {
    const files = this.snapshot(sessionId);
    const ok = await this.sendDiff(sessionId, files, []);
    if (ok) {
      this.snapshots.set(sessionId, files);
      this.markForwarded(sessionId, Object.keys(files));
    }
  }

  private async pushDiff(sessionId: string) {
    const current = this.snapshot(sessionId);
    const prev = this.snapshots.get(sessionId);
    if (!prev) {
      this.snapshots.set(sessionId, current);
      return;
    }
    const fromDisk = this.lastWrittenFromDisk.get(sessionId) ?? {};

    const changes: Record<string, string> = {};
    const deleted: string[] = [];
    for (const [key, value] of Object.entries(current)) {
      if (fromDisk[key] === value) {
        // content matches what we last pulled from disk — no real editor change
        delete fromDisk[key];
        continue;
      }
      if (prev[key] !== value) changes[key] = value;
    }
    for (const key of Object.keys(prev)) {
      if (!(key in current)) deleted.push(key);
    }

    if (Object.keys(changes).length === 0 && deleted.length === 0) {
      this.snapshots.set(sessionId, current);
      if (Object.keys(fromDisk).length === 0) {
        this.lastWrittenFromDisk.delete(sessionId);
      } else {
        this.lastWrittenFromDisk.set(sessionId, fromDisk);
      }
      return;
    }

    const ok = await this.sendDiff(sessionId, changes, deleted);
    if (!ok) return; // keep the old baseline so the next event retries

    this.snapshots.set(sessionId, current);
    this.markForwarded(sessionId, Object.keys(changes));
    if (Object.keys(fromDisk).length === 0) {
      this.lastWrittenFromDisk.delete(sessionId);
    } else {
      this.lastWrittenFromDisk.set(sessionId, fromDisk);
    }
  }

  private markForwarded(sessionId: string, keys: string[]) {
    if (keys.length === 0) return;
    const cutoff = Date.now() - FORWARD_SKIP_MS;
    const recents = this.forwardedRecently.get(sessionId) ?? {};
    for (const key of Object.keys(recents)) {
      if (recents[key] < cutoff) delete recents[key];
    }
    const now = Date.now();
    for (const key of keys) recents[key] = now;
    this.forwardedRecently.set(sessionId, recents);
  }

  private async sendDiff(
    sessionId: string,
    files: Record<string, string>,
    deleted: string[],
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.runnerUrl}/sandbox/${encodeURIComponent(sessionId)}/files`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, deleted }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── reverse sync (disk → editor) ─────────────────────────────────────────

  private handleControl(sessionId: string, frame: string) {
    type FilesControl = {
      type?: string;
      changes?: Record<string, string>;
      deleted?: string[];
    };
    let ctrl: FilesControl;
    try {
      ctrl = JSON.parse(frame.slice(1)) as FilesControl;
    } catch {
      return;
    }
    if (ctrl.type === 'files') {
      this.writeFilesToDoc(sessionId, ctrl.changes ?? {}, ctrl.deleted ?? []);
    }
  }

  private writeFilesToDoc(
    sessionId: string,
    changes: Record<string, string>,
    deleted: string[],
  ) {
    const doc = this.getDoc(sessionId);
    const filesMap = doc.getMap<Y.Text>('files');
    const cutoff = Date.now() - FORWARD_SKIP_MS;
    const recents = this.forwardedRecently.get(sessionId) ?? {};
    const fromDisk = this.lastWrittenFromDisk.get(sessionId) ?? {};

    const isEditing = (key: string) =>
      recents[key] !== undefined && recents[key] > cutoff;

    doc.transact(() => {
      for (const [key, content] of Object.entries(changes)) {
        if (isEditing(key)) continue; // editor has it open — don't clobber
        fromDisk[key] = content;
        if (key.endsWith('/')) {
          if (!filesMap.has(key)) filesMap.set(key, new Y.Text());
          continue;
        }
        const text = filesMap.get(key);
        if (text) {
          if (text.toJSON() !== content) {
            text.delete(0, text.length);
            text.insert(0, content);
          }
        } else {
          const fresh = new Y.Text();
          fresh.insert(0, content);
          filesMap.set(key, fresh);
        }
      }
      for (const key of deleted) {
        if (isEditing(key)) continue;
        if (filesMap.has(key)) filesMap.delete(key);
      }
    });

    if (Object.keys(fromDisk).length === 0) {
      this.lastWrittenFromDisk.delete(sessionId);
    } else {
      this.lastWrittenFromDisk.set(sessionId, fromDisk);
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
}
