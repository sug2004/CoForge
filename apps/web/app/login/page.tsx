'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CORE_API = process.env.NEXT_PUBLIC_CORE_API_URL ?? 'http://localhost:3002';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${CORE_API}/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(
          mode === 'register'
            ? { username: form.username, email: form.email, password: form.password }
            : { email: form.email, password: form.password },
        ),
      });
      if (!res.ok) { setError((await res.json()).message ?? 'Something went wrong'); return; }
      router.push('/dashboard');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
      <div className="w-full max-w-sm flex flex-col gap-6">
        {/* logo */}
        <div className="flex items-center gap-2 justify-center mb-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ background: 'var(--accent)' }}>
            {'</>'}
          </div>
          <span className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>CoForge</span>
        </div>

        <div className="rounded-xl p-8 flex flex-col gap-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-1)' }}>
              {mode === 'login' ? 'Welcome back' : 'Create account'}
            </h2>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-2)' }}>
              {mode === 'login' ? 'Sign in to your workspace' : 'Start collaborating today'}
            </p>
          </div>

          <a
            href={`${CORE_API}/auth/github`}
            className="flex items-center justify-center gap-2.5 py-2.5 rounded-lg font-medium text-sm transition-colors"
            style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Continue with GitHub
          </a>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
            <span className="text-xs" style={{ color: 'var(--text-3)' }}>or</span>
            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === 'register' && (
              <input
                className="px-3 py-2.5 rounded-lg text-sm outline-none transition-colors"
                style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
                placeholder="Username"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                required
              />
            )}
            <input
              type="email"
              className="px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
              placeholder="Email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              required
            />
            <input
              type="password"
              className="px-3 py-2.5 rounded-lg text-sm outline-none"
              style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-1)' }}
              placeholder="Password"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              required
            />
            {error && <p className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="py-2.5 rounded-lg font-medium text-sm text-white transition-opacity disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? '...' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="text-center text-sm" style={{ color: 'var(--text-3)' }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              className="font-medium"
              style={{ color: 'var(--accent-h)' }}
              onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError(''); }}
            >
              {mode === 'login' ? 'Register' : 'Sign in'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
