import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentThreadsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, sessionId: string, title?: string) {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        project: { include: { workspace: { include: { members: true } } } },
      },
    });

    const isMember = session.project.workspace.members.some(
      (m) => m.userId === userId,
    );
    if (!isMember) throw new ForbiddenException();

    return this.prisma.agentThread.create({
      data: {
        sessionId,
        userId,
        title: title ?? 'New conversation',
      },
      include: {
        messages: true,
      },
    });
  }

  async findBySessionAndUser(sessionId: string, userId: string) {
    return this.prisma.agentThread.findMany({
      where: { sessionId, userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        contextSnapshots: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (thread.userId !== userId) throw new ForbiddenException();
    return thread;
  }

  async addMessage(
    threadId: string,
    userId: string,
    role: string,
    content: any,
  ) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (thread.userId !== userId) throw new ForbiddenException();

    return this.prisma.agentMessage.create({
      data: { threadId, role, content },
    });
  }

  async addContextSnapshot(
    threadId: string,
    userId: string,
    data: {
      focusFileId?: string;
      cursor?: { line: number; col: number };
      selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
      openFileIds: string[];
    },
  ) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (thread.userId !== userId) throw new ForbiddenException();

    return this.prisma.contextSnapshot.create({
      data: {
        threadId,
        focusFileId: data.focusFileId,
        cursor: data.cursor,
        selection: data.selection,
        openFileIds: data.openFileIds,
      },
    });
  }

  async updateTitle(threadId: string, userId: string, title: string) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (thread.userId !== userId) throw new ForbiddenException();

    return this.prisma.agentThread.update({
      where: { id: threadId },
      data: { title },
    });
  }

  async archive(threadId: string, userId: string) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (thread.userId !== userId) throw new ForbiddenException();

    return this.prisma.agentThread.update({
      where: { id: threadId },
      data: { archivedAt: new Date() },
    });
  }

  async delete(threadId: string, userId: string) {
    const thread = await this.prisma.agentThread.findUniqueOrThrow({
      where: { id: threadId },
    });
    if (thread.userId !== userId) throw new ForbiddenException();

    await this.prisma.agentThread.delete({ where: { id: threadId } });
  }
}