'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import AppShell, { Avatar } from '@/components/AppShell';

interface Profile {
  id: string;
  githubId: string | null;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

const C = {
  bg: 'var(--bg-base)',
  surface: 'var(--bg-surface)',
  card: 'var(--bg-card)',
  border: 'var(--border)',
  border2: 'var(--border2)',
  hover: 'var(--bg-hover)',
  text1: 'var(--text-1)',
  text2: 'var(--text-2)',
  text3: 'var(--text-3)',
  accent: 'var(--accent)',
  accentSoft: 'var(--accent-soft)',
  green: 'var(--green)',
  red: 'var(--red)',
  yellow: 'var(--yellow)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.hover,
  color: C.text1,
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  outline: 'none',
  transition: 'border-color 0.15s',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: C.text2,
  marginBottom: 6,
  display: 'block',
  letterSpacing: '0.02em',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '20px 24px', borderRadius: 12, background: C.card, border: `1px solid ${C.border}` }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, color: C.text1, marginBottom: 16, letterSpacing: '-0.01em' }}>{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}`, ...style }}>
      <span style={{ fontSize: 13, color: C.text2 }}>{label}</span>
      <div style={{ fontSize: 13, color: C.text1 }}>{children}</div>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.auth.me()
      .then((u) => {
        setProfile(u as Profile);
        setUsername(u.username);
        setEmail(u.email ?? '');
        setAvatarUrl(u.avatarUrl ?? '');
      })
      .catch(() => router.push('/login'));
  }, [router]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      const updated = await api.auth.updateProfile({
        username: username.trim(),
        email: email.trim() || undefined,
        avatarUrl: avatarUrl.trim() || undefined,
      });
      setProfile((p) => (p ? { ...p, ...updated } : p));
      setMsg({ type: 'ok', text: 'Profile updated successfully' });
      setTimeout(() => setMsg(null), 3000);
    } catch (err) {
      setMsg({ type: 'err', text: (err as Error).message ?? 'Failed to update profile' });
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPw || !newPw) return;
    if (newPw.length < 6) {
      setPwMsg({ type: 'err', text: 'New password must be at least 6 characters' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: 'New passwords do not match' });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      await api.auth.changePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg({ type: 'ok', text: 'Password changed successfully' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setTimeout(() => setPwMsg(null), 3000);
    } catch (err) {
      setPwMsg({ type: 'err', text: (err as Error).message ?? 'Failed to change password' });
    } finally {
      setPwSaving(false);
    }
  }

  if (!profile) {
    return (
      <AppShell>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text3, fontSize: 13 }}>
          Loading…
        </div>
      </AppShell>
    );
  }

  const hasPassword = !!profile.githubId || true;

  return (
    <AppShell>
      <div style={{ flex: 1, overflowY: 'auto', maxWidth: 680, margin: '0 auto', width: '100%', padding: '0 24px 40px' }}>

        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '20px 0 4px', fontSize: 12, color: C.text3 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', fontSize: 12, padding: 0 }}>Dashboard</button>
          <span style={{ color: C.text3 }}>/</span>
          <span style={{ color: C.text1 }}>Profile</span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text1, marginBottom: 24, marginTop: 8 }}>Profile</h1>

        {/* ── Hero card ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24,
          padding: '24px 28px', borderRadius: 14,
          background: 'linear-gradient(135deg, rgba(56,182,255,0.08) 0%, var(--bg-card) 100%)',
          border: `1px solid ${C.border}`,
        }}>
          <Avatar name={profile.username} avatarUrl={avatarUrl || profile.avatarUrl} size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 18, fontWeight: 700, color: C.text1, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {profile.username}
            </p>
            <p style={{ fontSize: 13, color: C.text3, margin: '2px 0 0' }}>
              {profile.email ?? 'No email set'}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {profile.githubId && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: C.accentSoft, color: C.accent }}>
                  GitHub linked
                </span>
              )}
              {!profile.githubId && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: C.hover, color: C.text3 }}>
                  No GitHub
                </span>
              )}
              <span style={{ fontSize: 11, fontWeight: 500, padding: '3px 10px', borderRadius: 6, background: C.hover, color: C.text3 }}>
                Member since {new Date(profile.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </span>
            </div>
          </div>
        </div>

        {/* ── Edit Profile ── */}
        <Section title="Edit profile">
          <form onSubmit={saveProfile}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Username</label>
                <input
                  ref={usernameRef}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  style={inputStyle}
                  placeholder="your-username"
                  required
                  onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                  onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                />
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                  placeholder="you@example.com"
                  onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                  onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Avatar URL</label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <input
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    style={inputStyle}
                    placeholder="https://example.com/avatar.png"
                    onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                    onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                  />
                </div>
                <div style={{ flexShrink: 0, paddingTop: 2 }}>
                  <Avatar name={username || '?'} avatarUrl={avatarUrl || profile.avatarUrl} size={10} />
                </div>
              </div>
            </div>

            {msg && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 16,
                background: msg.type === 'ok' ? 'rgba(87,171,90,0.12)' : 'rgba(229,83,75,0.12)',
                color: msg.type === 'ok' ? C.green : C.red,
                border: `1px solid ${msg.type === 'ok' ? 'rgba(87,171,90,0.2)' : 'rgba(229,83,75,0.2)'}`,
              }}>
                {msg.text}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="submit"
                disabled={saving || !username.trim()}
                className="btn-primary"
                style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  cursor: saving || !username.trim() ? 'not-allowed' : 'pointer',
                  opacity: saving || !username.trim() ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              {(username !== profile.username || email !== (profile.email ?? '') || avatarUrl !== (profile.avatarUrl ?? '')) && !msg && (
                <span style={{ fontSize: 12, color: C.yellow }}>Unsaved changes</span>
              )}
            </div>
          </form>
        </Section>

        {/* ── Change Password ── */}
        <div style={{ marginTop: 16 }}>
          <Section title="Change password">
            <form onSubmit={savePassword}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Current password</label>
                  <input
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    style={inputStyle}
                    placeholder="••••••••"
                    onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                    onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>New password</label>
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    style={inputStyle}
                    placeholder="••••••••"
                    minLength={6}
                    onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                    onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Confirm new password</label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    style={inputStyle}
                    placeholder="••••••••"
                    minLength={6}
                    onFocus={(e) => { (e.target as HTMLElement).style.borderColor = C.accent; }}
                    onBlur={(e) => { (e.target as HTMLElement).style.borderColor = C.border; }}
                  />
                </div>
              </div>

              {pwMsg && (
                <div style={{
                  padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 16,
                  background: pwMsg.type === 'ok' ? 'rgba(87,171,90,0.12)' : 'rgba(229,83,75,0.12)',
                  color: pwMsg.type === 'ok' ? C.green : C.red,
                  border: `1px solid ${pwMsg.type === 'ok' ? 'rgba(87,171,90,0.2)' : 'rgba(229,83,75,0.2)'}`,
                }}>
                  {pwMsg.text}
                </div>
              )}

              <button
                type="submit"
                disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                className="btn-primary"
                style={{
                  padding: '8px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  cursor: pwSaving || !currentPw || !newPw || !confirmPw ? 'not-allowed' : 'pointer',
                  opacity: pwSaving || !currentPw || !newPw || !confirmPw ? 0.5 : 1,
                }}
              >
                {pwSaving ? 'Changing…' : 'Change password'}
              </button>
            </form>
          </Section>
        </div>

        {/* ── Account Details ── */}
        <div style={{ marginTop: 16 }}>
          <Section title="Account details">
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Row label="User ID">
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: C.text3 }}>{profile.id}</span>
              </Row>
              <Row label="Username">
                <span>{profile.username}</span>
              </Row>
              <Row label="Email">
                <span>{profile.email ?? <span style={{ color: C.text3 }}>Not set</span>}</span>
              </Row>
              <Row label="GitHub">
                {profile.githubId ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green, flexShrink: 0 }} />
                    Linked
                  </span>
                ) : (
                  <span style={{ color: C.text3 }}>Not linked</span>
                )}
              </Row>
              <Row label="Member since" style={{ borderBottom: 'none' }}>
                <span>{new Date(profile.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
              </Row>
            </div>
          </Section>
        </div>

        {/* ── Danger Zone ── */}
        <div style={{ marginTop: 16 }}>
          <div style={{
            padding: '20px 24px', borderRadius: 12,
            background: C.card, border: `1px solid rgba(229,83,75,0.25)`,
          }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 8 }}>Danger zone</h2>
            <p style={{ fontSize: 12, color: C.text3, marginBottom: 16, lineHeight: 1.5 }}>
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
            <button
              disabled
              style={{
                padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: 'rgba(229,83,75,0.1)', color: C.red,
                border: `1px solid rgba(229,83,75,0.25)`,
                cursor: 'not-allowed', opacity: 0.5,
              }}
            >
              Delete account
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
