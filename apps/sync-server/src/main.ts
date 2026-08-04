import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

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
    rooms.set(roomName, { doc, awareness, conns: new Set() });
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
      const syncMsgType = syncProtocol.readSyncMessage(decoder, replyEncoder, room.doc, null);

      // send step2 reply back to the sender
      if (encoding.length(replyEncoder) > 1) {
        send(ws, encoding.toUint8Array(replyEncoder));
      }

      // if this was an update (type 2), broadcast the original message to all other conns
      if (syncMsgType === syncProtocol.messageYjsSyncStep2 || syncMsgType === syncProtocol.messageYjsUpdate) {
        room.conns.forEach((conn) => {
          if (conn !== ws) send(conn, data);
        });
      }
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
    awarenessProtocol.removeAwarenessStates(room.awareness, [room.doc.clientID], null);
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const httpServer = http.createServer(app.getHttpAdapter().getInstance());
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const roomName = (req.url ?? '/').slice(1) || 'default';
    handleConnection(ws, roomName);
  });

  await app.init();
  httpServer.listen(3001, () => {
    console.log('sync-server running on ws://localhost:3001');
  });
}
bootstrap();
