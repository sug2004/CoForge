import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export function createYSession(sessionId: string) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider('ws://localhost:3001', sessionId, ydoc);
  return { ydoc, provider, awareness: provider.awareness };
}
