import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const RUNNER_URL =
  process.env.SANDBOX_RUNNER_URL ?? 'http://localhost:3004';

async function destroySandbox(sessionId: string) {
  try {
    await fetch(
      `${RUNNER_URL}/sandbox/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  } catch {
    // best effort — runner may be down
  }
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, name: string) {
    return this.prisma.workspace.create({
      data: {
        name,
        ownerId: userId,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
  }

  async findAllForUser(userId: string) {
    return this.prisma.workspace.findMany({
      where: { members: { some: { userId } } },
      include: { members: true, projects: true },
    });
  }

  async addMember(
    workspaceId: string,
    requesterId: string,
    userId: string,
    role: 'EDITOR' | 'VIEWER',
  ) {
    await this.assertOwner(workspaceId, requesterId);
    return this.prisma.workspaceMember.create({
      data: { workspaceId, userId, role },
    });
  }

  async removeMember(workspaceId: string, requesterId: string, userId: string) {
    await this.assertOwner(workspaceId, requesterId);
    await this.prisma.workspaceMember.deleteMany({
      where: { workspaceId, userId },
    });
  }

  async delete(workspaceId: string, userId: string) {
    await this.assertOwner(workspaceId, userId);
    // gather all session ids before the cascade delete so sandbox containers
    // can be removed afterwards
    const sessions = await this.prisma.session.findMany({
      where: { project: { workspaceId } },
      select: { id: true },
    });
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
    for (const session of sessions) {
      void destroySandbox(session.id);
    }
  }

  private async assertOwner(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member || member.role !== 'OWNER') throw new ForbiddenException();
  }
}
