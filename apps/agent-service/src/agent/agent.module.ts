import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { LlmClient } from './pipeline/client';
import { ContextService } from './pipeline/context';
import { Planner } from './pipeline/planner';
import { Coder } from './pipeline/coder';
import { Validator } from './pipeline/validator';
import { Applier } from './pipeline/applier';
import { AgentEmitter } from './pipeline/emitter';
import { SandboxClient } from './pipeline/sandbox-client';
import { AgentTools } from './pipeline/tools';

@Module({
  controllers: [AgentController],
  providers: [
    AgentService,
    { provide: LlmClient, useFactory: (config: ConfigService) => new LlmClient(config), inject: [ConfigService] },
    { provide: ContextService, useFactory: (config: ConfigService) => new ContextService(config), inject: [ConfigService] },
    { provide: SandboxClient, useFactory: (config: ConfigService) => new SandboxClient(config), inject: [ConfigService] },
    { provide: Validator, useFactory: (sandbox: SandboxClient) => new Validator(sandbox), inject: [SandboxClient] },
    { provide: AgentEmitter, useFactory: (config: ConfigService) => new AgentEmitter(config), inject: [ConfigService] },
    Planner,
    Coder,
    AgentTools,
    Applier,
  ],
  exports: [AgentService],
})
export class AgentModule {}
