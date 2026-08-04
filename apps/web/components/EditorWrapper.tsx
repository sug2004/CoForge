'use client';

import dynamic from 'next/dynamic';

const Editor = dynamic(() => import('@/components/Editor'), { ssr: false });

export default function EditorWrapper({ sessionId }: { sessionId: string }) {
  return <Editor sessionId={sessionId} />;
}
