'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { AuthUser } from '@/lib/auth';

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  logo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  ),
  workspaces: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  projects: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <rect x="3" y="11" width="18" height="10" rx="2"/><path d="M9 11V7a3 3 0 016 0v4"/>
      <circle cx="12" cy="16" r="1" fill="currentColor"/>
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
    </svg>
  ),
  help: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 24 24" fill="#facc15" width="14" height="14">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
    </svg>
  ),
};

const NAV = [
  { label: 'Dashboard',  icon: Icon.dashboard,   href: '/dashboard' },
  { label: 'Workspaces', icon: Icon.workspaces,   href: '/dashboard' },
  { label: 'Projects',   icon: Icon.projects,     href: '/dashboard' },
  { label: 'Sessions',   icon: Icon.sessions,     href: '/dashboard' },
  { label: 'AI Agents',  icon: Icon.agents,       href: '/dashboard' },
  { label: 'Activity',   icon: Icon.activity,     href: '/dashboard' },
  { label: 'Settings',   icon: Icon.settings,     href: '/dashboard' },
];

const WS_COLORS = ['#6366f1', '#22c55e', '#f97316', '#3b82f6', '#ec4899', '#14b8a6'];

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
  const [me, setMe] = useState<AuthUser | null>(user ?? null);
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    if (!me) api.auth.me().then(setMe).catch(() => {});
  }, []);

  function logout() {
    localStorage.removeItem('token');
    router.push('/login');
  }

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
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
            const active = isActive(item.href) && item.label === 'Dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href) && item.href !== '/dashboard';
            // special case: Dashboard is only active on exact /dashboard
            const isNavActive = item.label === 'Dashboard'
              ? pathname === '/dashboard'
              : item.label === 'Sessions'
              ? pathname.startsWith('/session')
              : false;

            return (
              <button
                key={item.label}
                onClick={() => router.push(item.href)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 8, fontSize: 13.5, fontWeight: 500, textAlign: 'left', width: '100%',
                  background: isNavActive ? 'var(--accent)' : 'transparent',
                  color: isNavActive ? '#fff' : 'var(--text-2)',
                  border: 'none', cursor: 'pointer',
                }}
                onMouseEnter={e => { if (!isNavActive) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (!isNavActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <span style={{ opacity: isNavActive ? 1 : 0.65, flexShrink: 0, display: 'flex' }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}

          {/* Starred Workspaces */}
          <div style={{ marginTop: 18, marginBottom: 4, padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-3)' }}>Starred Workspaces</span>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex', padding: 2 }}>{Icon.plus}</button>
          </div>
          {[
            { label: 'AI-Workspace', color: WS_COLORS[0] },
            { label: 'Web Redesign', color: WS_COLORS[1] },
            { label: 'Mobile App',   color: WS_COLORS[2] },
            { label: 'Docs Engine',  color: WS_COLORS[3] },
          ].map(ws => (
            <button
              key={ws.label}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 8, fontSize: 13, textAlign: 'left', width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <div style={{ width: 20, height: 20, borderRadius: 5, background: ws.color, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                {ws.label.charAt(0)}
              </div>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.label}</span>
            </button>
          ))}
          <button
            onClick={() => router.push('/dashboard')}
            style={{ padding: '4px 12px', fontSize: 12, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}
          >
            View all workspaces →
          </button>
        </nav>


        {/* User */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {showUserMenu && (
            <div style={{ position: 'absolute', bottom: '100%', left: 8, right: 8, marginBottom: 4, borderRadius: 10, background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow: 'hidden', zIndex: 50 }}>
              <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid var(--border)' }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{me?.username ?? '—'}</p>
                <p style={{ margin: 0, fontSize: 11, color: 'var(--text-3)' }}>{me?.email ?? ''}</p>
              </div>
              <button
                onClick={logout}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#f87171', textAlign: 'left' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
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

        {/* Topbar — hidden in editor mode */}
        {!editorMode && (
          <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 24px', height: 52, flexShrink: 0, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-1)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                {me?.username?.charAt(0).toUpperCase() ?? 'A'}
              </div>
              <span>{me?.username ? `${me.username}'s Workspace` : 'Workspace'}</span>
              <span style={{ color: 'var(--text-3)', display: 'flex' }}>{Icon.chevronDown}</span>
            </button>

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-3)', fontSize: 13 }}>
              <span style={{ display: 'flex', opacity: 0.5 }}>{Icon.search}</span>
              <span>Search projects, files, sessions...</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 6px', borderRadius: 5, background: 'var(--bg-hover)', fontFamily: 'monospace' }}>⌘K</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative' }}>
                {Icon.bell}
                <span style={{ position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', border: '1.5px solid var(--bg-surface)' }} />
              </button>
              <button style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                {Icon.help}
              </button>
              <Avatar name={me?.username ?? '?'} avatarUrl={me?.avatarUrl} size={8} />
            </div>
          </header>
        )}

        <main style={{ flex: 1, overflowY: editorMode ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
