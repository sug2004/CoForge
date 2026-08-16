import { Module } from '@nestjs/common';
import { AgentGateway } from './sync.gateway';
import { SyncController } from './sync.controller';

@Module({
  controllers: [SyncController],
  providers: [AgentGateway],
  exports: [AgentGateway],
})
export class SyncModule {}
