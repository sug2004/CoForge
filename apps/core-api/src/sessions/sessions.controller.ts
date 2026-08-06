import { Controller, Get, Post, Delete, Param, Query, Req, UseGuards, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { SessionsService } from './sessions.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('projects/:id/sessions')
  create(@Req() req, @Param('id') projectId: string) {
    return this.sessions.create(req.user.id, projectId);
  }

  @Get('sessions/:id')
  findOne(@Param('id') id: string) {
    return this.sessions.findOne(id);
  }

  @Post('sessions/:id/join')
  join(@Req() req, @Param('id') id: string) {
    return this.sessions.join(id, req.user.id);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  delete(@Req() req, @Param('id') id: string) {
    return this.sessions.delete(id, req.user.id);
  }

  @Post('sessions/:id/clone')
  cloneRepo(@Req() req, @Param('id') id: string) {
    return this.sessions.cloneRepo(id, req.user.id);
  }

  @Get('sessions/:id/events')
  findEvents(@Param('id') id: string, @Query('since') since?: string) {
    return this.sessions.findEvents(id, since);
  }
}
