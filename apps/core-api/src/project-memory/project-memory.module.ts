import { Module } from '@nestjs/common';
import { ProjectMemoryService } from './project-memory.service';
import { ProjectMemoryController } from './project-memory.controller';

@Module({
  controllers: [ProjectMemoryController],
  providers: [ProjectMemoryService],
  exports: [ProjectMemoryService],
})
export class ProjectMemoryModule {}
