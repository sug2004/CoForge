import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AgentThreadsService } from './agent-threads.service';
import { JwtAuthGuard } from '../auth/jwt/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

@Controller('sessions/:sessionId/agent-threads')
@UseGuards(JwtAuthGuard)
export class AgentThreadsController {
  constructor(private readonly service: AgentThreadsService) {}

  @Post()
  async create(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { title?: string },
  ) {
    return this.service.create(req.user.id, sessionId, body.title);
  }

  @Get()
  async findBySessionAndUser(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.findBySessionAndUser(sessionId, req.user.id);
  }

  @Get(':id')
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.findOne(id, req.user.id);
  }

  @Post(':id/messages')
  async addMessage(
    @Param('sessionId') sessionId: string,
    @Param('id') threadId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { role: string; content: any },
  ) {
    return this.service.addMessage(threadId, req.user.id, body.role, body.content);
  }

  @Post(':id/context-snapshots')
  async addContextSnapshot(
    @Param('sessionId') sessionId: string,
    @Param('id') threadId: string,
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      focusFileId?: string;
      cursor?: { line: number; col: number };
      selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
      openFileIds: string[];
    },
  ) {
    return this.service.addContextSnapshot(threadId, req.user.id, body);
  }

  @Patch(':id')
  async updateTitle(
    @Param('sessionId') sessionId: string,
    @Param('id') threadId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: { title: string },
  ) {
    return this.service.updateTitle(threadId, req.user.id, body.title);
  }

  @Patch(':id/archive')
  async archive(
    @Param('sessionId') sessionId: string,
    @Param('id') threadId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.archive(threadId, req.user.id);
  }

  @Delete(':id')
  async delete(
    @Param('sessionId') sessionId: string,
    @Param('id') threadId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.delete(threadId, req.user.id);
  }
}