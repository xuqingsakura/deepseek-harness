/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  BOTTOM_DEFAULT, BOTTOM_MAX, BOTTOM_MIN, clampWidth,
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/** Sidebar width while the workbench file-tree view is active (the file tree alone now). */
const WORKBENCH_SIDEBAR_WIDTH = 300
/** Details-column width while the workbench view is active (the conversation column). */
const WORKBENCH_DETAILS_WIDTH = 480

/**
 * Layout store state: panel width preferences in px (0 = closed), the active
 * sidebar view (the workbench file tree swaps the workspace browser), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
type LayoutState = { sidebar: number; details: number; bottom: number; sidebarView: 'default' | 'workbench'; narrow: boolean; narrowExpanded: boolean; workbenchEqual: boolean }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setBottom: (draft: LayoutState, px: number) => void
  toggleBottom: (draft: LayoutState) => void
  closeBottom: (draft: LayoutState) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openWorkbench: (draft: LayoutState) => void
  closeWorkbench: (draft: LayoutState) => void
  setSidebarView: (draft: LayoutState, view: 'default' | 'workbench') => void
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({ sidebar: SIDEBAR_DEFAULT, details: 0, bottom: 0, sidebarView: 'default', narrow: false, narrowExpanded: false, workbenchEqual: false }),
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX); d.workbenchEqual = false },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX); d.workbenchEqual = false },
      setBottom: (d, px: number) => { d.bottom = clampWidth(px, BOTTOM_MIN, BOTTOM_MAX) },
      // VSCode terminal-panel semantics: toggle between the default height and closed.
      toggleBottom: (d) => { d.bottom = d.bottom === 0 ? BOTTOM_DEFAULT : 0 },
      closeBottom: (d) => { d.bottom = 0 },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else {
          // Re-expand restores the active view's contract width (the workbench
          // tree is narrower than the workspace browser).
          const width = d.sidebarView === 'workbench' ? WORKBENCH_SIDEBAR_WIDTH : SIDEBAR_DEFAULT
          d.sidebar = d.sidebar === 0 ? width : 0
          if (d.sidebarView === 'workbench') d.workbenchEqual = false
        }
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
      // Opening the workbench view also expands a collapsed sidebar, sizes
      // the tree column, and opens the conversation column on the right;
      // closing restores the browsing width and closes that column.
      openWorkbench: (d) => {
        d.sidebarView = 'workbench'
        d.sidebar = WORKBENCH_SIDEBAR_WIDTH
        d.details = WORKBENCH_DETAILS_WIDTH
        d.workbenchEqual = true
      },
      closeWorkbench: (d) => {
        d.sidebarView = 'default'
        d.sidebar = SIDEBAR_DEFAULT
        d.details = 0
        d.workbenchEqual = false
      },
      // VSCode activity-bar semantics: clicking the active view's icon
      // toggles the panel closed; clicking another view switches and opens it.
      // Switching INTO the workbench opens the conversation column too;
      // switching back to the browser closes it.
      setSidebarView: (d, view: 'default' | 'workbench') => {
        if (d.sidebarView === view) {
          if (view === 'workbench') {
            d.sidebar = d.sidebar === 0 ? WORKBENCH_SIDEBAR_WIDTH : 0
            d.workbenchEqual = false
          } else {
            d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
          }
        } else if (view === 'workbench') {
          d.sidebarView = 'workbench'
          d.sidebar = WORKBENCH_SIDEBAR_WIDTH
          d.details = WORKBENCH_DETAILS_WIDTH
          d.workbenchEqual = true
        } else {
          d.sidebarView = 'default'
          d.sidebar = SIDEBAR_DEFAULT
          d.details = 0
          d.workbenchEqual = false
        }
      },
    },
  })
  return handle
}
