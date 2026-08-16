import { Module } from "@nestjs/common";
import { AgentService } from "./agent.service";
import { AgentController } from "./agent.controller";
import { LlmClient } from "./pipeline/client";
import { ContextService } from "./pipeline/context";
import { Planner } from "./pipeline/planner";
import { Coder } from "./pipeline/coder";
import { Validator } from "./pipeline/validator";
import { Applier } from "./pipeline/applier";
import { AgentEmitter } from "./pipeline/emitter";
import { SandboxClient } from "./pipeline/sandbox-client";
import { AgentTools } from "./pipeline/tools";
import { Chat } from "./pipeline/chat";

@Module({
  controllers: [AgentController],
  providers: [
    AgentService,
    LlmClient,
    ContextService,
    SandboxClient,
    Validator,
    AgentEmitter,
    Planner,
    Coder,
    AgentTools,
    Applier,
    Chat,
  ],
  exports: [AgentService],
})
export class AgentModule {}
