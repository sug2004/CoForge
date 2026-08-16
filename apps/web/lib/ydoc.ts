import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const SYNC_SERVER_URL = process.env.NEXT_PUBLIC_SYNC_SERVER_URL ?? 'http://localhost:3001';
const WS_SERVER_URL = SYNC_SERVER_URL.replace(/^http/, 'ws');

export function createYSession(sessionId: string) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(WS_SERVER_URL, sessionId, ydoc);
  return { ydoc, provider, awareness: provider.awareness };
}
