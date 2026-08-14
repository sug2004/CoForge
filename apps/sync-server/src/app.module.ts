import { Module } from '@nestjs/common';
import { SyncModule } from './sync/sync.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [SyncModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
