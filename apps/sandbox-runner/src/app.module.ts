import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SandboxModule } from './sandbox/sandbox.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), SandboxModule],
})
export class AppModule {}
