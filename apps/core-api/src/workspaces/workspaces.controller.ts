import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards, HttpCode } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  create(@Req() req, @Body('name') name: string) {
    return this.workspaces.create(req.user.id, name);
  }

  @Get()
  findAll(@Req() req) {
    return this.workspaces.findAllForUser(req.user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Req() req, @Param('id') id: string) {
    return this.workspaces.delete(id, req.user.id);
  }

  @Post(':id/members')
  addMember(@Req() req, @Param('id') id: string, @Body() body: { userId: string; role: 'EDITOR' | 'VIEWER' }) {
    return this.workspaces.addMember(id, req.user.id, body.userId, body.role);
  }

  @Delete(':id/members/:userId')
  removeMember(@Req() req, @Param('id') id: string, @Param('userId') userId: string) {
    return this.workspaces.removeMember(id, req.user.id, userId);
  }
}
