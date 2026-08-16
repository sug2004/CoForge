import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
} from '@nestjs/common';
import * as Y from 'yjs';
import { AgentGateway } from './sync.gateway';

interface Rooms {
  getDoc: (sessionId: string) => Y.Doc;
}

@Controller('sync')
export class SyncController {
  constructor(
    @Inject(AgentGateway) private readonly agentGateway: AgentGateway,
  ) {}

  // Read lazily: main.ts assigns (global as any).coforgeRooms AFTER Nest
  // instantiates controllers, so a constructor-cached reference is always
  // undefined.
  private get rooms(): Rooms {
    return (global as any).coforgeRooms;
  }

  private getFiles(sessionId: string): Record<string, string> {
    if (!this.rooms) throw new BadRequestException('sync-server not ready');
    const doc = this.rooms.getDoc(sessionId);
    const filesMap = doc.getMap<Y.Text>('files');
    const files: Record<string, string> = {};
    for (const [key, text] of filesMap) {
      files[key] = text.toJSON();
    }
    return files;
  }

  // Snapshot of the shared Y.Doc files — used by agent-service to pull live
  // content for the Coder/Validator phases.
  @Post('files')
  files(@Body('sessionId') sessionId: string) {
    if (!sessionId) throw new BadRequestException('sessionId is required');
    return { files: this.getFiles(sessionId) };
  }

  // Apply an agent's validated diff to the shared Y.Doc as a tagged Y.Text
  // transaction, then broadcast to the whole session. The ydoc 'update'
  // observer handles the CRDT broadcast; this also emits the agent:edit_applied
  // event over Socket.io so clients can attribute the change.
  @Post('apply')
  apply(
    @Body()
    body: {
      sessionId: string;
      threadId: string;
      userId: string;
      toolCallId: string;
      files: Record<string, string>;
    },
  ) {
    const { sessionId, threadId, userId, toolCallId, files } = body;
    if (!sessionId || !files || typeof files !== 'object') {
      throw new BadRequestException('sessionId and files are required');
    }
    if (!this.rooms) throw new BadRequestException('sync-server not ready');

    const doc = this.rooms.getDoc(sessionId);
    const filesMap = doc.getMap<Y.Text>('files');

    doc.transact(
      () => {
        for (const [relPath, content] of Object.entries(files)) {
          if (relPath.endsWith('/')) {
            if (!filesMap.has(relPath)) filesMap.set(relPath, new Y.Text());
            continue;
          }
          const text = filesMap.get(relPath);
          if (text) {
            if (text.toJSON() !== content) {
              text.delete(0, text.length);
              text.insert(0, content);
            }
          } else {
            const fresh = new Y.Text();
            fresh.insert(0, content);
            filesMap.set(relPath, fresh);
          }
        }
      },
      { actor: 'agent', toolCallId, userId, threadId },
    );

    for (const relPath of Object.keys(files)) {
      this.agentGateway.emit(
        'agent:edit_applied',
        sessionId,
        userId,
        threadId,
        { fileId: relPath, toolCallId },
        true,
      );
    }
    this.agentGateway.emit(
      'session:activity',
      sessionId,
      userId,
      threadId,
      { type: 'agent_edit_applied', actorId: userId, summary: `agent applied changes to ${Object.keys(files).length} file(s)` },
      true,
    );

    return { ok: true, applied: Object.keys(files) };
  }
}
