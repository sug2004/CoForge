import {
  Controller,
  Get,
  Param,
  Post,
  Put,
  Delete,
  Body,
  HttpCode,
} from '@nestjs/common';
import { SandboxService } from './sandbox.service';

export interface FilesBody {
  files?: Record<string, string>;
  deleted?: string[];
}

export interface PreviewBody {
  port?: number;
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
