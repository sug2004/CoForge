import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: string;
  sub?: string;
}

@Injectable()
export class AgentGateway implements OnModuleInit {
  private server: Server;
  private userRooms = new Map<string, Set<string>>(); // socketId -> set of room names

  onModuleInit() {
    // Get the Socket.io server from global (initialized in main.ts)
    this.server = (global as any).agentIo;
    if (!this.server) {
      console.warn('AgentGateway: Socket.io server not initialized yet');
      return;
    }

    this.server
      .of('/agent')
      .on('connection', (client: Socket) => this.handleConnection(client));
  }

  private handleConnection(client: Socket) {
    const token = client.handshake.auth.token as string;
    if (!token) {
      client.disconnect();
      return;
    }

    let payload: JwtPayload;
    try {
      const secret = process.env.JWT_SECRET ?? 'dev-secret-change-me';
      payload = jwt.verify(token, secret) as JwtPayload;
    } catch {
      client.disconnect();
      return;
    }

    const sessionId = client.handshake.query.sessionId as string;
    if (!sessionId) {
      client.disconnect();
      return;
    }

    const roomName = `session:${sessionId}:user:${payload.userId ?? payload.sub ?? ''}`;
    client.join(roomName);

    // Broadcast events (agent:edit_applied, session:activity, ...) target the
    // whole-session room — join it too so they aren't silently dropped.
    const sessionRoomName = `session:${sessionId}`;
    client.join(sessionRoomName);

    if (!this.userRooms.has(client.id)) {
      this.userRooms.set(client.id, new Set());
    }
    this.userRooms.get(client.id)!.add(roomName);
    this.userRooms.get(client.id)!.add(sessionRoomName);

    // Store user info on socket for later use
    (client as any).userId = payload.userId ?? payload.sub;
    (client as any).sessionId = sessionId;
  }

  private handleDisconnect(client: Socket) {
    const rooms = this.userRooms.get(client.id);
    if (rooms) {
      for (const room of rooms) {
        client.leave(room);
      }
      this.userRooms.delete(client.id);
    }
  }

  // Server-to-client event dispatcher used by the HTTP emit endpoint
  // (agent-service streams all agent events through it). Per-user events go to
  // the requester's private room; broadcast events go to the whole session.
  emit(
    event: string,
    sessionId: string,
    userId: string,
    threadId: string,
    data: any,
    broadcast = false,
  ) {
    if (broadcast) {
      this.server
        ?.of('/agent')
        .to(`session:${sessionId}`)
        .emit(event, { threadId, userId, ...data });
      return;
    }
    this.server
      ?.of('/agent')
      .to(`session:${sessionId}:user:${userId}`)
      .emit(event, { threadId, ...data });
  }
}
