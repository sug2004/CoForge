'use client';

import { useMemo, useState, type ReactNode } from 'react';

const C = {
  bg: '#0a0c10',
  surface: '#0d1017',
  border: '#1e2535',
  text1: '#e8f0e0',
  text2: '#7a9070',
  text3: '#3d5040',
  accent: '#3ef07f',
  codeBg: '#0f141b',
  codeBorder: '#1c2434',
};

// Minimal, dependency-free markdown renderer for agent chat messages — the
// planner/coder text comes from the model as plain markdown, and opencode-style
// output needs it rendered (headings, code, lists, links) rather than dumped
// as a raw string. Handles the common subset: paragraphs, headings, inline
// emphasis/code/links, fenced + indented code blocks, lists, blockquotes, hr.

function inline(content: string): ReactNode[] {
  const out: ReactNode[] = [];
  let remaining = content;
  let key = 0;

  const push = (node: ReactNode) => out.push(<span key={key++}>{node}</span>);

  // Order matters: code first so `*` inside code isn't parsed as emphasis.
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(__[^_]+__)|(_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(remaining)) !== null) {
    if (match.index > lastIndex) push(remaining.slice(lastIndex, match.index));
    if (match[1]) {
      push(<code style={{ ...codeStyle }}>{match[1].slice(1, -1)}</code>);
    } else if (match[2]) {
      push(<strong>{match[2].slice(2, -2)}</strong>);
    } else if (match[3]) {
      push(<em>{match[3].slice(1, -1)}</em>);
    } else if (match[4]) {
      const inner = match[4];
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/;
      const parts = linkRe.exec(inner);
      if (parts) {
        const label = parts[1];
        const href = parts[2];
        const isLocal =
          href.startsWith('#') ||
          href.startsWith('/') ||
          href.startsWith('file:');
        push(
          <a
            href={isLocal ? href : href}
            target={isLocal ? undefined : '_blank'}
            rel="noreferrer"
            style={{ color: C.accent, textDecoration: 'underline' }}
            onClick={(e) => {
              // Keep #-fragments / file paths from navigating away.
              if (href.startsWith('#') || href.startsWith('file:')) {
                e.preventDefault();
              }
            }}
          >
            {label}
          </a>,
        );
      } else {
        push(inner);
      }
    } else if (match[5]) {
      push(<strong>{match[5].slice(2, -2)}</strong>);
    } else if (match[6]) {
      push(<em>{match[6].slice(1, -1)}</em>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < remaining.length) push(remaining.slice(lastIndex));
  return out;
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };
  return (
    <div
      style={{
        margin: '6px 0',
        borderRadius: 8,
        border: `1px solid ${C.codeBorder}`,
        overflow: 'hidden',
        background: C.codeBg,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11.5,
        lineHeight: 1.6,
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 10px', background: C.surface, borderBottom: `1px solid ${C.codeBorder}`,
        }}
      >
        <span style={{ color: C.text3, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.08em' }}>
          {lang || 'code'}
        </span>
        <button
          onClick={copy}
          style={{
            background: 'none', border: 'none', color: copied ? C.accent : C.text2,
            cursor: 'pointer', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: '0.05em', padding: '2px 4px',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre
        style={{
          margin: 0, padding: '8px 10px', overflow: 'auto',
          color: C.text1, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  background: C.codeBg,
  border: `1px solid ${C.codeBorder}`,
  borderRadius: 4,
  padding: '1px 4px',
  fontSize: '0.92em',
  fontFamily: 'JetBrains Mono, monospace',
  color: '#c8f7d6',
};

function Paragraph({ children }: { children: ReactNode }) {
  return <p style={{ margin: '4px 0', lineHeight: 1.55 }}>{children}</p>;
}

function ListItem({ children }: { children: ReactNode }) {
  return <li style={{ margin: '2px 0' }}>{children}</li>;
}

// Parses a markdown string into React nodes. Kept intentionally small — unknown
// syntax falls through to plain text rather than erroring.
function renderMarkdown(md: string): ReactNode {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const push = (node: ReactNode) => nodes.push(<div key={key++}>{node}</div>);

  const isFence = (line: string) => /^```/.test(line.trim());
  const fenceLang = (line: string) =>
    line.trim().replace(/^```/, '').trim().split(/\s/)[0] || 'code';

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (isFence(line)) {
      const lang = fenceLang(line);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      push(<CodeBlock code={buf.join('\n')} lang={lang} />);
      continue;
    }

    // Indented code block (4+ spaces) — rare in chat, render inline code style
    if (/^ {4}/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^ {4}/.test(lines[i])) {
        buf.push(lines[i].replace(/^ {4}/, ''));
        i++;
      }
      push(<CodeBlock code={buf.join('\n')} lang="code" />);
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const size = [20, 17, 15, 13.5, 12.5, 12][level - 1];
      push(
        <div
          style={{ fontSize: size, fontWeight: 700, margin: '6px 0 3px', color: C.text1, lineHeight: 1.35 }}
        >
          {inline(heading[2])}
        </div>,
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      push(<hr style={{ border: 'none', borderTop: `1px solid ${C.border}`, margin: '8px 0' }} />);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      push(
        <blockquote
          style={{
            margin: '6px 0', padding: '2px 10px', borderLeft: `3px solid ${C.accent}44`,
            color: C.text2, fontStyle: 'italic',
          }}
        >
          {inline(buf.join(' '))}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*[-*+]\s+/, '');
        items.push(<ListItem key={key++}>{inline(text)}</ListItem>);
        i++;
      }
      push(<ul style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ul>);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*\d+[.)]\s+/, '');
        items.push(<ListItem key={key++}>{inline(text)}</ListItem>);
        i++;
      }
      push(<ol style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ol>);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: consume consecutive non-empty lines
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i].trim());
      i++;
    }
    push(<Paragraph>{inline(buf.join(' '))}</Paragraph>);
  }

  return nodes;
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div style={{ fontSize: 12.5, color: C.text1, wordBreak: 'break-word' }}>
      {html}
    </div>
  );
}

// For plain (non-markdown) user text.
export function PlainText({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 12.5, color: C.text1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
      {text}
    </div>
  );
}
