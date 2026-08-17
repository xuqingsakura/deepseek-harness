/** Workbench background-tasks panel: this session's `ctx.jobs` records as a
 * scrollable list. The data rides the same jobsBySession mirror the session
 * header popover uses, so the panel issues no RPC and holds no state beyond a
 * ticking clock for live durations. */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { JobView, ObservableSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './WorkbenchTasksPanel.module.css'

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_TASKS: readonly JobView[] = []

/** A job the registry still holds open, and whose duration therefore ticks. */
function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled job status: ${JSON.stringify(value)}`)
}

/** Status marker semantics (mirrors the session-header popover). */
function dotState(status: JobView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Human status word for the row and its accessible name. */
function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'stopping': return t('status.stopping')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Elapsed time in at most two adjacent units (mirrors the popover). */
function formatDuration(elapsedMs: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/** Live rows first in start order, then settled rows newest-first. */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** Full props for the background-tasks panel. */
export type WorkbenchTasksPanelProps = {
  /** The conversation whose jobs to show. */
  sessionId: string
  /** The session list feed; jobsBySession is the read-only job mirror. */
  sessions: ObservableSnapshot<SessionListState>
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/**
 * The workbench background-tasks panel: a scrollable list of the session's
 * jobs with live durations. An empty list shows a hint instead of the table.
 */
export function WorkbenchTasksPanel({ sessionId, sessions, t }: WorkbenchTasksPanelProps) {
  const jobs = useSyncExternalStore(
    sessions.subscribe,
    () => sessions.getSnapshot().jobsBySession[sessionId as SessionId] ?? NO_TASKS,
    () => NO_TASKS,
  )
  const [now, setNow] = useState(() => Date.now())
  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveCount = useMemo(() => jobs.filter(isLive).length, [jobs])

  // The clock only runs while a live row is visible.
  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [liveCount])

  return (
    <div className={css.panel}>
      <div className={css.toolbar}>
        <span className={css.title}>{t('tasks.title')}</span>
        <span className={css.count}>{jobs.length > 0 ? t('tasks.count', { count: String(jobs.length) }) : ''}</span>
      </div>
      <div className={css.body}>
        {rows.length === 0 ? (
          <div className={css.empty}>{t('tasks.empty')}</div>
        ) : (
          <ul className={css.list}>
            {rows.map((job) => {
              const live = isLive(job)
              const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
              return (
                <li key={job.id} className={live ? css.row : `${css.row} ${css.rowSettled}`}>
                  <StateDot state={dotState(job.status)} className={css.dot} />
                  <span className={css.kind}>{job.kind}</span>
                  <span className={css.label} title={job.label}>{job.label}</span>
                  <span className={css.status} title={job.detail ?? statusLabel(job.status, t)}>
                    {job.detail ?? statusLabel(job.status, t)}
                  </span>
                  <span className={css.duration}>{formatDuration(elapsed, t)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

export default WorkbenchTasksPanel
