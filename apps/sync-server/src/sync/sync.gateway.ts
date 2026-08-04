import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as Y from 'yjs';

@WebSocketGateway({ cors: { origin: 'http://localhost:3000' } })
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  // sessionId -> Y.Doc
  private docs = new Map<string, Y.Doc>();

  private getDoc(sessionId: string): Y.Doc {
    if (!this.docs.has(sessionId)) {
      this.docs.set(sessionId, new Y.Doc());
    }
    return this.docs.get(sessionId)!;
  }

  handleConnection(client: Socket) {
    const sessionId = client.handshake.query.sessionId as string;
    if (!sessionId) { client.disconnect(); return; }

    client.join(`session:${sessionId}`);
    const doc = this.getDoc(sessionId);

    // send current doc state to the newly connected client
    const state = Y.encodeStateAsUpdate(doc);
    client.emit('doc:load', Buffer.from(state).toString('base64'));

    client.on('doc:update', (data: string) => {
      const update = Uint8Array.from(Buffer.from(data, 'base64'));
      Y.applyUpdate(doc, update);
      // broadcast to everyone else in the room
      client.to(`session:${sessionId}`).emit('doc:update', data);
    });
  }

  handleDisconnect(client: Socket) {
    const sessionId = client.handshake.query.sessionId as string;
    client.leave(`session:${sessionId}`);
  }
}
