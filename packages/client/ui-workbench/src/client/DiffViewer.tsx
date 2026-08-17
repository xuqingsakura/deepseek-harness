/** Center-column diff preview for Git changes: fetches one path's unified
 * diff through the workbench Remote and renders it with per-line +/- coloring.
 * The Git panel opens this view instead of showing a diff in the narrow
 * sidebar. */

import { useEffect, useState } from 'react'
import type { WorkbenchGitDiffResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './DiffViewer.module.css'

/** The injected git-diff verb the diff viewer needs. */
export interface DiffViewerInjected {
  /** Unified diff of one path (index or worktree per staged). */
  gitDiff: (sessionId: string, path: string, staged: boolean) => Promise<WorkbenchGitDiffResult>
}

/** Full props for the diff viewer. */
export type DiffViewerProps = DiffViewerInjected & {
  /** The conversation whose cwd holds the repository. */
  sessionId: string
  /** The changed file path, relative to the session cwd. */
  path: string
  /** Whether to diff the staged (index) or worktree version. */
  staged: boolean
  /** Close the diff view and return to the file content view. */
  onClose: () => void
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** Render a unified diff with per-line +/- coloring. */
function DiffText({ text, t }: { text: string; t: TranslateNS<typeof NS> }) {
  const lines = text.split('\n')
  return (
    <pre className={css.diff}>
      {lines.map((line, index) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? css.diffAdd
          : line.startsWith('-') && !line.startsWith('---')
            ? css.diffRemove
            : line.startsWith('@@')
              ? css.diffHunk
              : undefined
        return <div key={index} className={cls}>{line === '' ? '\u00a0' : line}</div>
      })}
      {text === '' ? t('git.selectHint') : null}
    </pre>
  )
}

/**
 * The center-column diff viewer: loads the selected change's diff on mount
 * and renders it highlighted, with a header showing the path and a close
 * button that returns to the file content view.
 */
export function DiffViewer({ sessionId, path, staged, gitDiff, onClose, t }: DiffViewerProps) {
  const [result, setResult] = useState<WorkbenchGitDiffResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setResult(undefined)
    setError(undefined)
    void gitDiff(sessionId, path, staged)
      .then((next) => { if (alive) setResult(next) })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => { alive = false }
  }, [sessionId, path, staged, gitDiff])

  return (
    <div className={css.viewer}>
      <div className={css.header}>
        <span className={css.path} title={path}>{path}</span>
        {result?.binary === true ? <span className={css.hint}>{t('git.binaryDiff')}</span> : null}
        <button type="button" className={css.close} aria-label={t('tab.close')} title={t('tab.close')} onClick={onClose}>
          ✕
        </button>
      </div>
      {error !== undefined ? <div className={css.error}>{error}</div> : null}
      {result === undefined && error === undefined ? <div className={css.hint}>{t('tree.loading')}</div> : null}
      {result !== undefined ? <DiffText text={result.diff} t={t} /> : null}
    </div>
  )
}

export default DiffViewer
