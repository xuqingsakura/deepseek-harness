/** Which sidebar panel the workbench view shows. */
export type WorkbenchSidebarTab = 'files' | 'terminal' | 'git' | 'tasks' | 'browser'

/**
 * The workbench's shared viewing state: whether the panel is open, which
 * session it is bound to, which files are open in the tab bar, which one is
 * active, and which sidebar panel is selected. The state handle is created
 * inside the plugin apply body (never module-level) and handed to the toggle
 * and the panel through their slot inject closures, so the two registrations
 * share one identity without the slot store seat (which forbids a shared
 * handle across two scopes).
 */
export interface WorkbenchViewState {
  /** Whether the right-hand workbench panel is visible. */
  open: boolean
  /** The conversation the panel is bound to (set by the header toggle). */
  sessionId: string | undefined
  /** Open file paths in the tab bar, in open order (first tab leftmost). */
  openPaths: string[]
  /** The active file path, relative to the session cwd ('' = cwd root). */
  activePath: string | undefined
  /** The selected sidebar panel. */
  tab: WorkbenchSidebarTab
  /** The in-workbench browser's current URL ('' = blank start page). */
  browserUrl: string
  /** The Git change whose diff is open in the center viewer (undefined = file content view). */
  diff: { path: string; staged: boolean } | undefined
}

/** Snapshot/subscribe/update handle handed to workbench components. */
export interface WorkbenchStateHandle {
  getSnapshot: () => WorkbenchViewState
  subscribe: (listener: () => void) => () => void
  set: (patch: Partial<WorkbenchViewState>) => void
  /** Open a file: append it to the tab bar once and activate it (exits diff view). */
  open: (path: string) => void
  /** Open a Git change's diff in the center viewer. */
  openDiff: (path: string, staged: boolean) => void
  /** Close the diff view and return to the file content view. */
  clearDiff: () => void
  /** Close a file tab; closing the active file activates its tab neighbor. */
  close: (path: string) => void
  /** Close every tab except one; the survivor becomes active. */
  closeOthers: (path: string) => void
  /** Close every tab. */
  closeAll: () => void
  /** Navigate the in-workbench browser to a URL (empty = blank). */
  navigateBrowser: (url: string) => void
}

/**
 * Create a workbench state handle.
 * @returns the live handle; one instance per plugin activation.
 */
export function createWorkbenchState(): WorkbenchStateHandle {
  let state: WorkbenchViewState = { open: false, sessionId: undefined, openPaths: [], activePath: undefined, tab: 'files', diff: undefined, browserUrl: 'https://www.deepseek.com' }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (patch) => {
      state = { ...state, ...patch }
      notify()
    },
    open: (path) => {
      const openPaths = state.openPaths.includes(path) ? state.openPaths : [...state.openPaths, path]
      state = { ...state, openPaths, activePath: path, diff: undefined }
      notify()
    },
    openDiff: (path, staged) => {
      state = { ...state, diff: { path, staged } }
      notify()
    },
    clearDiff: () => {
      if (state.diff === undefined) return
      state = { ...state, diff: undefined }
      notify()
    },
    close: (path) => {
      const index = state.openPaths.indexOf(path)
      if (index === -1) return
      const openPaths = state.openPaths.filter(candidate => candidate !== path)
      let activePath = state.activePath
      if (state.activePath === path) {
        // Prefer the tab that slides into the closed slot, else the previous one.
        activePath = openPaths[index] ?? openPaths[index - 1] ?? undefined
      }
      state = { ...state, openPaths, activePath }
      notify()
    },
    closeOthers: (path) => {
      if (!state.openPaths.includes(path)) return
      state = { ...state, openPaths: [path], activePath: path }
      notify()
    },
    closeAll: () => {
      state = { ...state, openPaths: [], activePath: undefined }
      notify()
    },
    navigateBrowser: (url) => {
      state = { ...state, browserUrl: url }
      notify()
    },
  }
}
