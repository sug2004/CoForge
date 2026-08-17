import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';
import { ProjectsService } from './projects.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('projects')
  findAll(@Req() req) {
    return this.projects.findAllForUser(req.user.id);
  }

  @Post('workspaces/:id/projects')
  create(
    @Req() req,
    @Param('id') workspaceId: string,
    @Body() body: { name: string; repoUrl?: string },
  ) {
    return this.projects.create(
      req.user.id,
      workspaceId,
      body.name,
      body.repoUrl,
    );
  }

  @Get('projects/:id')
  findOne(@Param('id') id: string) {
    return this.projects.findOne(id);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  delete(@Req() req, @Param('id') id: string) {
    return this.projects.delete(id, req.user.id);
  }
}
