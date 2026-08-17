'use client';

import { useEffect, useState, useCallback, useRef, useId } from 'react';
import { api, type AgentThread, type AgentMessage } from '@/lib/api';
import { io, Socket } from 'socket.io-client';
import { DiffEditor } from '@monaco-editor/react';
import { useAgentContextReporter } from '@/hooks/useAgentContextReporter';
import { Markdown, PlainText } from './Markdown';

const SYNC_SERVER_URL = process.env.NEXT_PUBLIC_SYNC_SERVER_URL ?? 'http://localhost:3001';

const C = {
  bg: 'var(--bg-base)',
  surface: 'var(--bg-surface)',
  card: 'var(--bg-card)',
  hover: 'var(--bg-hover)',
  border: 'var(--border)',
  text1: 'var(--text-1)',
  text2: 'var(--text-2)',
  text3: 'var(--text-3)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  red: 'var(--red)',
  yellow: 'var(--yellow)',
};

export interface ProposedEdit {
  fileId: string;
  diff: string;
  oldContent: string;
  newContent: string;
  toolCallId: string;
}

// Map a file path to a Monaco language id so diffs get syntax highlighting.
function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', css: 'css', scss: 'scss',
    less: 'less', html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown',
    py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php',
    swift: 'swift', kt: 'kotlin', sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml',
    sql: 'sql', vue: 'html', svg: 'xml',
  };
  return map[ext] ?? 'plaintext';
}

// Real (Monaco) side-by-side diff — replaces the old +/- hint text. Each
// instance gets stable, unique file:// model paths. Without them Monaco
// auto-assigns `inmemory://model/N` URIs, which the TypeScript worker can't
// track across model dispose/recreate (diff bubbles remount as the message
// list updates) — it then throws "Could not find source file:
// 'inmemory://model/N'" on hover.
function DiffView({
  fileId,
  original,
  modified,
  height = 220,
}: {
  fileId: string;
  original: string;
  modified: string;
  height?: number;
}) {
  const uid = useId().replace(/[^0-9A-Za-z]/g, '');
  const dot = fileId.lastIndexOf('.');
  const ext = dot >= 0 ? fileId.slice(dot + 1) : 'txt';
  const base = `file:///agent-diff/${encodeURIComponent(fileId)}/${uid}-${ext}`;
  return (
    <div style={{ height, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: C.bg }}>
      <DiffEditor
        original={original}
        modified={modified}
        originalModelPath={`${base}-orig`}
        modifiedModelPath={`${base}-mod`}
        language={langFromPath(fileId)}
        theme="vs-dark"
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          lineNumbersMinChars: 3,
          folding: false,
          wordWrap: 'on',
          contextmenu: false,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
    </div>
  );
}

// Map the raw phase ids emitted by the pipeline to friendly labels.
const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning…',
  coding: 'Coding…',
  validating: 'Validating…',
  applying: 'Applying…',
};
function phaseLabel(phase: string | null): string {
  return phase ? (PHASE_LABELS[phase] ?? phase) : 'thinking';
}

export function AgentPanel({ sessionId, userId, editorRef, ydocRef }: {
  sessionId: string;
  userId: string;
  editorRef: React.RefObject<any>;
  ydocRef: React.RefObject<any>;
}) {
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [newThreadTitle, setNewThreadTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<string | null>(null);
  const [phaseStep, setPhaseStep] = useState<number>(0);
  const [lastResponseMs, setLastResponseMs] = useState<number | null>(null);
  const [streamText, setStreamText] = useState<string>('');
  const [toolOutputs, setToolOutputs] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Array<{ description: string; files: string[] }> | null>(null);
  const [pendingApply, setPendingApply] = useState<{
    toolCallId: string;
    files: ProposedEdit[];
    applied: boolean;
  } | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const tokenRef = useRef<string>('');
  const runStartRef = useRef<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number>(0);
  const [socketStatus, setSocketStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 360;
    const saved = parseInt(localStorage.getItem('coforge.agent.panelWidth') ?? '', 10);
    return Number.isFinite(saved) ? Math.max(280, Math.min(760, saved)) : 360;
  });
  const widthRef = useRef(panelWidth);
  widthRef.current = panelWidth;
  const resizeRef = useRef({ dragging: false, startX: 0, startW: 0 });

  const handleResizeStart = (e: React.MouseEvent) => {
    resizeRef.current = { dragging: true, startX: e.clientX, startW: panelWidth };
    e.preventDefault();
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r.dragging) return;
      const next = Math.max(280, Math.min(760, r.startW + (r.startX - e.clientX)));
      setPanelWidth(next);
    };
    const onMouseUp = () => {
      if (!resizeRef.current.dragging) return;
      resizeRef.current.dragging = false;
      localStorage.setItem('coforge.agent.panelWidth', String(widthRef.current));
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useAgentContextReporter(sessionId, activeThreadId, editorRef, ydocRef);

  // Live elapsed-seconds ticker while a run is in flight (starts on send,
  // stops when agent:done clears `sending`).
  useEffect(() => {
    if (!sending) {
      runStartRef.current = null;
      setElapsedSecs(0);
      return;
    }
    runStartRef.current = runStartRef.current ?? Date.now();
    const iv = setInterval(() => {
      const start = runStartRef.current;
      if (start == null) return;
      setElapsedSecs(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(iv);
  }, [sending]);

  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.agentThreads.list(sessionId);
      if (data.length === 0) {
        // No conversations yet — start one automatically so the chat is usable
        // immediately instead of dead-ending on the empty state.
        setStarting(true);
        const thread = await api.agentThreads.create(sessionId, 'New conversation');
        setThreads([thread]);
        setActiveThreadId(thread.id);
      } else {
        setThreads(data);
        if (!activeThreadId) {
          setActiveThreadId(data[0].id);
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStarting(false);
      setLoading(false);
    }
  }, [sessionId, activeThreadId]);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  // Load messages when thread changes
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  useEffect(() => {
    if (!activeThreadId) {
      setMessages([]);
      setPlan(null);
      setCurrentPhase(null);
      setStreamText('');
      setToolOutputs({});
      return;
    }

    const thread = threadsRef.current.find(t => t.id === activeThreadId);
    if (thread) {
      setMessages(thread.messages || []);
    }
    setPlan(null);
    setCurrentPhase(null);
    setStreamText('');
    setToolOutputs({});

    // Connect to socket for real-time updates
    connectSocket(activeThreadId);
  }, [activeThreadId]);

  const registerSocketHandlers = (socket: Socket, threadId: string) => {
    socket.on('connect', () => {
      console.log('Agent socket connected');
      setSocketStatus('connected');
    });

    socket.on('connect_error', (e: Error) => {
      console.warn('Agent socket connect_error:', e.message);
      setSocketStatus('error');
      setError(`Agent connection error: ${e.message}`);
    });

    socket.on('disconnect', () => {
      setSocketStatus('connecting');
    });

    socket.on('agent:message', (data: { threadId: string; text: string }) => {
      if (data.threadId === threadId) {
        setMessages(prev => [...prev, {
          id: `temp-${Date.now()}`,
          threadId,
          role: 'assistant',
          content: { text: data.text },
          createdAt: new Date().toISOString(),
        }]);
      }
    });

    socket.on('agent:tool_started', (data: { threadId: string; toolCallId: string; toolName: string; args: any }) => {
      if (data.threadId === threadId) {
        setMessages(prev => [...prev, {
          id: `temp-${Date.now()}`,
          threadId,
          role: 'assistant',
          content: { tool_use: { id: data.toolCallId, name: data.toolName, input: data.args } },
          createdAt: new Date().toISOString(),
        }]);
      }
    });

    socket.on('agent:tool_result', (data: { threadId: string; toolCallId: string; result: any; isError: boolean }) => {
      if (data.threadId === threadId) {
        // Merge the result into the matching tool_use message (by toolCallId)
        // so the chat shows one tool card with its live output + final status,
        // like opencode — not a separate raw-JSON bubble per event.
        setMessages(prev => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const c = prev[i].content;
            if (
              c && typeof c === 'object' &&
              'tool_use' in c &&
              (c as any).tool_use.id === data.toolCallId
            ) {
              const copy = [...prev];
              copy[i] = {
                ...copy[i],
                content: {
                  ...(c as object),
                  tool_result: {
                    toolCallId: data.toolCallId,
                    result: data.result,
                    isError: data.isError,
                  },
                },
              };
              return copy;
            }
          }
          // No matching tool_use (e.g. reload mid-run) — show a standalone card.
          return [...prev, {
            id: `temp-${Date.now()}`,
            threadId,
            role: 'assistant',
            content: { tool_result: { toolCallId: data.toolCallId, result: data.result, isError: data.isError } },
            createdAt: new Date().toISOString(),
          }];
        });
      }
    });

    socket.on('agent:phase_started', (data: { threadId: string; phase: string; stepIndex?: number }) => {
      if (data.threadId === threadId) {
        setCurrentPhase(data.phase);
        setStreamText('');
        if (typeof data.stepIndex === 'number') setPhaseStep(data.stepIndex);
      }
    });

    // Live token stream from the model (planning/coding LLM calls). Coalesced
    // into ~120ms chunks server-side; appended to the phase indicator so the
    // chat shows the agent working instead of a frozen "Planning…" label.
    socket.on('agent:stream', (data: { threadId: string; chunk: string }) => {
      if (data.threadId === threadId && data.chunk) {
        setStreamText(prev => (prev + data.chunk).slice(-12_000));
      }
    });

    socket.on('agent:plan', (data: { threadId: string; steps: Array<{ description: string; files: string[] }> }) => {
      if (data.threadId === threadId) {
        setPlan(data.steps);
      }
    });

    socket.on('agent:edit_proposed', (data: { threadId: string; fileId: string; diff: string; oldContent: string; newContent: string; toolCallId: string }) => {
      if (data.threadId === threadId) {
        setMessages(prev => [...prev, {
          id: `temp-${Date.now()}`,
          threadId,
          role: 'assistant',
          content: {
            edit_proposed: {
              fileId: data.fileId,
              diff: data.diff,
              oldContent: data.oldContent,
              newContent: data.newContent,
              toolCallId: data.toolCallId,
            },
          },
          createdAt: new Date().toISOString(),
        }]);
        const edit: ProposedEdit = {
          fileId: data.fileId,
          diff: data.diff,
          oldContent: data.oldContent,
          newContent: data.newContent,
          toolCallId: data.toolCallId,
        };
        setPendingApply((prev) => {
          if (prev && prev.toolCallId === data.toolCallId) {
            return { ...prev, files: [...prev.files, edit] };
          }
          return { toolCallId: data.toolCallId, files: [edit], applied: false };
        });
      }
    });

    socket.on('agent:edit_applied', (data: { threadId: string; toolCallId: string }) => {
      if (data.threadId === threadId) {
        setPendingApply((prev) =>
          prev && prev.toolCallId === data.toolCallId ? { ...prev, applied: true } : prev
        );
      }
    });

    // Live output from the agent's terminal/tool calls. Chunks arrive while a
    // command is still running, so the chat renders a streaming terminal block
    // instead of waiting for the final result.
    socket.on('agent:tool_chunk', (data: { threadId: string; toolCallId: string; chunk: string }) => {
      if (data.threadId === threadId) {
        setToolOutputs(prev => {
          const cur = (prev[data.toolCallId] ?? '') + data.chunk;
          const capped = cur.length > 120_000 ? cur.slice(cur.length - 120_000) : cur;
          return { ...prev, [data.toolCallId]: capped };
        });
      }
    });

    // The agent-service acknowledges the invoke HTTP call immediately and
    // streams the whole run here. agent:done is the terminal signal — use it
    // to release the UI instead of waiting on the (now instant) HTTP response.
    socket.on('agent:done', (data: { threadId: string; elapsedMs?: number }) => {
      if (data.threadId === threadId) {
        setSending(false);
        setCurrentPhase(null);
        setPhaseStep(0);
        setStreamText('');
        setToolOutputs({});
        if (typeof data.elapsedMs === 'number' && data.elapsedMs > 0) {
          setLastResponseMs(data.elapsedMs);
        }
      }
    });
  };

  // Connect the agent socket, resolving once the connection is established (or
  // rejecting with a visible error instead of failing silently).
  const connectAgentSocket = (threadId: string) =>
    new Promise<Socket>((resolve, reject) => {
      setSocketStatus('connecting');
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const settle = (err?: Error, socket?: Socket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          socket?.disconnect();
          reject(err);
        } else if (socket) {
          resolve(socket);
        }
      };

      // One retry: socket.io won't emit connect_error until its own (20s)
      // timeout, which is longer than the outer deadline — so a flaky one-off
      // (e.g. a blip while sync-server restarts) would otherwise surface as a
      // needless "timed out connecting" error.
      const attempt = (tryNo: number) => {
        if (settled) return;
        timer = setTimeout(() => {
          if (settled) return;
          if (tryNo === 1) {
            socketRef.current?.disconnect();
            socketRef.current = null;
            attempt(2);
          } else {
            settle(new Error('Agent socket timed out connecting'));
          }
        }, 8000);

        // The JWT is an httpOnly cookie — it can't be read from localStorage.
        // Fetch a fresh token from the API for socket auth.
        api.auth
          .meToken()
          .then(({ accessToken }) => {
            if (settled) return;
            tokenRef.current = accessToken;
            const socket = io(`${SYNC_SERVER_URL}/agent`, {
              auth: { token: accessToken },
              query: { sessionId },
              timeout: 10000,
            });
            socketRef.current = socket;
            registerSocketHandlers(socket, threadId);
            socket.on('connect', () => settle(undefined, socket));
            socket.on('connect_error', (e: Error) =>
              settle(new Error(`Agent socket error: ${e.message}`)),
            );
            socket.on('disconnect', (reason) => {
              // Server rejected the handshake (e.g. bad token) without a
              // connect_error — surface it instead of silently timing out.
              settle(new Error(`Agent socket disconnected before connecting: ${reason}`));
            });
          })
          .catch((e: Error) =>
            settle(new Error(`Could not authenticate agent socket: ${e.message}`)),
          );
      };

      attempt(1);
    });

  const connectSocket = (threadId: string) => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    connectAgentSocket(threadId).catch((e: Error) => setError(e.message));
  };

  // Used before sending: guarantee a live socket so the agent's streamed
  // responses have somewhere to go (otherwise they'd be silently dropped).
  const ensureAgentSocket = async (threadId: string) => {
    if (socketRef.current?.connected) return;
    socketRef.current?.disconnect();
    socketRef.current = null;
    await connectAgentSocket(threadId);
  };

  const handleCreateThread = async () => {
    if (!newThreadTitle.trim()) return;
    try {
      const thread = await api.agentThreads.create(sessionId, newThreadTitle.trim());
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setNewThreadTitle('');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSwitchThread = (threadId: string) => {
    setActiveThreadId(threadId);
  };

  const handleDeleteThread = async (threadId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await api.agentThreads.delete(sessionId, threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(threadsRef.current.find((t) => t.id !== threadId)?.id ?? null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleArchiveThread = async (threadId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await api.agentThreads.archive(sessionId, threadId);
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, archivedAt: new Date().toISOString() } : t))
      );
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleTitleChange = async (threadId: string, title: string) => {
    try {
      await api.agentThreads.updateTitle(sessionId, threadId, title);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const invokePrompt = async (threadId: string, prompt: string) => {
    // Add user message optimistically
    const userMsg: AgentMessage = {
      id: `temp-${Date.now()}`,
      threadId,
      role: 'user',
      content: { text: prompt },
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    // A new run invalidates any unreviewed proposal for this thread — clear the
    // review panel so Apply can't act on superseded edits.
    setPendingApply(null);
    setExpandedDiff(null);

    try {
      // Make sure the agent socket is connected before invoking, so streamed
      // responses (agent:message / agent:phase_started / ...) aren't missed.
      await ensureAgentSocket(threadId);

      // Get current editor context
      const editorContext = getEditorContext();

      // Send context snapshot
      await api.agentThreads.addContextSnapshot(sessionId, threadId, editorContext);

      // Call agent service. The server acknowledges the job immediately and
      // streams progress + the terminal `agent:done` over the socket, so the
      // browser no longer waits for the whole pipeline and can't time out
      // mid-response. A short ack timeout is all that's needed here.
      const response = await fetch(`${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://localhost:3005'}/agent/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          sessionId,
          userId,
          threadId,
          prompt,
          focus: editorContext,
          token: tokenRef.current,
        }),
      });

      const body = await response.json().catch(() => ({}));
      // The server can return HTTP 200 with success:false (e.g. a duplicate
      // invoke while another run holds the thread). Surface it so the UI
      // releases instead of waiting forever for an agent:done that never comes.
      if (!response.ok || body?.success === false) {
        throw new Error(
          body?.error ?? `Failed to invoke agent (HTTP ${response.status})`,
        );
      }
    } catch (e: any) {
      // Remove optimistic message on error
      setMessages(prev => prev.filter(m => m.id !== userMsg.id));
      throw e;
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || !activeThreadId || sending) return;

    const prompt = inputValue.trim();
    setInputValue('');
    setSending(true);

    try {
      await invokePrompt(activeThreadId, prompt);
    } catch (e: any) {
      setSending(false);
      setError(e.message);
    }
    // On success `sending` stays true until the agent finishes and the
    // `agent:done` socket event releases the UI.
  };

  const getEditorContext = () => {
    const editor = editorRef.current;
    if (!editor) {
      return {
        focusFileId: undefined,
        cursor: undefined,
        selection: undefined,
        openFileIds: [],
      };
    }
    try {
      const model = editor.getModel?.();
      const position = editor.getPosition?.();
      const selection = editor.getSelection?.();
      const focusFileId = model?.uri?.path?.slice(1) || undefined;

      let openFileIds: string[] = [];
      try {
        const models = editor._modelData?.models ?? editor.getModels?.() ?? [];
        openFileIds = Array.from(models as any[])
          .map((m) => m.uri?.path?.slice(1) || '')
          .filter(Boolean);
      } catch {
        openFileIds = focusFileId ? [focusFileId] : [];
      }

      return {
        focusFileId,
        cursor: position ? { line: position.lineNumber, col: position.column } : undefined,
        selection: selection
          ? {
              startLine: selection.startLineNumber,
              startCol: selection.startColumn,
              endLine: selection.endLineNumber,
              endCol: selection.endColumn,
            }
          : undefined,
        openFileIds,
      };
    } catch {
      return {
        focusFileId: undefined,
        cursor: undefined,
        selection: undefined,
        openFileIds: [],
      };
    }
  };

  const handleAcceptApply = async () => {
    if (!pendingApply || pendingApply.applied) return;
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://localhost:3005'}/agent/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            threadId: activeThreadId,
            sessionId,
            userId,
            token: tokenRef.current,
          }),
        },
      );
      if (!response.ok) {
        throw new Error('Failed to apply agent changes');
      }
      setPendingApply((prev) => (prev ? { ...prev, applied: true } : prev));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleRejectApply = async () => {
    // Clear the server-side pending entry too, so a later proposal can't
    // overwrite this one or try to apply a stale plan.
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://localhost:3005'}/agent/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ threadId: activeThreadId }),
        },
      ).catch(() => {});
    } finally {
      setPendingApply(null);
      setExpandedDiff(null);
    }
  };

  // Aborts the in-flight run for this thread. The agent-service turns the abort
  // into a `cancelled` agent:done event which releases the UI.
  const handleStop = async () => {
    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://localhost:3005'}/agent/stop`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ threadId: activeThreadId }),
        },
      ).catch(() => {});
    } catch {
      // agent:done will release the UI regardless.
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          <span style={{ width: 14, height: 14, border: `2px solid ${C.border}`, borderTopColor: C.accent, borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
          {starting ? 'Starting conversation...' : 'Loading conversations...'}
        </div>
      </div>
    );
  }

  if (!activeThreadId) {
    return (
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', width: panelWidth, flex: '0 0 auto', background: C.surface, borderLeft: `1px solid ${C.border}` }}>
        {/* drag handle */}
        <div
          onMouseDown={handleResizeStart}
          style={{ position: 'absolute', top: 0, left: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 10, background: 'transparent', transition: 'background 0.15s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        />
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: C.accent, fontFamily: 'JetBrains Mono, monospace' }}>
            Agent
          </span>
          <button
            onClick={() => setNewThreadTitle('')}
            style={{
              background: 'none', border: `1px solid ${C.border}`, color: C.accent,
              padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.05em',
            }}
          >
            + New
          </button>
        </div>

        {/* Thread list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {threads.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: C.text3, gap: 12 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" style={{ opacity: 0.3 }}>
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M9 11V7a3 3 0 016 0v4" />
                <circle cx="12" cy="16" r="1" fill="currentColor" />
              </svg>
              <p style={{ fontSize: 13, margin: 0 }}>No conversations yet</p>
              <p style={{ fontSize: 11, margin: 0, textAlign: 'center', maxWidth: 200 }}>
                Start a new conversation with the agent
              </p>
            </div>
          ) : (
            <>
              {threads.map((thread) => (
                <AgentThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={false}
                  onClick={() => handleSwitchThread(thread.id)}
                  onDelete={() => handleDeleteThread(thread.id)}
                  onArchive={() => handleArchiveThread(thread.id)}
                  onTitleChange={handleTitleChange}
                />
              ))}
            </>
          )}
        </div>

        {/* New thread input */}
        <div style={{ padding: '0 8px 8px', borderTop: `1px solid ${C.border}` }}>
          <input
            value={newThreadTitle}
            onChange={(e) => setNewThreadTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateThread()}
            placeholder="Conversation title..."
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 6,
              background: C.bg, border: `1px solid ${C.border}`, color: C.text1, fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace',
            }}
            autoFocus
          />
        </div>

        {/* Error banner — shown in the empty state too so failures aren't silent */}
        {error && (
          <div style={{ padding: '8px 14px', borderTop: `1px solid rgba(209,69,74,0.27)`, background: 'rgba(209,69,74,0.08)', color: C.red, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'JetBrains Mono, monospace' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => setError(null)}
              title="Dismiss"
              style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 12, padding: 2 }}
            >
              ✕
            </button>
          </div>
        )}
      </div>
    );
  }

  // Active thread view - Chat interface
  const activeThread = threads.find(t => t.id === activeThreadId);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', width: panelWidth, flex: '0 0 auto', background: C.surface, borderLeft: `1px solid ${C.border}` }}>
      {/* drag handle */}
      <div
        onMouseDown={handleResizeStart}
        style={{ position: 'absolute', top: 0, left: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 10, background: 'transparent', transition: 'background 0.15s' }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => setActiveThreadId(null)}
            style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', padding: 4, fontSize: 14 }}
            title="Back to conversations"
          >
            ←
          </button>
          <div>
            {editingTitle ? (
              <input
                defaultValue={activeThread?.title ?? ''}
                autoFocus
                onBlur={(e) => {
                  setEditingTitle(false);
                  if (e.target.value.trim() && e.target.value.trim() !== activeThread?.title) {
                    handleTitleChange(activeThreadId!, e.target.value.trim());
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                style={{
                  background: C.bg, border: `1px solid ${C.accent}`, color: C.text1,
                  fontSize: 12, fontFamily: 'JetBrains Mono, monospace', padding: '2px 6px',
                  borderRadius: 4, outline: 'none', width: '100%',
                }}
              />
            ) : (
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text1 }}>
                {activeThread?.title ?? 'Untitled'}
              </div>
            )}
            {currentPhase && (
              <div style={{ fontSize: 10, color: C.accent, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {phaseLabel(currentPhase)}
              </div>
            )}
            {sending && (
              <div style={{ fontSize: 9, color: C.text2, fontFamily: 'JetBrains Mono, monospace' }}>
                {elapsedSecs}s
              </div>
            )}
            {lastResponseMs != null && !sending && !currentPhase && (
              <div style={{ fontSize: 9, color: C.text2, fontFamily: 'JetBrains Mono, monospace' }}>
                Last response: {(lastResponseMs / 1000).toFixed(1)}s
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
                background: socketStatus === 'connected' ? C.green : socketStatus === 'error' ? C.red : C.yellow,
                boxShadow: socketStatus === 'connected' ? `0 0 6px ${C.green}` : 'none',
              }} />
              <span style={{ fontSize: 9, color: C.text2, textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'JetBrains Mono, monospace' }}>
                {socketStatus === 'connected' ? 'Connected' : socketStatus === 'error' ? 'Disconnected' : socketStatus === 'connecting' ? 'Connecting...' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {sending && (
            <button
              onClick={handleStop}
              title="Stop running agent"
              style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
            >
              ⏹
            </button>
          )}
          <button
            onClick={() => setEditingTitle(true)}
            title="Rename"
            style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
          >
            ✏️
          </button>
          {!activeThread?.archivedAt && (
            <button
              onClick={(e) => { e.stopPropagation(); handleArchiveThread(activeThreadId!); }}
              title="Archive"
              style={{ background: 'none', border: 'none', color: C.text2, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
            >
              📦
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteThread(activeThreadId!); }}
            title="Delete"
            style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
          >
            🗑
          </button>
        </div>
      </div>

      {/* Plan view */}
      {plan && plan.length > 0 && (
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, background: C.card }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: C.accent, fontFamily: 'JetBrains Mono, monospace', marginBottom: 6 }}>
            Plan
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {plan.map((step, i) => {
              const isDone = i < phaseStep;
              const isActive = i === phaseStep;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: isDone ? C.text3 : C.text2, fontFamily: 'JetBrains Mono, monospace' }}>
                  <span style={{ color: isDone ? C.text3 : isActive ? C.yellow : C.accent, flexShrink: 0 }}>
                    {isDone ? '✓' : isActive ? '▸' : `${i + 1}.`}
                  </span>
                  <span style={{ textDecoration: isDone ? 'line-through' : 'none' }}>{step.description}</span>
                  {step.files.length > 0 && (
                    <span style={{ color: C.text3, fontSize: 10 }}>
                      ({step.files.join(', ')})
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.map((msg, idx) => {
          const toolId =
            msg.content &&
            typeof msg.content === 'object' &&
            'tool_use' in msg.content
              ? (msg.content as { tool_use: { id: string } }).tool_use.id
              : null;
          return (
            <div key={`${msg.id}-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <AgentMessageBubble message={msg} />
              {toolId && toolOutputs[toolId] != null && (
                <LiveToolOutput output={toolOutputs[toolId]} />
              )}
            </div>
          );
        })}
        {sending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '85%', width: '100%', padding: '10px 14px', borderRadius: 12, background: C.card, border: `1px solid ${C.border}`, borderBottomLeftRadius: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: '50%', background: C.accent,
                    display: 'inline-block', animation: 'typing-bounce 1.2s infinite',
                    animationDelay: `${i * 0.18}s`,
                  }} />
                ))}
                <span style={{ fontSize: 10, color: C.text2, marginLeft: 4, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'JetBrains Mono, monospace' }}>
                  {phaseLabel(currentPhase)}
                </span>
                <span style={{ fontSize: 10, color: C.accent, fontFamily: 'JetBrains Mono, monospace' }}>
                  {elapsedSecs}s
                </span>
              </div>
              {streamText.trim() && (
                <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 10.5, color: C.text3, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
                  {streamText}
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Proposed changes review */}
      {pendingApply && pendingApply.files.length > 0 && (
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.border}`, background: C.card }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, color: C.accent, fontFamily: 'JetBrains Mono, monospace', marginBottom: 6 }}>
            {pendingApply.applied ? 'Applied' : 'Changes ready to apply'} · {pendingApply.files.length} file{pendingApply.files.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {pendingApply.files.map((f) => (
              <span
                key={f.fileId}
                onClick={() => setExpandedDiff((cur) => (cur === f.fileId ? null : f.fileId))}
                title="Toggle diff"
                style={{
                  fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                  color: expandedDiff === f.fileId ? C.accent : C.text2,
                  background: expandedDiff === f.fileId ? C.bg : C.bg,
                  border: `1px solid ${expandedDiff === f.fileId ? C.accent : C.border}`,
                  borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                }}
              >
                {expandedDiff === f.fileId ? '▾ ' : '▸ '}
                {f.fileId}
              </span>
            ))}
          </div>
          {pendingApply.files.map((f) =>
            expandedDiff === f.fileId && (
              <div key={`diff-${f.fileId}`} style={{ marginBottom: 8 }}>
                <DiffView fileId={f.fileId} original={f.oldContent} modified={f.newContent} height={240} />
              </div>
            )
          )}
          {!pendingApply.applied && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleAcceptApply}
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  background: C.accent, border: 'none', color: C.bg, fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.05em',
                }}
              >
                ✓ Apply
              </button>
              <button
                onClick={handleRejectApply}
                style={{
                  flex: 1, padding: '6px 10px', borderRadius: 6,
                  background: C.bg, border: `1px solid ${C.red}`, color: C.red, fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.05em',
                }}
              >
                ✗ Reject
              </button>
            </div>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div style={{ padding: '8px 14px', borderTop: `1px solid rgba(209,69,74,0.27)`, background: 'rgba(209,69,74,0.08)', color: C.red, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'JetBrains Mono, monospace' }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setError(null)}
            title="Dismiss"
            style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 12, padding: 2 }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: 12, borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="Ask the agent... (Enter to send)"
            disabled={sending}
            rows={3}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 6,
              background: C.bg, border: `1px solid ${C.border}`, color: C.text1, fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace', resize: 'none', outline: 'none',
              minHeight: 50, maxHeight: 150,
            }}
          />
          <button
            onClick={handleSendMessage}
            disabled={sending || !inputValue.trim()}
            title="Send message"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '0 22px', borderRadius: 8,
              background: '#1e3a5f', color: '#e8edf3', fontSize: 14, fontWeight: 700,
              cursor: sending || !inputValue.trim() ? 'not-allowed' : 'pointer',
              opacity: sending || !inputValue.trim() ? 0.6 : 1,
              alignSelf: 'stretch', minHeight: 50,
              fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.08em',
              boxShadow: sending ? 'none' : '0 0 12px var(--accent-soft)',
            }}
          >
            {sending && (
              <span style={{ width: 14, height: 14, border: '2px solid rgba(232,237,243,0.3)', borderTopColor: '#e8edf3', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            )}
            {sending ? 'Working' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live terminal output for an in-flight agent tool call. Auto-scrolls as
// `agent:tool_chunk` events stream in; the block sits under the tool_use bubble
// so you watch the agent work instead of waiting for the final result.
function LiveToolOutput({ output }: { output: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{ maxWidth: '85%', width: '100%' }}>
        <div style={{ fontSize: 10, color: C.yellow, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', marginBottom: 4 }}>
          ● terminal output
        </div>
        <div
          ref={ref}
          style={{
            maxHeight: 180,
            overflowY: 'auto',
            padding: '8px 10px',
            borderRadius: 6,
            background: C.bg,
            border: `1px solid ${C.border}`,
            fontSize: 11,
            lineHeight: 1.5,
            color: C.text1,
            fontFamily: 'JetBrains Mono, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {output || '…'}
        </div>
      </div>
    </div>
  );
}

function ToolArgsSummary({ name, args }: { name: string; args: any }) {
  if (!args || typeof args !== 'object') return null;
  const style: React.CSSProperties = {
    fontSize: 11, color: C.text2, fontFamily: 'JetBrains Mono, monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
  };
  switch (name) {
    case 'run_terminal':
      return <div style={style}><span style={{ color: C.yellow }}>$</span> {String(args.command ?? '')}</div>;
    case 'read_file':
    case 'write_file':
    case 'delete_file':
      return <div style={style}><span style={{ color: C.accent }}>FILE</span> {String(args.path ?? '')}</div>;
    case 'list_files':
      return <div style={style}><span style={{ color: C.accent }}>DIR</span> {String(args.path ?? '.')}{args.recursive ? ' (recursive)' : ''}</div>;
    case 'glob':
      return <div style={style}><span style={{ color: C.accent }}>GLOB</span> {String(args.pattern ?? '')}</div>;
    case 'grep':
      return <div style={style}><span style={{ color: C.accent }}>GREP</span> {String(args.pattern ?? '')} {args.path ? `in ${args.path}` : ''}</div>;
    case 'run_tests':
      return <div style={style}><span style={{ color: C.accent }}>TEST</span> {String(args.command ?? '')}</div>;
    default:
      return <pre style={{ margin: 0, fontSize: 10.5, color: C.text2, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>{JSON.stringify(args, null, 2)}</pre>;
  }
}

function ToolCard({ tool, result }: { tool: { name: string; input?: any }; result?: any }) {
  const [open, setOpen] = useState(true);
  const name = tool.name;
  const err = result?.isError;
  const resultData = result?.result;
  const statusLine =
    resultData === undefined
      ? null
      : resultData && typeof resultData === 'object' && 'passed' in resultData
        ? (resultData.passed ? 'passed' : 'failed')
        : err
          ? 'failed'
          : 'ok';

  return (
    <div style={{ maxWidth: '100%', borderRadius: 8, border: `1px solid ${C.border}`, background: C.bg, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', background: C.surface }}
      >
        <span style={{ fontSize: 10, color: err ? C.red : C.green, fontFamily: 'JetBrains Mono, monospace' }}>
          {statusLine ? (statusLine === 'passed' || statusLine === 'ok' ? '✓' : '✗') : '▸'}
        </span>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.text2, fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
          {name}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.text3 }}>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <div style={{ padding: '6px 10px' }}>
          <ToolArgsSummary name={name} args={tool.input} />
        </div>
      )}
    </div>
  );
}

function AgentMessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === 'user';
  const content = message.content;

  if (isUser) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          maxWidth: '85%', padding: '10px 12px', borderRadius: 12,
          background: C.accent, color: C.bg, fontSize: 13, lineHeight: 1.5,
          borderBottomRightRadius: 4,
        }}>
          {typeof content === 'string' ? <PlainText text={content} /> : <PlainText text={content?.text ?? JSON.stringify(content)} />}
        </div>
      </div>
    );
  }

  // Assistant message - could be text, tool_use (+merged tool_result), tool_result, or edit_proposed
  if (typeof content === 'object' && content !== null) {
    if ('tool_use' in content) {
      const tool = content.tool_use;
      const result = (content as any).tool_result;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '100%' }}>
          <ToolCard tool={tool} result={result} />
        </div>
      );
    }

    if ('tool_result' in content) {
      const result = content.tool_result;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '85%' }}>
          <div style={{ fontSize: 10, color: result.isError ? C.red : C.green, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase' }}>
            {result.isError ? '✗' : '✓'} Result
          </div>
          <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 6, background: C.bg, border: `1px solid ${result.isError ? C.red : C.border}`, fontSize: 11, color: result.isError ? C.red : C.text1, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap' }}>
            {typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)}
          </pre>
        </div>
      );
    }

    if ('edit_proposed' in content) {
      const edit = content.edit_proposed;
      const hasFull =
        typeof edit.oldContent === 'string' && typeof edit.newContent === 'string';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '85%' }}>
          <div style={{ fontSize: 10, color: C.accent, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase' }}>
            Proposed Edit: {edit.fileId}
          </div>
          {hasFull ? (
            <DiffView
              fileId={edit.fileId}
              original={edit.oldContent}
              modified={edit.newContent}
              height={200}
            />
          ) : (
            <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 6, background: C.bg, border: `1px solid ${C.accent}`, fontSize: 11, color: C.accent, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace' }}>
              {edit.diff}
            </pre>
          )}
        </div>
      );
    }

    if ('text' in content) {
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
          <div style={{
            maxWidth: '85%', padding: '10px 12px', borderRadius: 12,
            background: C.card, color: C.text1, fontSize: 13, lineHeight: 1.5,
            borderBottomLeftRadius: 4, border: `1px solid ${C.border}`,
          }}>
            <Markdown text={String(content.text)} />
          </div>
        </div>
      );
    }

    // Persisted validator message (role 'validator') — a pass/fail card.
    if ('passed' in content && 'output' in content) {
      const v = content as any;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '85%' }}>
          <div style={{ fontSize: 10, color: v.passed ? C.green : C.red, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase' }}>
            {v.passed ? '✓' : '✗'} Validation {v.passed ? 'passed' : 'failed'}{v.command ? ` — ${v.command}` : ''}
          </div>
          {typeof v.output === 'string' && v.output.trim() && (
            <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 6, background: C.bg, border: `1px solid ${v.passed ? C.border : C.red}`, fontSize: 11, color: v.passed ? C.text1 : C.red, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap' }}>
              {v.output.length > 4000 ? `${v.output.slice(0, 4000)}\n… (truncated)` : v.output}
            </pre>
          )}
        </div>
      );
    }

    // Persisted planner message (role 'planner') — summary + step list.
    if ('plan' in content) {
      const p = content as any;
      const steps = Array.isArray(p.plan?.steps) ? p.plan.steps : [];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '85%' }}>
          {typeof p.text === 'string' && p.text && (
            <div style={{ padding: '10px 12px', borderRadius: 12, background: C.card, border: `1px solid ${C.border}`, fontSize: 13, lineHeight: 1.5, color: C.text1, borderBottomLeftRadius: 4 }}>
              <Markdown text={p.text} />
            </div>
          )}
          {steps.length > 0 && (
            <div style={{ padding: '8px 12px', borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: C.text2 }}>
              <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.1em', color: C.accent, marginBottom: 4 }}>Plan</div>
              {steps.map((s: any, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
                  <span style={{ color: C.accent, flexShrink: 0 }}>{i + 1}.</span>
                  <span>{s.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div style={{
        maxWidth: '85%', padding: '10px 12px', borderRadius: 12,
        background: C.card, color: C.text1, fontSize: 13, lineHeight: 1.5,
        borderBottomLeftRadius: 4, border: `1px solid ${C.border}`,
      }}>
        {typeof content === 'string' ? <Markdown text={content} /> : <PlainText text={JSON.stringify(content)} />}
      </div>
    </div>
  );
}

function AgentThreadItem({
  thread,
  isActive,
  onClick,
  onDelete,
  onArchive,
  onTitleChange,
}: {
  thread: AgentThread;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onTitleChange: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title ?? '');
  const [hovered, setHovered] = useState(false);

  const handleTitleSubmit = () => {
    if (editTitle.trim() && editTitle !== thread.title) {
      onTitleChange(thread.id, editTitle.trim());
    }
    setEditing(false);
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
        background: isActive ? C.accent : hovered ? C.card : 'transparent',
        border: isActive ? `1px solid ${C.accent}` : '1px solid transparent',
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleTitleSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTitleSubmit();
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{
              width: '100%', padding: '2px 6px', borderRadius: 4,
              background: C.bg, border: `1px solid ${C.accent}`, color: C.text1, fontSize: 12,
              fontFamily: 'JetBrains Mono, monospace', outline: 'none',
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontSize: 12, fontWeight: 500, color: isActive ? C.bg : C.text1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            >
              {thread.title ?? 'Untitled'}
            </span>
            {thread.archivedAt && (
              <span style={{ fontSize: 9, color: isActive ? 'rgba(0,0,0,0.6)' : C.text3, textTransform: 'uppercase' }}>
                Archived
              </span>
            )}
          </div>
        )}
        <div style={{ fontSize: 10, color: isActive ? 'rgba(0,0,0,0.5)' : C.text3, fontFamily: 'JetBrains Mono, monospace' }}>
          {thread.messages?.length ?? 0} messages
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, opacity: hovered || isActive ? 1 : 0, transition: 'opacity 0.15s' }}>
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          title="Rename"
          style={{ background: 'none', border: 'none', color: isActive ? C.bg : C.text2, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
        >
          ✏️
        </button>
        {!thread.archivedAt && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            title="Archive"
            style={{ background: 'none', border: 'none', color: isActive ? C.bg : C.text2, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
          >
            📦
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
          style={{ background: 'none', border: 'none', color: isActive ? C.bg : C.red, cursor: 'pointer', padding: 4, fontSize: 12, borderRadius: 4 }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}