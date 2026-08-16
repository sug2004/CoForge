import { Injectable } from "@nestjs/common";
import { AgentEmitter } from "./emitter";
import { PendingApply, Risk } from "./types";

// Cheap line-based hint diff for the review UI — not a replacement for a real
// diff viewer, just enough to preview what changed at a glance.
export function hintDiff(oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: string[] = [];
  for (let i = prefix; i < a.length - suffix; i++) out.push(`- ${a[i]}`);
  for (let i = prefix; i < b.length - suffix; i++) out.push(`+ ${b[i]}`);
  return out.join("\n");
}

@Injectable()
export class Applier {
  private readonly pending = new Map<string, PendingApply>();

  constructor(private readonly emitter: AgentEmitter) {}

  async propose(
    sessionId: string,
    userId: string,
    threadId: string,
    toolCallId: string,
    files: Record<string, string>,
    baseFiles: Record<string, string>,
    risk: Risk,
  ): Promise<PendingApply> {
    const existing = this.pending.get(threadId);
    if (existing) {
      // A new run finished while the user still had an unreviewed proposal.
      // Don't silently clobber it — tell the user the old one is being dropped
      // so the review UI and the server-side pending stay in sync.
      await this.emitter
        .user(sessionId, userId, threadId, "agent:message", {
          text: `A newer run produced fresh changes, so the earlier proposal for this thread was superseded and will not be applied.`,
        })
        .catch(() => {});
    }

    const entry: PendingApply = {
      sessionId,
      userId,
      threadId,
      toolCallId,
      files,
      risk,
      createdAt: Date.now(),
    };
    this.pending.set(threadId, entry);

    for (const [fileId, newContent] of Object.entries(files)) {
      const oldContent = baseFiles[fileId] ?? "";
      await this.emitter.user(
        sessionId,
        userId,
        threadId,
        "agent:edit_proposed",
        {
          fileId,
          diff: hintDiff(oldContent, newContent),
          oldContent,
          newContent,
          toolCallId,
        },
      );
    }
    return entry;
  }

  getPending(threadId: string): PendingApply | undefined {
    return this.pending.get(threadId);
  }

  clearPending(threadId: string): void {
    this.pending.delete(threadId);
  }
}
