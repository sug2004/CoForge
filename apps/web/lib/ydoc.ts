import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export function createYSession(sessionId: string) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(
    'ws://localhost:3001',
    sessionId,
    ydoc,
  );

  // do NOT pre-set 'main' here — let the server sync happen first
  // fileContent is retrieved after sync in Editor.tsx
  return { ydoc, provider };
}
