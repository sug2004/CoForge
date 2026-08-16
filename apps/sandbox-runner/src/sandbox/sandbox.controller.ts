import {
  Controller,
  Get,
  Param,
  Post,
  Put,
  Delete,
  Body,
  HttpCode,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { SandboxService } from './sandbox.service';

export interface FilesBody {
  files?: Record<string, string>;
  deleted?: string[];
}

export interface PreviewBody {
  port?: number;
}

export interface ExecBody {
  command: string;
  timeoutMs?: number;
  cwd?: string;
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

  @Put(':sessionId/files')
  async writeFiles(
    @Param('sessionId') sessionId: string,
    @Body() body: FilesBody,
  ) {
    await this.sandbox.writeFiles(sessionId, {
      files: body.files ?? {},
      deleted: body.deleted ?? [],
    });
    return { ok: true };
  }

  // Warm + provision the container (containers are never auto-removed, so this
  // just ensures provisioning is done before a command runs).
  @Post(':sessionId/touch')
  async touch(@Param('sessionId') sessionId: string) {
    await this.sandbox.touch(sessionId);
    return { ok: true };
  }

  // One-shot command execution streaming NDJSON:
  //   {"stream":"stdout","chunk":"…"}
  //   {"stream":"stderr","chunk":"…"}
  //   {"stream":"exit","exitCode":0}
  //   {"stream":"exit","exitCode":null,"timeout":true}
  @Post(':sessionId/exec')
  async exec(
    @Param('sessionId') sessionId: string,
    @Body() body: ExecBody,
    @Res() res: Response,
  ) {
    if (!body?.command) {
      return res.status(400).json({ error: 'command is required' });
    }
    const timeoutMs = Math.max(
      1,
      Math.min(body.timeoutMs ?? 30_000, 300_000),
    );

    let run;
    try {
      run = await this.sandbox.runCommand(sessionId, body.command, timeoutMs, body.cwd);
    } catch (e: any) {
      const status = e?.status === 409 ? 409 : e?.status === 400 ? 400 : 500;
      return res.status(status).json({ error: e?.message ?? 'exec failed' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.flushHeaders?.();

    run.stdout.on('data', (chunk: Buffer) => {
      res.write(`${JSON.stringify({ stream: 'stdout', chunk: chunk.toString() })}\n`);
    });
    run.stderr.on('data', (chunk: Buffer) => {
      res.write(`${JSON.stringify({ stream: 'stderr', chunk: chunk.toString() })}\n`);
    });
    run.status.on('data', (chunk: Buffer) => {
      res.write(`${JSON.stringify({ stream: 'status', chunk: chunk.toString() })}\n`);
    });

    // The caller (agent-service) aborts the stream when a run is cancelled. res
    // 'close' fires on abort before run.done resolves — kill the container
    // process instead of leaving it running (and the busy slot locked). The
    // handler is registered before awaiting so an early abort isn't missed.
    let settled = false;
    void run.done.then(() => {
      settled = true;
    });
    res.on('close', () => {
      if (!settled) void this.sandbox.abortExec(sessionId);
    });

    const { exitCode, timeout } = await run.done;
    res.end(`${JSON.stringify({ stream: 'exit', exitCode, timeout })}\n`);
  }

  @Get(':sessionId/preview')
  async listPreviews(@Param('sessionId') sessionId: string) {
    const ports = await this.sandbox.listPublishedPorts(sessionId);
    return { ports };
  }

  @Post(':sessionId/preview')
  async openPreview(
    @Param('sessionId') sessionId: string,
    @Body() body: PreviewBody,
  ) {
    const port = Math.max(1, Math.min(65535, body?.port ?? 3000));
    const { hostPort } = await this.sandbox.openPreview(sessionId, port);
    return { url: `http://localhost:${hostPort}`, hostPort };
  }

  @Delete(':sessionId')
  @HttpCode(204)
  async destroy(@Param('sessionId') sessionId: string) {
    await this.sandbox.destroyContainer(sessionId);
  }

  @Delete(':sessionId/preview')
  async closePreview(@Param('sessionId') sessionId: string) {
    this.sandbox.closePreview(sessionId);
    return { ok: true };
  }
}
