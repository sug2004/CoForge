'use client';

import { useEffect, useRef, useState } from 'react';
import { SandboxChannel } from '@/lib/sandbox';

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

type Line = { stream: 'stdout' | 'stderr'; text: string };

interface Props {
  sessionId: string;
}

export default function SandboxPanel({ sessionId }: Props) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | 'info' } | null>(null);
  const channelRef = useRef<SandboxChannel | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const channel = new SandboxChannel(sessionId);
    channelRef.current = channel;
    const off = channel.on((e) => {
      if (e.type === 'sandbox:output') {
        setLines((prev) => [...prev, { stream: e.stream, text: e.chunk }]);
      } else if (e.type === 'sandbox:exit') {
        setRunning(false);
        setStatus(
          e.stopped
            ? { text: 'Stopped', kind: 'err' }
            : e.timeout
              ? { text: 'Killed: timeout', kind: 'err' }
              : e.exitCode === 0
                ? { text: `Exit ${e.exitCode}`, kind: 'ok' }
                : { text: `Exit ${e.exitCode}`, kind: 'err' },
        );
      } else if (e.type === 'sandbox:error') {
        setRunning(false);
        setStatus({ text: e.message, kind: 'err' });
      }
    });
    channel.connect();
    return () => {
      off();
      channel.close();
    };
  }, [sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function run(e?: React.FormEvent) {
    e?.preventDefault();
    const cmd = command.trim();
    if (!cmd || running) return;
    setHistory((prev) => [...prev, cmd]);
    setHistIdx(-1);
    setLines([]);
    setStatus(null);
    setRunning(true);
    channelRef.current?.run(cmd);
    setCommand('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setCommand(history[next]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setCommand('');
      } else {
        setHistIdx(next);
        setCommand(history[next]);
      }
    } else if (e.key === 'Enter') {
      run();
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderTop: `1px solid ${C.border}`,
        background: C.surface,
        minHeight: 180,
        maxHeight: 280,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.text2, textTransform: 'uppercase' }}>
          Terminal
        </span>
        {status && (
          <span style={{ fontSize: 11, color: status.kind === 'ok' ? C.green : status.kind === 'err' ? C.red : C.yellow }}>
            {status.text}
          </span>
        )}
        {running && <span style={{ fontSize: 11, color: C.yellow }}>running…</span>}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            setLines([]);
            setStatus(null);
          }}
          style={btnStyle}
        >
          Clear
        </button>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 12px',
          fontFamily: '"Cascadia Code", Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: C.text1,
          minHeight: 110,
          maxHeight: 210,
        }}
      >
        {lines.length === 0 && (
          <span style={{ color: C.text3 }}>
            {running ? 'running…' : 'type a command and press Enter (runs in the session sandbox)'}
          </span>
        )}
        {lines.map((l, i) => (
          <span key={i} style={{ color: l.stream === 'stderr' ? C.red : C.text1 }}>
            {l.text}
          </span>
        ))}
      </div>

      <form onSubmit={run} style={{ display: 'flex', gap: 8, padding: '8px 10px' }}>
        <span style={{ color: C.accent, fontFamily: 'monospace', fontSize: 13, lineHeight: '24px' }}>$</span>
        <input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. npm test, node index.js, ls"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: '4px 8px',
            color: C.text1,
            fontFamily: '"Cascadia Code", Consolas, monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />
        {running ? (
          <button
            type="button"
            onClick={() => {
              channelRef.current?.stop();
              setStatus({ text: 'stopping…', kind: 'info' });
            }}
            style={{ ...btnStyle, background: '#2a1410', color: C.red }}
          >
            Stop
          </button>
        ) : (
          <button type="submit" style={{ ...btnStyle, background: '#0f2415', color: C.accent }}>
            Run
          </button>
        )}
      </form>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  border: '1px solid #1e2535',
  background: '#111520',
  color: '#7a9070',
  borderRadius: 6,
  padding: '4px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
