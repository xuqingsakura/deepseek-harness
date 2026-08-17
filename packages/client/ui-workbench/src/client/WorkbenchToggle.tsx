/** Workbench header toggle: opens the workbench bound to this conversation. */

import { useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import type { WorkbenchStateHandle } from './workbench-store.ts'
import css from './WorkbenchToggle.module.css'

/** Full props for the session-header workbench toggle. */
export type WorkbenchToggleProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & { workbench: WorkbenchStateHandle; layout: ILayout }

/**
 * The header action that opens the workbench for this session. The button is
 * pressed while the panel is open and bound to the same conversation.
 */
export function WorkbenchToggle({ sessionId, workbench, layout, t }: WorkbenchToggleProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot)
  const active = state.open && state.sessionId === sessionId
  return (
    <button
      type="button"
      className={css.trigger}
      aria-pressed={active}
      aria-label={t('toggle.aria')}
      onClick={() => {
        if (active) {
          workbench.set({ open: false })
          layout.closeWorkbench()
        } else {
          // Switching conversations drops the previous session's open tabs.
          workbench.set(state.sessionId === sessionId
            ? { sessionId, open: true }
            : { sessionId, open: true, openPaths: [], activePath: undefined })
          layout.openWorkbench()
        }
      }}
    >
      {t('toggle.open')}
    </button>
  )
}
