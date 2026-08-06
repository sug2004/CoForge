'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { api, Session, Project, Participant } from '@/lib/api';
import AppShell, { Avatar } from '@/components/AppShell';

const PEER_COLORS = ['#6366f1','#22c55e','#f97316','#3b82f6','#ec4899','#14b8a6','#e05252','#d4b84a'];

function colorFor(id: string) {
  return PEER_COLORS[id.charCodeAt(0) % PEER_COLORS.length];
}

function ParticipantStack({ participants, max = 4 }: { participants: { user: Participant }[]; max?: number }) {
  const shown = participants.slice(0, max);
  const extra = participants.length - max;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {shown.map(({ user }, i) => (
        <div key={user.id} title={user.username} style={{ marginLeft: i === 0 ? 0 : -8, zIndex: max - i, position: 'relative' }}>
          <Avatar name={user.username} avatarUrl={user.avatarUrl} size={7} color={colorFor(user.id)} />
        </div>
      ))}
      {extra > 0 && (
        <div style={{ marginLeft: -8, width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-hover)', border: '2px solid var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-2)', zIndex: 0 }}>
          +{extra}
        </div>
      )}
    </div>
  );
}

function ParticipantList({ participants }: { participants: { user: Participant }[] }) {
  if (participants.length === 0) {
    return <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0 }}>No collaborators yet</p>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {participants.map(({ user }) => (
        <div key={user.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 4px', borderRadius: 20, background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
          <Avatar name={user.username} avatarUrl={user.avatarUrl} size={5} color={colorFor(user.id)} />
          <span style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 500 }}>{user.username}</span>
        </div>
      ))}
    </div>
  );
}

function SessionCard({ session, onJoin, onDelete, live }: {
  session: Session; onJoin: () => void; onDelete: (e: React.MouseEvent) => void; live?: boolean;
}) {
  const participants = session.participants ?? [];
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
        {/* icon */}
        <div style={{ width: 40, height: 40, borderRadius: 10, background: live ? 'rgba(34,197,94,0.12)' : 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke={live ? 'var(--green)' : 'var(--text-3)'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>

        {/* info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
              {session.creator?.username ?? 'Session'}
            </span>
            {live && (
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 20, fontWeight: 700, background: 'rgba(34,197,94,0.15)', color: 'var(--green)', letterSpacing: '0.05em' }}>
                LIVE
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(session.startedAt).toLocaleString()}</span>
            <button
              onClick={() => setExpanded(e => !e)}
              style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {participants.length} collaborator{participants.length !== 1 ? 's' : ''} {expanded ? '▲' : '▼'}
            </button>
          </div>
        </div>

        {/* stacked avatars */}
        {participants.length > 0 && <ParticipantStack participants={participants} />}

        {/* actions */}
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={onJoin}
            style={{ padding: '7px 18px', borderRadius: 8, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Join
          </button>
          <button
            onClick={onDelete}
            style={{ padding: '7px 10px', borderRadius: 8, background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--red)', fontSize: 12, cursor: 'pointer' }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* expanded participant list */}
      {expanded && (
        <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border)' }}>
          <p style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600, margin: '10px 0 6px' }}>Collaborators</p>
          <ParticipantList participants={participants} />
        </div>
      )}
    </div>
  );
}

export default function ProjectPage() {
  const router = useRouter();
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const [project, setProject] = useState<(Project & { sessions: Session[] }) | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.projects.get(projectId).then(setProject).catch(() => router.push('/dashboard'));
  }, [projectId]);

  // re-fetch project every 10s to pick up new collaborators who joined via invite
  useEffect(() => {
    const interval = setInterval(() => {
      api.projects.get(projectId).then(setProject).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [projectId]);

  async function startSession() {
    setLoading(true);
    try {
      const session = await api.sessions.create(projectId);
      router.push(`/session/${session.id}`);
    } finally { setLoading(false); }
  }

  async function deleteSession(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('Delete this session?')) return;
    await api.sessions.delete(id);
    setProject(prev => prev ? { ...prev, sessions: prev.sessions.filter(s => s.id !== id) } : prev);
  }

  if (!project) return <AppShell><div style={{ padding: 24, color: 'var(--text-3)' }}>Loading...</div></AppShell>;

  const liveSessions = project.sessions.filter(s => !s.endedAt);
  const pastSessions = project.sessions.filter(s => s.endedAt);

  return (
    <AppShell>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 860 }}>

        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-3)' }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 13 }}>Dashboard</button>
          <span>/</span>
          <button onClick={() => router.push(`/dashboard/${workspaceId}`)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 13 }}>Workspace</button>
          <span>/</span>
          <span style={{ color: 'var(--text-1)' }}>{project.name}</span>
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-1)', margin: 0 }}>{project.name}</h2>
            {project.repoUrl && <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{project.repoUrl}</p>}
          </div>
          <button
            onClick={startSession}
            disabled={loading}
            style={{ padding: '8px 18px', borderRadius: 8, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.5 : 1, flexShrink: 0 }}
          >
            {loading ? 'Starting...' : '+ New Session'}
          </button>
        </div>

        {/* Live sessions */}
        {liveSessions.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
              <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', margin: 0 }}>Live Sessions</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {liveSessions.map(s => (
                <SessionCard key={s.id} session={s} onJoin={() => router.push(`/session/${s.id}`)} onDelete={e => deleteSession(e, s.id)} live />
              ))}
            </div>
          </div>
        )}

        {/* Past / all sessions */}
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', margin: '0 0 12px' }}>
            {liveSessions.length > 0 ? 'Past Sessions' : 'Sessions'}
          </h3>
          {project.sessions.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>No sessions yet. Start one above.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(liveSessions.length > 0 ? pastSessions : project.sessions).map(s => (
                <SessionCard key={s.id} session={s} onJoin={() => router.push(`/session/${s.id}`)} onDelete={e => deleteSession(e, s.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
