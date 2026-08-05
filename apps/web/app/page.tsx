import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';

export default async function Home() {
  const cookieStore = await cookies();
  const user = await getUser(cookieStore.toString());
  redirect(user ? '/dashboard' : '/login');
}
