import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({ limit: '50mb' }));
  app.enableCors();
  await app.listen(process.env.PORT ?? 3004);
  console.log(
    `sandbox-runner running on http://localhost:${process.env.PORT ?? 3004}`,
  );
}
void bootstrap();
