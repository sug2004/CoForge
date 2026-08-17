import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

const USER_SELECT = {
  id: true,
  githubId: true,
  username: true,
  email: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private sign(user: { id: string; username: string }) {
    return this.jwtService.signAsync({ sub: user.id, username: user.username });
  }

  async issueToken(user: { id: string; username: string }) {
    return this.sign(user);
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  }

  async updateProfile(
    id: string,
    data: { username?: string; email?: string; avatarUrl?: string },
  ) {
    return this.prisma.user.update({ where: { id }, data, select: USER_SELECT });
  }

  async changePassword(id: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user?.password) throw new UnauthorizedException('No password set — use GitHub login');
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id }, data: { password: hash } });
  }

  async register(username: string, email: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');
    const hash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: { username, email, password: hash },
      select: USER_SELECT,
    });
    return { accessToken: await this.sign(user), user };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.password) throw new UnauthorizedException('Invalid credentials');
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    const safe = await this.findById(user.id);
    return { accessToken: await this.sign(user), user: safe };
  }

  async validateGithubUser(profile: {
    githubId: string;
    username: string;
    email?: string;
    avatarUrl?: string;
  }) {
    let user = await this.prisma.user.findUnique({
      where: { githubId: profile.githubId },
    });
    if (!user) {
      // check if email account exists — link it
      user = profile.email
        ? ((await this.prisma.user.findUnique({
            where: { email: profile.email },
          })) ?? null)
        : null;

      if (user) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { githubId: profile.githubId, avatarUrl: profile.avatarUrl },
        });
      } else {
        user = await this.prisma.user.create({
          data: {
            githubId: profile.githubId,
            username: profile.username,
            email: profile.email,
            avatarUrl: profile.avatarUrl,
          },
        });
      }
    }
    return { accessToken: await this.sign(user), user: await this.findById(user.id) };
  }

  async linkGithub(
    userId: string,
    profile: { githubId: string; avatarUrl?: string },
  ) {
    const conflict = await this.prisma.user.findUnique({
      where: { githubId: profile.githubId },
    });
    if (conflict && conflict.id !== userId)
      throw new ConflictException(
        'GitHub account already linked to another user',
      );
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { githubId: profile.githubId, avatarUrl: profile.avatarUrl },
    });
    return user;
  }
}
