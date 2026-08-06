'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { api, Project } from '@/lib/api';
import AppShell from '@/components/AppShell';

const WS_COLORS = ['#6366f1', '#22c55e', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

export default function WorkspacePage() {
  const router = useRouter();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [wsName, setWsName] = useState('');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.workspaces.list().then(wsList => {
      const ws = wsList.find(w => w.id === workspaceId);
      if (!ws) { router.push('/dashboard'); return; }
      setWsName(ws.name);
      setProjects((ws as any).projects ?? []);
    }).catch(() => router.push('/login'));
  }, [workspaceId]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const project = await api.projects.create(workspaceId, name.trim(), repoUrl || undefined);
      setProjects(prev => [...prev, project]);
      setName(''); setRepoUrl('');
    } finally { setLoading(false); }
  }

  async function deleteProject(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this project and all its sessions?')) return;
    await api.projects.delete(id);
    setProjects(prev => prev.filter(p => p.id !== id));
  }

  return (
    <AppShell>
      <div className="p-6 flex flex-col gap-6 max-w-5xl">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-3)' }}>
          <button onClick={() => router.push('/dashboard')} className="hover:underline" style={{ color: 'var(--text-2)' }}>Dashboard</button>
          <span>/</span>
          <span style={{ color: 'var(--text-1)' }}>{wsName}</span>
        </div>

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>{wsName} — Projects</h2>
        </div>

        {/* Create form */}
        <form onSubmit={create} className="flex gap-3 p-4 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <input
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
            placeholder="Project name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
            placeholder="Repo URL (optional)"
            value={repoUrl}
            onChange={e => setRepoUrl(e.target.value)}
          />
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            + Create
          </button>
        </form>

        {/* Projects grid */}
        {projects.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>No projects yet. Create one above.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p, i) => (
              <div
                key={p.id}
                className="rounded-xl p-5 cursor-pointer group flex flex-col gap-3 transition-colors"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                onClick={() => router.push(`/dashboard/${workspaceId}/${p.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ background: WS_COLORS[i % WS_COLORS.length] }}>
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <button
                    onClick={e => deleteProject(e, p.id)}
                    className="opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded transition-opacity"
                    style={{ color: 'var(--red)', background: 'var(--bg-hover)' }}
                  >
                    Delete
                  </button>
                </div>
                <div>
                  <p className="font-semibold" style={{ color: 'var(--text-1)' }}>{p.name}</p>
                  {p.repoUrl && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-3)' }}>{p.repoUrl}</p>}
                </div>
                <div className="flex items-center gap-2 mt-auto">
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-hover)', color: 'var(--text-2)' }}>Active</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
