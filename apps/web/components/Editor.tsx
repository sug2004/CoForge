'use client';

import { useEffect, useRef, useState } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { createYSession } from '@/lib/ydoc';
import type { editor as MonacoEditor2 } from 'monaco-editor';
import * as Y from 'yjs';

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r?.type === 'cancelation' || r?.msg === 'operation is manually canceled') {
      e.preventDefault();
    }
  });
}

const LANGUAGES = [
  'typescript', 'javascript', 'python', 'rust', 'go',
  'java', 'cpp', 'c', 'csharp', 'html', 'css', 'json', 'markdown', 'sql', 'shell',
];

function bindYTextToMonaco(yText: Y.Text, ydoc: Y.Doc, editor: MonacoEditor2.IStandaloneCodeEditor) {
  const model = editor.getModel();
  if (!model) return () => {};
  let ignoreModelChange = false;

  model.setValue(yText.toString());

  const yObserver = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.local) return;
    ignoreModelChange = true;
    let index = 0;
    event.delta.forEach((op) => {
      if (op.retain) {
        index += op.retain;
      } else if (op.insert) {
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

export default function Editor({ sessionId }: { sessionId: string }) {
  const [language, setLanguage] = useState('typescript');

  // stable refs — never reassigned, only mutated
  const editorRef = useRef<MonacoEditor2.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const textCleanupRef = useRef<(() => void) | null>(null);
  const metaCleanupRef = useRef<(() => void) | null>(null);

  function applyLanguage(lang: string) {
    setLanguage(lang);
    const model = editorRef.current?.getModel();
    if (model && monacoRef.current) {
      monacoRef.current.editor.setModelLanguage(model, lang);
    }
  }

  function handleEditorMount(
    editor: MonacoEditor2.IStandaloneCodeEditor,
    monaco: typeof import('monaco-editor'),
  ) {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const { ydoc, provider } = createYSession(sessionId);
    ydocRef.current = ydoc;

    const fileMeta = ydoc.getMap<string>('fileMeta');

    // observe ALL fileMeta changes (local + remote) — single source of truth
    const metaObserver = () => {
      const lang = fileMeta.get('language');
      if (lang) applyLanguage(lang);
    };
    fileMeta.observe(metaObserver);
    metaCleanupRef.current = () => fileMeta.unobserve(metaObserver);

    const setupBinding = () => {
      const model = editor.getModel();
      if (!model) return;

      // apply synced language or set default
      const syncedLang = fileMeta.get('language');
      if (syncedLang) {
        applyLanguage(syncedLang);
      } else {
        ydoc.transact(() => fileMeta.set('language', 'typescript'));
      }

      // setup text binding
      const files = ydoc.getMap<Y.Text>('files');
      if (!files.has('main')) {
        ydoc.transact(() => files.set('main', new Y.Text()));
      }
      textCleanupRef.current?.();
      textCleanupRef.current = bindYTextToMonaco(files.get('main')!, ydoc, editor);
    };

    if (provider.synced) {
      setupBinding();
    } else {
      provider.once('sync', setupBinding);
    }
  }

  function handleLanguageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    // write to ydoc only — metaObserver fires locally too and calls applyLanguage
    ydocRef.current?.getMap<string>('fileMeta').set('language', e.target.value);
  }

  useEffect(() => {
    return () => {
      textCleanupRef.current?.();
      metaCleanupRef.current?.();
    };
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[#1e1e1e]">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#2d2d2d] border-b border-[#3e3e3e]">
        <span className="text-xs text-gray-400 font-mono">Language</span>
        <select
          value={language}
          onChange={handleLanguageChange}
          className="bg-[#3c3c3c] text-gray-200 text-xs font-mono px-2 py-1 rounded border border-[#555] focus:outline-none focus:border-blue-500 cursor-pointer"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>{lang}</option>
          ))}
        </select>
        <span className="text-xs text-gray-600 font-mono ml-auto">{sessionId}</span>
      </div>
      <MonacoEditor
        height="100%"
        language={language}
        theme="vs-dark"
        onMount={handleEditorMount}
        options={{ fontSize: 14, minimap: { enabled: false } }}
        keepCurrentModel
      />
    </div>
  );
}
