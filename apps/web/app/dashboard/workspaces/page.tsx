'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Workspace } from '@/lib/api';
import AppShell from '@/components/AppShell';

const WS_COLORS = ['#e2652f', '#5b9bd1', '#7fb787', '#d9b54c', '#b18ad1', '#f08a54'];

export default function WorkspacesPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.workspaces.list().then(setWorkspaces).catch(() => router.push('/login'));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const ws = await api.workspaces.create(name.trim());
      setWorkspaces(prev => [...prev, { ...ws, projects: [] }]);
      setName('');
    } catch (err) {
      alert((err as Error).message ?? 'Failed to create workspace');
    } finally { setLoading(false); }
  }

  async function deleteWs(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this workspace and all its projects?')) return;
    try {
      await api.workspaces.delete(id);
      setWorkspaces(prev => prev.filter(w => w.id !== id));
    } catch (err) {
      alert((err as Error).message ?? 'Failed to delete workspace');
    }
  }

  return (
    <AppShell>
      <div className="p-6 flex flex-col gap-6 max-w-5xl">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>Workspaces</h2>
          <form onSubmit={create} className="flex gap-2">
            <input
              className="px-3 py-1.5 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)', width: 200 }}
              placeholder="New workspace name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <button
              type="submit"
              disabled={loading}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              + Create
            </button>
          </form>
        </div>

        {/* List */}
        {workspaces.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>No workspaces yet. Create one above.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {workspaces.map((ws, i) => (
              <div
                key={ws.id}
                className="rounded-xl p-5 cursor-pointer group flex flex-col gap-4"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                onClick={() => router.push(`/dashboard/${ws.id}`)}
              >
                {/* top row */}
                <div className="flex items-start justify-between">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0"
                    style={{ background: WS_COLORS[i % WS_COLORS.length] }}
                  >
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <button
                    onClick={e => deleteWs(e, ws.id)}
                    className="opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded transition-opacity"
                    style={{ color: 'var(--red)', background: 'var(--bg-hover)' }}
                  >
                    Delete
                  </button>
                </div>

                {/* name */}
                <div>
                  <p className="font-semibold text-sm" style={{ color: 'var(--text-1)' }}>{ws.name}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                    {ws.members.length} member{ws.members.length !== 1 ? 's' : ''}
                  </p>
                </div>

                {/* projects preview */}
                <div className="flex flex-col gap-1 mt-auto">
                  {ws.projects.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>No projects yet</p>
                  ) : (
                    ws.projects.slice(0, 3).map(p => (
                      <div
                        key={p.id}
                        className="flex items-center gap-2 px-2 py-1 rounded-lg"
                        style={{ background: 'var(--bg-hover)' }}
                        onClick={e => { e.stopPropagation(); router.push(`/dashboard/${ws.id}/${p.id}`); }}
                      >
                        <span style={{ color: 'var(--accent)', fontSize: 11 }}>▸</span>
                        <span className="text-xs truncate" style={{ color: 'var(--text-2)' }}>{p.name}</span>
                      </div>
                    ))
                  )}
                  {ws.projects.length > 3 && (
                    <p className="text-xs px-2" style={{ color: 'var(--text-3)' }}>+{ws.projects.length - 3} more</p>
                  )}
                </div>

                {/* footer */}
                <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                    {ws.projects.length} project{ws.projects.length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--accent)' }}>Open →</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
