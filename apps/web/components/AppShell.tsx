'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AuthUser } from '@/lib/auth';

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  logo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  projects: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 24 24" fill="var(--yellow)" width="14" height="14">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />

    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
};

const NAV = [
  { label: 'Dashboard', icon: Icon.dashboard, href: '/dashboard', exact: true },
  { label: 'Projects', icon: Icon.projects, href: '/dashboard/projects', exact: true },
  { label: 'Sessions', icon: Icon.sessions, href: '/dashboard/sessions', exact: false, matchPrefix: '/session' },
  { label: 'Profile', icon: Icon.user, href: '/profile', exact: true },
];

export function Avatar({ name, avatarUrl, size = 7, color }: {
  name: string; avatarUrl?: string | null; size?: number; color?: string;
}) {
  const px = size * 4;
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} style={{ width: px, height: px, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: px, height: px, borderRadius: '50%', background: color ?? 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: px * 0.38, textTransform: 'uppercase', flexShrink: 0, userSelect: 'none' }}>
      {name.charAt(0)}
    </div>
  );
}

// editorMode = true → no topbar, content fills remaining height (used in /session/*)
export default function AppShell({ children, user, editorMode = false }: {
  children: React.ReactNode;
  user?: AuthUser | null;
  editorMode?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string; workspace: { id: string; name: string } }[]>([]);

  useEffect(() => {
    api.auth.me().then(setMe).catch(() => { });
    api.projects.list().then(setProjects).catch(() => { });
  }, []);

  useEffect(() => {
    api.projects.list().then(setProjects).catch(() => { });
  }, [pathname]);

  function logout() {
    const CORE_API = process.env.NEXT_PUBLIC_CORE_API_URL ?? 'http://localhost:3002';
    window.location.href = `${CORE_API}/auth/logout`;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)' }}>

      {/* ── Sidebar ── */}
      <aside style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-surface)', borderRight: '1px solid var(--border)' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 12px', flexShrink: 0 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexShrink: 0 }}>
            {Icon.logo}
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-1)', letterSpacing: '-0.3px' }}>CoForge</span>
        </div>

        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '0 8px', flex: 1, overflowY: 'auto' }}>
          {NAV.map((item) => {
            const isNavActive = item.exact
              ? pathname === item.href
              : item.matchPrefix
                ? pathname.startsWith(item.matchPrefix) || pathname.startsWith(item.href)
                : pathname.startsWith(item.href);

            return (
              <button
                key={item.label}
                onClick={() => router.push(item.href)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 8, fontSize: 13.5, fontWeight: 500, textAlign: 'left', width: '100%',
                  background: isNavActive ? 'var(--accent-soft)' : 'transparent',
                  color: isNavActive ? 'var(--accent-h)' : 'var(--text-2)',
                  border: 'none',
                  borderLeft: isNavActive ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => { if (!isNavActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isNavActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ opacity: isNavActive ? 1 : 0.65, flexShrink: 0, display: 'flex' }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}

          {/* Projects quick-list */}
          <div style={{ marginTop: 18, marginBottom: 4, padding: '0 12px' }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-3)' }}>Projects</span>
          </div>
          {projects.map((proj) => {
            const isActive = pathname.includes(proj.id);
            return (
              <button
                key={proj.id}
                onClick={() => router.push(`/dashboard/${proj.workspace.id}/${proj.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 8,
                  fontSize: 13, textAlign: 'left', width: '100%',
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  color: isActive ? 'var(--accent-h)' : 'var(--text-2)',
                }}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 11, opacity: 0.6, flexShrink: 0 }}>▸</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proj.name}</span>
              </button>
            );
          })}
        </nav>


        {/* User */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {showUserMenu && (
            <div style={{ position: 'absolute', bottom: '100%', left: 8, right: 8, marginBottom: 4, borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden', zIndex: 50 }}>
              <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--border)' }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{me?.username ?? '—'}</p>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--text-3)' }}>{me?.email ?? ''}</p>
              </div>
              <button
                onClick={logout}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--red)', textAlign: 'left' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </button>
            </div>
          )}
          <button
            onClick={() => setShowUserMenu(s => !s)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--border)', width: '100%', background: showUserMenu ? 'var(--bg-hover)' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <Avatar name={me?.username ?? '?'} avatarUrl={me?.avatarUrl} size={8} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>{me?.username ?? '—'}</p>
              <p style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>{me?.email ?? ''}</p>
            </div>
            <span style={{ color: 'var(--text-3)', display: 'flex', transform: showUserMenu ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>{Icon.chevronDown}</span>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

        <main style={{ flex: 1, overflowY: editorMode ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
