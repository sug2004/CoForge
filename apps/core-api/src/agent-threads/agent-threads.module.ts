import { Module } from '@nestjs/common';
import { AgentThreadsService } from './agent-threads.service';
import { AgentThreadsController } from './agent-threads.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AgentThreadsController],
  providers: [AgentThreadsService],
  exports: [AgentThreadsService],
})
export class AgentThreadsModule {}