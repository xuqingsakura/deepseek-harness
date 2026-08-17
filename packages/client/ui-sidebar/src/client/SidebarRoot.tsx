/**
 * Sidebar shell: the left column hosts a permanent 56px activity bar (brand
 * mark plus the view-switch icons) and a resizable panel behind it. The
 * activity bar always renders; the panel mounts only while the column is
 * wide (VSCode-style: clicking the active view's icon collapses the panel to
 * the rail, clicking another view switches and reopens it). The workspace
 * browsing region between the New Session button and the foot is the
 * `sidebar.workspaces` registrant's; the workbench file tree is the
 * `sidebar.workbench` registrant's; the foot holds `sidebar.settings` plus
 * `sidebar.footer.action`. The shell hands them the wide flag (plus an
 * expand request callback for the browser).
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconFolderOpenOutline16, IconNewChatOutline16, IconPanelLeftOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Render the sidebar column shell: activity rail + view panel.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  view,
  startSession,
  toggleSidebar,
  setSidebarView,
  workbenchAvailable,
  subscribeWorkbench,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  // The workbench icon appears only while the workbench plugin is installed
  // (it registers the sidebar.workbench seat).
  const hasWorkbench = useSyncExternalStore(subscribeWorkbench, workbenchAvailable)

  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .panel), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const workspacesActive = view !== 'workbench'

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      {/* The permanent activity rail: brand mark on top, view-switch icons
          below. The rail survives collapse — it IS the collapsed column. */}
      <div className={css.activityBar}>
        <Tooltip label={collapsed ? t('toggle.open') : t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            className={css.brandButton}
            aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            <FishLogo className={css.brandFish} size={24} />
          </button>
        </Tooltip>
        <div className={css.activityIcons}>
          <Tooltip label={t('view.workspaces')} delayMs={500}>
            <button
              type="button"
              className={clsx(css.activityIcon, workspacesActive && css.activityIconActive)}
              aria-label={t('view.workspaces')}
              aria-current={workspacesActive || undefined}
              onClick={() => { setSidebarView('default') }}
            >
              <IconNewChatOutline16 size={18} />
            </button>
          </Tooltip>
          {hasWorkbench ? (
            <Tooltip label={t('view.workbench')} delayMs={500}>
              <button
                type="button"
                className={clsx(css.activityIcon, view === 'workbench' && css.activityIconActive)}
                aria-label={t('view.workbench')}
                aria-current={view === 'workbench' || undefined}
                onClick={() => { setSidebarView('workbench') }}
              >
                <IconFolderOpenOutline16 size={18} />
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className={css.activitySpacer} />
        <Tooltip label={collapsed ? t('toggle.open') : t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            className={css.activityIcon}
            aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            <IconPanelLeftOutline16 size={18} />
          </button>
        </Tooltip>
        {/* Settings rides the rail bottom (VSCode-style gear), always
            reachable whether the panel is wide or collapsed. */}
        {renderSlot('sidebar.settings', { wide: false })}
      </div>

      {/* The wide panel mounts only while the column is wide. */}
      {wide && (
        <div className={css.panel}>
          <div className={css.panelHeader}>
            <span className={css.panelTitle}>
              {workspacesActive ? t('view.workspaces') : t('view.workbench')}
            </span>
          </div>

          {workspacesActive && (
            <Tooltip label={t('session.new.label')} delayMs={500} disabled>
              <button
                type="button"
                className={css.newSession}
                aria-label={t('session.new.label')}
                onClick={() => { startSession() }}
              >
                <IconNewChatOutline16 size={14} />
                <span className={css.newSessionLabel}>{t('session.new')}</span>
              </button>
            </Tooltip>
          )}

          {/* The browsing region fills the panel between the header and the
              foot; the active view decides which region renders. */}
          <div className={css.regionArea}>
            {view === 'workbench'
              ? renderSlot('sidebar.workbench', {
                wide,
                expandSidebar: () => { if (collapsed) toggleSidebar() },
              })
              : renderSlot('sidebar.workspaces', {
                wide,
                expandSidebar: () => { if (collapsed) toggleSidebar() },
              })}
          </div>

          <div className={css.footArea}>
            <div className={css.footerActions}>
              {renderSlot('sidebar.footer.action', { wide })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
