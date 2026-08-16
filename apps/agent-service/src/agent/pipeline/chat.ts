import { Injectable, Logger } from "@nestjs/common";
import { LlmClient, LlmOverride } from "./client";
import { throwIfAborted } from "./types";

// Matches a message that is ONLY social small-talk — greeting, thanks,
// acknowledgement, identity question. These skip the whole planning →
// coder → validator pipeline and get a natural conversational reply instead
// (like talking to a real coding agent). Anything with actual intent to work
// on code ("hey, can you fix the login bug") deliberately does NOT match: the
// trailing requirement words fail the full-string anchor, so it flows into
// the normal pipeline.
// Trailing tolerance: allow stray punctuation/whitespace/digits after the
// actual word so typos ("Hiiii9", "hey!!", "thanksss...") still count as
// small talk instead of dumping a greeting into the 5-minute pipeline.
const TRAIL = "[\\s!.,?~-]*\\d*";
const SMALL_TALK_PATTERN = new RegExp(
  `^(hi+|hello+|h+e+y+|yo+|hiya|hola|sup|howdy|greetings|good\\s+(morning|afternoon|evening|day)|what'?s\\s+up|wassup|how\\s+(are\\s+you|'?re\\s+you\\s+doing|it\\s+going)|you\\s+there|are\\s+you\\s+there)${TRAIL}$` +
    `|^(thanks|thank\\s+you|thank\\s+you\\s+so\\s+much|thx|ty|cheers|appreciate\\s+it|much\\s+appreciated)${TRAIL}$` +
    `|^(ok|okay|okey|kk|fine|sure|alright|got\\s+it|understood|sounds\\s+good|no\\s+problem|roger\\s+that|10-4)${TRAIL}$` +
    `|^(who\\s+are\\s+you|what\\s+are\\s+you|what\\s+can\\s+you\\s+do|what\\s+do\\s+you\\s+do|are\\s+you\\s+human|are\\s+you\\s+a\\s+(bot|robot|person))${TRAIL}$`,
  "i",
);

@Injectable()
export class Chat {
  private readonly logger = new Logger(Chat.name);

  constructor(private readonly llm: LlmClient) {}

  // Cheap gate: is this message pure social small-talk (no coding intent)?
  isSmallTalk(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    return SMALL_TALK_PATTERN.test(trimmed);
  }

  // A light conversational reply. No context, no sandbox, no tools — just a
  // quick, friendly answer like a normal chat, with a hardcoded fallback so
  // a model hiccup never leaves the user with silence.
  async respond(
    prompt: string,
    override?: LlmOverride,
    signal?: AbortSignal,
  ): Promise<string> {
    const system = `You are the CoForge coding assistant, a friendly agent living inside the user's collaborative code editor. The user just sent a brief social message. Reply conversationally — warm, brief (1-3 sentences), no tool calls, no planning. It's fine to offer help with code, but don't fabricate project details. Use plain text; keep markdown to a minimum.`;
    try {
      const { text } = await this.llm.complete({
        model: "chat",
        system,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 300,
        temperature: 0.7,
        override,
        signal,
      });
      throwIfAborted(signal);
      const reply = text.trim();
      if (reply) return reply;
      throw new Error("empty chat response");
    } catch (e) {
      // A user cancel means the whole run is being torn down — propagate it.
      throwIfAborted(signal);
      this.logger.warn(
        `Chat reply failed (${(e as Error).message}) — using fallback`,
      );
      return "Hey! I'm the CoForge agent. I can plan and implement code changes in this workspace. What would you like to work on?";
    }
  }
}
