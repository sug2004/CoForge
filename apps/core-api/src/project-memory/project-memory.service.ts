import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(projectId: string, userId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { workspace: { include: { members: true } } },
    });
    const isMember = project.workspace.members.some((m) => m.userId === userId);
    if (!isMember) throw new ForbiddenException();
    return project;
  }

  async getMemory(projectId: string, userId: string) {
    await this.assertMember(projectId, userId);
    const mem = await this.prisma.projectMemory.findUnique({
      where: { projectId },
    });
    // Always return a JSON body — a null return value serializes to a 200 with
    // an empty body, which breaks JSON.parse on the agent-service side.
    return mem ?? { summary: '' };
  }

  async upsertMemory(projectId: string, userId: string, summary: string) {
    await this.assertMember(projectId, userId);
    return this.prisma.projectMemory.upsert({
      where: { projectId },
      create: { projectId, summary },
      update: { summary },
    });
  }

  async getPreferences(projectId: string, userId: string) {
    await this.assertMember(projectId, userId);
    const prefs = await this.prisma.userProjectPreference.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    // Never return null (see getMemory).
    return prefs ?? { notes: '' };
  }

  async upsertPreferences(projectId: string, userId: string, notes: string) {
    await this.assertMember(projectId, userId);
    return this.prisma.userProjectPreference.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, notes },
      update: { notes },
    });
  }
}
