const CORE_API = process.env.NEXT_PUBLIC_CORE_API_URL ?? 'http://localhost:3002';

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}

export async function getUser(cookie?: string): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${CORE_API}/me`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
