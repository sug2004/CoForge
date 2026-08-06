'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { createYSession } from '@/lib/ydoc';
import { api } from '@/lib/api';
import type { editor as MonacoEditorType } from 'monaco-editor';
import * as Y from 'yjs';

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (
      r?.type === 'cancelation' ||
      r?.name === 'Canceled' ||
      r?.message === 'Canceled' ||
      r?.msg === 'operation is manually canceled'
    ) e.preventDefault();
  });
}

const T = {
  bg:      '#0a0c10',
  surface: '#0d1017',
  card:    '#111520',
  hover:   '#161b28',
  border:  '#1e2535',
  text1:   '#e8f0e0',
  text2:   '#7a9070',
  text3:   '#3d5040',
  accent:  '#3ef07f',
  green:   '#3ef07f',
  red:     '#f05a3e',
};

const PEER_COLORS = [
  '#3ef07f', '#f0d03e', '#f05a3e', '#3eb8f0', '#9d7ff0',
  '#f07f3e', '#3ef0d0', '#f03eb8',
];

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', cpp: 'cpp', c: 'c',
  cs: 'csharp', html: 'html', css: 'css', json: 'json', md: 'markdown',
  sql: 'sql', sh: 'shell', yaml: 'yaml', yml: 'yaml', toml: 'plaintext',
};

type Peer = { clientId: number; name: string; color: string; avatarUrl?: string | null; online: boolean };
type DbParticipant = { user: { id: string; username: string; avatarUrl: string | null } };

function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop() ?? '';
  return EXT_LANG[ext] ?? 'plaintext';
}

function bindYTextToMonaco(yText: Y.Text, ydoc: Y.Doc, editor: MonacoEditorType.IStandaloneCodeEditor): () => void {
  const model = editor.getModel();
  if (!model) return () => {};
  let ignoreModelChange = false;

  model.setValue(yText.toString());

  const yObserver = (event: Y.YTextEvent, tx: Y.Transaction) => {
    if (tx.local) return;
    ignoreModelChange = true;
    let index = 0;
    event.delta.forEach((op) => {
      if (op.retain) { index += op.retain; }
      else if (op.insert) {
        const pos = model.getPositionAt(index);
        model.applyEdits([{ range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column }, text: op.insert as string }]);
        index += (op.insert as string).length;
      } else if (op.delete) {
        const start = model.getPositionAt(index);
        const end = model.getPositionAt(index + op.delete);
        model.applyEdits([{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: '' }]);
      }
    });
    ignoreModelChange = false;
  };

  const modelListener = model.onDidChangeContent((e) => {
    if (ignoreModelChange) return;
    ydoc.transact(() => {
      e.changes.sort((a, b) => b.rangeOffset - a.rangeOffset).forEach((change) => {
        if (change.rangeLength > 0) yText.delete(change.rangeOffset, change.rangeLength);
        if (change.text) yText.insert(change.rangeOffset, change.text);
      });
    });
  });

  yText.observe(yObserver);
  return () => { yText.unobserve(yObserver); modelListener.dispose(); };
}

function Avatar({ name, color, avatarUrl, size = 7 }: {
  name: string; color: string; avatarUrl?: string | null; size?: number;
}) {
  const px = size * 4;
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} style={{ width: px, height: px, borderRadius: '50%', border: `2px solid ${T.surface}`, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: px, height: px, borderRadius: '50%', background: color, border: `2px solid ${T.surface}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: px * 0.38, textTransform: 'uppercase', flexShrink: 0, userSelect: 'none' }}>
      {name.charAt(0)}
    </div>
  );
}

// ── file-icon helpers ────────────────────────────────────────────────────────
const FILE_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', json: '📋',
  py: '🐍', rs: '🦀', go: '🐹', java: '☕', cpp: '⚙️', c: '⚙️',
  cs: '🔵', html: '🌐', css: '🎨', md: '📝', sql: '🗄️',
  sh: '💲', yaml: '📄', yml: '📄', toml: '📄', env: '🔒',
};
function fileIcon(name: string) {
  const ext = name.split('.').pop() ?? '';
  return FILE_ICONS[ext] ?? '📄';
}

// ── tree builder (supports arbitrary nesting) ─────────────────────────────────
type TreeNode =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'dir';  name: string; children: TreeNode[] };

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const p of [...paths].sort()) {
    const parts = p.split('/');
    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        nodes.push({ kind: 'file', path: p, name: part });
      } else {
        let dir = nodes.find(n => n.kind === 'dir' && n.name === part) as Extract<TreeNode, { kind: 'dir' }> | undefined;
        if (!dir) { dir = { kind: 'dir', name: part, children: [] }; nodes.push(dir); }
        nodes = dir.children;
      }
    }
  }
  return root;
}

function TreeNodes({ nodes, active, onSelect, onRename, onDelete, depth }: {
  nodes: TreeNode[]; active: string; onSelect: (p: string) => void;
  onRename: (p: string) => void; onDelete: (p: string) => void; depth: number;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const indent = depth * 12;
  return (
    <>
      {nodes.map(node =>
        node.kind === 'file' ? (
          <div
            key={node.path}
            style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
            onMouseEnter={() => setHovered(node.path)}
            onMouseLeave={() => setHovered(null)}
          >
            <button
              onClick={() => onSelect(node.path)}
              title={node.path}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, flex: 1,
                textAlign: 'left',
                paddingLeft: 8 + indent, paddingRight: hovered === node.path ? 52 : 8,
                paddingTop: 2, paddingBottom: 2,
                fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
                background: active === node.path ? T.hover : hovered === node.path ? T.card : 'transparent',
                color: active === node.path ? T.accent : T.text2,
                borderTop: 'none', borderRight: 'none', borderBottom: 'none',
                borderLeft: active === node.path ? `2px solid ${T.accent}` : '2px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              <span style={{ fontSize: 11, flexShrink: 0 }}>{fileIcon(node.name)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
            </button>
            {hovered === node.path && (
              <div style={{ position: 'absolute', right: 4, display: 'flex', gap: 2 }}>
                <button
                  onClick={e => { e.stopPropagation(); onRename(node.path); }}
                  title="Rename"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', borderRadius: 4, color: T.text2, fontSize: 11, lineHeight: 1 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = T.hover; (e.currentTarget as HTMLElement).style.color = T.accent; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; (e.currentTarget as HTMLElement).style.color = T.text2; }}
                >✏️</button>
                <button
                  onClick={e => { e.stopPropagation(); onDelete(node.path); }}
                  title="Delete"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', borderRadius: 4, color: T.text2, fontSize: 11, lineHeight: 1 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2a1010'; (e.currentTarget as HTMLElement).style.color = T.red; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; (e.currentTarget as HTMLElement).style.color = T.text2; }}
                >🗑</button>
              </div>
            )}
          </div>
        ) : (
          <div key={node.name}>
            <button
              onClick={() => setCollapsed(s => { const n = new Set(s); n.has(node.name) ? n.delete(node.name) : n.add(node.name); return n; })}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                width: '100%', textAlign: 'left',
                paddingLeft: 8 + indent, paddingRight: 8,
                paddingTop: 3, paddingBottom: 3,
                fontSize: 11, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600,
                color: T.accent, background: 'transparent', border: 'none', cursor: 'pointer',
                userSelect: 'none', letterSpacing: '0.03em',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = T.hover; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 9, display: 'inline-block', width: 10, textAlign: 'center', flexShrink: 0 }}>
                {collapsed.has(node.name) ? '▶' : '▼'}
              </span>
              <span style={{ fontSize: 13, flexShrink: 0 }}>{collapsed.has(node.name) ? '📁' : '📂'}</span>
              <span style={{ letterSpacing: '0.02em' }}>{node.name}</span>
            </button>
            {!collapsed.has(node.name) && (
              <TreeNodes nodes={node.children} active={active} onSelect={onSelect} onRename={onRename} onDelete={onDelete} depth={depth + 1} />
            )}
          </div>
        )
      )}
    </>
  );
}

function FileTree({ paths, active, onSelect, onNewFile, onRename, onDelete }: {
  paths: string[]; active: string; onSelect: (p: string) => void;
  onNewFile: () => void; onRename: (p: string) => void; onDelete: (p: string) => void;
}) {
  const tree = buildTree(paths);
  const [width, setWidth] = useState(210);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const next = Math.max(140, Math.min(500, startW.current + e.clientX - startX.current));
      setWidth(next);
    }
    function onMouseUp() { dragging.current = false; }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width, flexShrink: 0, background: T.surface, borderRight: `1px solid ${T.border}`, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, color: T.accent, fontFamily: 'JetBrains Mono, monospace' }}>Explorer</span>
        <button onClick={onNewFile} title="New file" style={{ color: T.accent, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>+</button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, paddingTop: 4, paddingBottom: 4 }}>
        <TreeNodes nodes={tree} active={active} onSelect={onSelect} onRename={onRename} onDelete={onDelete} depth={0} />
      </div>
      {/* drag handle */}
      <div
        onMouseDown={onMouseDown}
        style={{ position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 10,
          background: 'transparent', transition: 'background 0.15s' }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = T.accent + '44'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      />
    </div>
  );
}

function Navbar({ sessionId, activeFile, cloning, onClone, peers, dbParticipants, allOnlineNames }: {
  sessionId: string; activeFile: string; cloning: boolean; onClone: () => void;
  peers: Peer[]; dbParticipants: DbParticipant[]; allOnlineNames: Set<string>;
}) {
  const [copied, setCopied] = useState(false);
  const [showList, setShowList] = useState(false);

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/session/${sessionId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // dbParticipants is already deduped upstream
  const listItems = dbParticipants.map(({ user }) => ({
    id: user.id,
    name: user.username,
    avatarUrl: user.avatarUrl,
    online: allOnlineNames.has(user.username),
    color: PEER_COLORS[user.id.charCodeAt(0) % PEER_COLORS.length],
  }));

  // participantCount = DB list (who ever joined)
  // totalOnline = awareness (who is connected right now, updates instantly)
  const participantCount = dbParticipants.length;
  const totalOnline = allOnlineNames.size;

  return (
    <div className="flex items-center gap-3 px-4 shrink-0 h-11 relative" style={{ background: T.surface, borderBottom: `1px solid ${T.border}` }}>
      {/* left — session id */}
      <span className="text-xs font-mono truncate max-w-[180px]" style={{ color: T.accent, opacity: 0.5 }} title={sessionId}>
        <span style={{ color: T.text3 }}>~/</span>{sessionId.slice(0, 16)}
      </span>

      {/* center */}
      <span className="text-xs font-mono flex-1 text-center truncate" style={{ color: T.accent }}>
        {activeFile && <span style={{ color: T.text3 }}>▸ </span>}{activeFile}
      </span>

      {/* avatars — always show if we have a list, clicking opens dropdown */}
      {(dbParticipants.length > 0 || allOnlineNames.size > 0) && (
        <button
          onClick={() => setShowList(s => !s)}
          className="flex items-center gap-1.5 focus:outline-none"
          title="Collaborators"
        >
          <div className="flex items-center">
            {peers.slice(0, 4).map((p, i) => (
              <div key={p.clientId} style={{ marginLeft: i === 0 ? 0 : -6, zIndex: 10 - i, position: 'relative' }}>
                <Avatar name={p.name} color={p.color} avatarUrl={p.avatarUrl} size={7} />
              </div>
            ))}
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold" style={{ background: T.accent + '22', color: T.accent, border: `1px solid ${T.accent}44` }}>
            {totalOnline} online
          </span>
        </button>
      )}

      {/* dropdown */}
      {showList && (
        <div className="absolute right-36 top-12 z-50 rounded-lg shadow-2xl w-60 py-2" style={{ background: T.card, border: `1px solid ${T.accent}44` }}>
          <div className="flex items-center justify-between px-3 pb-2 pt-1">
            <p className="text-[10px] uppercase tracking-widest font-semibold font-mono" style={{ color: T.accent }}>
              Collaborators · {participantCount}
            </p>
            <button onClick={() => setShowList(false)} style={{ color: T.text3, fontSize: 14, lineHeight: 1 }}>✕</button>
          </div>
          {listItems.map(item => (
            <div key={item.id} className="flex items-center gap-2.5 px-3 py-2" style={{ borderTop: `1px solid ${T.border}` }}>
              <div className="relative shrink-0">
                <Avatar name={item.name} color={item.color} avatarUrl={item.avatarUrl} size={7} />
                <span
                  className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full"
                  style={{ background: item.online ? T.green : T.text3, border: `2px solid ${T.card}` }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: T.text1 }}>{item.name}</p>
                <p className="text-[11px]" style={{ color: item.online ? T.green : T.text3 }}>
                  {item.online ? '● Online' : '○ Offline'}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* right actions */}
      <button
        onClick={onClone}
        disabled={cloning}
        className="text-xs px-2.5 py-1 rounded font-mono disabled:opacity-50"
        style={{ background: T.card, border: `1px solid ${T.border}`, color: T.text2 }}
      >
        {cloning ? 'Cloning…' : '⬇ Load Git'}
      </button>

      <button
        onClick={copyLink}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono font-semibold"
        style={{ background: 'transparent', border: `1px solid ${T.accent}`, color: T.accent }}
      >
        {copied ? '✓ Copied!' : '🔗 Invite'}
      </button>
    </div>
  );
}

function dedupeParticipants(list: DbParticipant[]): DbParticipant[] {
  const seen = new Set<string>();
  return list.filter(p => {
    if (seen.has(p.user.id)) return false;
    seen.add(p.user.id);
    return true;
  });
}

export default function Editor({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string>('');
  const [language, setLanguage] = useState('plaintext');
  const [cloning, setCloning] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [dbParticipants, setDbParticipants] = useState<DbParticipant[]>([]);
  const [allOnlineNames, setAllOnlineNames] = useState<Set<string>>(new Set());
  const awarenessRef = useRef<any>(null);
  const pendingParticipantsRef = useRef<DbParticipant[]>([]);
  const allOnlineNamesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    api.sessions.join(sessionId)
      .then(session => {
        const participants = dedupeParticipants(session.participants ?? []);
        setDbParticipants(participants);
        pendingParticipantsRef.current = participants;
        awarenessRef.current?.setLocalStateField('participants', participants);
      })
      .catch(() => {});
    // reset peers on session change so stale awareness from previous session is cleared
    setPeers([]);
    setAllOnlineNames(new Set());
    allOnlineNamesRef.current = new Set();
  }, [sessionId]);

  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const textCleanupRef = useRef<(() => void) | null>(null);

  const switchToFile = useCallback((filePath: string) => {
    const ydoc = ydocRef.current;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!ydoc || !editor || !monaco) return;

    const filesMap = ydoc.getMap<Y.Text>('files');
    if (!filesMap.has(filePath)) ydoc.transact(() => filesMap.set(filePath, new Y.Text()));

    const lang = langFromPath(filePath);
    const uri = monaco.Uri.parse(`file:///${filePath}`);
    let model = monaco.editor.getModel(uri);
    if (!model) model = monaco.editor.createModel('', lang, uri);
    else monaco.editor.setModelLanguage(model, lang);

    try { editor.setModel(model); } catch { /* Monaco Canceled — benign */ }
    setActiveFile(filePath);
    setLanguage(lang);

    textCleanupRef.current?.();
    textCleanupRef.current = bindYTextToMonaco(filesMap.get(filePath)!, ydoc, editor);
  }, []);

  function handleEditorMount(editor: MonacoEditorType.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const m = monaco as any;
    const compilerOptions = {
      target: m.languages.typescript.ScriptTarget.ESNext,
      module: m.languages.typescript.ModuleKind.ESNext,
      moduleResolution: m.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: m.languages.typescript.JsxEmit.ReactJSX,
      strict: false, allowJs: true, allowSyntheticDefaultImports: true,
      esModuleInterop: true, baseUrl: 'file:///',
    };
    m.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
    m.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
    m.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    m.languages.typescript.javascriptDefaults.setEagerModelSync(true);

    const { ydoc, provider, awareness } = createYSession(sessionId);
    ydocRef.current = ydoc;
    awarenessRef.current = awareness;

    // set local user identity, then trigger awareness update
    const myUsernameRef = { current: '' };

    function handleAwarenessChange() {
      const states = Array.from(awareness.getStates().entries());
      const myName = myUsernameRef.current;

      const names = new Set(
        states.filter(([, s]) => s.user).map(([, s]) => s.user.name as string)
      );
      allOnlineNamesRef.current = names;
      setAllOnlineNames(new Set(names));

      const seenNames = new Set<string>();
      const onlinePeers = states
        .filter(([id, s]) => {
          if (id === awareness.clientID) return false;
          if (!s.user) return false;
          if (myName && s.user.name === myName) return false;
          if (seenNames.has(s.user.name)) return false;
          seenNames.add(s.user.name);
          return true;
        })
        .map(([id, s]) => ({
          clientId: id,
          name: s.user.name as string,
          color: s.user.color as string,
          avatarUrl: s.user.avatarUrl as string | null,
          online: true,
        }));
      setPeers(onlinePeers);

      const knownNames = new Set(pendingParticipantsRef.current.map(p => p.user.username));
      const hasNew = onlinePeers.some(p => !knownNames.has(p.name));
      if (hasNew) {
        api.sessions.get(sessionId)
          .then(session => {
            const fresh = dedupeParticipants(session.participants ?? []);
            pendingParticipantsRef.current = fresh;
            setDbParticipants(fresh);
          })
          .catch(() => {});
      }
    }

    // register handler immediately so no events are missed
    awareness.on('change', handleAwarenessChange);

    api.auth.me()
      .catch(() => ({ id: `anon-${Date.now()}`, username: `User${Math.floor(Math.random() * 900 + 100)}`, avatarUrl: null }))
      .then(me => {
        myUsernameRef.current = me.username;
        const color = PEER_COLORS[me.id.charCodeAt(0) % PEER_COLORS.length];
        awareness.setLocalStateField('user', { name: me.username, color, avatarUrl: me.avatarUrl });
        if (pendingParticipantsRef.current.length > 0) {
          awareness.setLocalStateField('participants', pendingParticipantsRef.current);
        }
        // re-run handler now that identity is known — fixes self showing as offline
        handleAwarenessChange();
      });

    const filesMap = ydoc.getMap<Y.Text>('files');
    filesMap.observe(() => setFiles(Array.from(filesMap.keys()).sort()));

    const setup = () => {
      const keys = Array.from(filesMap.keys()).sort();
      if (keys.length === 0) {
        ydoc.transact(() => filesMap.set('main.ts', new Y.Text()));
      } else {
        setFiles(keys);
        keys.forEach(k => {
          const uri = monaco.Uri.parse(`file:///${k}`);
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(filesMap.get(k)!.toString(), langFromPath(k), uri);
          }
        });
        switchToFile(keys[0]);
      }
    };

    provider.synced ? setup() : provider.once('sync', setup);
  }

  useEffect(() => {
    if (activeFile) switchToFile(activeFile);
  }, [activeFile]);

  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const filesMap = ydoc.getMap<Y.Text>('files');
    const observer = () => {
      const keys = Array.from(filesMap.keys()).sort();
      setFiles(keys);
      if (!activeFile && keys.length > 0) switchToFile(keys[0]);
    };
    filesMap.observe(observer);
    return () => filesMap.unobserve(observer);
  }, [ydocRef.current]);

  function handleNewFile() {
    const name = prompt('File name (e.g. src/utils.ts)');
    if (!name?.trim()) return;
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const filesMap = ydoc.getMap<Y.Text>('files');
    if (!filesMap.has(name)) ydoc.transact(() => filesMap.set(name, new Y.Text()));
    switchToFile(name);
  }

  function handleRename(oldPath: string) {
    const newPath = prompt('Rename to:', oldPath);
    if (!newPath?.trim() || newPath === oldPath) return;
    const ydoc = ydocRef.current;
    const monaco = monacoRef.current;
    if (!ydoc || !monaco) return;
    const filesMap = ydoc.getMap<Y.Text>('files');
    const existing = filesMap.get(oldPath);
    if (!existing) return;
    ydoc.transact(() => {
      const copy = new Y.Text();
      copy.insert(0, existing.toString());
      filesMap.set(newPath, copy);
      filesMap.delete(oldPath);
    });
    // dispose old monaco model then switch — defer so Monaco finishes cleanup
    const oldUri = monaco.Uri.parse(`file:///${oldPath}`);
    monaco.editor.getModel(oldUri)?.dispose();
    if (activeFile === oldPath) setTimeout(() => switchToFile(newPath), 0);
  }

  function handleDelete(path: string) {
    if (!confirm(`Delete "${path}"?`)) return;
    const ydoc = ydocRef.current;
    const monaco = monacoRef.current;
    if (!ydoc || !monaco) return;
    const filesMap = ydoc.getMap<Y.Text>('files');
    ydoc.transact(() => filesMap.delete(path));
    const uri = monaco.Uri.parse(`file:///${path}`);
    monaco.editor.getModel(uri)?.dispose();
    if (activeFile === path) {
      const remaining = Array.from(filesMap.keys()).sort();
      if (remaining.length > 0) switchToFile(remaining[0]);
      else setActiveFile('');
    }
  }

  async function handleClone() {
    setCloning(true);
    try {
      const { files: repoFiles } = await api.sessions_clone(sessionId);
      const ydoc = ydocRef.current;
      const monaco = monacoRef.current;
      if (!ydoc || !monaco) return;
      const filesMap = ydoc.getMap<Y.Text>('files');
      ydoc.transact(() => {
        Object.entries(repoFiles).forEach(([p, content]) => {
          const yText = new Y.Text();
          yText.insert(0, content);
          filesMap.set(p, yText);
          const uri = monaco.Uri.parse(`file:///${p}`);
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(content, langFromPath(p), uri);
          }
        });
      });
    } catch (e: any) {
      alert(e.message ?? 'Clone failed');
    } finally {
      setCloning(false);
    }
  }

  useEffect(() => {
    return () => { textCleanupRef.current?.(); };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.bg }}>
      <Navbar
        sessionId={sessionId}
        activeFile={activeFile}
        cloning={cloning}
        onClone={handleClone}
        peers={peers}
        dbParticipants={dbParticipants}
        allOnlineNames={allOnlineNames}
      />
      <div className="flex flex-1 overflow-hidden">
        <FileTree
          paths={files}
          active={activeFile}
          onSelect={switchToFile}
          onNewFile={handleNewFile}
          onRename={handleRename}
          onDelete={handleDelete}
        />
        <MonacoEditor
          height="100%"
          language={language}
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            fontSize: 14,
            fontFamily: 'JetBrains Mono, Fira Code, monospace',
            fontLigatures: true,
            minimap: { enabled: false },
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            cursorBlinking: 'smooth',
            cursorStyle: 'block',
          }}
          keepCurrentModel
        />
      </div>
    </div>
  );
}
