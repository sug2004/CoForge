import { cookies } from 'next/headers';
import { getUser } from '@/lib/auth';

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const user = await getUser(cookieStore.toString());

  return (
    <div className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">CoForge</h1>
          <div className="flex items-center gap-3">
            {user?.avatarUrl && (
              <img src={user.avatarUrl} alt={user.username} className="w-8 h-8 rounded-full" />
            )}
            <span className="text-gray-300">{user?.username}</span>
            <a href="http://localhost:3002/auth/logout" className="text-sm text-gray-500 hover:text-white">
              Sign out
            </a>
          </div>
        </div>
        <h2 className="text-lg font-semibold mb-4">Workspaces</h2>
        <p className="text-gray-500">No workspaces yet. Workspace CRUD coming in next step.</p>
      </div>
    </div>
  );
}
