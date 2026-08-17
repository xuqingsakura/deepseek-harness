// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

// English-dictionary translate stub: the shell renders the same copy the
// assertions below query by accessible name.
const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never

function mountShell({ collapsed = false, width = 300, initialView = 'default', workbench = false }: { collapsed?: boolean; width?: number; initialView?: 'default' | 'workbench'; workbench?: boolean } = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  const setSidebarView = vi.fn()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let workbenchOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let current = { collapsed, width, view: initialView, workbench }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width} view={current.view}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar}
      setSidebarView={setSidebarView}
      workbenchAvailable={() => current.workbench}
      subscribeWorkbench={() => () => {}}
      t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.workbench') {
          workbenchOwner = owner as SidebarSectionOwnerProps
          return <div data-testid="workbench-region" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    setSidebarView,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    workbenchOwner: () => {
      if (workbenchOwner === undefined) throw new Error('workbench owner not rendered')
      return workbenchOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('routes New Session and the column toggle', () => {
    const b = mountShell()
    // Expanded, the panel capsule starts a session.
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(1)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse sidebar' })[0]!)
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('the foot collapse button toggles back open from the collapsed rail', () => {
    const b = mountShell()
    const collapseButtons = screen.getAllByRole('button', { name: 'Collapse sidebar' })
    // The foot button is the last of the two activity-bar toggles.
    const foot = collapseButtons[collapseButtons.length - 1]!
    fireEvent.click(foot)
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
    b.rerender({ collapsed: true })
    fireEvent.click(screen.getAllByRole('button', { name: 'Open sidebar' })[0]!)
    expect(b.toggleSidebar).toHaveBeenCalledTimes(2)
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // Settings now rides the activity rail (always reachable), so it never
    // sees the wide panel flag; footer actions stay in the panel foot.
    expect(b.settingsOwner().wide).toBe(false)
    expect(b.footerActionOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the panel mounted through collapse, then unmounts at settle', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window.
    expect(b.regionOwner().wide).toBe(true)
    expect(screen.getByTestId('region')).toBeTruthy()
    vi.advanceTimersByTime(200)
    b.rerender({})
    // At settle the panel unmounts; the activity rail remains.
    expect(screen.queryByTestId('region')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open sidebar' })[0]).toBeTruthy()
    // The stale region owner's expand request still routes through the shell.
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (rail only, no panel)', () => {
    mountShell({ collapsed: true })
    expect(screen.queryByTestId('region')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Open sidebar' })[0]).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
  })

  it('shows the workspace browser by default and swaps to the file tree on the workbench view', () => {
    const b = mountShell()
    expect(screen.getByTestId('region')).toBeTruthy()
    expect(screen.queryByTestId('workbench-region')).toBeNull()
    b.rerender({ view: 'workbench' })
    expect(screen.getByTestId('workbench-region')).toBeTruthy()
    expect(screen.queryByTestId('region')).toBeNull()
    expect(b.workbenchOwner().wide).toBe(true)
  })

  it('hides the workbench icon until the workbench seat is registered, then routes clicks to setSidebarView', () => {
    const b = mountShell()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
    b.rerender({ workbench: true })
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(b.setSidebarView).toHaveBeenCalledWith('workbench')
    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }))
    expect(b.setSidebarView).toHaveBeenCalledWith('default')
  })
})
