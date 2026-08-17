/** CodeMirror-based code editor for workbench files: syntax highlighting,
 * line numbers, search, history, and optional read-write editing. The theme
 * follows the app's `body[data-ds-dark-theme]` attribute live, so the editor
 * matches the surrounding light/dark palette without a restart. */

import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage, bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine,
  highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view'
import { langFromPath } from './file-lang.ts'
import styles from './CodeEditor.module.css'

/** Map one file-language hint to its CodeMirror language extension. */
function languageSupportFor(lang: string | undefined): Extension {
  switch (lang) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: lang === 'tsx' })
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: lang === 'jsx' })
    case 'json':
    case 'jsonc':
      return json()
    case 'py':
      return python()
    case 'java':
      return java()
    case 'rs':
      return rust()
    case 'php':
      return php()
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'hpp':
    case 'cxx':
      return cpp()
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell)
    case 'yaml':
    case 'yml':
      return yaml()
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'sql':
      return sql()
    case 'xml':
      return xml()
    case 'lua':
      return StreamLanguage.define(lua)
    case 'md':
    case 'markdown':
    case 'mdx':
      return markdown()
    default:
      return []
  }
}

/** True when the app is currently in the dark palette. */
function isDarkTheme(): boolean {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** Build the CodeMirror extension set for one state/reconfigure. */
function buildExtensions(
  dark: boolean,
  readOnly: boolean,
  onChange: ((value: string) => void) | undefined,
  language: Extension,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    EditorView.lineWrapping,
    readOnly === true ? EditorState.readOnly.of(true) : [],
    language,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && readOnly === false) onChange?.(update.state.doc.toString())
    }),
    EditorView.theme(
      {
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
        '&.cm-focused': { outline: 'none' },
      },
      { dark },
    ),
    dark === true ? oneDark : [],
  ]
}

/** Full props for the CodeMirror editor. */
export interface CodeEditorProps {
  /** The document text to show. */
  value: string
  /** Optional language hint from a file path. */
  lang?: string | undefined
  /** Disable editing when true. */
  readOnly?: boolean | undefined
  /** Report edited text (read-write mode only). */
  onChange?: ((value: string) => void) | undefined
}

/**
 * One CodeMirror editor instance. The view is recreated when the document,
 * language, or read-only flag changes; theme switches (light/dark) are applied
 * live through a MutationObserver on the body attribute.
 */
export function CodeEditor({ value, lang, readOnly = false, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const language = languageSupportFor(langFromPath(lang ?? ''))

  useEffect(() => {
    const host = hostRef.current
    /* v8 ignore next -- the host div is always attached by effect time */
    if (host === null) return
    let view: EditorView | null = null
    const recreate = (): void => {
      if (view !== null) view.destroy()
      const extensions = buildExtensions(isDarkTheme(), readOnlyRef.current, next => onChangeRef.current?.(next), language)
      const state = EditorState.create({ doc: value, extensions })
      view = new EditorView({ state, parent: host })
    }
    recreate()
    const observer = new MutationObserver(() => {
      const nowDark = isDarkTheme()
      if (view !== null) {
        view.dispatch({ effects: StateEffect.reconfigure.of(
          buildExtensions(nowDark, readOnlyRef.current, next => onChangeRef.current?.(next), language),
        ) })
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      observer.disconnect()
      view?.destroy()
    }
    // The editor re-initializes on document/language/read-only changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- language derives from lang; value/readOnly are intentional keys.
  }, [value, lang, readOnly])

  return <div ref={hostRef} className={styles.host} />
}

export default CodeEditor
