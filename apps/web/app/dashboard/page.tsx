'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Workspace, Session } from '@/lib/api';
import AppShell, { Avatar } from '@/components/AppShell';

const WS_COLORS = ['#6366f1', '#22c55e', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

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
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [greeting, setGreeting] = useState('');
  const [totalProjects, setTotalProjects] = useState(0);

  useEffect(() => {
    api.workspaces.list().then(wsList => {
      setWorkspaces(wsList);
      setTotalProjects(wsList.reduce((sum, ws) => sum + (ws.projects?.length ?? 0), 0));
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
          <div className="relative rounded-2xl overflow-hidden p-6 flex items-center justify-between" style={{ background: 'linear-gradient(135deg, #1a1f35 0%, #0f1420 100%)', border: '1px solid var(--border)', minHeight: 140 }}>
            <div>
              <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-1)' }}>
                {greeting} 👋
              </h1>
              <p className="text-sm mb-4" style={{ color: 'var(--text-2)' }}>Pick up where you left off or start something new.</p>
              <button
                onClick={() => router.push('/dashboard/sessions')}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                style={{ background: 'var(--accent)' }}
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
          {/* Online Collaborators */}
          <div>
            <SectionHeader title="Online Collaborators" />
            <div className="flex flex-col gap-1">
              {[
                { name: 'You', sub: 'You', crown: true },
                { name: 'samar', sub: 'Active', online: true },
                { name: 'nivedha', sub: 'Active', online: true },
                { name: 'arjun', sub: 'Idle' },
                { name: 'meghana', sub: 'Idle' },
              ].map(u => (
                <div key={u.name} className="flex items-center gap-2.5 px-2 py-2 rounded-lg" style={{ background: 'transparent' }}>
                  <div className="relative">
                    <Avatar name={u.name} size={8} color={u.crown ? '#6366f1' : '#374151'} />
                    {u.online && <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2" style={{ background: 'var(--green)', borderColor: 'var(--bg-surface)' }} />}
                    {u.crown && <span className="absolute -top-1 -right-1 text-[10px]">👑</span>}
                  </div>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>{u.name}</p>
                    <p className="text-xs" style={{ color: u.online ? 'var(--green)' : 'var(--text-3)' }}>{u.sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Commits */}
          <div>
            <SectionHeader title="Recent Commits" />
            <div className="flex flex-col gap-3">
              {[
                { msg: 'feat: add cursor awareness', by: 'sug2004', hash: 'a1b2c3d', time: '2h ago' },
                { msg: 'fix: resolve merge conflicts', by: 'samar', hash: 'd4e5f6a', time: '5h ago' },
                { msg: 'chore: update dependencies', by: 'sug2004', hash: 'f7g8h9i', time: '1d ago' },
                { msg: 'feat: improve session list UI', by: 'nivedha', hash: 'j1k2l3m', time: '2d ago' },
              ].map(c => (
                <div key={c.hash} className="flex items-start gap-2">
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--accent)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate" style={{ color: 'var(--text-1)' }}>{c.msg}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>by {c.by}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <span className="text-[10px]" style={{ color: 'var(--text-3)' }}>{c.time}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--bg-hover)', color: 'var(--text-3)' }}>{c.hash}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Upcoming Tasks */}
          <div>
            <SectionHeader title="Upcoming Tasks" />
            <div className="flex flex-col gap-2">
              {[
                { label: 'Implement file presence', sub: 'AI Code Assistant', badge: 'Today', badgeColor: 'var(--accent)' },
                { label: 'Add inline chat feedback', sub: 'Realtime Chat App', badge: 'Tomorrow', badgeColor: '#374151' },
                { label: 'Refactor auth module', sub: 'Mobile Companion', badge: 'May 10', badgeColor: '#374151' },
                { label: 'Write integration tests', sub: 'Docs Intelligence', badge: 'May 12', badgeColor: '#374151' },
              ].map(t => (
                <div key={t.label} className="flex items-center gap-2.5">
                  <div className="w-4 h-4 rounded-full shrink-0" style={{ border: '1.5px solid var(--border)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text-1)' }}>{t.label}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>{t.sub}</p>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 text-white" style={{ background: t.badgeColor }}>{t.badge}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
