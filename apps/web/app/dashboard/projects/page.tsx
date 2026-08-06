'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Project, Workspace } from '@/lib/api';
import AppShell from '@/components/AppShell';

const WS_COLORS = ['#6366f1', '#22c55e', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

type ProjectWithWs = Project & { wsName: string; wsId: string };

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithWs[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>('all');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.workspaces.list().then(wsList => {
      setWorkspaces(wsList);
      const all: ProjectWithWs[] = wsList.flatMap(ws =>
        (ws.projects ?? []).map((p) => ({ ...p, wsName: ws.name, wsId: ws.id }))
      );
      setProjects(all);
    }).catch(() => router.push('/login'));
  }, []);

  const targetWsId = selectedWs === 'all' ? workspaces[0]?.id : selectedWs;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !targetWsId) return;
    setLoading(true);
    try {
      const ws = workspaces.find(w => w.id === targetWsId)!;
      const p = await api.projects.create(targetWsId, name.trim(), repoUrl || undefined);
      setProjects(prev => [...prev, { ...p, wsName: ws.name, wsId: ws.id }]);
      setName(''); setRepoUrl('');
    } finally { setLoading(false); }
  }

  async function deleteProject(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this project and all its sessions?')) return;
    await api.projects.delete(id);
    setProjects(prev => prev.filter(p => p.id !== id));
  }

  const visible = selectedWs === 'all' ? projects : projects.filter(p => p.wsId === selectedWs);

  return (
    <AppShell>
      <div className="p-6 flex flex-col gap-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>Projects</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-3)' }}>Workspace:</span>
            <select
              value={selectedWs}
              onChange={e => setSelectedWs(e.target.value)}
              className="px-2 py-1.5 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
            >
              <option value="all">All</option>
              {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
            </select>
          </div>
        </div>

        {/* Create form */}
        {workspaces.length > 0 && (
          <form onSubmit={create} className="flex gap-3 p-4 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            {selectedWs === 'all' && (
              <select
                value={targetWsId ?? ''}
                onChange={e => setSelectedWs(e.target.value)}
                className="px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
              >
                {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
              </select>
            )}
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
        )}

        {/* Grid */}
        {visible.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>No projects yet. Create one above.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((p, i) => (
              <div
                key={p.id}
                className="rounded-xl p-5 cursor-pointer group flex flex-col gap-3"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                onClick={() => router.push(`/dashboard/${p.wsId}/${p.id}`)}
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
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>{p.wsName}</p>
                  {p.repoUrl && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-3)' }}>{p.repoUrl}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
