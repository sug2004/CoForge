import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
  }

  private async assertOwner(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member || member.role !== 'OWNER') throw new ForbiddenException();
  }
}
