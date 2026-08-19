/** Workbench Git panel: VSCode-style change list (staged / unstaged /
 * untracked), commit composer, branch switching, fetch/pull/push via an
 * overflow menu, and a recent-commit history list. Clicking a change row
 * opens that file's diff in the center-column viewer. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  WorkbenchGitBranch,
  WorkbenchGitChange,
  WorkbenchGitDiffResult,
  WorkbenchGitLogEntry,
  WorkbenchGitStatusResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { buildGitGraph } from './git-graph.ts'
import css from './WorkbenchGitPanel.module.css'

/** The injected git verbs the panel hands down. */
export interface WorkbenchGitPanelInjected {
  /** Project the working-tree status. */
  gitStatus: (sessionId: string) => Promise<WorkbenchGitStatusResult>
  /** Unified diff of one path (or the whole tree). */
  gitDiff: (sessionId: string, path?: string, staged?: boolean) => Promise<WorkbenchGitDiffResult>
  /** Recent commit history. */
  gitLog: (sessionId: string, limit?: number) => Promise<WorkbenchGitLogEntry[]>
  /** Local branches with the checked-out one flagged. */
  gitBranches: (sessionId: string) => Promise<WorkbenchGitBranch[]>
  /** Stage paths (empty = all). */
  gitAdd: (sessionId: string, paths?: string[]) => Promise<void>
  /** Discard worktree changes or unstage index entries. */
  gitRestore: (sessionId: string, paths: string[], staged?: boolean) => Promise<void>
  /** Commit the staged changes. */
  gitCommit: (sessionId: string, message: string) => Promise<void>
  /** Check out one local branch. */
  gitCheckout: (sessionId: string, branch: string) => Promise<void>
  /** Fetch from the configured upstream. */
  gitFetch: (sessionId: string, remote?: string) => Promise<void>
  /** Pull the current branch. */
  gitPull: (sessionId: string) => Promise<void>
  /** Push the current branch. */
  gitPush: (sessionId: string, remote?: string, branch?: string) => Promise<void>
}

/** Full props for the git panel. */
export type WorkbenchGitPanelProps = WorkbenchGitPanelInjected & {
  /** The conversation whose cwd holds the repository. */
  sessionId: string
  /** Open a changed file's diff in the center-column viewer (VSCode click-to-open). */
  onOpenDiff: (path: string, staged: boolean) => void
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** Group changes into staged, unstaged, and untracked buckets. */
function groupChanges(changes: WorkbenchGitChange[]): {
  staged: WorkbenchGitChange[]
  unstaged: WorkbenchGitChange[]
  untracked: WorkbenchGitChange[]
} {
  const staged: WorkbenchGitChange[] = []
  const unstaged: WorkbenchGitChange[] = []
  const untracked: WorkbenchGitChange[] = []
  for (const change of changes) {
    if (change.kind === 'untracked') untracked.push(change)
    else if (change.staged) staged.push(change)
    else unstaged.push(change)
  }
  return { staged, unstaged, untracked }
}



/**
 * The workbench Git panel: status list with per-file actions, a highlighted
 * unified diff viewer, commit composer, branch switching, fetch/pull/push
 * toolbar, and a compact recent-commit history. Non-repository directories
 * show an empty-state hint instead of the list.
 */
export function WorkbenchGitPanel({
  sessionId, onOpenDiff, t,
  gitStatus, gitDiff, gitLog, gitBranches, gitAdd, gitRestore, gitCommit, gitCheckout, gitFetch, gitPull, gitPush,
}: WorkbenchGitPanelProps) {
  const [status, setStatus] = useState<WorkbenchGitStatusResult | undefined>(undefined)
  const [log, setLog] = useState<WorkbenchGitLogEntry[]>([])
  const [branches, setBranches] = useState<WorkbenchGitBranch[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  /** Change groups collapsed by the user (folded file lists). */
  const [collapsed, setCollapsed] = useState<ReadonlySet<'staged' | 'unstaged' | 'untracked'>>(() => new Set())
  const graph = useMemo(() => buildGitGraph(log), [log])
  // Keep the latest verbs without retriggering on inline prop identity.
  const verbs = useRef({ gitStatus, gitDiff, gitLog, gitBranches, gitAdd, gitRestore, gitCommit, gitCheckout, gitFetch, gitPull, gitPush })
  verbs.current = { gitStatus, gitDiff, gitLog, gitBranches, gitAdd, gitRestore, gitCommit, gitCheckout, gitFetch, gitPull, gitPush }

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    setError(undefined)
    try {
      const [nextStatus, nextLog, nextBranches] = await Promise.all([
        verbs.current.gitStatus(sessionId),
        verbs.current.gitLog(sessionId, 30),
        verbs.current.gitBranches(sessionId),
      ])
      setStatus(nextStatus)
      setLog(nextLog)
      setBranches(nextBranches)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRefreshing(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await refresh()
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const stageAll = (): void => { void run(() => verbs.current.gitAdd(sessionId, [])) }
  const discardAll = (): void => {
    const unstaged = status?.changes.filter(change => !change.staged) ?? []
    if (unstaged.length === 0) return
    if (!window.confirm(t('git.discardConfirm', { count: String(unstaged.length) }))) return
    void run(() => verbs.current.gitRestore(sessionId, unstaged.map(change => change.path), false))
  }
  const commit = (): void => {
    const trimmed = message.trim()
    if (trimmed.length === 0) return
    void run(async () => {
      await verbs.current.gitCommit(sessionId, trimmed)
      setMessage('')
    })
  }
  const checkout = (branch: string): void => {
    if (branch === status?.branch) return
    void run(() => verbs.current.gitCheckout(sessionId, branch))
  }
  const toggleGroup = (group: 'staged' | 'unstaged' | 'untracked'): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const groups = status === undefined ? undefined : groupChanges(status.changes)

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <span className={css.title}>{t('git.title')}</span>
        {status?.isRepo === true ? (
          <Menu
            open={moreOpen}
            onClose={() =>{  setMoreOpen(false) }}
            portal
            align="end"
            items={[
              { id: 'stageAll', label: t('git.stageAll') },
              { id: 'discardAll', label: t('git.discardAll'), danger: true },
              { type: 'separator', id: 'sep' },
              { id: 'fetch', label: t('git.fetch') },
              { id: 'pull', label: t('git.pull') },
              { id: 'push', label: t('git.push') },
            ]}
            onSelect={(id) => {
              setMoreOpen(false)
              if (id === 'stageAll') stageAll()
              else if (id === 'discardAll') discardAll()
              else if (id === 'fetch') void run(() => verbs.current.gitFetch(sessionId, undefined))
              else if (id === 'pull') void run(() => verbs.current.gitPull(sessionId))
              else if (id === 'push') void run(() => verbs.current.gitPush(sessionId, undefined, undefined))
            }}
            anchor={(
              <button
                type="button"
                className={css.moreButton}
                disabled={busy}
                aria-label={t('git.more')}
                title={t('git.more')}
                onClick={() =>{  setMoreOpen(open => !open) }}
              >
                ⋯
              </button>
            )}
          />
        ) : null}
        <button type="button" className={css.action} disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? t('git.refreshing') : t('refresh')}
        </button>
      </div>

      {error !== undefined ? <div className={css.error}>{error}</div> : null}

      {status?.isRepo === true ? (
        <div className={css.branchRow}>
          <select
            className={css.select}
            value={status.branch}
            onChange={(event) =>{  checkout(event.target.value) }}
            aria-label={t('git.branchAria')}
          >
            {branches.map(branch => (
              <option key={branch.name} value={branch.name}>{branch.current ? `✓ ${branch.name}` : branch.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {status !== undefined && ! status.isRepo ? (
        <div className={css.empty}>{t('git.noRepo')}</div>
      ) : (
        <>
          <div className={css.history}>
            <div className={css.historyHeader}>{t('git.history')}</div>
            {log.length === 0 ? (
              <div className={css.hint}>{t('git.noCommits')}</div>
            ) : (
              <ul className={css.historyList}>
                {graph.map(row => (
                  <li key={row.commit.hash} className={css.graphRow} title={`${row.commit.hash}\n${row.commit.author} · ${row.commit.date}`}>
                    <span className={css.graphCells} aria-hidden="true">
                      {row.cells.map((cell, index) => (
                        <span
                          key={index}
                          className={
                            cell === 'empty'
                              ? css.graphEmpty
                              : cell === 'edge'
                                ? css.graphEdge
                                : css.graphNode
                          }
                        />
                      ))}
                    </span>
                    <span className={css.graphHash}>{row.commit.shortHash}</span>
                    <span className={css.graphMessage}>
                      {row.commit.message}
                      {row.merge ? <span className={css.graphMergeTag}>{t('git.merge')}</span> : null}
                    </span>
                    <span className={css.graphAuthor}>{row.commit.author}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={css.body}>
            <div className={css.listCol}>
              {groups === undefined ? (
                <div className={css.hint}>{t('tree.loading')}</div>
              ) : groups.staged.length + groups.unstaged.length + groups.untracked.length === 0 ? (
                <div className={css.hint}>{t('git.clean')}</div>
              ) : (
                <>
                  {groups.staged.length > 0 ? (
                    <GroupSection
                      label={t('git.staged')}
                      count={groups.staged.length}
                      collapsed={collapsed.has('staged')}
                      onToggle={() =>{  toggleGroup('staged') }}
                    >
                      {groups.staged.map(change => (
                        <ChangeRow
                          key={change.path}
                          change={change}
                          onOpenDiff={() =>{  onOpenDiff(change.path, true) }}
                          onUnstage={() => void run(() => verbs.current.gitRestore(sessionId, [change.path], true))}
                          t={t}
                        />
                      ))}
                    </GroupSection>
                  ) : null}
                  {groups.unstaged.length > 0 ? (
                    <GroupSection
                      label={t('git.unstaged')}
                      count={groups.unstaged.length}
                      collapsed={collapsed.has('unstaged')}
                      onToggle={() =>{  toggleGroup('unstaged') }}
                    >
                      {groups.unstaged.map(change => (
                        <ChangeRow
                          key={change.path}
                          change={change}
                          onOpenDiff={() =>{  onOpenDiff(change.path, false) }}
                          onStage={() => void run(() => verbs.current.gitAdd(sessionId, [change.path]))}
                          onDiscard={() => {
                            if (window.confirm(t('git.discardConfirm', { count: '1' }))) {
                              void run(() => verbs.current.gitRestore(sessionId, [change.path], false))
                            }
                          }}
                          t={t}
                        />
                      ))}
                    </GroupSection>
                  ) : null}
                  {groups.untracked.length > 0 ? (
                    <GroupSection
                      label={t('git.untracked')}
                      count={groups.untracked.length}
                      collapsed={collapsed.has('untracked')}
                      onToggle={() =>{  toggleGroup('untracked') }}
                    >
                      {groups.untracked.map(change => (
                        <ChangeRow
                          key={change.path}
                          change={change}
                          onOpenDiff={() =>{  onOpenDiff(change.path, false) }}
                          onStage={() => void run(() => verbs.current.gitAdd(sessionId, [change.path]))}
                          t={t}
                        />
                      ))}
                    </GroupSection>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className={css.bottom}>
            <input
              className={css.commitInput}
              value={message}
              onChange={(event) =>{  setMessage(event.target.value) }}
              placeholder={t('git.commitPlaceholder')}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit() }}
            />
            <button type="button" className={css.commitButton} disabled={busy || message.trim() === ''} onClick={commit}>
              {t('git.commit')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** One collapsible change group: a folder-style header (arrow toggles the
 * whole file list) over its rows. */
function GroupSection({
  label, count, collapsed, onToggle, children,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <>
      <button type="button" className={css.groupHeader} onClick={onToggle} aria-expanded={!collapsed}>
        <span className={css.groupArrow} aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        <span>{label} ({count})</span>
      </button>
      {collapsed ? null : children}
    </>
  )
}

/** One change row: single-click opens the file's diff in the center viewer. */
function ChangeRow({
  change, onOpenDiff, onStage, onUnstage, onDiscard, t,
}: {
  change: WorkbenchGitChange
  onOpenDiff: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  t: TranslateNS<typeof NS>
}) {
  return (
    <div
      className={css.row}
      onClick={onOpenDiff}
      title={t('git.openDiffInViewer')}
    >
      <span className={css.kindBadge} data-kind={change.kind}>{kindLabel(change.kind, t)}</span>
      <span className={css.path} title={change.path}>{change.path}</span>
      <span className={css.rowActions}>
        {onStage ? <button type="button" className={css.rowAction} title={t('git.stage')} onClick={(event) => { event.stopPropagation(); onStage() }}>+</button> : null}
        {onUnstage ? <button type="button" className={css.rowAction} title={t('git.unstage')} onClick={(event) => { event.stopPropagation(); onUnstage() }}>−</button> : null}
        {onDiscard ? <button type="button" className={css.rowActionDanger} title={t('git.discard')} onClick={(event) => { event.stopPropagation(); onDiscard() }}>✕</button> : null}
      </span>
    </div>
  )
}
/** Short kind label for the change badge. */
function kindLabel(kind: WorkbenchGitChange['kind'], t: TranslateNS<typeof NS>): string {
  switch (kind) {
    case 'added': return 'A'
    case 'modified': return 'M'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'untracked': return '?'
    /* v8 ignore next -- closed wire union */
    default: return t('git.unknown')
  }
}

export default WorkbenchGitPanel
