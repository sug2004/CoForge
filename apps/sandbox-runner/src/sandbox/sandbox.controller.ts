import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Body,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { SandboxService } from './sandbox.service';
import { writeNdjson } from './ndjson';

export interface ExecBody {
  command?: string;
  files?: Record<string, string>;
  timeoutMs?: number;
}

@Controller('sandbox')
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @Get(':sessionId/files')
  async files(@Param('sessionId') sessionId: string) {
    const files = await this.sandbox.listFiles(sessionId);
    return { files };
  }

  @Post(':sessionId/exec')
  async exec(
    @Param('sessionId') sessionId: string,
    @Body() body: ExecBody,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    try {
      await this.sandbox.exec(
        sessionId,
        body.command,
        body.files,
        body.timeoutMs,
        res,
      );
    } catch (e) {
      const isConflict = e instanceof ConflictException;
      const isBadRequest = e instanceof BadRequestException;
      const statusCode = (e as { statusCode?: number })?.statusCode;
      const status = isConflict
        ? 409
        : isBadRequest
          ? 400
          : statusCode && statusCode >= 400 && statusCode < 600
            ? statusCode
            : 500;
      const message = e instanceof Error ? e.message : 'Internal error';

      if (!res.headersSent) {
        res.status(status).json({ error: message });
      } else {
        writeNdjson(res, { stream: 'error', message });
        res.end();
      }
    }
  }
}
