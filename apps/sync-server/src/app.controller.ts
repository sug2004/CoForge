import { Controller, Get, Post, Body, Inject } from '@nestjs/common';
import { AppService } from './app.service';
import { AgentGateway } from './sync/sync.gateway';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(AgentGateway) private readonly agentGateway: AgentGateway,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('agent/emit')
  emitToUser(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      threadId: string;
      event: string;
      data: any;
      broadcast?: boolean;
    },
  ) {
    const { sessionId, userId, threadId, event, data, broadcast } = body;
    if (!event || !sessionId || !userId) {
      return { success: false, error: 'event, sessionId and userId are required' };
    }
    this.agentGateway.emit(event, sessionId, userId, threadId, data, broadcast);
    return { success: true };
  }
}
