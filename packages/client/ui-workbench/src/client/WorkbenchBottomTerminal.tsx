/** Bottom terminal strip: the VSCode-style terminal panel in the frame's
 * bottom row. The session binding mirrors the file tree (the header toggle's
 * pinned session, current as fallback), so the shell follows the workbench
 * view the user is working in. */

import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { WorkbenchStateHandle } from './workbench-store.ts'
import { WorkbenchTerminalPanel, type WorkbenchTerminalPanelInjected } from './WorkbenchTerminalPanel.tsx'
import css from './WorkbenchBottomTerminal.module.css'

/** Full props for the bottom terminal strip. */
export type WorkbenchBottomTerminalProps =
  PropsLocale<typeof NS>
  & WorkbenchTerminalPanelInjected
  & {
    /** The workbench state handle (pinned session + tab state). */
    workbench: WorkbenchStateHandle
    /** The session list feed; its current selection is the fallback binding. */
    sessions: ObservableSnapshot<SessionListState>
    /** The layout panel face (closes the bottom strip). */
    layout: ILayout
  }

/**
 * The bottom terminal: resolves the session the tree is bound to and renders
 * the shared terminal panel. When no session is available the strip shows a
 * quiet empty state instead of a broken shell.
 */
export function WorkbenchBottomTerminal({ workbench, sessions, layout, t, ...verbs }: WorkbenchBottomTerminalProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot)
  const currentSessionId = useSyncExternalStore(listener => sessions.subscribe(listener), () => sessions.getSnapshot().current)
  const sessionId = state.sessionId ?? currentSessionId
  if (sessionId === undefined) return <div className={css.empty}>{t('tree.loading')}</div>
  return <WorkbenchTerminalPanel sessionId={sessionId} onClose={() =>{  layout.closeBottom() }} t={t} {...verbs} />
}

export default WorkbenchBottomTerminal
