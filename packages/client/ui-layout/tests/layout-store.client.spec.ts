// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({ sidebar: SIDEBAR_DEFAULT, details: 0, bottom: 0, sidebarView: 'default', narrow: false, narrowExpanded: false, workbenchEqual: false })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('toggleSidebar in the workbench view restores the workbench width, not the browser default', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebarView('workbench')
    const opened = store.getSnapshot().sidebar
    expect(opened).toBeGreaterThan(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(opened)
    expect(store.getSnapshot().sidebar).not.toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({ sidebar: 400, details: 0, bottom: 0, sidebarView: 'default', narrow: true, narrowExpanded: true, workbenchEqual: false })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('openWorkbench switches the sidebar view, sizes the tree column, and opens the conversation column; closeWorkbench restores browsing', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(300)
    actions.openWorkbench()
    expect(store.getSnapshot().sidebarView).toBe('workbench')
    expect(store.getSnapshot().sidebar).toBeGreaterThan(SIDEBAR_DEFAULT)
    expect(store.getSnapshot().details).toBeGreaterThan(0)
    actions.closeWorkbench()
    expect(store.getSnapshot().sidebarView).toBe('default')
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    expect(store.getSnapshot().details).toBe(0)
  })

  it('openWorkbench expands a collapsed sidebar and opens the conversation column', () => {
    const { store, actions } = createLayoutStore().create()
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.openWorkbench()
    expect(store.getSnapshot().sidebarView).toBe('workbench')
    expect(store.getSnapshot().sidebar).toBeGreaterThan(0)
    expect(store.getSnapshot().details).toBeGreaterThan(0)
  })

  it('setSidebarView switches between views, opening/closing the conversation column, and toggles the active view panel', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().sidebarView).toBe('workbench')
    expect(store.getSnapshot().details).toBeGreaterThan(0)
    // Clicking the active view's icon collapses the tree panel (conversation column stays open).
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().sidebar).toBe(0)
    expect(store.getSnapshot().details).toBeGreaterThan(0)
    // Re-clicking re-expands it.
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().sidebar).toBeGreaterThan(0)
    // Switching to the browser closes the conversation column.
    actions.setSidebarView('default')
    expect(store.getSnapshot().sidebarView).toBe('default')
    expect(store.getSnapshot().details).toBe(0)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('does not persist panel geometry', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull()

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      bottom: 0,
      sidebarView: 'default',
      narrow: false,
      narrowExpanded: false,
      workbenchEqual: false,
    })
  })

  it('workbench defaults to an equal split until a drag or panel toggle exits it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openWorkbench()
    expect(store.getSnapshot().workbenchEqual).toBe(true)
    // Dragging a handle exits the equal split into pixels.
    actions.setSidebar(400)
    expect(store.getSnapshot().workbenchEqual).toBe(false)
    // Reopening restores the equal default.
    actions.closeWorkbench()
    actions.openWorkbench()
    expect(store.getSnapshot().workbenchEqual).toBe(true)
    // Toggling the tree panel also exits it (re-expand keeps the pixel width).
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().workbenchEqual).toBe(false)
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().sidebar).toBeGreaterThan(0)
    // Switching views resets it; re-entering restores the equal default.
    actions.setSidebarView('default')
    expect(store.getSnapshot().workbenchEqual).toBe(false)
    actions.setSidebarView('workbench')
    expect(store.getSnapshot().workbenchEqual).toBe(true)
  })
})
