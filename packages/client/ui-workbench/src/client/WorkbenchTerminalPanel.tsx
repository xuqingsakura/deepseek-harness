/** Workbench terminal panel: multiple persistent shell sessions (PowerShell on
 * Windows) as tabs, each a scrollable output strip with a command input. The
 * shell owns the prompt and command echo, so the panel is a thin pipe to the
 * Remote terminal verbs. Output is polled incrementally; each terminal keeps
 * its own input history (Up/Down) and a clear button. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WorkbenchTerminalReadResult,
  WorkbenchTerminalSpawnResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { parseAnsi } from './ansi.ts'
import { NS } from './locales.ts'
import css from './WorkbenchTerminalPanel.module.css'

/** The injected terminal verbs the panel hands down. */
export interface WorkbenchTerminalPanelInjected {
  /** Spawn one persistent shell for the session scope (optional initial cwd). */
  terminalSpawn(sessionId: string, cwd?: string): Promise<WorkbenchTerminalSpawnResult>
  /** Write raw input to one terminal's stdin. */
  terminalWrite(sessionId: string, id: string, data: string): Promise<void>
  /** Consume incremental output from one terminal. */
  terminalRead(sessionId: string, id: string): Promise<WorkbenchTerminalReadResult>
  /** Terminate one terminal. */
  terminalClose(sessionId: string, id: string): Promise<void>
  /** Terminate every terminal of the session scope (session switch). */
  terminalCloseSession(sessionId: string): Promise<void>
}

/** Full props for the terminal panel. */
export type WorkbenchTerminalPanelProps = WorkbenchTerminalPanelInjected & {
  /** The conversation whose cwd the shell starts in. */
  sessionId: string
  /** Close the whole bottom terminal panel (VSCode x button). */
  onClose?(): void
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** Poll cadence for incremental output reads. */
const POLL_MS = 200

/** One live terminal tab. */
interface TerminalView {
  id: string
  shell: string
  output: string
  running: boolean
}

/**
 * The workbench terminal panel: a tab strip of persistent shells per session.
 * A "+" button spawns a new shell; each tab has its own output, input with
 * Up/Down history, a clear button, and a close button. Switching sessions
 * tears down every shell and starts fresh.
 */
export function WorkbenchTerminalPanel({
  sessionId, onClose, terminalSpawn, terminalWrite, terminalRead, terminalClose, terminalCloseSession, t,
}: WorkbenchTerminalPanelProps) {
  const [views, setViews] = useState<TerminalView[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  // Keep the latest verbs without retriggering on inline prop identity.
  const verbs = useRef({ terminalSpawn, terminalWrite, terminalRead, terminalClose, terminalCloseSession })
  verbs.current = { terminalSpawn, terminalWrite, terminalRead, terminalClose, terminalCloseSession }
  const viewsRef = useRef(views)
  viewsRef.current = views

  // Tear down every shell when the bound session changes or the panel unmounts.
  useEffect(() => {
    const previousSession = sessionId
    return () => {
      void verbs.current.terminalCloseSession(previousSession)
    }
  }, [sessionId])

  const updateView = useCallback((id: string, patch: Partial<TerminalView>) => {
    setViews(prev => prev.map(view => (view.id === id ? { ...view, ...patch } : view)))
  }, [])

  const spawn = useCallback(async (): Promise<void> => {
    setError(undefined)
    try {
      const result = await verbs.current.terminalSpawn(sessionId, undefined)
      const view: TerminalView = { id: result.session.id, shell: result.shell, output: '', running: result.session.status === 'running' }
      setViews(prev => [...prev, view])
      setActiveId(result.session.id)
      // Poll this terminal's output until it exits.
      const poll = setInterval(() => {
        void verbs.current.terminalRead(sessionId, result.session.id)
          .then((read) => {
            const current = viewsRef.current.find(v => v.id === result.session.id)
            if (current === undefined) { clearInterval(poll); return }
            if (read.delta.length > 0) updateView(result.session.id, { output: current.output + read.delta })
            if (read.session.status === 'exited') {
              updateView(result.session.id, { running: false })
              clearInterval(poll)
            }
          })
          .catch((caught: unknown) => {
            // The tab was closed while this poll was in flight: the host
            // already dropped the terminal, so stop polling without an error.
            const current = viewsRef.current.find(v => v.id === result.session.id)
            if (current === undefined) { clearInterval(poll); return }
            setError(caught instanceof Error ? caught.message : String(caught))
          })
      }, POLL_MS)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [sessionId, updateView])

  // Spawn the first terminal on mount (or session change).
  useEffect(() => {
    setViews([])
    setActiveId(undefined)
    setError(undefined)
    void spawn()
  }, [sessionId, spawn])

  const close = useCallback((id: string): void => {
    // Closing the last shell tab closes the whole panel (VSCode-like);
    // with multiple tabs it only closes that shell.
    const views = viewsRef.current
    if (onClose !== undefined && views.length === 1 && views[0]?.id === id) {
      void verbs.current.terminalClose(sessionId, id)
      onClose()
      return
    }
    void verbs.current.terminalClose(sessionId, id)
    setViews((prev) => {
      const next = prev.filter(view => view.id !== id)
      setActiveId(current => (current === id ? next[next.length - 1]?.id : current))
      return next
    })
  }, [onClose, sessionId])

  const clearOutput = useCallback((id: string): void => {
    updateView(id, { output: '' })
  }, [updateView])


  const active = views.find(view => view.id === activeId)

  return (
    <div className={css.panel}>
      <div className={css.tabbar}>
        {views.map(view => (
          <button
            key={view.id}
            type="button"
            className={view.id === activeId ? css.tabActive : css.tab}
            onClick={() => setActiveId(view.id)}
          >
            <span className={view.running ? css.dotRunning : css.dotExited} aria-hidden="true" />
            <span className={css.tabLabel}>{view.shell.split(/[\\/]/).pop()}</span>
            <span
              role="button"
              tabIndex={-1}
              className={css.tabClose}
              aria-label={t('terminal.close')}
              onClick={(event) => { event.stopPropagation(); close(view.id) }}
            >
              ✕
            </span>
          </button>
        ))}
        <button type="button" className={css.addTab} onClick={() => void spawn()} aria-label={t('terminal.new')}>
          +
        </button>
        {onClose !== undefined ? (
          <button type="button" className={css.panelClose} aria-label={t('terminal.closePanel')} title={t('terminal.closePanel')} onClick={onClose}>
            ✕
          </button>
        ) : null}
      </div>
      {error !== undefined ? <div className={css.error}>{error}</div> : null}
      {active !== undefined ? (
        <TerminalBody
          key={active.id}
          sessionId={sessionId}
          terminalId={active.id}
          output={active.output}
          running={active.running}
          terminalWrite={terminalWrite}
          onClear={() => clearOutput(active.id)}
          t={t}
        />
      ) : (
        <div className={css.empty}>{t('tree.loading')}</div>
      )}
    </div>
  )
}

/** One terminal's output strip + input row (per-tab, keyed by terminal id). */
function TerminalBody({
  sessionId, terminalId, output, running, terminalWrite, onClear, t,
}: {
  sessionId: string
  terminalId: string
  output: string
  running: boolean
  terminalWrite(sessionId: string, id: string, data: string): Promise<void>
  onClear(): void
  t: TranslateNS<typeof NS>
}) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef(history)
  historyRef.current = history
  const verbs = useRef({ terminalWrite })
  verbs.current = { terminalWrite }

  // Keep the output pinned to the newest line while it grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [output])

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const trimmed = value
    if (trimmed.length === 0) return
    void verbs.current.terminalWrite(sessionId, terminalId, `${trimmed}\n`).catch((caught: unknown) => {
      // Surfaced by the panel-level error state; keep the input intact.
      console.error(caught)
    })
    setHistory(prev => [...prev, trimmed])
    setHistoryIndex(-1)
    setValue('')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const index = historyIndex === -1 ? historyRef.current.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(index)
      setValue(historyRef.current[index] ?? '')
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (historyIndex === -1) return
      const index = historyIndex + 1
      if (index >= historyRef.current.length) {
        setHistoryIndex(-1)
        setValue('')
      } else {
        setHistoryIndex(index)
        setValue(historyRef.current[index] ?? '')
      }
    }
  }

  return (
    <>
      <div className={css.toolbar}>
        <span className={css.title}>{t('terminal.title')}</span>
        <span className={running ? css.stateRunning : css.stateExited}>
          {running ? t('terminal.running') : t('terminal.exited')}
        </span>
        <button type="button" className={css.action} onClick={onClear}>{t('terminal.clear')}</button>
      </div>
      <div ref={scrollRef} className={css.output} aria-live="polite">
        <pre className={css.buffer}>
          {parseAnsi(output).map((segment, index) => (
            segment.style === undefined ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span
                key={index}
                style={{
                  color: segment.style.fg,
                  backgroundColor: segment.style.bg,
                  fontWeight: segment.style.bold ? 700 : undefined,
                  ...(segment.style.inverse
                    ? { color: segment.style.bg, backgroundColor: segment.style.fg }
                    : {}),
                }}
              >
                {segment.text}
              </span>
            )
          ))}
        </pre>
        {!running ? <div className={css.exited}>{t('terminal.exited')}</div> : null}
      </div>
      <form className={css.inputRow} onSubmit={submit}>
        <span className={css.prompt}>›</span>
        <input
          className={css.input}
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('terminal.placeholder')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('terminal.inputAria')}
        />
      </form>
    </>
  )
}

export default WorkbenchTerminalPanel
