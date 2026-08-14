import { Injectable, Logger } from '@nestjs/common';
import { LlmClient, LlmOverride } from './client';
import { AgentContext, Plan, throwIfAborted } from './types';
import { extractJson } from './json';
import { describeWorkspace } from './workspace';

@Injectable()
export class Planner {
  private readonly logger = new Logger(Planner.name);

  constructor(private readonly llm: LlmClient) {}

  async plan(
    context: AgentContext,
    prompt: string,
    override?: LlmOverride,
    signal?: AbortSignal,
  ): Promise<Plan> {
    // Cap the file list — a huge monorepo can bloat the prompt enough to slow
    // the model down (the user-facing symptom: "planning takes forever").
    const FILE_LIST_CAP = 200;
    const allFiles = Object.keys(context.files).sort();
    const fileLines = allFiles.slice(0, FILE_LIST_CAP).map((f) => `- ${f}`);
    const omitted = allFiles.length - fileLines.length;
    if (omitted > 0) fileLines.push(`- … (${omitted} more files)`);
    const fileList = fileLines.join('\n');

    // A compact structural summary of the workspace (tree + detected project
    // root + test command). Always injected so planning never guesses the
    // project layout.
    const layout = describeWorkspace(context.files);

    const system = `You are the planning phase of a code agent working in a collaborative editor.
Your job is to decide WHAT needs to happen — not to write code. You analyze the user's request against the current project state and produce a structured plan.

Project memory (architecture/conventions):
${context.projectMemory || '(none yet)'}

User preferences:
${context.userPreferences || '(none)'}

Project instructions (AGENTS.md / CLAUDE.md / editor rules — follow these):
${context.instructions || '(none)'}

Project summary:
${context.projectSummary || '(none)'}

Current workspace:
${layout || '(empty workspace)'}

Respond with ONLY a JSON object in this exact shape:
{
  "summary": "one sentence summary of the approach",
  "needsClarification": false,
  "clarification": "optional question to the user",
  "risk": "low" | "medium" | "high",
  "steps": [
    { "description": "what to do", "files": ["relative/path/file.ts"] }
  ]
}

Rules:
- Prefer ACTION over clarification. When a reasonable interpretation exists, choose the most likely one, proceed, and list the assumptions you made in the summary. Do not ask about things you can reasonably infer (names, file locations, conventions) or discover yourself — that's what the Coder's tools are for.
- Only set needsClarification=true when the request genuinely CANNOT be acted on without information you have no way to infer — e.g. a missing target ("the thing" with no signal for which one), an explicit either/or with zero signal, or an irreversible/destructive choice. This should be RARE (well under 10% of requests).
- When you do clarify, ask exactly ONE short question that offers concrete options (e.g. 'Which one: A or B?') so the user can answer in one word.
- risk is "high" for anything touching auth, payments, data migration, schema, or deleting files; "medium" for most multi-file changes; "low" for trivial/isolated changes.
- Keep steps small and independently testable. Each step lists the files it touches.
- If no code change is needed, return steps: [] with a summary explaining why.`;

    try {
      const { text } = await this.llm.complete({
        model: 'planner',
        system,
        messages: context.workingMemory.map((m) => ({
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.text,
        })).concat({
          role: 'user' as const,
          content: `The user's request:\n\n${prompt}\n\nRespond with the JSON plan.`,
        }),
        maxTokens: 4096,
        temperature: 0.1,
        override,
        signal,
      });
      throwIfAborted(signal);

      try {
        const plan = extractJson(text) as Plan;
        if (!Array.isArray(plan.steps)) throw new Error('plan missing steps array');
        plan.risk = plan.risk ?? 'medium';
        return plan;
      } catch (parseError) {
        // Models occasionally mangle the JSON (smart quotes, trailing prose,
        // doubled objects). Retry once with a strict single-object prompt
        // before giving up.
        this.logger.warn(`Planner JSON parse failed (${(parseError as Error).message}) — retrying`);
        const { text: retryText } = await this.llm.complete({
          model: 'planner',
          system: `${system}\n\nIMPORTANT: Return ONLY the raw JSON object. No markdown code fences, no prose, no explanation before or after. Use straight double quotes for all strings.`,
          messages: [
            ...context.workingMemory
              .slice(-6)
              .map((m) => ({
                role: m.role === 'user' ? 'user' as const : 'assistant' as const,
                content: m.text,
              })),
            {
              role: 'user' as const,
              content: `The user's request:\n\n${prompt}\n\nReturn ONLY the JSON plan object.`,
            },
          ],
          maxTokens: 4096,
          temperature: 0,
          override,
          signal,
        });
        throwIfAborted(signal);
        const plan = extractJson(retryText) as Plan;
        if (!Array.isArray(plan.steps)) throw new Error('plan missing steps array');
        plan.risk = plan.risk ?? 'medium';
        return plan;
      }
    } catch (e) {
      // A user cancel makes the in-flight call reject with an SDK error — turn
      // that into AgentCancelledError instead of a graceful "could not plan".
      throwIfAborted(signal);
      this.logger.error('Planner failed', e);
      return {
        summary: `Could not plan this request: ${(e as Error).message}`,
        needsClarification: false,
        risk: 'medium',
        steps: [],
      };
    }
  }
}
