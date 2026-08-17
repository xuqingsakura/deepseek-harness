// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as layoutApply, inject as layoutInject } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as themeApply, inject as themeInject } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'
import { WorkbenchToggle } from '../src/client/WorkbenchToggle.tsx'
import { WorkbenchTreePanel, type WorkbenchTreePanelInjected, type WorkbenchTreePanelProps } from '../src/client/WorkbenchTreePanel.tsx'
import { WorkbenchViewerPanel, type WorkbenchViewerInjected, type WorkbenchViewerPanelProps } from '../src/client/WorkbenchViewerPanel.tsx'
import { createWorkbenchState, type WorkbenchStateHandle } from '../src/client/workbench-store.ts'
import { en, zh } from '../src/client/locales.ts'
import type { WorkbenchReadResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const CWD = { path: 'C:\\work' }
const LIST = [{ name: 'a.txt', type: 'file' as const, size: 5 }]
const READ: WorkbenchReadResult = {
  content: 'hello', truncated: false, binary: false, size: 5,
  version: 'v1' as WorkbenchReadResult['version'],
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const cwd = vi.fn<(sessionId: string) => Promise<RemoteResult<typeof CWD>>>().mockResolvedValue({ ok: true, value: CWD })
  const listDir = vi.fn<(sessionId: string, path: string) => Promise<RemoteResult<typeof LIST>>>()
    .mockResolvedValue({ ok: true, value: LIST })
  const readText = vi.fn<(sessionId: string, path: string) => Promise<RemoteResult<typeof READ>>>()
    .mockResolvedValue({ ok: true, value: READ })
  const writeText = vi.fn<
    (sessionId: string, path: string, content: string, version: string) =>
    Promise<RemoteResult<{ version: string }>>
  >().mockResolvedValue({ ok: true, value: { version: 'v2' } })
  const terminalSpawn = vi.fn().mockResolvedValue({ ok: true, value: { session: { id: 't0', status: 'running', exitCode: null }, shell: 'powershell.exe' } })
  const terminalWrite = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const terminalRead = vi.fn().mockResolvedValue({ ok: true, value: { delta: '', session: { id: 't0', status: 'running', exitCode: null } } })
  const terminalClose = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const terminalCloseSession = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const gitStatus = vi.fn().mockResolvedValue({ ok: true, value: { isRepo: false, branch: '', changes: [] } })
  const gitDiff = vi.fn().mockResolvedValue({ ok: true, value: { diff: '', binary: false } })
  const gitLog = vi.fn().mockResolvedValue({ ok: true, value: [] })
  const gitBranches = vi.fn().mockResolvedValue({ ok: true, value: [] })
  const gitAdd = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const gitRestore = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const gitCommit = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const gitCheckout = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  ctx.provide('remote.workbench', {
    cwd, listDir, readText, writeText,
    terminalSpawn, terminalWrite, terminalRead, terminalClose, terminalCloseSession,
    gitStatus, gitDiff, gitLog, gitBranches, gitAdd, gitRestore, gitCommit, gitCheckout,
  })
  const openWorkbench = vi.fn()
  const closeWorkbench = vi.fn()
  ctx.provide('layout', {
    toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    toggleBottom: vi.fn(), closeBottom: vi.fn(),
    openWorkbench, closeWorkbench, setSidebarView: vi.fn(),
  })
  // The tree falls back to the current session (activity-bar entry); the
  // list snapshot carries the current selection the panel reads. The id is
  // settable so tests can exercise the no-session hide state too.
  const currentSession = { id: 's1' as SessionId | undefined }
  const sessionsList = {
    getSnapshot: (): SessionListState => ({
      ids: ['s1' as SessionId], byId: {}, current: currentSession.id, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }),
    subscribe: () => () => {},
  }
  ctx.provide('sessions', { list: sessionsList })
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, cwd, listDir, readText, writeText,
    terminalSpawn, terminalWrite, terminalRead, terminalClose, terminalCloseSession,
    gitStatus, gitDiff, gitLog, gitBranches, gitAdd, gitRestore, gitCommit, gitCheckout,
    openWorkbench, closeWorkbench, sessionsList, currentSession,
  }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'sidebar.workbench': { kind: 'single', scope: 'root' },
      'workbench.viewer': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
}


/** Build the tree-panel props a real slot render would compose (runtime props stubbed). */
function treePanelProps(
  b: Awaited<ReturnType<typeof bench>>,
  workbench: WorkbenchStateHandle,
  t: TranslateNS<'workbench'>,
): WorkbenchTreePanelProps {
  return {
    workbench,
    t,
    cwd: async (sessionId: string) => {
      const r = await b.cwd(sessionId)
      if (!r.ok) throw new Error(r.error.message)
      return r.value.path
    },
    listDir: async (sessionId: string, path: string) => {
      const r = await b.listDir(sessionId, path)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    terminalSpawn: async (sessionId: string) => {
      const r = await b.terminalSpawn(sessionId)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    terminalWrite: async (sessionId: string, id: string, data: string) => {
      const r = await b.terminalWrite(sessionId, id, data)
      if (!r.ok) throw new Error(r.error.message)
    },
    terminalRead: async (sessionId: string, id: string) => {
      const r = await b.terminalRead(sessionId, id)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    terminalClose: async (sessionId: string, id: string) => {
      const r = await b.terminalClose(sessionId, id)
      if (!r.ok) throw new Error(r.error.message)
    },
    terminalCloseSession: async (sessionId: string) => {
      const r = await b.terminalCloseSession(sessionId)
      if (!r.ok) throw new Error(r.error.message)
    },
    gitStatus: async (sessionId: string) => {
      const r = await b.gitStatus(sessionId)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    gitDiff: async (sessionId: string, path?: string, staged?: boolean) => {
      const r = await b.gitDiff(sessionId, path, staged)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    gitLog: async (sessionId: string, limit?: number) => {
      const r = await b.gitLog(sessionId, limit)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    gitBranches: async (sessionId: string) => {
      const r = await b.gitBranches(sessionId)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    gitAdd: async (sessionId: string, paths?: string[]) => {
      const r = await b.gitAdd(sessionId, paths)
      if (!r.ok) throw new Error(r.error.message)
    },
    gitRestore: async (sessionId: string, paths: string[], staged?: boolean) => {
      const r = await b.gitRestore(sessionId, paths, staged)
      if (!r.ok) throw new Error(r.error.message)
    },
    gitCommit: async (sessionId: string, message: string) => {
      const r = await b.gitCommit(sessionId, message)
      if (!r.ok) throw new Error(r.error.message)
    },
    gitCheckout: async (sessionId: string, branch: string) => {
      const r = await b.gitCheckout(sessionId, branch)
      if (!r.ok) throw new Error(r.error.message)
    },
    sessions: b.sessionsList,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    sessionId: 's1' as never,
  } as unknown as WorkbenchTreePanelProps
}

/** Build the viewer-panel props a real slot render would compose (runtime props stubbed). */
function viewerPanelProps(
  b: Awaited<ReturnType<typeof bench>>,
  workbench: WorkbenchStateHandle,
  t: TranslateNS<'workbench'>,
): WorkbenchViewerPanelProps {
  return {
    workbench,
    t,
    readText: async (sessionId: string, path: string) => {
      const r = await b.readText(sessionId, path)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    writeText: async (sessionId: string, path: string, content: string, version: string) => {
      const r = await b.writeText(sessionId, path, content, version)
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    },
    sessions: b.sessionsList,
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    sessionId: 's1' as never,
  } as unknown as WorkbenchViewerPanelProps
}

describe('ui-workbench browser plugin', () => {
  it('declares only the services the workbench UI consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.workbench', 'layout', 'sessions'])
  })

  it('registers a header toggle, a file-tree panel, and a center-column viewer with one shared state handle', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const toggles = b.slots.entries('conversation.session.header.actions')
    expect(toggles).toHaveLength(1)
    expect(toggles[0]!.component).toBe(WorkbenchToggle)
    expect(toggles[0]!.options).toMatchObject({ id: 'workbench-toggle', order: 30 })

    const trees = b.slots.entries('sidebar.workbench')
    expect(trees).toHaveLength(1)
    expect(trees[0]!.component).toBe(WorkbenchTreePanel)
    // Single-seat 'sidebar.workbench' view: registration carries no id/order (those are list-slot fields).
    expect(trees[0]!.options).toEqual({})

    const viewers = b.slots.entries('workbench.viewer')
    expect(viewers).toHaveLength(1)
    expect(viewers[0]!.component).toBe(WorkbenchViewerPanel)
    expect(viewers[0]!.options).toEqual({})

    const toggleInjected = toggles[0]!.inject as () => { workbench: WorkbenchStateHandle }
    const treeInjected = trees[0]!.inject as unknown as () => WorkbenchTreePanelInjected & { workbench: WorkbenchStateHandle }
    const viewerInjected = viewers[0]!.inject as unknown as () => WorkbenchViewerInjected & { workbench: WorkbenchStateHandle }
    expect(toggleInjected().workbench).toBe(treeInjected().workbench)
    expect(treeInjected().workbench).toBe(viewerInjected().workbench)
    await b.ctx.fiber.dispose()
  })

  it('tree falls back to the current session when the view was opened from the activity bar (open flag untouched)', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    // Activity-bar entry flips only the layout view: open stays false and no
    // session is pinned, but the current session still fills the tree.
    const workbench = createWorkbenchState()
    workbench.set({ sessionId: 's1' })
    const t = b.locale.bind(NS)

    render(<WorkbenchTreePanel {...treePanelProps(b, workbench, t)} />)

    expect(await screen.findByText('a.txt')).toBeTruthy()
    expect(b.cwd).toHaveBeenCalledWith('s1')
    expect(b.listDir).toHaveBeenCalledWith('s1', '')
    await b.ctx.fiber.dispose()
  })

  it('toggle binds the session and opens the panel; tree stays hidden without a session', async () => {
    const b = await bench()
    b.currentSession.id = undefined
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const workbench = createWorkbenchState()
    const t = b.locale.bind(NS)

    const tree = render(<WorkbenchTreePanel {...treePanelProps(b, workbench, t)} />)
    expect(tree.container.firstChild).toBeNull()

    render(<WorkbenchToggle
      sessionId={'s1' as never}
      workbench={workbench}
      layout={{
        toggleSidebar: (() => {}), openDetails: (() => {}),
        closeDetails: (() => {}), toggleBottom: (() => {}),
        closeBottom: (() => {}), openWorkbench: b.openWorkbench,
        closeWorkbench: b.closeWorkbench, setSidebarView: (() => {}),
      }}
      t={t as never}
      useSession={(() => undefined) as never}
      useProjection={(() => undefined)}
      useInput={(() => undefined) as never}
      inputActions={undefined as never}
      useSessions={(() => undefined) as never}
      useWorkspaces={(() => undefined) as never}
    />)
    fireEvent.click(screen.getByRole('button', { name: '打开工作台' }))
    expect(workbench.getSnapshot()).toEqual({ open: true, sessionId: 's1', openPaths: [], activePath: undefined, tab: 'files' })
    expect(b.openWorkbench).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '打开工作台' }))
    expect(workbench.getSnapshot()).toEqual({ open: false, sessionId: 's1', openPaths: [], activePath: undefined, tab: 'files' })
    expect(b.closeWorkbench).toHaveBeenCalledTimes(1)
    await b.ctx.fiber.dispose()
  })

  it('tree resolves cwd, lists the tree, and opening a file selects it for the viewer', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1' })
    const t = b.locale.bind(NS)

    render(<WorkbenchTreePanel {...treePanelProps(b, workbench, t)} />)

    expect(b.cwd).toHaveBeenCalledWith('s1')
    // Root listing arrives: the file row appears; clicking selects it.
    const row = await screen.findByText('a.txt')
    expect(b.listDir).toHaveBeenCalledWith('s1', '')
    fireEvent.click(row)
    expect(workbench.getSnapshot().activePath).toBe('a.txt')
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt'])
    expect(b.readText).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
  })

  it('viewer reads the selected file and renders its content', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1', activePath: 'a.txt' })
    const t = b.locale.bind(NS)

    render(<WorkbenchViewerPanel {...viewerPanelProps(b, workbench, t)} />)

    expect(b.readText).toHaveBeenCalledWith('s1', 'a.txt')
    expect(await screen.findByText('hello')).toBeTruthy()
    await b.ctx.fiber.dispose()
  })

  it('viewer renders an editor tab bar; clicking a tab activates that file', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1', openPaths: ['a.txt', 'b.txt'], activePath: 'a.txt' })
    const t = b.locale.bind(NS)

    render(<WorkbenchViewerPanel {...viewerPanelProps(b, workbench, t)} />)

    const aTab = await screen.findByRole('tab', { name: /a\.txt/ })
    const bTab = screen.getByRole('tab', { name: /b\.txt/ })
    expect(aTab.getAttribute('aria-selected')).toBe('true')
    expect(bTab.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(bTab)
    expect(workbench.getSnapshot().activePath).toBe('b.txt')
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt', 'b.txt'])
    await b.ctx.fiber.dispose()
  })

  it('closing a tab removes it; closing the active tab activates its next neighbor', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1', openPaths: ['a.txt', 'b.txt', 'c.txt'], activePath: 'b.txt' })
    const t = b.locale.bind(NS)

    render(<WorkbenchViewerPanel {...viewerPanelProps(b, workbench, t)} />)
    await screen.findByRole('tab', { name: /a\.txt/ })

    // Close the active middle tab: its right neighbor slides into the slot.
    fireEvent.click(screen.getAllByRole('button', { name: '关闭标签' })[1]!)
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt', 'c.txt'])
    expect(workbench.getSnapshot().activePath).toBe('c.txt')
    await b.ctx.fiber.dispose()
  })

  it('toggle opening on a different conversation drops the previous session tabs', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1', openPaths: ['a.txt'], activePath: 'a.txt' })
    const t = b.locale.bind(NS)

    render(<WorkbenchToggle
      sessionId={'s2' as never}
      workbench={workbench}
      layout={{
        toggleSidebar: (() => {}), openDetails: (() => {}),
        closeDetails: (() => {}), toggleBottom: (() => {}),
        closeBottom: (() => {}), openWorkbench: b.openWorkbench,
        closeWorkbench: b.closeWorkbench, setSidebarView: (() => {}),
      }}
      t={t as never}
      useSession={(() => undefined) as never}
      useProjection={(() => undefined)}
      useInput={(() => undefined) as never}
      inputActions={undefined as never}
      useSessions={(() => undefined) as never}
      useWorkspaces={(() => undefined) as never}
    />)
    fireEvent.click(screen.getByRole('button', { name: '打开工作台' }))
    expect(workbench.getSnapshot()).toEqual({ open: true, sessionId: 's2', openPaths: [], activePath: undefined, tab: 'files' })
    await b.ctx.fiber.dispose()
  })

  it('workbench.viewer registers against the real ui-layout root declaration', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
    const sessionsList = {
      getSnapshot: (): SessionListState => ({
        ids: ['s1' as SessionId], byId: {}, current: 's1' as SessionId | undefined, phase: 'ready',
        subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
      }),
      subscribe: () => () => {},
    }
    ctx.provide('sessions', { list: sessionsList })
    ctx.provide('remote.workbench', {
      cwd: vi.fn().mockResolvedValue({ ok: true, value: CWD }),
      listDir: vi.fn().mockResolvedValue({ ok: true, value: LIST }),
      readText: vi.fn().mockResolvedValue({ ok: true, value: READ }),
      writeText: vi.fn().mockResolvedValue({ ok: true, value: { version: 'v2' } }),
      terminalSpawn: vi.fn().mockResolvedValue({ ok: true, value: { session: { id: 't0', status: 'running', exitCode: null }, shell: 'powershell.exe' } }),
      terminalWrite: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      terminalRead: vi.fn().mockResolvedValue({ ok: true, value: { delta: '', session: { id: 't0', status: 'running', exitCode: null } } }),
      terminalClose: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      terminalCloseSession: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitStatus: vi.fn().mockResolvedValue({ ok: true, value: { isRepo: false, branch: '', changes: [] } }),
      gitDiff: vi.fn().mockResolvedValue({ ok: true, value: { diff: '', binary: false } }),
      gitLog: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      gitBranches: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      gitAdd: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitRestore: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitCommit: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    })
    // ui-layout provides ctx.layout and declares 'workbench.viewer' on root.
    await ctx.plugin({ inject: [...layoutInject], apply: layoutApply }).await()
    // Capture delayed registration errors (slots.inject rethrows on a
    // microtask so apply itself does not reject).
    const errors: unknown[] = []
    const onError = (e: ErrorEvent): void => { errors.push(e.error ?? e.message) }
    const onRejection = (e: PromiseRejectionEvent): void => { errors.push(e.reason) }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await new Promise(resolve => setTimeout(resolve, 30))
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    const slots = ctx.get('slots') as SlotRegistry
    expect(slots.spec('workbench.viewer')).toEqual({ kind: 'single', scope: 'root' })
    expect(errors).toEqual([])
    expect(slots.entries('workbench.viewer')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('renders the viewer seat through the real slots renderer with a live session', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', {
      toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
      toggleBottom: vi.fn(), closeBottom: vi.fn(),
      openWorkbench: vi.fn(), closeWorkbench: vi.fn(), setSidebarView: vi.fn(),
    })
    runtime.provide('remote.workbench', {
      cwd: vi.fn().mockResolvedValue({ ok: true, value: CWD }),
      listDir: vi.fn().mockResolvedValue({ ok: true, value: LIST }),
      readText: vi.fn().mockResolvedValue({ ok: true, value: READ }),
      writeText: vi.fn().mockResolvedValue({ ok: true, value: { version: 'v2' } }),
      terminalSpawn: vi.fn().mockResolvedValue({ ok: true, value: { session: { id: 't0', status: 'running', exitCode: null }, shell: 'powershell.exe' } }),
      terminalWrite: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      terminalRead: vi.fn().mockResolvedValue({ ok: true, value: { delta: '', session: { id: 't0', status: 'running', exitCode: null } } }),
      terminalClose: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      terminalCloseSession: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitStatus: vi.fn().mockResolvedValue({ ok: true, value: { isRepo: false, branch: '', changes: [] } }),
      gitDiff: vi.fn().mockResolvedValue({ ok: true, value: { diff: '', binary: false } }),
      gitLog: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      gitBranches: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      gitAdd: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitRestore: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitCommit: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.sessions.add({
      id: 's1',
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
      snapshot: { nodes: [], blank: false, composerPhase: 'active' as const },
      session: { prompt: vi.fn(async () => ({ ok: true, value: { accepted: true } })), loadOlder: vi.fn() } as never,
    })
    const WB_CHILDREN = {
      'workbench.viewer': { kind: 'single', scope: 'root' },
    } as const
    type WBRootProps = PropsRenderSlots<'workbench.viewer'>
    function WBRoot({ renderSlot }: WBRootProps) {
      return <div data-testid="wb-root">{renderSlot('workbench.viewer', {})}</div>
    }
    await runtime.root.declare(WB_CHILDREN, WBRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    // Empty state: activePath unset, the viewer still renders its seat text.
    expect(view.getByTestId('wb-root').textContent).toContain('文件')
    await runtime.dispose()
  })

  it('viewer reports a failed read through the error state', async () => {
    const b = await bench()
    b.locale.register(NS, { zh, en })
    b.readText.mockRejectedValueOnce(new Error('boom'))
    const workbench = createWorkbenchState()
    workbench.set({ open: true, sessionId: 's1', activePath: 'x.txt' })
    const t = b.locale.bind(NS)

    render(<WorkbenchViewerPanel {...viewerPanelProps(b, workbench, t)} />)
    expect(await screen.findByText(/无法打开文件/)).toBeTruthy()
    await b.ctx.fiber.dispose()
  })
})
