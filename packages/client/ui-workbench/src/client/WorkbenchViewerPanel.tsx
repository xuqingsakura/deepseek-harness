/** Workbench file viewer: the center-column seat while the workbench view is active. */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkbenchGitDiffResult, WorkbenchReadResult, WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { WorkbenchStateHandle } from './workbench-store.ts'
import { DiffViewer, type DiffViewerInjected } from './DiffViewer.tsx'
import { FileViewer } from './FileViewer.tsx'
import { WorkbenchTabs } from './WorkbenchTabs.tsx'
import css from './WorkbenchViewer.module.css'

/** The injected read/write verbs and session feed the viewer panel hands down. */
export interface WorkbenchViewerInjected {
  /** Read one text file through the workbench window. */
  readText(sessionId: string, path: string): Promise<WorkbenchReadResult>
  /** Write one text file atomically; a stale version token fails loud. */
  writeText(sessionId: string, path: string, content: string, version: WorkbenchWriteResult['version']): Promise<WorkbenchWriteResult>
  /** Unified diff of one path (index or worktree per staged). */
  gitDiff(sessionId: string, path: string, staged: boolean): Promise<WorkbenchGitDiffResult>
  /** The session list feed; its current selection is the viewer's fallback binding. */
  sessions: ObservableSnapshot<SessionListState>
}

/** Full props for the workbench viewer panel. */
export type WorkbenchViewerPanelProps =
  PropsRuntime<'workbench.viewer'>
  & PropsLocale<typeof NS>
  & WorkbenchViewerInjected
  & DiffViewerInjected
  & { workbench: WorkbenchStateHandle }

/**
 * The workbench viewer: renders the active file through the read-only
 * viewer (Markdown rendering and code highlighting included) below an editor
 * tab bar. The session it reads is the one the header toggle bound; the current session is the
 * fallback when the view was opened from the activity bar. Rendering never
 * depends on the toggle's open flag, and the seat itself is root-scoped (like
 * the file tree) so it renders regardless of the strict-session outlet.
 */
export function WorkbenchViewerPanel({ workbench, readText, writeText, gitDiff, t, sessions }: WorkbenchViewerPanelProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot)
  // Subscribe to the current id only (a primitive): list snapshots may be
  // freshly allocated per read, and a stable current must not re-render.
  const currentSessionId = useSyncExternalStore(sessions.subscribe, () => sessions.getSnapshot().current)
  const viewerSessionId = state.sessionId ?? currentSessionId
  // Paths with unsaved edits, reported by the FileViewer instances; guards tab
  // switches and closes with a confirm instead of silently dropping work.
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set())
  const dirtyRef = useRef(dirtyPaths)
  dirtyRef.current = dirtyPaths

  const onDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      const next = new Set(prev)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const confirmIfDirty = useCallback((paths: readonly string[]): boolean => {
    const affected = paths.some(path => dirtyRef.current.has(path))
    if (!affected) return true
    return window.confirm(t('editor.confirmDiscard'))
  }, [t])

  const select = useCallback((path: string): void => {
    const current = state.activePath
    if (current !== undefined && current !== path && dirtyRef.current.has(current)) {
      if (!window.confirm(t('editor.confirmDiscard'))) return
      setDirtyPaths(new Set())
    }
    workbench.set({ activePath: path })
  }, [state.activePath, t, workbench])

  const close = useCallback((path: string): void => {
    if (dirtyRef.current.has(path) && !window.confirm(t('editor.confirmDiscard'))) return
    const next = new Set(dirtyRef.current)
    next.delete(path)
    setDirtyPaths(next)
    workbench.close(path)
  }, [t, workbench])

  const closeOthers = useCallback((path: string): void => {
    const affected = state.openPaths.filter(candidate => candidate !== path)
    if (!confirmIfDirty(affected)) return
    setDirtyPaths(new Set(path ? [path] : []))
    workbench.closeOthers(path)
  }, [state.openPaths, confirmIfDirty, workbench])

  const closeAll = useCallback((): void => {
    if (!confirmIfDirty(state.openPaths)) return
    setDirtyPaths(new Set())
    workbench.closeAll()
  }, [state.openPaths, confirmIfDirty, workbench])

  return (
    <div className={css.viewer}>
      {state.diff !== undefined && viewerSessionId !== undefined ? (
        <DiffViewer
          sessionId={viewerSessionId}
          path={state.diff.path}
          staged={state.diff.staged}
          gitDiff={gitDiff}
          onClose={workbench.clearDiff}
          t={t}
        />
      ) : (
        <>
          <WorkbenchTabs
            paths={state.openPaths}
            activePath={state.activePath}
            onSelect={select}
            onClose={close}
            onCloseOthers={closeOthers}
            onCloseAll={closeAll}
            t={t}
          />
          {state.activePath !== undefined && viewerSessionId !== undefined ? (
            <FileViewer
              sessionId={viewerSessionId}
              path={state.activePath}
              readText={readText}
              writeText={writeText}
              t={t}
              onDirtyChange={onDirtyChange}
            />
          ) : (
            <div className={css.empty}>{t('tab.files')}</div>
          )}
        </>
      )}
    </div>
  )
}
