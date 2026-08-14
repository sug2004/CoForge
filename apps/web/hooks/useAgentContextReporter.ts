'use client';

import { useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';

interface EditorContext {
  focusFileId?: string;
  cursor?: { line: number; col: number };
  selection?: { startLine: number; startCol: number; endLine: number; endCol: number };
  openFileIds: string[];
}

export function useAgentContextReporter(
  sessionId: string,
  threadId: string | null,
  editorRef: React.RefObject<any>,
  ydocRef: React.RefObject<any>
) {
  const lastReportRef = useRef<EditorContext>({
    focusFileId: undefined,
    cursor: undefined,
    selection: undefined,
    openFileIds: [],
  });
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);

  const reportContext = useCallback(async (context: EditorContext) => {
    if (!threadId) return;

    try {
      await api.agentThreads.addContextSnapshot(sessionId, threadId, context);
    } catch (error) {
      // Silently fail - context reporting is best effort
      console.warn('Failed to report context:', error);
    }
  }, [sessionId, threadId]);

  const throttleReport = useCallback((context: EditorContext) => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
    }

    throttleTimerRef.current = setTimeout(() => {
      reportContext(context);
    }, 1000); // ~1/sec as specified
  }, [reportContext]);

  useEffect(() => {
    const editor = editorRef.current;
    const ydoc = ydocRef.current;
    if (!editor || !ydoc) return;

    // Track open files from Monaco
    const getOpenFiles = () => {
      const models = editor._modelData?.models || [];
      return Array.from(models).map((m: any) => m.uri?.path?.slice(1) || '').filter(Boolean);
    };

    const handleCursorChange = () => {
      const model = editor.getModel();
      if (!model) return;

      const position = editor.getPosition();
      const selection = editor.getSelection();

      const context: EditorContext = {
        focusFileId: model.uri.path.slice(1),
        cursor: position ? { line: position.lineNumber, col: position.column } : undefined,
        selection: selection ? {
          startLine: selection.startLineNumber,
          startCol: selection.startColumn,
          endLine: selection.endLineNumber,
          endCol: selection.endColumn,
        } : undefined,
        openFileIds: getOpenFiles(),
      };

      // Check if context actually changed
      const last = lastReportRef.current;
      const changed = 
        last.focusFileId !== context.focusFileId ||
        JSON.stringify(last.cursor) !== JSON.stringify(context.cursor) ||
        JSON.stringify(last.selection) !== JSON.stringify(context.selection) ||
        JSON.stringify(last.openFileIds) !== JSON.stringify(context.openFileIds);

      if (changed) {
        lastReportRef.current = context;
        throttleReport(context);
      }
    };

    // Listen for cursor/selection changes
    const cursorDisposable = editor.onDidChangeCursorPosition(handleCursorChange);
    const selectionDisposable = editor.onDidChangeCursorSelection(handleCursorChange);

    // Also track model changes (file switches)
    const modelDisposable = editor.onDidChangeModel(() => {
      handleCursorChange();
    });

    // Track open editors
    const openEditorsDisposable = editor.onDidChangeModelDecorations(() => {
      handleCursorChange();
    });

    // Initial report
    handleCursorChange();

    return () => {
      cursorDisposable.dispose();
      selectionDisposable.dispose();
      modelDisposable.dispose();
      openEditorsDisposable.dispose();
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, [editorRef, ydocRef, threadId, throttleReport]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, []);
}