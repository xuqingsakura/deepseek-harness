/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from './bind.ts'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** Inputs available after the UI renderer's inject set activates. */
export interface AssemblyDeps {
  /** Client context carrying the renderer-owned Slot registry. */
  ctx: Context
}

/** The workbench layout face this boot glue needs — structural only, so the
 * renderer stays free of ui-layout's package reference (its tsconfig
 * references do not include ui-layout; a value import would drag that
 * package's source into this program via the tsconfig paths facade). */
interface WorkbenchLayoutLike {
  openWorkbench(): void
}

/** Whether this renderer is the detached VSCode-style workbench window. */
function workbenchWindowParams(): URLSearchParams | null {
  const search = new URLSearchParams(window.location.search)
  return search.get('dshWindow') === 'workbench' ? search : null
}

/**
 * Boot glue for the detached workbench window: once the session list is ready,
 * select the URL-pinned session (when present) and open the three-column
 * file workbench. The AppFrame layout then renders the file tree in the
 * sidebar, the viewer in the center, and the conversation on the right.
 */
function WorkbenchWindowBoot(props: {
  sessions: ISessions
  layout: WorkbenchLayoutLike | undefined
}) {
  const { sessions, layout } = props
  const useSessions = bindSnapshotSelector(sessions.list)
  const state = useSessions(s => ({ phase: s.phase, current: s.current }))
  const target = useMemo(() => workbenchWindowParams()?.get('session') ?? null, [])
  useEffect(() => {
    if (state.phase !== 'ready') return
    if (target !== null && target !== '' && target !== state.current) {
      try {
        sessions.open(target as SessionId)
      } catch {
        // Unknown/removed session: fall through to the persisted current one.
      }
    }
    layout?.openWorkbench()
  }, [state.phase, state.current, target, sessions, layout])
  return null
}

/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('ui renderer: sessions service unavailable')
  const layout = ctx.get('layout') as WorkbenchLayoutLike | undefined
  return () => (
    <>
      {workbenchWindowParams() !== null && (
        <WorkbenchWindowBoot sessions={sessions} layout={layout} />
      )}
      {ctx.slots.renderSlot('root', {})}
    </>
  )
}
