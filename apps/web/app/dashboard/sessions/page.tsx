'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, Session, Workspace } from '@/lib/api';
import AppShell, { Avatar } from '@/components/AppShell';

const PEER_COLORS = ['#6366f1', '#22c55e', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];
function colorFor(id: string) { return PEER_COLORS[id.charCodeAt(0) % PEER_COLORS.length]; }

type SessionWithCtx = Session & { projectName: string; wsId: string; projectId: string };

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionWithCtx[]>([]);
  const [filter, setFilter] = useState<'all' | 'live' | 'past'>('all');

  useEffect(() => {
    api.workspaces.list().then(async wsList => {
      const all: SessionWithCtx[] = [];
      for (const ws of wsList) {
        const projects = ws.projects ?? [];
        for (const p of projects) {
          try {
            const full = await api.projects.get(p.id);
            for (const s of full.sessions) {
              all.push({ ...s, projectName: p.name, wsId: ws.id, projectId: p.id });
            }
          } catch {}
        }
      }
      all.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      setSessions(all);
    }).catch(() => router.push('/login'));
  }, []);

  async function deleteSession(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this session?')) return;
    await api.sessions.delete(id);
    setSessions(prev => prev.filter(s => s.id !== id));
  }

  const visible = sessions.filter(s =>
    filter === 'all' ? true : filter === 'live' ? !s.endedAt : !!s.endedAt
  );

  return (
    <AppShell>
      <div className="p-6 flex flex-col gap-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>Sessions</h2>
          <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            {(['all', 'live', 'past'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-3 py-1 rounded-md text-xs font-medium capitalize"
                style={{
                  background: filter === f ? 'var(--accent)' : 'transparent',
                  color: filter === f ? '#fff' : 'var(--text-2)',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        {visible.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>No sessions found.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map(s => {
              const live = !s.endedAt;
              const participants = s.participants ?? [];
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-4 p-4 rounded-xl cursor-pointer group"
                  style={{ background: 'var(--bg-card)', border: `1px solid ${live ? 'rgba(34,197,94,0.3)' : 'var(--border)'}` }}
                  onClick={() => router.push(`/session/${s.id}`)}
                >
                  {/* status dot */}
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: live ? 'rgba(34,197,94,0.12)' : 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke={live ? 'var(--green)' : 'var(--text-3)'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </div>

                  {/* info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-1)' }}>
                        {s.projectName}
                      </span>
                      {live && (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 20, fontWeight: 700, background: 'rgba(34,197,94,0.15)', color: 'var(--green)', letterSpacing: '0.05em', flexShrink: 0 }}>
                          LIVE
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                        {new Date(s.startedAt).toLocaleString()}
                      </span>
                      {s.creator && (
                        <span className="text-xs" style={{ color: 'var(--text-3)' }}>by {s.creator.username}</span>
                      )}
                    </div>
                  </div>

                  {/* avatars */}
                  {participants.length > 0 && (
                    <div className="flex items-center shrink-0">
                      {participants.slice(0, 4).map(({ user }, i) => (
                        <div key={user.id} title={user.username} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: 4 - i, position: 'relative' }}>
                          <Avatar name={user.username} avatarUrl={user.avatarUrl} size={7} color={colorFor(user.id)} />
                        </div>
                      ))}
                      {participants.length > 4 && (
                        <div style={{ marginLeft: -8, width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-hover)', border: '2px solid var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-2)' }}>
                          +{participants.length - 4}
                        </div>
                      )}
                    </div>
                  )}

                  {/* actions */}
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={e => { e.stopPropagation(); router.push(`/session/${s.id}`); }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
                      style={{ background: 'var(--accent)' }}
                    >
                      Join
                    </button>
                    <button
                      onClick={e => deleteSession(e, s.id)}
                      className="opacity-0 group-hover:opacity-100 px-3 py-1.5 rounded-lg text-xs transition-opacity"
                      style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--red)' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
