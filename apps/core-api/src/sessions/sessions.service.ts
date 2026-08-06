import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import simpleGit from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.DS_Store']);
const MAX_FILE_SIZE = 500 * 1024; // 500kb — skip binary/large files
const MAX_FILES = 200;

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, projectId: string) {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { workspace: { include: { members: true } } },
    });
    const isMember = project.workspace.members.some(m => m.userId === userId);
    if (!isMember) throw new ForbiddenException();
    return this.prisma.session.create({ data: { projectId, createdBy: userId } });
  }

  async findOne(id: string) {
    return this.prisma.session.findUniqueOrThrow({
      where: { id },
      include: {
        project: true,
        creator: { select: { id: true, username: true, avatarUrl: true } },
        participants: {
          include: { user: { select: { id: true, username: true, avatarUrl: true } } },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
  }

  async join(sessionId: string, userId: string) {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { project: { include: { workspace: { include: { members: true } } } } },
    });

    const workspaceId = session.project.workspaceId;
    const isMember = session.project.workspace.members.some(m => m.userId === userId);

    // auto-add to workspace as EDITOR if not already a member (invite link flow)
    if (!isMember) {
      await this.prisma.workspaceMember.create({
        data: { workspaceId, userId, role: 'EDITOR' },
      });
    }

    // upsert session participant — no-op if already exists
    await this.prisma.sessionParticipant.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      create: { sessionId, userId },
      update: {},
    });

    return this.findOne(sessionId);
  }

  async findEvents(sessionId: string, since?: string) {
    return this.prisma.sessionEvent.findMany({
      where: {
        sessionId,
        ...(since ? { createdAt: { gt: new Date(since) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async delete(sessionId: string, userId: string) {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { project: { include: { workspace: { include: { members: true } } } } },
    });
    const isMember = session.project.workspace.members.some(m => m.userId === userId);
    if (!isMember) throw new ForbiddenException();
    await this.prisma.session.delete({ where: { id: sessionId } });
  }

  async cloneRepo(sessionId: string, userId: string): Promise<{ files: Record<string, string> }> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { project: { include: { workspace: { include: { members: true } } } } },
    });

    const isMember = session.project.workspace.members.some(m => m.userId === userId);
    if (!isMember) throw new ForbiddenException();

    const repoUrl = session.project.repoUrl;
    if (!repoUrl) throw new BadRequestException('Project has no repoUrl');

    const cloneDir = path.join(os.tmpdir(), `coforge-${sessionId}`);

    // reuse existing clone if present
    try { await fs.access(cloneDir); }
    catch { await simpleGit().clone(repoUrl, cloneDir, ['--depth', '1']); }

    const files = await this.readDir(cloneDir, cloneDir, 0);
    return { files };
  }

  private async readDir(
    base: string,
    dir: string,
    count: number,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (count >= MAX_FILES) break;
      if (IGNORED.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(base, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        const sub = await this.readDir(base, fullPath, count);
        Object.assign(result, sub);
        count += Object.keys(sub).length;
      } else {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        try {
          result[relPath] = await fs.readFile(fullPath, 'utf-8');
          count++;
        } catch {
          // skip binary files
        }
      }
    }
    return result;
  }
}
