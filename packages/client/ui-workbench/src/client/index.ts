/**
 * Workbench UI plugin, browser half: a session-header toggle switches the
 * layout to the file-workbench view — a lazy file tree in the left sidebar
 * and a read-only text viewer in the center column, with the conversation
 * moving to the right column — backed entirely by the session-scoped
 * workbench Remote (`ctx.remote.workbench`), which in turn rides `ctx.fs` on
 * the host.
 */
import type { WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the generated Remote API (ctx.remote.workbench) through the
// Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type WorkbenchKey } from './locales.ts'
import { createWorkbenchState, type WorkbenchStateHandle } from './workbench-store.ts'
import { WorkbenchToggle, type WorkbenchToggleProps } from './WorkbenchToggle.tsx'
import { WorkbenchTreePanel, type WorkbenchTreePanelInjected, type WorkbenchTreePanelProps } from './WorkbenchTreePanel.tsx'
import { WorkbenchBottomTerminal, type WorkbenchBottomTerminalProps } from './WorkbenchBottomTerminal.tsx'
import type { WorkbenchTerminalPanelInjected } from './WorkbenchTerminalPanel.tsx'
import { WorkbenchViewerPanel, type WorkbenchViewerInjected, type WorkbenchViewerPanelProps } from './WorkbenchViewerPanel.tsx'

export type { WorkbenchTreePanelInjected, WorkbenchTreePanelProps } from './WorkbenchTreePanel.tsx'
export type { WorkbenchTerminalPanelInjected } from './WorkbenchTerminalPanel.tsx'
export type { WorkbenchTerminalPanelProps } from './WorkbenchTerminalPanel.tsx'
export type { WorkbenchBottomTerminalProps } from './WorkbenchBottomTerminal.tsx'
export type { WorkbenchViewerInjected, WorkbenchViewerPanelProps } from './WorkbenchViewerPanel.tsx'
export type { WorkbenchToggleProps } from './WorkbenchToggle.tsx'
export type { WorkbenchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench panel copy. */
    workbench: WorkbenchKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workbench'

/** Required services: the slot registry, locale, the workbench Remote face, and the session list feed. */
export const inject = ['slots', 'locale', 'remote', 'remote.workbench', 'layout', 'sessions']

/** Surface one Remote failure as an Error with the method name. */
function remoteFailure(method: string, error: { code: string; message: string }): Error {
  return new Error(`workbench.${method} failed: ${error.code}: ${error.message}`)
}

/**
 * Append `@<relative path>` to a session's composer draft through the
 * conversation service (the same lazy `ctx.get` read the app's own plugins
 * use). A missing service or session scope degrades to a logged no-op.
 * @param ctx - client root context.
 * @param sessionId - the conversation whose composer receives the reference.
 * @param relPath - the relative path to append.
 */
function referenceInDraft(ctx: ClientContext, sessionId: string, relPath: string): void {
  try {
    const scope = ctx.sessions.scope(sessionId as SessionId)
    if (scope === undefined) return
    const conversation = ctx.get('conversation') as {
      input: { for: (actx: unknown) => { state: { getSnapshot: () => { draft: string } }; setDraft: (text: string) => void } }
    } | undefined
    if (conversation === undefined) return
    const input = conversation.input.for(scope)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? `@${relPath}` : `${draft} @${relPath}`)
  } catch (error) {
    console.warn('[ui-workbench] draft reference failed:', error)
  }
}

/**
 * Client plugin body: register the dictionaries, the header toggle, the
 * file-tree panel, and the center-column viewer over one shared workbench
 * state handle.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workbench: dictionaries')
  const workbench = createWorkbenchState()

  const treeInjected = (): WorkbenchTreePanelInjected => ({
    cwd: async (sessionId) => {
      const result = await ctx.remote.workbench.cwd(sessionId)
      if (!result.ok) throw remoteFailure('cwd', result.error)
      return result.value.path
    },
    listDir: async (sessionId, path) => {
      const result = await ctx.remote.workbench.listDir(sessionId, path)
      if (!result.ok) throw remoteFailure('listDir', result.error)
      return result.value
    },
    searchFiles: async (sessionId, query) => {
      const result = await ctx.remote.workbench.searchFiles(sessionId, query)
      if (!result.ok) throw remoteFailure('searchFiles', result.error)
      return result.value
    },
    referenceFile: (sessionId, relPath) => { referenceInDraft(ctx, sessionId, relPath) },
    terminalSpawn: async (sessionId) => {
      const result = await ctx.remote.workbench.terminalSpawn(sessionId, undefined)
      if (!result.ok) throw remoteFailure('terminalSpawn', result.error)
      return result.value
    },
    terminalWrite: async (sessionId, id, data) => {
      const result = await ctx.remote.workbench.terminalWrite(sessionId, id, data)
      if (!result.ok) throw remoteFailure('terminalWrite', result.error)
    },
    terminalRead: async (sessionId, id) => {
      const result = await ctx.remote.workbench.terminalRead(sessionId, id)
      if (!result.ok) throw remoteFailure('terminalRead', result.error)
      return result.value
    },
    terminalClose: async (sessionId, id) => {
      const result = await ctx.remote.workbench.terminalClose(sessionId, id)
      if (!result.ok) throw remoteFailure('terminalClose', result.error)
    },
    terminalCloseSession: async (sessionId) => {
      const result = await ctx.remote.workbench.terminalCloseSession(sessionId)
      if (!result.ok) throw remoteFailure('terminalCloseSession', result.error)
    },
    gitStatus: async (sessionId) => {
      const result = await ctx.remote.workbench.gitStatus(sessionId)
      if (!result.ok) throw remoteFailure('gitStatus', result.error)
      return result.value
    },
    gitDiff: async (sessionId, path, staged) => {
      const result = await ctx.remote.workbench.gitDiff(sessionId, path, staged)
      if (!result.ok) throw remoteFailure('gitDiff', result.error)
      return result.value
    },
    gitLog: async (sessionId, limit) => {
      const result = await ctx.remote.workbench.gitLog(sessionId, limit)
      if (!result.ok) throw remoteFailure('gitLog', result.error)
      return result.value
    },
    gitBranches: async (sessionId) => {
      const result = await ctx.remote.workbench.gitBranches(sessionId)
      if (!result.ok) throw remoteFailure('gitBranches', result.error)
      return result.value
    },
    gitAdd: async (sessionId, paths) => {
      const result = await ctx.remote.workbench.gitAdd(sessionId, paths)
      if (!result.ok) throw remoteFailure('gitAdd', result.error)
    },
    gitRestore: async (sessionId, paths, staged) => {
      const result = await ctx.remote.workbench.gitRestore(sessionId, paths, staged)
      if (!result.ok) throw remoteFailure('gitRestore', result.error)
    },
    gitCommit: async (sessionId, message) => {
      const result = await ctx.remote.workbench.gitCommit(sessionId, message)
      if (!result.ok) throw remoteFailure('gitCommit', result.error)
    },
    gitCheckout: async (sessionId, branch) => {
      const result = await ctx.remote.workbench.gitCheckout(sessionId, branch)
      if (!result.ok) throw remoteFailure('gitCheckout', result.error)
    },
    gitFetch: async (sessionId, remote) => {
      const result = await ctx.remote.workbench.gitFetch(sessionId, remote)
      if (!result.ok) throw remoteFailure('gitFetch', result.error)
    },
    gitPull: async (sessionId) => {
      const result = await ctx.remote.workbench.gitPull(sessionId)
      if (!result.ok) throw remoteFailure('gitPull', result.error)
    },
    gitPush: async (sessionId, remote, branch) => {
      const result = await ctx.remote.workbench.gitPush(sessionId, remote, branch)
      if (!result.ok) throw remoteFailure('gitPush', result.error)
    },
    fsMkdir: async (sessionId, path) => {
      const result = await ctx.remote.workbench.fsMkdir(sessionId, path)
      if (!result.ok) throw remoteFailure('fsMkdir', result.error)
    },
    fsRename: async (sessionId, path, nextPath) => {
      const result = await ctx.remote.workbench.fsRename(sessionId, path, nextPath)
      if (!result.ok) throw remoteFailure('fsRename', result.error)
    },
    fsRemove: async (sessionId, path, recursive) => {
      const result = await ctx.remote.workbench.fsRemove(sessionId, path, recursive)
      if (!result.ok) throw remoteFailure('fsRemove', result.error)
    },
    writeText: async (sessionId, path, content, version?: WorkbenchWriteResult['version']) => {
      const result = await ctx.remote.workbench.writeText(sessionId, path, content, version)
      if (!result.ok) throw remoteFailure('writeText', result.error)
      return result.value
    },
    // The tree falls back to the current session when the workbench view was
    // opened from the activity bar (which flips only the layout view).
    sessions: ctx.sessions.list,
  })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'workbench-toggle',
    order: 30,
    locale: NS,
    inject: () => ({ workbench, layout: ctx.layout }),
  }, WorkbenchToggle))

  ctx.slots.inject('sidebar.workbench', () => ctx.slots.register({
    name: 'sidebar.workbench',
    locale: NS,
    inject: () => ({ ...treeInjected(), workbench, layout: ctx.layout }),
  }, WorkbenchTreePanel))

  // The center-column viewer shares the same state handle: opening a file in
  // the tree hands the path to this seat, which the layout places in the
  // middle column while the workbench view is active.
  ctx.slots.inject('workbench.viewer', () => ctx.slots.register({
    name: 'workbench.viewer',
    locale: NS,
    inject: (): WorkbenchViewerInjected & { workbench: WorkbenchStateHandle } => ({
      readText: async (sessionId: string, path: string) => {
        const result = await ctx.remote.workbench.readText(sessionId, path)
        if (!result.ok) throw remoteFailure('readText', result.error)
        return result.value
      },
      writeText: async (sessionId: string, path: string, content: string, version: WorkbenchWriteResult['version']) => {
        const result = await ctx.remote.workbench.writeText(sessionId, path, content, version)
        if (!result.ok) throw remoteFailure('writeText', result.error)
        return result.value
      },
      gitDiff: async (sessionId: string, path: string, staged: boolean) => {
        const result = await ctx.remote.workbench.gitDiff(sessionId, path, staged)
        if (!result.ok) throw remoteFailure('gitDiff', result.error)
        return result.value
      },
      // Same current-session fallback the tree uses (activity-bar entry).
      sessions: ctx.sessions.list,
      workbench,
    }),
  }, WorkbenchViewerPanel))

  // The bottom terminal panel (VSCode-style): a session-scoped shell strip
  // rendered in the frame's bottom row while open. The session binding
  // mirrors the tree (the header toggle's pinned session, current as
  // fallback), so the terminal follows the file workbench.
  ctx.slots.inject('workbench.bottom', () => ctx.slots.register({
    name: 'workbench.bottom',
    locale: NS,
    inject: (): Pick<WorkbenchBottomTerminalProps, 'workbench' | 'sessions' | 'layout'> & WorkbenchTerminalPanelInjected => ({
      terminalSpawn: async (sessionId) => {
        const result = await ctx.remote.workbench.terminalSpawn(sessionId, undefined)
        if (!result.ok) throw remoteFailure('terminalSpawn', result.error)
        return result.value
      },
      terminalWrite: async (sessionId, id, data) => {
        const result = await ctx.remote.workbench.terminalWrite(sessionId, id, data)
        if (!result.ok) throw remoteFailure('terminalWrite', result.error)
      },
      terminalRead: async (sessionId, id) => {
        const result = await ctx.remote.workbench.terminalRead(sessionId, id)
        if (!result.ok) throw remoteFailure('terminalRead', result.error)
        return result.value
      },
      terminalClose: async (sessionId, id) => {
        const result = await ctx.remote.workbench.terminalClose(sessionId, id)
        if (!result.ok) throw remoteFailure('terminalClose', result.error)
      },
      terminalCloseSession: async (sessionId) => {
        const result = await ctx.remote.workbench.terminalCloseSession(sessionId)
        if (!result.ok) throw remoteFailure('terminalCloseSession', result.error)
      },
      sessions: ctx.sessions.list,
      workbench,
      layout: ctx.layout,
    }),
  }, WorkbenchBottomTerminal))
}

export type {
  WorkbenchToggleProps as _WorkbenchTogglePropsAlias,
  WorkbenchTreePanelProps as _WorkbenchTreePanelPropsAlias,
  WorkbenchViewerPanelProps as _WorkbenchViewerPanelPropsAlias,
}
