/** In-workbench browser: an address bar with navigation controls over an
 * embedded iframe. It lives in the center viewer column while the
 * workbench browser tab is active, so the conversation stays on the right
 * and the file tree on the left. Sites that forbid framing (
 * X-Frame-Options / CSP frame-ancestors) render an explanatory notice.
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './WorkbenchBrowserPanel.module.css'

/** Full props for the browser panel. */
export interface WorkbenchBrowserPanelProps {
  /** The URL currently loaded (or empty for the blank start page). */
  url: string
  /** Navigate to a URL; empty clears the frame. */
  onNavigate: (url: string) => void
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** Default landing URL when the panel opens. */
const HOME_URL = 'https://www.deepseek.com'

/**
 * Normalize user input into a navigable URL: bare domains get https://.
 * @param raw - the address-bar text.
 * @returns the normalized URL, or the raw value when it is not a URL-looking string.
 */
export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  // A colon followed by a digit is a port (localhost:3000), not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(trimmed)) return trimmed
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(trimmed) || /^localhost(:\d+)?(\/|$)/i.test(trimmed)) {
    return 'https://' + trimmed
  }
  return trimmed
}

/**
 * Render the embedded browser panel.
 * @param props - url, navigation verb, and copy.
 * @returns the browser column.
 */
export function WorkbenchBrowserPanel({ url, onNavigate, t }: WorkbenchBrowserPanelProps): ReactNode {
  const [input, setInput] = useState(url)
  const [address, setAddress] = useState(url)
  const history = useRef<string[]>([])
  const cursor = useRef(-1)

  const go = (next: string): void => {
    const normalized = normalizeBrowserUrl(next)
    setInput(normalized)
    setAddress(normalized)
    const stack = history.current
    stack.splice(cursor.current + 1, stack.length, normalized)
    cursor.current = stack.length - 1
    onNavigate(normalized)
  }

  const back = (): void => {
    if (cursor.current <= 0) return
    cursor.current -= 1
    const target = history.current[cursor.current] ?? ''
    setInput(target)
    setAddress(target)
    onNavigate(target)
  }

  const forward = (): void => {
    if (cursor.current >= history.current.length - 1) return
    cursor.current += 1
    const target = history.current[cursor.current] ?? ''
    setInput(target)
    setAddress(target)
    onNavigate(target)
  }

  const submit = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') go(input)
  }

  const canBack = cursor.current > 0
  const canForward = cursor.current < history.current.length - 1

  return (
    <div className={css.browser} data-workbench-browser>
      <div className={css.bar}>
        <button type="button" className={css.nav} onClick={back} disabled={!canBack} aria-label={t('browser.back')} title={t('browser.back')}>
          ←
        </button>
        <button type="button" className={css.nav} onClick={forward} disabled={!canForward} aria-label={t('browser.forward')} title={t('browser.forward')}>
          →
        </button>
        <button type="button" className={css.nav} onClick={() =>{  go(HOME_URL) }} aria-label={t('browser.home')} title={t('browser.home')}>
          ⌂
        </button>
        <button type="button" className={css.nav} onClick={() => { const current = address; setAddress(''); go(current) }} aria-label={t('browser.reload')} title={t('browser.reload')}>
          ⟳
        </button>
        <input
          className={css.address}
          type="text"
          value={input}
          placeholder={t('browser.addressPlaceholder')}
          aria-label={t('browser.addressAria')}
          onChange={(event) =>{  setInput(event.currentTarget.value) }}
          onKeyDown={submit}
          spellCheck={false}
        />
        <button type="button" className={css.go} onClick={() =>{  go(input) }} disabled={input.trim() === ''}>
          {t('browser.go')}
        </button>
      </div>
      {address === '' ? (
        <div className={css.blank}>{t('browser.blank')}</div>
      ) : (
        <iframe
          className={css.frame}
          src={address}
          title={t('browser.title')}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  )
}
