/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), and center absorbs any remaining
 * deficit as the last resort. Inputs are the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 */

/** Resolved widths for one frame; center may drop below the frame's centerMin only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

/** Per-frame column floors; the workbench view concedes lower than the default conversation frame. */
export interface ColumnMins {
  /** Sidebar clamp floor (the workbench file tree may concede lower). */
  sidebarMin: number
  /** Center column floor. */
  centerMin: number
  /** Details clamp floor. */
  detailsMin: number
}

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling (the workbench file-tree view opens wider). */
export const SIDEBAR_MAX = 720
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Bottom-panel height before any user drag. */
export const BOTTOM_DEFAULT = 220
/** Bottom-panel drag clamp floor. */
export const BOTTOM_MIN = 96
/** Bottom-panel drag clamp ceiling. */
export const BOTTOM_MAX = 640
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

/** The default conversation-frame floors (center >= CENTER_MIN, details >= DETAILS_MIN). */
export const DEFAULT_MINS: ColumnMins = {
  sidebarMin: SIDEBAR_MIN,
  centerMin: CENTER_MIN,
  detailsMin: DETAILS_MIN,
}


/** Workbench-frame floors: the file tree and viewer concede, the conversation column survives narrow viewports. */
export const WORKBENCH_MINS: ColumnMins = {
  sidebarMin: 200,
  centerMin: 300,
  detailsMin: 320,
}

/** Minimum viewport width for the equal workbench split (each of the three columns then holds its largest workbench floor). */
export const EQUAL_SPLIT_MIN_VIEWPORT = 3 * Math.max(WORKBENCH_MINS.sidebarMin, WORKBENCH_MINS.centerMin, WORKBENCH_MINS.detailsMin)

/**
 * Equal split for the workbench view: three columns at one third each, the
 * center absorbing the rounding remainder. Used only while the user has not
 * dragged a handle (stores.ts workbenchEqual); any drag exits to pixels.
 * @param viewport - available frame width in px.
 * @returns the equal columns.
 */
export function computeEqualColumns(viewport: number): Columns {
  const third = Math.floor(viewport / 3)
  return { sidebar: third, center: viewport - third * 2, details: third }
}

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param mins - per-column floors; the workbench view concedes below the
 * default conversation frame so its three columns survive narrow viewports.
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, mins = DEFAULT_MINS): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, mins.sidebarMin, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, mins.detailsMin, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + mins.centerMin <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(mins.detailsMin, viewport - s - mins.centerMin)
  if (s + d1 + mins.centerMin <= viewport) return { sidebar: s, center: mins.centerMin, details: d1 }

  // Step 3: shrink the sidebar — only workbench frames concede (their mins
  // floor below the global SIDEBAR_MIN); the default conversation frame keeps
  // its sidebar fixed at the preference.
  const s1 = s === SIDEBAR_COLLAPSED ? s
    : mins.sidebarMin < SIDEBAR_MIN ? Math.max(mins.sidebarMin, viewport - d1 - mins.centerMin)
      : s
  if (s1 + d1 + mins.centerMin <= viewport) return { sidebar: s1, center: mins.centerMin, details: d1 }

  // Step 4: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below the frame's centerMin).
  return { sidebar: s1, center: Math.max(0, viewport - s1), details: 0 }
}
