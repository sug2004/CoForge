import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ProjectMemoryService } from './project-memory.service';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard)
export class ProjectMemoryController {
  constructor(private readonly service: ProjectMemoryService) {}

  @Get('memory')
  getMemory(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.getMemory(projectId, req.user.id);
  }

  @Put('memory')
  upsertMemory(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { summary: string },
  ) {
    return this.service.upsertMemory(projectId, req.user.id, body.summary);
  }

  @Get('preferences')
  getPreferences(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.getPreferences(projectId, req.user.id);
  }

  @Put('preferences')
  upsertPreferences(
    @Param('projectId') projectId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { notes: string },
  ) {
    return this.service.upsertPreferences(projectId, req.user.id, body.notes);
  }
}
