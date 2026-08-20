/**
 * Real-UI assembly closure, invoked by the app-shell plugin once its inject
 * set is active: the whole layout tree hangs off the built-in 'root' slot
 * (ui-layout registers AppFrame there and renders the child slots
 * internally) — the shell's render is the one ctx-level renderSlot call in
 * the program.
 */
import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the runtime's SlotMap declaration merge (the 'root' key) into this program.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { DocumentTitle } from './DocumentTitle.tsx'

/** Assembly inputs: the active app-shell plugin ctx (slots/sessions/layout services provided). */
export interface AssemblyDeps {
  /** Client context with the assembly's inject set active. */
  ctx: Context
}

/** The workbench layout face this boot glue needs — structural only, so the
 * web package stays free of ui-layout's package reference (its tsconfig
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
 * Build the renderApp factory the app-shell plugin provides to AppRoot.
 * @param deps - assembly inputs.
 * @returns factory producing the real UI tree (called once per AppRoot render after settled).
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('shell assembly: sessions service unavailable')
  const layout = ctx.get('layout') as WorkbenchLayoutLike | undefined
  const useSessions = bindSnapshotSelector(sessions.list)
  const SessionDocumentTitle = (): ReactNode => {
    const title = useSessions((state) => {
      const id = state.current
      return id === undefined ? undefined : state.byId[id]?.title
    })
    return <DocumentTitle {...title === undefined ? {} : { title }} />
  }
  return () => (
    <>
      <SessionDocumentTitle />
      {workbenchWindowParams() !== null && (
        <WorkbenchWindowBoot sessions={sessions} layout={layout} />
      )}
      {ctx.slots.renderSlot('root', {})}
    </>
  )
}
