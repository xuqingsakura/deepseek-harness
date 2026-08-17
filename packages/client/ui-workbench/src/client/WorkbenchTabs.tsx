/** Workbench editor tab bar: one tab per open file, click to activate, × to
 * close, and a right-click menu for batch close actions. */

import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fileBadge } from './file-lang.ts'
import { NS } from './locales.ts'
import css from './WorkbenchTabs.module.css'

/** Full props for the workbench tab bar. */
export interface WorkbenchTabsProps {
  /** Open file paths in open order (first tab leftmost). */
  paths: readonly string[]
  /** The active file path (highlighted tab). */
  activePath: string | undefined
  /** Activate one open file. */
  onSelect(path: string): void
  /** Close one open file. */
  onClose(path: string): void
  /** Close every tab except one. */
  onCloseOthers(path: string): void
  /** Close every tab. */
  onCloseAll(): void
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** The basename of a path (forward- or backslash separated). */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * The tab bar above the file viewer: one tab per open file, the active one
 * highlighted, each with a file-type badge and a close button. Right-clicking
 * a tab opens a small context menu (close this / others / all) that dismisses
 * on outside click or Escape.
 */
export function WorkbenchTabs({ paths, activePath, onSelect, onClose, onCloseOthers, onCloseAll, t }: WorkbenchTabsProps) {
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Dismiss the menu on outside pointer-down or Escape.
  useEffect(() => {
    if (menu === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  return (
    <div className={css.bar} role="tablist">
      {paths.map((path) => {
        const active = path === activePath
        const badge = fileBadge(path)
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            className={active ? css.tabActive : css.tab}
            title={path}
            onClick={() => onSelect(path)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ path, x: event.clientX, y: event.clientY })
            }}
          >
            <span className={css.badge} style={{ background: badge.color }}>{badge.label}</span>
            <span className={css.label}>{basename(path)}</span>
            <button
              type="button"
              className={css.close}
              aria-label={t('tab.close')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(path)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
      {menu !== undefined ? (
        <div
          ref={menuRef}
          className={css.menu}
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={t('tab.menuAria')}
        >
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            onClick={() => { onClose(menu.path); setMenu(undefined) }}
          >
            {t('tab.closeThis')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            disabled={paths.length <= 1}
            onClick={() => { onCloseOthers(menu.path); setMenu(undefined) }}
          >
            {t('tab.closeOthers')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.menuItem}
            disabled={paths.length === 0}
            onClick={() => { onCloseAll(); setMenu(undefined) }}
          >
            {t('tab.closeAll')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
