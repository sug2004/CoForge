const RUNNER_URL =
  process.env.NEXT_PUBLIC_SANDBOX_RUNNER_URL ?? 'http://localhost:3004';

export interface PreviewPortInfo {
  port: number;
  hostPort: number;
  url: string;
}

export async function listPreviews(
  sessionId: string,
): Promise<PreviewPortInfo[]> {
  const res = await fetch(
    `${RUNNER_URL}/sandbox/${encodeURIComponent(sessionId)}/preview`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`list previews failed: HTTP ${res.status}`);
  const body = (await res.json()) as { ports?: PreviewPortInfo[] };
  return body.ports ?? [];
}

export async function openPreview(
  sessionId: string,
  port = 3000,
): Promise<string> {
  const res = await fetch(
    `${RUNNER_URL}/sandbox/${encodeURIComponent(sessionId)}/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    },
  );
  if (!res.ok) throw new Error(`preview failed: HTTP ${res.status}`);
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error('preview returned no url');
  return body.url;
}

export async function closePreview(sessionId: string) {
  try {
    await fetch(
      `${RUNNER_URL}/sandbox/${encodeURIComponent(sessionId)}/preview`,
      { method: 'DELETE' },
    );
  } catch {
    // best effort
  }
}
