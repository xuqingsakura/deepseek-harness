/** Workbench sidebar panel: a tab strip (files / terminal / git / tasks) over
 * the session-scoped views. The files tab carries a file-name search box, a
 * refresh affordance, a close button, and the session cwd breadcrumb above the
 * windowed file tree (hover rows offer @-references into the composer draft).
 * The file tree, terminal shell, Git worktree, and background-task list all
 * bind to the session the header toggle set (falling back to the current
 * session when the view was opened from the activity bar). */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchDirListing, WorkbenchWriteResult, WorkbenchSearchResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
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
  cwd: (sessionId: string) => Promise<string>
  /** List one directory level; an empty path is the session cwd itself. */
  listDir: (sessionId: string, path: string) => Promise<WorkbenchDirListing>
  /** Recursive file-name search rooted at the session cwd. */
  searchFiles: (sessionId: string, query: string) => Promise<WorkbenchSearchResult>
  /** Append `@<relative path>` to the session's composer draft. */
  referenceFile: (sessionId: string, relativePath: string) => void
  /** The session list feed; its current selection is the fallback binding. */
  sessions: ObservableSnapshot<SessionListState>
}

/** Filesystem mutation verbs shared by the tree and editor seats. */
export interface WorkbenchFileOpsInjected {
  /** Create one directory (and parents). */
  fsMkdir: (sessionId: string, path: string) => Promise<void>
  /** Rename or move one file or directory. */
  fsRename: (sessionId: string, path: string, nextPath: string) => Promise<void>
  /** Delete one file or (recursively) directory. */
  fsRemove: (sessionId: string, path: string, recursive?: boolean) => Promise<void>
  /** Write a file (version omitted = create-or-overwrite). */
  writeText: (sessionId: string, path: string, content: string, version?: WorkbenchWriteResult['version']) => Promise<WorkbenchWriteResult>
}

/** Full props for the workbench sidebar panel. */
export type WorkbenchTreePanelProps =
  PropsRuntime<'sidebar.workbench'>
  & PropsLocale<typeof NS>
  & WorkbenchTreePanelInjected
  & { workbench: WorkbenchStateHandle; layout: ILayout }

/** The sidebar tabs in display order. */
const TABS: readonly { id: WorkbenchSidebarTab; labelKey: 'tab.files' | 'tab.git' | 'tab.tasks' | 'tab.browser' }[] = [
  { id: 'files', labelKey: 'tab.files' },
  { id: 'git', labelKey: 'tab.git' },
  { id: 'tasks', labelKey: 'tab.tasks' },
  { id: 'browser', labelKey: 'tab.browser' },
]

/** Debounce window for the file-name search input. */
const SEARCH_DEBOUNCE_MS = 300

/** Last path segment of a cwd (the breadcrumb label). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/**
 * The workbench sidebar panel: a tab strip over the file tree (with search +
 * toolbar), terminal, Git panel, and background-task list. All views bind to
 * the session the header toggle pinned (the current session is the fallback
 * for the activity-bar entry); opening a file hands the path to the
 * center-column editor.
 */
export function WorkbenchTreePanel({
  workbench, layout, t, cwd, listDir, searchFiles, referenceFile, sessions, fsMkdir, fsRename, fsRemove, writeText, ...verbs
}: WorkbenchTreePanelProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot)
  // Subscribe to the current id only (a primitive): list snapshots may be
  // freshly allocated per read, and a stable current must not re-render.
  const currentSessionId = useSyncExternalStore(listener => sessions.subscribe(listener), () => sessions.getSnapshot().current)
  const [resolvedCwd, setResolvedCwd] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkbenchSearchResult | null>(null)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  // Keep the latest verbs without retriggering on inline prop identity.
  const verbsRef = useRef({ cwd, listDir, searchFiles, referenceFile, fsMkdir, fsRename, fsRemove, writeText })
  verbsRef.current = { cwd, listDir, searchFiles, referenceFile, fsMkdir, fsRename, fsRemove, writeText }

  // The header toggle pins a session; the current session is the fallback so
  // the activity-bar entry (which only flips the layout view) still fills
  // the tree. Rendering never depends on the toggle's open flag.
  const sessionId = state.sessionId ?? currentSessionId

  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    setResolvedCwd(undefined)
    void verbsRef.current.cwd(sessionId)
      .then((path) => { if (alive) setResolvedCwd(path) })
      .catch(() => { if (alive) setResolvedCwd('') })
    return () => { alive = false }
  }, [sessionId])

  // Debounced file-name search; an in-flight request is aborted by the next
  // keystroke or a session switch.
  const needle = query.trim()
  useEffect(() => {
    if (sessionId === undefined || needle === '') {
      setResults(null)
      setSearchError(undefined)
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const timer = window.setTimeout(() => {
      void verbsRef.current.searchFiles(sessionId, needle)
        .then((found) => { if (!alive) return; setResults(found); setSearchError(undefined) })
        .catch((error: unknown) => {
          if (!alive) return
          setResults(null)
          setSearchError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => { if (alive) setSearching(false) })
    }, SEARCH_DEBOUNCE_MS)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [sessionId, needle])

  if (sessionId === undefined) return null

  const openFile = (path: string): void => { workbench.open(path) }
  const setTab = (tab: WorkbenchSidebarTab): void => { workbench.set({ tab }) }
  const reference = (relPath: string): void => { verbsRef.current.referenceFile(sessionId, relPath) }
  const openSearchResult = (rel: string): void => {
    if (resolvedCwd === undefined) return
    // Search results are relative to the cwd; join onto it for the viewer.
    openFile(resolvedCwd.replace(/\\/g, '/') + '/' + rel)
  }

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
            onClick={() => { setTab(tab.id) }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
        <button
          type="button"
          className={css.terminalToggle}
          aria-label={t('tab.terminal')}
          title={t('tab.terminal')}
          onClick={() => { layout.toggleBottom() }}
        >
          &gt;_
        </button>
      </div>
      <div className={css.body}>
        {state.tab === 'files' ? (
          <div className={css.filesPane}>
            <div className={css.toolbar}>
              <input
                className={css.searchInput}
                value={query}
                placeholder={t('panel.searchPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setQuery(event.target.value) }}
              />
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('panel.refresh')}
                title={t('panel.refresh')}
                onClick={() => { setRefreshTick(tick => tick + 1) }}
              >
                <IconRefreshOutline16 size={14} />
              </button>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('panel.close')}
                title={t('panel.close')}
                onClick={() => { layout.closeWorkbench() }}
              >
                ✕
              </button>
            </div>
            {resolvedCwd !== undefined ? (
              <div className={css.cwdBar} title={resolvedCwd}>{baseName(resolvedCwd)}</div>
            ) : null}
            {needle === '' ? (
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
                  onReference={reference}
                  refreshTick={refreshTick}
                  t={t}
                />
              ) : (
                <div className={css.empty}>{t('tree.loading')}</div>
              )
            ) : (
              <div className={css.searchBody}>
                {searching ? <div className={css.searchHint}>{t('panel.searchLoading')}</div> : null}
                {searchError !== undefined ? <div className={css.searchHint}>{searchError}</div> : null}
                {!searching && searchError === undefined && results !== null && results.matches.length === 0 ? (
                  <div className={css.searchHint}>{t('panel.searchNoResults')}</div>
                ) : null}
                {!searching && searchError === undefined && results !== null ? results.matches.map(rel => (
                  <button
                    key={rel}
                    type="button"
                    className={css.searchResult}
                    title={rel}
                    onClick={() => { openSearchResult(rel) }}
                  >
                    {rel}
                  </button>
                )) : null}
                {results?.truncated === true ? <div className={css.searchHint}>{t('panel.searchTruncated')}</div> : null}
              </div>
            )}
          </div>
        ) : null}
        {state.tab === 'git' ? (
          <WorkbenchGitPanel sessionId={sessionId} onOpenDiff={(path, staged) => { workbench.openDiff(path, staged) }} t={t} {...verbs} />
        ) : null}
        {state.tab === 'tasks' ? (
          <WorkbenchTasksPanel sessionId={sessionId} sessions={sessions} t={t} />
        ) : null}
      </div>
    </aside>
  )
}
