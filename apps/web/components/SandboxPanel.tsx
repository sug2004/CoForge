'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SandboxChannel } from '@/lib/sandbox';
import {
  listPreviews,
  openPreview,
  closePreview,
  type PreviewPortInfo,
} from '@/lib/preview';
import '@xterm/xterm/css/xterm.css';

const C = {
  bg: '#0a0c10',
  surface: '#0d1017',
  border: '#1e2535',
  text1: '#e8f0e0',
  text2: '#7a9070',
  text3: '#3d5040',
  accent: '#3ef07f',
  green: '#3ef07f',
  red: '#f05a3e',
  yellow: '#f0d03e',
};

const TERM_THEME = {
  background: C.bg,
  foreground: C.text1,
  cursor: C.accent,
  cursorAccent: C.bg,
  selectionBackground: '#3ef07f33',
  black: '#0a0c10',
  red: '#f05a3e',
  green: '#3ef07f',
  yellow: '#f0d03e',
  blue: '#3eb8f0',
  magenta: '#9d7ff0',
  cyan: '#3ef0d0',
  white: '#e8f0e0',
  brightBlack: '#3d5040',
  brightRed: '#f07f7f',
  brightGreen: '#7ff0a5',
  brightYellow: '#f0e07f',
  brightBlue: '#7fd0f0',
  brightMagenta: '#c0a5f0',
  brightCyan: '#7ff0e0',
  brightWhite: '#ffffff',
};

const HEADER_H = 32;
const MIN_H = 120;
const MAX_RATIO = 0.6;
const DEFAULT_H = 200;

type Tab = 'terminal' | 'preview';

interface Props {
  sessionId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export default function SandboxPanel({ sessionId, collapsed, onToggleCollapse }: Props) {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [panelH, setPanelH] = useState(DEFAULT_H);
  const [tab, setTab] = useState<Tab>('terminal');
  const [previewPort, setPreviewPort] = useState('3000');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPorts, setPreviewPorts] = useState<PreviewPortInfo[] | null>(null);
  const [portsErr, setPortsErr] = useState<string | null>(null);
  const lastHRef = useRef(DEFAULT_H);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const channelRef = useRef<SandboxChannel | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const toggleCollapse = useCallback(() => {
    if (!collapsed) lastHRef.current = panelH;
    onToggleCollapse();
  }, [collapsed, panelH, onToggleCollapse]);

  useEffect(() => {
    if (collapsed) return;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      scrollback: 5000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        // container may be hidden
      }
    };

    const doFitAndFocus = () => {
      doFit();
      term.focus();
    };

    const raf = requestAnimationFrame(() => {
      term.open(container);

      term.onData((data) => {
        channelRef.current?.send(data);
      });
      term.onResize(({ cols, rows }) => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null;
          channelRef.current?.sendResize(cols, rows);
        }, 150);
      });

      const channel = new SandboxChannel(sessionId);
      channelRef.current = channel;

      channel.onData((data) => {
        term.write(data);
      });
      channel.onOpen(() => {
        setStatus('connected');
        doFitAndFocus();
        channel.sendResize(term.cols, term.rows);
      });
      channel.onClose(() => {
        setStatus('disconnected');
      });
      channel.connect();
    });

    const ro = new ResizeObserver(() => doFit());
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      channelRef.current?.close();
      channelRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, collapsed]);

  useEffect(() => {
    if (collapsed) return;
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const maxH = Math.max(MIN_H, Math.floor(window.innerHeight * MAX_RATIO));
      const h = Math.max(MIN_H, Math.min(maxH, startH.current - (e.clientY - startY.current)));
      setPanelH(h);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [collapsed]);

  useEffect(() => {
    return () => {
      void closePreview(sessionId);
    };
  }, [sessionId]);

  const refreshPorts = useCallback(async () => {
    setPortsErr(null);
    try {
      const ports = await listPreviews(sessionId);
      setPreviewPorts(ports);
    } catch (e) {
      setPortsErr((e as Error)?.message ?? 'failed to load port forwards');
    }
  }, [sessionId]);

  useEffect(() => {
    if (tab !== 'preview' || collapsed) return;
    void refreshPorts();
  }, [tab, collapsed, refreshPorts]);

  const handleStartPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewErr(null);
    try {
      const port = Number.parseInt(previewPort, 10);
      const url = await openPreview(sessionId, Number.isFinite(port) ? port : 3000);
      setPreviewUrl(url);
      void refreshPorts();
    } catch (e) {
      setPreviewErr((e as Error)?.message ?? 'failed to start preview');
    } finally {
      setPreviewLoading(false);
    }
  }, [sessionId, previewPort, refreshPorts]);

  const handleShow = useCallback(
    async (p: PreviewPortInfo) => {
      setPreviewErr(null);
      try {
        const url = await openPreview(sessionId, p.port);
        setPreviewUrl(url);
      } catch (e) {
        setPreviewErr((e as Error)?.message ?? 'failed to open preview');
      }
    },
    [sessionId],
  );

  const handleStopPreview = useCallback(async () => {
    await closePreview(sessionId);
    setPreviewUrl(null);
    setPreviewErr(null);
  }, [sessionId]);

  const effectiveH = collapsed ? HEADER_H : panelH;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: C.surface,
        height: effectiveH,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <div
        onMouseDown={(e) => {
          dragging.current = true;
          startY.current = e.clientY;
          startH.current = panelH;
          document.body.style.cursor = 'row-resize';
          document.body.style.userSelect = 'none';
          e.preventDefault();
        }}
        onDoubleClick={toggleCollapse}
        title="Drag to resize / double-click to collapse (Ctrl+J)"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          cursor: 'row-resize',
          zIndex: 10,
          background: 'transparent',
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = C.accent + '33';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
        }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          height: HEADER_H,
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={toggleCollapse}
          title={collapsed ? 'Expand terminal (Ctrl+J)' : 'Collapse terminal (Ctrl+J)'}
          style={{
            background: 'none',
            border: 'none',
            color: C.accent,
            fontSize: 10,
            cursor: 'pointer',
            padding: '2px 4px',
            lineHeight: 1,
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        >
          ▼
        </button>
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')}>
          Terminal
        </TabButton>
        <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>
          Preview
        </TabButton>
        <span style={{ fontSize: 11, color: status === 'connected' ? C.green : status === 'connecting' ? C.yellow : C.red }}>
          {status === 'connected' ? '●' : status === 'connecting' ? '○' : '○'}
          {status === 'connected' ? ' connected' : status === 'connecting' ? ' connecting…' : ' reconnecting…'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => channelRef.current?.stop()} title="Send Ctrl+C" style={btnStyle}>
          Ctrl+C
        </button>
        <button type="button" onClick={() => termRef.current?.clear()} style={btnStyle}>
          Clear
        </button>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <div
          ref={containerRef}
          onClick={focusTerminal}
          style={{
            position: 'absolute',
            inset: 0,
            padding: 4,
            background: C.bg,
          }}
        />
        {tab === 'preview' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              background: C.surface,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderBottom: `1px solid ${C.border}`,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 11, color: C.text2 }}>Port</span>
              <input
                value={previewPort}
                onChange={(e) => setPreviewPort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleStartPreview();
                }}
                style={{
                  width: 64,
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  color: C.text1,
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: 12,
                }}
              />
              <button
                type="button"
                onClick={() => void handleStartPreview()}
                disabled={previewLoading}
                style={previewLoading ? { ...btnStyle, opacity: 0.6 } : btnStyle}
              >
                {previewLoading ? 'Opening…' : 'Open'}
              </button>
              <button type="button" onClick={() => void refreshPorts()} style={btnStyle}>
                Refresh
              </button>
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: C.accent, wordBreak: 'break-all' }}
                >
                  {previewUrl}
                </a>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: C.text3 }}>
                run your app with `--host 0.0.0.0` if it binds to localhost
              </span>
            </div>
            {previewErr && (
              <div style={{ padding: '6px 10px', fontSize: 12, color: C.red }}>{previewErr}</div>
            )}
            {portsErr && (
              <div style={{ padding: '6px 10px', fontSize: 12, color: C.red }}>{portsErr}</div>
            )}
            <div style={{ position: 'relative', flex: 1 }}>
              {previewPorts && previewPorts.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    gap: 6,
                    padding: '6px 10px',
                    overflowX: 'auto',
                    background: C.surface,
                    borderBottom: `1px solid ${C.border}`,
                    zIndex: 2,
                  }}
                >
                  {previewPorts.map((p) => (
                    <div
                      key={p.port}
                      onClick={() => handleShow(p)}
                      title={p.url}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        border: `1px solid ${previewUrl === p.url ? C.accent : C.border}`,
                        background: previewUrl === p.url ? '#14352a' : '#111520',
                        color: C.text1,
                        borderRadius: 8,
                        fontSize: 12,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ fontWeight: 700, color: C.accent }}>{p.port}</span>
                      <span style={{ color: C.text3 }}>→</span>
                      <span>{p.url.replace('http://localhost:', 'localhost:')}</span>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: C.text2, textDecoration: 'none', fontWeight: 700 }}
                        title="Open in new tab"
                      >
                        ↗
                      </a>
                    </div>
                  ))}
                </div>
              )}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  paddingTop: previewPorts && previewPorts.length > 0 ? 40 : 0,
                }}
              >
                {previewUrl ? (
                  <iframe
                    src={previewUrl}
                    title="Sandbox preview"
                    style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                  />
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      height: '100%',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: C.text3,
                      fontSize: 13,
                      padding: 10,
                      textAlign: 'center',
                    }}
                  >
                    {previewPorts && previewPorts.length > 0
                      ? 'Select a forwarded port above to preview it'
                      : 'No port forwards — start your app, then pick its port and click Open'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        color: active ? C.accent : C.text2,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        cursor: 'pointer',
        padding: '4px 2px',
        borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
      }}
    >
      {children}
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  border: '1px solid #1e2535',
  background: '#111520',
  color: '#7a9070',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
