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
  return res.json();
}

export interface Participant { id: string; username: string; avatarUrl: string | null }
export interface Workspace { id: string; name: string; ownerId: string; members: { userId: string; role: string }[] }
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

export const api = {
  auth: {
    me: () => apiFetch<{ id: string; username: string; email: string | null; avatarUrl: string | null }>('/me'),
  },
  sessions_clone: (sessionId: string) =>
    apiFetch<{ files: Record<string, string> }>(`/sessions/${sessionId}/clone`, { method: 'POST' }),
  workspaces: {
    list: () => apiFetch<Workspace[]>('/workspaces'),
    create: (name: string) => apiFetch<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
    delete: (id: string) => apiFetch<void>(`/workspaces/${id}`, { method: 'DELETE' }),
  },
  projects: {
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
};
