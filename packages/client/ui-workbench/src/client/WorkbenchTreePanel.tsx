/** Workbench sidebar panel: a tab strip (files / terminal / git / tasks) over
 * the session-scoped views. The file tree, terminal shell, Git worktree, and
 * background-task list all bind to the session the header toggle set
 * (falling back to the current session when the view was opened from the
 * activity bar). */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkbenchDirEntry, WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { WorkbenchStateHandle, WorkbenchSidebarTab } from './workbench-store.ts'
import { FileTree } from './FileTree.tsx'
import { WorkbenchGitPanel, type WorkbenchGitPanelInjected } from './WorkbenchGitPanel.tsx'
import type { WorkbenchTerminalPanelInjected } from './WorkbenchTerminalPanel.tsx'
import { WorkbenchTasksPanel } from './WorkbenchTasksPanel.tsx'
import css from './WorkbenchTreePanel.module.css'

/** The injected Remote verbs the tree panel hands to its views. */
export interface WorkbenchTreePanelInjected
  extends WorkbenchGitPanelInjected, WorkbenchTerminalPanelInjected, WorkbenchFileOpsInjected {
  /** Resolve the session's authoritative cwd. */
  cwd(sessionId: string): Promise<string>
  /** List one directory level; an empty path is the session cwd itself. */
  listDir(sessionId: string, path: string): Promise<WorkbenchDirEntry[]>
  /** The session list feed; its current selection is the fallback binding. */
  sessions: ObservableSnapshot<SessionListState>
}

/** Filesystem mutation verbs shared by the tree and editor seats. */
export interface WorkbenchFileOpsInjected {
  /** Create one directory (and parents). */
  fsMkdir(sessionId: string, path: string): Promise<void>
  /** Rename or move one file or directory. */
  fsRename(sessionId: string, path: string, nextPath: string): Promise<void>
  /** Delete one file or (recursively) directory. */
  fsRemove(sessionId: string, path: string, recursive?: boolean): Promise<void>
  /** Write a file (version omitted = create-or-overwrite). */
  writeText(sessionId: string, path: string, content: string, version?: WorkbenchWriteResult['version']): Promise<WorkbenchWriteResult>
}

/** Full props for the workbench sidebar panel. */
export type WorkbenchTreePanelProps =
  PropsRuntime<'sidebar.workbench'>
  & PropsLocale<typeof NS>
  & WorkbenchTreePanelInjected
  & { workbench: WorkbenchStateHandle; layout: ILayout }

/** The four sidebar tabs in display order. */
const TABS: readonly { id: WorkbenchSidebarTab; labelKey: 'tab.files' | 'tab.git' | 'tab.tasks' }[] = [
  { id: 'files', labelKey: 'tab.files' },
  { id: 'git', labelKey: 'tab.git' },
  { id: 'tasks', labelKey: 'tab.tasks' },
]

/**
 * The workbench sidebar panel: a tab strip over the file tree, terminal, Git
 * panel, and background-task list. All views bind to the session the header
 * toggle pinned (the current session is the fallback for the activity-bar
 * entry); opening a file hands the path to the center-column editor.
 */
export function WorkbenchTreePanel({
  workbench, layout, t, cwd, listDir, sessions, fsMkdir, fsRename, fsRemove, writeText, ...verbs
}: WorkbenchTreePanelProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot)
  // Subscribe to the current id only (a primitive): list snapshots may be
  // freshly allocated per read, and a stable current must not re-render.
  const currentSessionId = useSyncExternalStore(sessions.subscribe, () => sessions.getSnapshot().current)
  const [resolvedCwd, setResolvedCwd] = useState<string | undefined>(undefined)
  // Keep the latest listing verb without retriggering on inline prop identity.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  // The header toggle pins a session; the current session is the fallback so
  // the activity-bar entry (which only flips the layout view) still fills
  // the tree. Rendering never depends on the toggle's open flag.
  const sessionId = state.sessionId ?? currentSessionId

  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    setResolvedCwd(undefined)
    void cwdRef.current(sessionId)
      .then((path) => { if (alive) setResolvedCwd(path) })
      .catch(() => { if (alive) setResolvedCwd('') })
    return () => { alive = false }
  }, [sessionId])

  if (sessionId === undefined) return null

  const openFile = (path: string): void => workbench.open(path)
  const setTab = (tab: WorkbenchSidebarTab): void => workbench.set({ tab })

  return (
    <aside className={css.panel} aria-label={t('panel.title')}>
      <div className={css.tabs} role="tablist" aria-label={t('panel.title')}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={state.tab === tab.id}
            className={state.tab === tab.id ? css.tabActive : css.tab}
            onClick={() => setTab(tab.id)}
          >
            {t(tab.labelKey)}
          </button>
        ))}
        <button
          type="button"
          className={css.terminalToggle}
          aria-label={t('tab.terminal')}
          title={t('tab.terminal')}
          onClick={() => layout.toggleBottom()}
        >
          &gt;_
        </button>
      </div>
      <div className={css.body}>
        {state.tab === 'files' ? (
          resolvedCwd !== undefined ? (
            <FileTree
              sessionId={sessionId}
              cwd={resolvedCwd}
              listDir={listDir}
              fsMkdir={fsMkdir}
              fsRename={fsRename}
              fsRemove={fsRemove}
              writeText={writeText}
              onOpen={openFile}
              activePath={state.activePath}
              t={t}
            />
          ) : (
            <div className={css.empty}>{t('tree.loading')}</div>
          )
        ) : null}
        {state.tab === 'git' ? (
          <WorkbenchGitPanel sessionId={sessionId} onOpenDiff={(path, staged) => workbench.openDiff(path, staged)} t={t} {...verbs} />
        ) : null}
        {state.tab === 'tasks' ? (
          <WorkbenchTasksPanel sessionId={sessionId} sessions={sessions} t={t} />
        ) : null}
      </div>
    </aside>
  )
}
