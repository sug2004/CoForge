import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { resolve } from 'node:path';
import * as http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { SandboxRelay } from './sandbox/sandbox-relay';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

function getRoom(roomName: string): Room {
  if (!rooms.has(roomName)) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const room: Room = { doc, awareness, conns: new Set() };
    rooms.set(roomName, room);

    // Broadcast Y.Doc updates to all connected clients — including server-local
    // changes (e.g. the sandbox relay writing files back), where origin is null.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns) {
        if (conn !== origin) send(conn, message);
      }
    });
  }
  return rooms.get(roomName)!;
}

function send(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
  }
}

function handleConnection(ws: WebSocket, roomName: string) {
  const room = getRoom(roomName);
  room.conns.add(ws);

  // send sync step 1 to the new client
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  send(ws, encoding.toUint8Array(syncEncoder));

  ws.on('message', (rawData: Buffer) => {
    const data = new Uint8Array(rawData);
    const decoder = decoding.createDecoder(data);
    const msgType = decoding.readVarUint(decoder);

    if (msgType === MESSAGE_SYNC) {
      const replyEncoder = encoding.createEncoder();
      encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, replyEncoder, room.doc, ws);

      // send step2 reply back to the sender
      if (encoding.length(replyEncoder) > 1) {
        send(ws, encoding.toUint8Array(replyEncoder));
      }

      // updates are broadcast to all other conns via the doc 'update' observer
    } else if (msgType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        ws,
      );
      room.conns.forEach((conn) => {
        if (conn !== ws) send(conn, data);
      });
    }
  });

  ws.on('close', () => {
    room.conns.delete(ws);
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [room.doc.clientID],
      null,
    );
  });
}

// Load the repo-root .env so a manual `npm run start:dev` uses the same
// JWT_SECRET as core-api (tokens are signed by core-api and verified here).
// dev.ps1 already injects JWT_SECRET into the process env, which wins.
if (!process.env.JWT_SECRET) {
  try {
    process.loadEnvFile(resolve(__dirname, '../../../.env'));
  } catch {
    // No root .env (e.g. CI) — fall back to the hardcoded dev secret.
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const httpServer = http.createServer(
    app.getHttpAdapter().getInstance() as http.RequestListener,
  );

  // Initialize Socket.io for agent events. The engine.io path stays at the
  // default '/socket.io'; clients join the '/agent' *namespace* (the gateway
  // listens on `server.of('/agent')`). The raw-ws Yjs relay and the sandbox
  // shell relay both live on the same http server but use their own paths.
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    },
  });

  // Make io available globally for the gateway
  (global as any).agentIo = io;

  // Expose the room/doc registry so the Nest controllers (/sync/files,
  // /sync/apply) can read + write the shared Y.Doc state that main.ts owns.
  (global as any).coforgeRooms = {
    getDoc: (sessionId: string) => getRoom(sessionId).doc,
  };

  const sandboxRelay = new SandboxRelay((sessionId) => getRoom(sessionId).doc);

  const wss = new WebSocketServer({ noServer: true });

  // Route raw WebSocket upgrades manually so socket.io (path /socket.io) and
  // the Yjs/sandbox relays (everything else) don't fight over the same socket.
  // Without this, connecting to the /agent namespace crashes the process with
  // "server.handleUpgrade() was called more than once with the same socket".
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname.startsWith('/socket.io')) return; // engine.io handles these
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname.startsWith('/sandbox/')) {
      const sessionId = pathname.slice('/sandbox/'.length) || 'default';
      sandboxRelay.handleConnection(ws, sessionId);
      return;
    }

    const roomName = pathname.slice(1) || 'default';
    handleConnection(ws, roomName);
  });

  await app.init();
  const port = parseInt(process.env.PORT ?? '3001', 10);
  httpServer.listen(port, () => {
    console.log(`sync-server running on ws://localhost:${port}`);
  });
}
void bootstrap();
