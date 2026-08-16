import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithTimeout } from "./http";
import { AgentContext, EditorFocus } from "./types";
import {
  detectTestCommand,
  extractInstructions,
  summarizeProject,
} from "./project";

interface MemoryMessage {
  role: string;
  content: any;
}

@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);
  private readonly coreApiUrl: string;
  private readonly syncServerUrl: string;

  constructor(private readonly config: ConfigService) {
    this.coreApiUrl = config.get("CORE_API_URL") ?? "http://localhost:3002";
    this.syncServerUrl =
      config.get("SYNC_SERVER_URL") ?? "http://localhost:3001";
  }

  private async get(url: string, token?: string): Promise<any | null> {
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        10_000,
      );
      if (!res.ok) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      return JSON.parse(text);
    } catch (e) {
      this.logger.warn(
        `core-api request failed: ${url} — ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async post(url: string, body: any): Promise<any | null> {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        10_000,
      );
      if (!res.ok) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      return JSON.parse(text);
    } catch (e) {
      this.logger.warn(`request failed: ${url} — ${(e as Error).message}`);
      return null;
    }
  }

  async getProjectId(
    sessionId: string,
    token?: string,
  ): Promise<string | null> {
    const session = await this.get(
      `${this.coreApiUrl}/sessions/${encodeURIComponent(sessionId)}`,
      token,
    );
    return session?.projectId ?? null;
  }

  async getProjectMemory(projectId: string, token?: string): Promise<string> {
    const mem = await this.get(
      `${this.coreApiUrl}/projects/${encodeURIComponent(projectId)}/memory`,
      token,
    );
    return mem?.summary ?? "";
  }

  async getUserPreferences(
    projectId: string,
    userId: string,
    token?: string,
  ): Promise<string> {
    const prefs = await this.get(
      `${this.coreApiUrl}/projects/${encodeURIComponent(projectId)}/preferences`,
      token,
    );
    return prefs?.notes ?? "";
  }

  async getWorkingMemory(
    sessionId: string,
    threadId: string,
    token?: string,
  ): Promise<MemoryMessage[]> {
    const thread = await this.get(
      `${this.coreApiUrl}/sessions/${encodeURIComponent(sessionId)}/agent-threads/${encodeURIComponent(threadId)}`,
      token,
    );
    return thread?.messages ?? [];
  }

  async getFiles(sessionId: string): Promise<Record<string, string>> {
    const res = await this.post(`${this.syncServerUrl}/sync/files`, {
      sessionId,
    });
    return res?.files ?? {};
  }

  async buildContext(params: {
    sessionId: string;
    userId: string;
    threadId: string;
    prompt: string;
    focus?: EditorFocus;
    token?: string;
  }): Promise<AgentContext> {
    const { sessionId, userId, threadId, focus, token } = params;

    const projectId = await this.getProjectId(sessionId, token);
    const [projectMemory, userPreferences, rawMessages, files] =
      await Promise.all([
        projectId
          ? this.getProjectMemory(projectId, token)
          : Promise.resolve(""),
        projectId
          ? this.getUserPreferences(projectId, userId, token)
          : Promise.resolve(""),
        this.getWorkingMemory(sessionId, threadId, token),
        this.getFiles(sessionId),
      ]);

    // Working memory: last ~20 turns verbatim, large payloads truncated. Each
    // turn is capped hard — these messages are replayed verbatim into every
    // planner/coder request, and the free Groq tier (~6000 TPM) rejects
    // oversized prompts, so keep them compact.
    const workingMemory = rawMessages.slice(-20).map((m) => {
      let text: string;
      if (typeof m.content === "string") text = m.content;
      else if (m.content?.text) text = m.content.text;
      else if (m.content?.plan)
        text = `plan: ${JSON.stringify(m.content.plan)}`;
      else text = JSON.stringify(m.content);
      return {
        role: m.role === "user" ? "user" : "assistant",
        text: text.length > 800 ? `${text.slice(0, 800)}… (truncated)` : text,
      };
    });

    // Project memory is replayed verbatim into every planner/coder system
    // prompt. The memory writer produces long, prose-heavy summaries; on the
    // free Groq tier (~6000 TPM, counting input + max_tokens) a multi-KB
    // summary alone can push a request over the limit, so cap what we inject.
    const PROJECT_MEMORY_CAP = 1_200;
    const projectMemoryCapped =
      projectMemory.length > PROJECT_MEMORY_CAP
        ? `${projectMemory.slice(0, PROJECT_MEMORY_CAP)}\n… (memory truncated)`
        : projectMemory;

    return {
      projectMemory: projectMemoryCapped,
      userPreferences,
      workingMemory,
      files,
      focus: focus ?? { openFileIds: [] },
      testCommand: detectTestCommand(files),
      instructions: extractInstructions(files),
      projectSummary: summarizeProject(files),
    };
  }
}
