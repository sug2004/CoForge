export type Risk = 'low' | 'medium' | 'high';

export interface PlanStep {
  description: string;
  files: string[];
}

export interface Plan {
  steps: PlanStep[];
  needsClarification: boolean;
  clarification?: string;
  risk: Risk;
  summary: string;
}

export interface CoderOutput {
  files: Record<string, string>;
  explanation: string;
}

export interface ValidationResult {
  passed: boolean;
  output: string;
  command: string | null;
  reason?: string;
}

export interface EditorFocus {
  focusFileId?: string;
  cursor?: { line: number; col: number };
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  openFileIds: string[];
}

export interface AgentContext {
  projectMemory: string;
  userPreferences: string;
  workingMemory: { role: string; text: string }[];
  files: Record<string, string>;
  focus: EditorFocus;
  testCommand: string | null;
  // Project instructions (AGENTS.md / CLAUDE.md / .cursorrules) and a compact
  // manifest-derived summary (name, scripts, framework, README excerpt) —
  // gathered like opencode does so the model never has to guess the project.
  instructions: string;
  projectSummary: string;
}

export interface PendingApply {
  sessionId: string;
  userId: string;
  threadId: string;
  toolCallId: string;
  files: Record<string, string>;
  risk: Risk;
  createdAt: number;
}

// Thrown anywhere in the pipeline when the user cancels a running invocation.
// The service catches it distinctly so the client gets a `cancelled` signal
// instead of a generic failure.
export class AgentCancelledError extends Error {
  constructor(message = 'Agent run cancelled') {
    super(message);
    this.name = 'AgentCancelledError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentCancelledError();
}
