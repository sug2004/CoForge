'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Workspace, Session } from '@/lib/api';
import AppShell, { Avatar } from '@/components/AppShell';

const WS_COLORS = ['#e2652f', '#5b9bd1', '#7fb787', '#d9b54c', '#b18ad1', '#f08a54'];

function StatCard({ icon, value, label, delta }: { icon: string; value: number | string; label: string; delta?: string }) {
  return (
    <div className="flex items-center gap-4 p-5 rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0" style={{ background: 'var(--bg-hover)' }}>{icon}</div>
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold" style={{ color: 'var(--text-1)' }}>{value}</span>
          {delta && <span className="text-xs font-medium" style={{ color: 'var(--green)' }}>↑ {delta}</span>}
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>{label}</p>
      </div>
    </div>
  );
}

function SectionHeader({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-semibold text-sm" style={{ color: 'var(--text-1)' }}>{title}</h3>
      {onViewAll && (
        <button className="text-xs flex items-center gap-1" style={{ color: 'var(--text-3)' }} onClick={onViewAll}>
          View all →
        </button>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [recentSessions, setRecentSessions] = useState<(Session & { creator?: { id: string; username: string; avatarUrl: string | null } })[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [greeting, setGreeting] = useState('');
  const [totalProjects, setTotalProjects] = useState(0);

  useEffect(() => {
    api.workspaces.list().then(wsList => {
      setWorkspaces(wsList);
      setTotalProjects(wsList.reduce((sum, ws) => sum + (ws.projects?.length ?? 0), 0));

      const allProjectIds = wsList.flatMap(ws => (ws.projects ?? []).map(p => p.id));
      Promise.all(allProjectIds.map(pid => api.projects.get(pid).catch(() => null)))
        .then(projects => {
          const sessions = projects
            .filter(Boolean)
            .flatMap(p => (p?.sessions ?? []).map(s => ({ ...s, creator: s.creator })))
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
            .slice(0, 8);
          setRecentSessions(sessions);
        })
        .catch(() => {});
    }).catch(() => router.push('/login'));
    const h = new Date().getHours();
    setGreeting(h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      api.workspaces.list().then(wsList => {
        setWorkspaces(wsList);
        setTotalProjects(wsList.reduce((sum, ws) => sum + (ws.projects?.length ?? 0), 0));
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const ws = await api.workspaces.create(name.trim());
      setWorkspaces(prev => [...prev, ws]);
      setName('');
    } finally { setLoading(false); }
  }

  async function deleteWorkspace(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this workspace and all its projects?')) return;
    await api.workspaces.delete(id);
    setWorkspaces(prev => prev.filter(w => w.id !== id));
  }

  return (
    <AppShell>
      <div className="flex h-full">
        {/* Center content */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">

          {/* Hero */}
          <div className="relative rounded-2xl overflow-hidden p-6 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, var(--bg-card) 100%)', border: '1px solid var(--border)', minHeight: 140 }}>
            <div>
              <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-1)' }}>
                {greeting} 👋
              </h1>
              <p className="text-sm mb-4" style={{ color: 'var(--text-2)' }}>Pick up where you left off or start something new.</p>
              <button
                onClick={() => router.push('/dashboard/sessions')}
                className="btn-primary flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold"
              >
                Continue Working →
              </button>
            </div>
            <div className="hidden md:flex items-center justify-center w-32 h-24 rounded-xl text-4xl" style={{ background: 'var(--bg-hover)' }}>
              {'</>'}
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon="◻" value={workspaces.length} label="Workspaces" />
            <StatCard icon="◷" value={totalProjects} label="Projects" />
            <StatCard icon="👥" value={workspaces.reduce((s, w) => s + (w.members?.length ?? 0), 0)} label="Team Members" />
            <StatCard icon="✦" value="—" label="AI Tasks" />
          </div>

          {/* Workspaces table */}
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="px-5 pt-5 pb-3 flex items-center justify-between">
              <SectionHeader title="Workspaces" />
              <form onSubmit={create} className="flex gap-2">
                <input
                  id="ws-name-input"
                  className="px-3 py-1.5 rounded-lg text-sm outline-none"
                  style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)', width: 180 }}
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

            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderTop: '1px solid var(--border)' }}>
                  {['Workspace', 'Members', 'Projects', ''].map(h => (
                    <th key={h} className="px-5 py-2.5 text-left text-xs font-medium" style={{ color: 'var(--text-3)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workspaces.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-sm" style={{ color: 'var(--text-3)' }}>No workspaces yet. Create one above.</td></tr>
                )}
                {workspaces.map((ws, i) => (
                  <tr
                    key={ws.id}
                    className="cursor-pointer transition-colors group"
                    style={{ borderTop: '1px solid var(--border)' }}
                    onClick={() => router.push(`/dashboard/${ws.id}`)}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ background: WS_COLORS[i % WS_COLORS.length] }}>
                          {ws.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium" style={{ color: 'var(--text-1)' }}>{ws.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3" style={{ color: 'var(--text-2)' }}>{ws.members?.length ?? 0}</td>
                    <td className="px-5 py-3" style={{ color: 'var(--text-2)' }}>{ws.projects?.length ?? 0}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={e => deleteWorkspace(e, ws.id)}
                        className="opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded transition-opacity"
                        style={{ color: 'var(--red)', background: 'var(--bg-hover)' }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Quick Actions */}
          <div>
            <SectionHeader title="Quick Actions" />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { icon: '◫', label: 'New Workspace',     sub: 'Create a new workspace',      action: () => document.getElementById('ws-name-input')?.focus() },
                { icon: '◻', label: 'Create Project',    sub: 'Start a new project',          action: () => router.push('/dashboard/projects') },
                { icon: '◷', label: 'Start Session',     sub: 'Collaborate in real-time',     action: () => router.push('/dashboard/sessions') },
                { icon: '⬆', label: 'Import GitHub Repo', sub: 'Connect and import',          action: () => router.push('/dashboard/projects') },
                { icon: '👥', label: 'Invite Member',    sub: 'Add people to your workspace', action: () => router.push('/dashboard') },
              ].map(qa => (
                <button
                  key={qa.label}
                  onClick={qa.action}
                  className="flex items-center gap-3 p-4 rounded-xl text-left transition-colors group"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                >
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg shrink-0" style={{ background: 'var(--bg-hover)' }}>{qa.icon}</div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>{qa.label}</p>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>{qa.sub}</p>
                  </div>
                  <span className="ml-auto" style={{ color: 'var(--text-3)' }}>›</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right panel */}
        <aside className="w-72 shrink-0 overflow-y-auto p-4 flex flex-col gap-5" style={{ borderLeft: '1px solid var(--border)' }}>
          {/* Workspace Members */}
          <div>
            <SectionHeader title="Workspace Members" />
            <div className="flex flex-col gap-1">
              {workspaces.flatMap(ws => (ws.members ?? []).map(m => ({ ...m, wsName: ws.name })))
                .filter((m, i, arr) => arr.findIndex(x => x.userId === m.userId) === i)
                .slice(0, 8)
                .map(m => (
                <div key={m.userId} className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
                  <Avatar name={m.userId.slice(0, 6)} size={8} color="var(--text-3)" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--text-1)' }}>{m.userId.slice(0, 8)}…</p>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>{m.role}</p>
                  </div>
                </div>
              ))}
              {workspaces.flatMap(ws => (ws.members ?? [])).length === 0 && (
                <p className="text-xs" style={{ color: 'var(--text-3)' }}>No members yet</p>
              )}
            </div>
          </div>

          {/* Recent Sessions */}
          <div>
            <SectionHeader title="Recent Sessions" onViewAll={() => router.push('/dashboard/sessions')} />
            <div className="flex flex-col gap-3">
              {recentSessions.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--text-3)' }}>No recent sessions</p>
              )}
              {recentSessions.map(s => (
                <div
                  key={s.id}
                  className="flex items-start gap-2 cursor-pointer rounded-lg px-2 py-1.5 transition-colors"
                  style={{ ':hover': { background: 'var(--bg-hover)' } }}
                  onClick={() => router.push(`/session/${s.id}`)}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: s.endedAt ? 'var(--text-3)' : 'var(--green)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate" style={{ color: 'var(--text-1)' }}>
                      {s.creator?.username ?? 'User'} — {new Date(s.startedAt).toLocaleDateString()}
                    </p>
                    <p className="text-[11px]" style={{ color: s.endedAt ? 'var(--text-3)' : 'var(--green)' }}>
                      {s.endedAt ? 'ended' : 'live'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Stats */}
          <div>
            <SectionHeader title="Overview" />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>Total workspaces</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>{workspaces.length}</span>
              </div>
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>Total projects</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>{totalProjects}</span>
              </div>
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>Recent sessions</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>{recentSessions.length}</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
