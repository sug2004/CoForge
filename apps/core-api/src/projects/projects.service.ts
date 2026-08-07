import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    workspaceId: string,
    name: string,
    repoUrl?: string,
  ) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException();
    return this.prisma.project.create({ data: { workspaceId, name, repoUrl } });
  }

  async findOne(id: string) {
    return this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: {
        sessions: {
          include: {
            creator: { select: { id: true, username: true, avatarUrl: true } },
            participants: {
              include: {
                user: { select: { id: true, username: true, avatarUrl: true } },
              },
              orderBy: { joinedAt: 'asc' },
            },
          },
          orderBy: { startedAt: 'desc' },
        },
      },
    });
  }

  async delete(id: string, userId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: { workspace: { include: { members: true } } },
    });
    const member = project.workspace.members.find((m) => m.userId === userId);
    if (!member || (member.role !== 'OWNER' && member.role !== 'EDITOR'))
      throw new ForbiddenException();
    await this.prisma.project.delete({ where: { id } });
  }
}
