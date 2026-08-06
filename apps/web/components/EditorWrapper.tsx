'use client';

import dynamic from 'next/dynamic';
import AppShell from '@/components/AppShell';

const Editor = dynamic(() => import('@/components/Editor'), { ssr: false });

export default function EditorWrapper({ sessionId }: { sessionId: string }) {
  return (
    <AppShell editorMode>
      <Editor sessionId={sessionId} />
    </AppShell>
  );
}
