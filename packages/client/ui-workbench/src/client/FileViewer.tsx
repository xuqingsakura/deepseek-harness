/** Workbench file editor: Markdown previews stay rendered; every other text
 * file opens in the CodeMirror editor with save (Ctrl+S / button) through the
 * workbench Remote's version-guarded write. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchReadResult, WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeEditor } from './CodeEditor.tsx'
import { NS } from './locales.ts'
import css from './FileViewer.module.css'

/** The injected read/write verbs the panel hands down. */
export interface FileViewerInjected {
  /** Read one text file through the workbench window. */
  readText: (sessionId: string, path: string) => Promise<WorkbenchReadResult>
  /** Write one text file atomically; a stale version token fails loud. */
  writeText: (sessionId: string, path: string, content: string, version: WorkbenchWriteResult['version']) => Promise<WorkbenchWriteResult>
}

/** Full props for the file viewer. */
export type FileViewerProps = FileViewerInjected & {
  /** The conversation whose cwd the file lives in. */
  sessionId: string
  /** The file path, relative to the session cwd. */
  path: string
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
  /** Report dirty-state changes so the panel can guard tab switches. */
  onDirtyChange?: (path: string, dirty: boolean) => void
}

/** Markdown file extensions rendered through MarkdownText; everything else stays a highlighted code view. */
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i

/** True when the path names a Markdown document. */
function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.test(path)
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; result: WorkbenchReadResult }
  | { status: 'error'; message: string }

/** Save notice surfaced after a write attempt ('' = no notice). */
type SaveState = { kind: 'saved' | 'error'; message: string } | { kind: 'idle' }

/**
 * The workbench file editor: loads one file on mount or path change and
 * renders Markdown as a read-only preview or other text in the CodeMirror
 * editor with an explicit save. Tracks a dirty flag; Ctrl+S and the header
 * button both save through the version-guarded write.
 */
export function FileViewer({ sessionId, path, readText, writeText, t, onDirtyChange }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  // Reference-stable per locale revision (MarkdownText caches streaming render
  // state keyed by the codeLabels identity).
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const versionRef = useRef<WorkbenchWriteResult['version'] | undefined>(undefined)
  const writeTextRef = useRef(writeText)
  writeTextRef.current = writeText

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    setText('')
    setDirty(false)
    setSave({ kind: 'idle' })
    onDirtyChange?.(path, false)
    void readText(sessionId, path)
      .then((result) => {
        if (!alive) return
        setState({ status: 'ready', result })
        setText(result.content)
        versionRef.current = result.version
      })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
      onDirtyChange?.(path, false)
    }
  }, [sessionId, path, readText, onDirtyChange])

  const saveFile = useCallback(async (): Promise<void> => {
    if (state.status !== 'ready' || ! dirty || saving) return
    if (versionRef.current === undefined) return
    setSaving(true)
    setSave({ kind: 'idle' })
    try {
      const result = await writeTextRef.current(sessionId, path, text, versionRef.current)
      versionRef.current = result.version
      setDirty(false)
      onDirtyChange?.(path, false)
      setSave({ kind: 'saved', message: t('editor.saved') })
    } catch (error: unknown) {
      setSave({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }, [state.status, dirty, saving, sessionId, path, text, t])

  // Ctrl+S anywhere in the viewer saves the open document.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault()
      void saveFile()
    }
  }, [saveFile])

  const markdown = state.status === 'ready' && isMarkdownPath(path)

  return (
    <div className={css.viewer} onKeyDown={onKeyDown}>
      <div className={css.header}>
        <span className={css.title} title={path}>{path || t('viewer.title', { path: '/' })}</span>
        {state.status === 'ready' && !state.result.binary && !markdown ? (
          <div className={css.actions}>
            {save.kind === 'saved' && <span className={css.saved}>{save.message}</span>}
            {save.kind === 'error' && <span className={css.warning} title={save.message}>{t('editor.saveError')}</span>}
            <button
              type="button"
              className={css.saveButton}
              disabled={!dirty || saving}
              onClick={() => void saveFile()}
            >
              {saving ? t('editor.saving') : t('editor.save')}
            </button>
            {dirty ? <span className={css.dirtyDot} aria-label={t('editor.dirty')} /> : null}
          </div>
        ) : null}
      </div>
      <div className={css.body}>
        {state.status === 'loading' && <div className={css.hint}>{t('tree.loading')}</div>}
        {state.status === 'error' && (
          <div className={css.hint}>{t('viewer.openError')}: {state.message}</div>
        )}
        {state.status === 'ready' && state.result.binary && (
          <div className={css.hint}>{t('viewer.binary')}</div>
        )}
        {state.status === 'ready' && !state.result.binary && state.result.truncated && (
          <div className={css.warning}>{t('viewer.truncated')}</div>
        )}
        {state.status === 'ready' && !state.result.binary && markdown && (
          <MarkdownText text={state.result.content} labels={{ code: codeLabels, footnotes: t('footnotes') }} />
        )}
        {state.status === 'ready' && !state.result.binary && !markdown && (
          <CodeEditor
            value={text}
            lang={path}
            onChange={(next) => {
              setText(next)
              setDirty(true)
              setSave({ kind: 'idle' })
              onDirtyChange?.(path, true)
            }}
          />
        )}
      </div>
    </div>
  )
}
