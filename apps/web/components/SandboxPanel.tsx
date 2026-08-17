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
  bg: 'var(--bg-base)',
  surface: 'var(--bg-surface)',
  border: 'var(--border)',
  text1: 'var(--text-1)',
  text2: 'var(--text-2)',
  text3: 'var(--text-3)',
  accent: 'var(--accent)',
  green: 'var(--green)',
  red: 'var(--red)',
  yellow: 'var(--yellow)',
};

function resolveVar(v: string): string {
  if (!v.startsWith('var(')) return v;
  const name = v.slice(4, -1);
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getTermTheme() {
  const g = (n: string) => resolveVar(`var(${n})`);
  return {
    background: g('--bg-base'),
    foreground: g('--text-1'),
    cursor: g('--accent'),
    cursorAccent: g('--bg-base'),
    selectionBackground: resolveVar('var(--accent)') + '33',
    black: g('--bg-base'),
    red: g('--red'),
    green: g('--green'),
    yellow: g('--yellow'),
    blue: '#5b9bd1',
    magenta: g('--purple'),
    cyan: '#4ecdc4',
    white: g('--text-1'),
    brightBlack: g('--text-3'),
    brightRed: '#e87c7f',
    brightGreen: '#a4d4ae',
    brightYellow: '#e6cc7a',
    brightBlue: '#8bb8d9',
    brightMagenta: '#c9a6e0',
    brightCyan: '#7ed4df',
    brightWhite: '#ffffff',
  };
}

const HEADER_H = 32;
const MIN_H = 120;
const MAX_RATIO = 0.6;
const DEFAULT_H = 200;

type PanelTab = 'preview';

interface TerminalTab {
  id: number;
  name: string;
  status: 'connecting' | 'connected' | 'disconnected';
  term: Terminal | null;
  fit: FitAddon | null;
  channel: SandboxChannel | null;
  containerRef: HTMLDivElement | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  ro: ResizeObserver | null;
}

interface Props {
  sessionId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

let nextTermId = 1;

export default function SandboxPanel({ sessionId, collapsed, onToggleCollapse }: Props) {
  const [panelH, setPanelH] = useState(DEFAULT_H);
  const [panelTab, setPanelTab] = useState<PanelTab | null>(null);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [previewPort, setPreviewPort] = useState('3000');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPorts, setPreviewPorts] = useState<PreviewPortInfo[] | null>(null);
  const [portsErr, setPortsErr] = useState<string | null>(null);
  const lastHRef = useRef(DEFAULT_H);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTabIdRef = useRef<number | null>(null);

  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const toggleCollapse = useCallback(() => {
    if (!collapsed) lastHRef.current = panelH;
    onToggleCollapse();
  }, [collapsed, panelH, onToggleCollapse]);

  const fitActive = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (tab?.fit) {
      try {
        tab.fit.fit();
      } catch {}
    }
  }, []);

  const focusActive = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    tab?.term?.focus();
  }, []);

  const updateTab = useCallback((id: number, patch: Partial<TerminalTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const disposeTab = useCallback((t: TerminalTab) => {
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.ro?.disconnect();
    t.channel?.close();
    t.term?.dispose();
  }, []);

  const addTab = useCallback(() => {
    const id = nextTermId++;
    const name = `Terminal ${id}`;
    setTabs((prev) => [
      ...prev,
      { id, name, status: 'connecting', term: null, fit: null, channel: null, containerRef: null, resizeTimer: null, ro: null },
    ]);
    setActiveTabId(id);
    setPanelTab(null);
  }, []);

  const removeTab = useCallback(
    (id: number) => {
      setTabs((prev) => {
        const filtered = prev.filter((t) => t.id !== id);
        if (filtered.length === 0) return prev;
        const removed = prev.find((t) => t.id === id);
        if (removed) disposeTab(removed);
        if (activeTabIdRef.current === id) {
          setActiveTabId(filtered[filtered.length - 1].id);
        }
        return filtered;
      });
    },
    [disposeTab],
  );

  const showTerminalContent = panelTab === null;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const effectiveH = collapsed ? HEADER_H : panelH;

  // Create xterm + channel for the active tab
  useEffect(() => {
    if (collapsed) return;

    const inst = tabs.find((t) => t.id === activeTabId);
    if (!inst || inst.term) return;

    const container = inst.containerRef;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      scrollback: 5000,
      theme: getTermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const doFit = () => {
      if (activeTabIdRef.current !== inst.id) return;
      try { fit.fit(); } catch {}
    };

    const raf = requestAnimationFrame(() => {
      term.open(container);

      term.onData((data) => {
        const current = tabsRef.current.find((t) => t.id === inst.id);
        current?.channel?.send(data);
      });
      term.onResize(({ cols, rows }) => {
        const current = tabsRef.current.find((t) => t.id === inst.id);
        if (current?.resizeTimer) clearTimeout(current.resizeTimer);
        const timer = setTimeout(() => {
          current?.channel?.sendResize(cols, rows);
        }, 150);
        updateTab(inst.id, { resizeTimer: timer });
      });

      const channel = new SandboxChannel(sessionId);
      channel.onData((data) => {
        term.write(data);
      });
      channel.onOpen(() => {
        updateTab(inst.id, { status: 'connected' });
        if (activeTabIdRef.current === inst.id) {
          doFit();
          term.focus();
        }
        channel.sendResize(term.cols, term.rows);
      });
      channel.onClose(() => {
        updateTab(inst.id, { status: 'disconnected' });
      });
      channel.connect();

      updateTab(inst.id, { term, fit, channel });
    });

    const ro = new ResizeObserver(() => doFit());
    ro.observe(container);
    updateTab(inst.id, { ro });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      const current = tabsRef.current.find((t) => t.id === inst.id);
      if (current) {
        if (current.resizeTimer) clearTimeout(current.resizeTimer);
        current.channel?.close();
        current.term?.dispose();
      }
      updateTab(inst.id, { term: null, fit: null, channel: null, ro: null });
    };
  }, [activeTabId, collapsed, tabs.length, sessionId, updateTab]);

  useEffect(() => {
    fitActive();
  }, [activeTabId, panelH, collapsed, fitActive]);

  useEffect(() => {
    if (collapsed || tabs.length > 0) return;
    addTab();
  }, [collapsed, tabs.length, addTab]);

  useEffect(() => {
    return () => {
      void closePreview(sessionId);
      tabsRef.current.forEach((t) => disposeTab(t));
    };
  }, [sessionId, disposeTab]);

  // Drag to resize
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
    if (panelTab !== 'preview' || collapsed) return;
    void refreshPorts();
  }, [panelTab, collapsed, refreshPorts]);

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
          (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent';
        }}
      />

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          padding: '0 6px',
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

        {tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => {
              setActiveTabId(t.id);
              setPanelTab(null);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              cursor: 'pointer',
              borderBottom:
                showTerminalContent && activeTabId === t.id
                  ? `2px solid ${C.accent}`
                  : '2px solid transparent',
              color: showTerminalContent && activeTabId === t.id ? C.accent : C.text2,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.3,
              userSelect: 'none',
              transition: 'color 0.12s',
            }}
          >
            <span
              style={{
                fontSize: 8,
                color:
                  t.status === 'connected'
                    ? C.green
                    : t.status === 'connecting'
                      ? C.yellow
                      : C.red,
              }}
            >
              ●
            </span>
            <span>{t.name}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(t.id);
                }}
                title={`Close ${t.name}`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: C.text3,
                  fontSize: 13,
                  cursor: 'pointer',
                  padding: '0 2px',
                  lineHeight: 1,
                  borderRadius: 3,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.color = C.red;
                  (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.color = C.text3;
                  (e.currentTarget as HTMLElement).style.background = 'none';
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={addTab}
          title="New terminal"
          style={{
            background: 'none',
            border: 'none',
            color: C.text2,
            fontSize: 16,
            cursor: 'pointer',
            padding: '2px 6px',
            lineHeight: 1,
            borderRadius: 4,
            marginLeft: 2,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = C.accent;
            (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = C.text2;
            (e.currentTarget as HTMLElement).style.background = 'none';
          }}
        >
          +
        </button>

        <span
          style={{
            fontSize: 11,
            color:
              activeTab?.status === 'connected'
                ? C.green
                : activeTab?.status === 'connecting'
                  ? C.yellow
                  : C.red,
            marginLeft: 4,
          }}
        >
          {activeTab?.status === 'connected'
            ? '● connected'
            : activeTab?.status === 'connecting'
              ? '○ connecting…'
              : '○ reconnecting…'}
        </span>

        <div style={{ flex: 1 }} />

        {showTerminalContent && (
          <>
            <button
              type="button"
              onClick={() => activeTab?.channel?.stop()}
              title="Send Ctrl+C"
              style={btnStyle}
            >
              Ctrl+C
            </button>
            <button
              type="button"
              onClick={() => activeTab?.term?.clear()}
              style={btnStyle}
            >
              Clear
            </button>
          </>
        )}

        <TabButton active={panelTab === 'preview'} onClick={() => setPanelTab('preview')}>
          Preview
        </TabButton>
      </div>

      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        {tabs.map((t) => (
          <div
            key={t.id}
            ref={(el) => {
              t.containerRef = el;
            }}
            onClick={focusActive}
            style={{
              position: 'absolute',
              inset: 0,
              padding: 4,
              background: C.bg,
              display: showTerminalContent && activeTabId === t.id ? 'block' : 'none',
            }}
          />
        ))}

        {panelTab === 'preview' && (
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
                        background: previewUrl === p.url ? 'var(--accent-soft)' : 'var(--bg-card)',
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
        padding: '4px 8px',
        borderBottom: active ? `2px solid ${C.accent}` : '2px solid transparent',
      }}
    >
      {children}
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  border: `1px solid var(--border)`,
  background: 'var(--bg-card)',
  color: 'var(--text-2)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
