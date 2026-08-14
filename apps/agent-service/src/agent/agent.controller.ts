import { Body, Controller, Post } from '@nestjs/common';
import { AgentService, InvokeRequest } from './agent.service';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('invoke')
  async invoke(@Body() request: InvokeRequest) {
    // Fire-and-forget: the pipeline runs in the background and streams progress
    // plus a terminal `agent:done` over the agent socket. The HTTP response is
    // only an acknowledgement — blocking here until the full response was
    // complete is what caused client/proxy timeouts on long agent runs.
    void this.agentService.invoke(request);
    return { success: true, async: true };
  }

  @Post('apply')
  async apply(
    @Body()
    body: {
      threadId: string;
      sessionId: string;
      userId: string;
      token?: string;
    },
  ) {
    await this.agentService.applyPending(
      body.threadId,
      body.sessionId,
      body.userId,
      body.token,
    );
    return { success: true };
  }

  @Post('stop')
  async stop(@Body() body: { threadId: string }) {
    const stopped = await this.agentService.cancel(body.threadId);
    return { success: true, stopped };
  }

  @Post('reject')
  async reject(@Body() body: { threadId: string }) {
    await this.agentService.rejectPending(body.threadId);
    return { success: true };
  }
}
