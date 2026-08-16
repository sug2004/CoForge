import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithTimeout } from "./http";

@Injectable()
export class AgentEmitter {
  private readonly logger = new Logger(AgentEmitter.name);
  private readonly syncServerUrl: string;

  constructor(config: ConfigService) {
    this.syncServerUrl =
      config.get("SYNC_SERVER_URL") ?? "http://localhost:3001";
  }

  // Per-user event — delivered only to session:<sessionId>:user:<userId>
  async user(
    sessionId: string,
    userId: string,
    threadId: string,
    event: string,
    data: any,
  ): Promise<void> {
    await this.post({ sessionId, userId, threadId, event, data });
  }

  private async post(body: any): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.syncServerUrl}/agent/emit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        10_000,
      );
    } catch (e) {
      this.logger.warn(
        `emit failed for ${body.event}: ${(e as Error).message}`,
      );
    }
  }
}
