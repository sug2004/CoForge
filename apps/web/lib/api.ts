const CORE_API = process.env.NEXT_PUBLIC_CORE_API_URL ?? 'http://localhost:3002';

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CORE_API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `${res.status}`);
  }
  // 204 No Content (e.g. deletes) — nothing to parse
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export interface Participant { id: string; username: string; avatarUrl: string | null }
export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  members: { userId: string; role: string }[];
  projects: { id: string; name: string; repoUrl: string | null }[];
}
export interface Project { id: string; name: string; workspaceId: string; repoUrl: string | null; defaultBranch: string }
export interface Session {
  id: string;
  projectId: string;
  createdBy: string;
  startedAt: string;
  endedAt?: string | null;
  creator?: Participant;
  participants?: { user: Participant }[];
}

export interface AgentMessage {
  id: string;
  threadId: string;
  role: string;
  content: any;
  createdAt: string;
}
export interface ContextSnapshot {
  id: string;
  threadId: string;
  focusFileId?: string;
  cursor?: { line: number; col: number };
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  openFileIds: string[];
  createdAt: string;
}
export interface AgentThread {
  id: string;
  sessionId: string;
  userId: string;
  title: string | null;
  createdAt: string;
  archivedAt: string | null;
  messages: AgentMessage[];
  contextSnapshots?: ContextSnapshot[];
}

export const api = {
  auth: {
    me: () => apiFetch<{ id: string; githubId: string | null; username: string; email: string | null; avatarUrl: string | null; createdAt: string }>('/me'),
    meToken: () => apiFetch<{ accessToken: string }>('/me/token'),
    updateProfile: (data: { username?: string; email?: string; avatarUrl?: string }) =>
      apiFetch<{ id: string; username: string; email: string | null; avatarUrl: string | null }>('/me', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      apiFetch<{ ok: boolean }>('/me/password', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },
  sessions_clone: (sessionId: string) =>
    apiFetch<{ files: Record<string, string> }>(`/sessions/${sessionId}/clone`, { method: 'POST' }),
  workspaces: {
    list: () => apiFetch<Workspace[]>('/workspaces'),
    create: (name: string) => apiFetch<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
    delete: (id: string) => apiFetch<void>(`/workspaces/${id}`, { method: 'DELETE' }),
  },
  projects: {
    list: () => apiFetch<(Project & { workspace: { id: string; name: string } })[]>('/projects'),
    create: (workspaceId: string, name: string, repoUrl?: string) =>
      apiFetch<Project>(`/workspaces/${workspaceId}/projects`, { method: 'POST', body: JSON.stringify({ name, repoUrl }) }),
    get: (id: string) => apiFetch<Project & { sessions: Session[] }>(`/projects/${id}`),
    delete: (id: string) => apiFetch<void>(`/projects/${id}`, { method: 'DELETE' }),
  },
  sessions: {
    create: (projectId: string) => apiFetch<Session>(`/projects/${projectId}/sessions`, { method: 'POST' }),
    get: (id: string) => apiFetch<Session>(`/sessions/${id}`),
    join: (id: string) => apiFetch<Session>(`/sessions/${id}/join`, { method: 'POST' }),
    delete: (id: string) => apiFetch<void>(`/sessions/${id}`, { method: 'DELETE' }),
  },
  agentThreads: {
    list: (sessionId: string) =>
      apiFetch<AgentThread[]>(`/sessions/${sessionId}/agent-threads`),
    create: (sessionId: string, title?: string) =>
      apiFetch<AgentThread>(`/sessions/${sessionId}/agent-threads`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    get: (sessionId: string, threadId: string) =>
      apiFetch<AgentThread>(`/sessions/${sessionId}/agent-threads/${threadId}`),
    addMessage: (sessionId: string, threadId: string, role: string, content: any) =>
      apiFetch<AgentMessage>(`/sessions/${sessionId}/agent-threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role, content }),
      }),
    addContextSnapshot: (
      sessionId: string,
      threadId: string,
      data: {
        focusFileId?: string;
        cursor?: { line: number; col: number };
        selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
        openFileIds: string[];
      },
    ) =>
      apiFetch<ContextSnapshot>(`/sessions/${sessionId}/agent-threads/${threadId}/context-snapshots`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateTitle: (sessionId: string, threadId: string, title: string) =>
      apiFetch<AgentThread>(`/sessions/${sessionId}/agent-threads/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    archive: (sessionId: string, threadId: string) =>
      apiFetch<AgentThread>(`/sessions/${sessionId}/agent-threads/${threadId}/archive`, {
        method: 'PATCH',
      }),
    delete: (sessionId: string, threadId: string) =>
      apiFetch<void>(`/sessions/${sessionId}/agent-threads/${threadId}`, { method: 'DELETE' }),
  },
};
