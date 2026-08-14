// Every outbound HTTP call from the agent pipeline needs a hard deadline. A
// stalled peer (sync-server, sandbox-runner, core-api) would otherwise leave
// the `await fetch(...)` pending forever — the pipeline never emits the
// terminal `agent:done` and the thread stays locked in `AgentService.runs`.
// The optional `signal` (cancel) is combined with a timeout so aborts still
// work while hangs can't.
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}
