import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProjectsModule } from './projects/projects.module';
import { SessionsModule } from './sessions/sessions.module';
import { AgentThreadsModule } from './agent-threads/agent-threads.module';
import { ProjectMemoryModule } from './project-memory/project-memory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    WorkspacesModule,
    ProjectsModule,
    SessionsModule,
    AgentThreadsModule,
    ProjectMemoryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
