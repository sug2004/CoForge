import { Injectable, OnModuleInit } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: string;
  sub?: string;
}

interface AgentInvokePayload {
  threadId: string;
  prompt: string;
}

interface AgentContextUpdatePayload {
  threadId: string;
  focusFileId?: string;
  cursor?: { line: number; col: number };
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  openFileIds: string[];
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

    this.server.of('/agent').on('connection', (client: Socket) => this.handleConnection(client));
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

    // Handle incoming messages
    client.on('agent:invoke', (payload: AgentInvokePayload) => this.handleInvoke(client, payload));
    client.on('agent:context_update', (payload: AgentContextUpdatePayload) => this.handleContextUpdate(client, payload));
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

  private handleInvoke(client: Socket, payload: AgentInvokePayload) {
    // Acknowledge - the actual invocation will be done via REST API from the client
    client.emit('agent:invoke:ack', { threadId: payload.threadId });
  }

  private handleContextUpdate(client: Socket, payload: AgentContextUpdatePayload) {
    // Acknowledge receipt
    client.emit('agent:context_update:ack', { threadId: payload.threadId });
  }

  // Server-to-client event emitters (called from agent-service via HTTP or message queue)
  emitPhaseStarted(threadId: string, sessionId: string, userId: string, phase: string) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:phase_started', {
      threadId,
      phase,
    });
  }

  emitToolStarted(threadId: string, sessionId: string, userId: string, toolCallId: string, toolName: string, args: any) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:tool_started', {
      threadId,
      toolCallId,
      toolName,
      args,
    });
  }

  emitToolResult(threadId: string, sessionId: string, userId: string, toolCallId: string, result: any, isError: boolean) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:tool_result', {
      threadId,
      toolCallId,
      result,
      isError,
    });
  }

  emitMessage(threadId: string, sessionId: string, userId: string, text: string) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:message', {
      threadId,
      text,
    });
  }

  emitEditProposed(threadId: string, sessionId: string, userId: string, fileId: string, diff: string, toolCallId: string) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:edit_proposed', {
      threadId,
      fileId,
      diff,
      toolCallId,
    });
  }

  emitPlan(threadId: string, sessionId: string, userId: string, steps: Array<{ description: string; files: string[] }>) {
    this.server?.of('/agent').to(`session:${sessionId}:user:${userId}`).emit('agent:plan', {
      threadId,
      steps,
    });
  }

  // Generic dispatcher used by the HTTP emit endpoint. Per-user events go to
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

  // Broadcast events (to all users in session)
  emitEditApplied(threadId: string, sessionId: string, userId: string, fileId: string, toolCallId: string) {
    this.server?.of('/agent').to(`session:${sessionId}`).emit('agent:edit_applied', {
      threadId,
      userId,
      fileId,
      toolCallId,
    });
  }

  emitSessionActivity(sessionId: string, type: string, actorId: string, summary: string) {
    this.server?.of('/agent').to(`session:${sessionId}`).emit('session:activity', {
      type,
      actorId,
      summary,
    });
  }
}