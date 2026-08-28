/**
 * Chat flow windowing core: pure geometry over ordered node keys and a
 * measured-height cache. ChatView owns the DOM/spacer wiring; everything
 * here is deterministic and layout-free so jsdom and unit tests can pin the
 * window boundaries without stubbing rendering.
 */

/** Estimated height (px) for a row whose real height has not been measured. */
export const ROW_ESTIMATE_HEIGHT = 96
/** Extra rows kept mounted above and below the viewport while windowed. */
export const WINDOW_BUFFER_ROWS = 12
/** Minimum flow length (nodes) before windowing engages. */
export const WINDOW_THRESHOLD = 200

/** A cursor into a prefix-sum row height table. */
export interface RowGeometry {
  /** Cached measured heights by node key; absent keys fall back to the estimate. */
  readonly heights: ReadonlyMap<string, number>
  /** Fallback height for unmeasured rows. */
  readonly estimate: number
}

/**
 * Build the prefix-sum table: prefix[i] is the total height of the first i
 * rows. Length is order.length + 1; measured rows use their cached height and
 * unmeasured rows the estimate. O(n) per call; callers memoize across frames.
 * @param order - ordered node keys.
 * @param geometry - height cache plus fallback estimate.
 * @returns prefix sums, prefix[0] === 0.
 */
export function prefixSums(
  order: readonly string[],
  geometry: RowGeometry,
): number[] {
  const sums = new Array<number>(order.length + 1)
  sums[0] = 0
  let total = 0
  for (let i = 0; i < order.length; i++) {
    const key = order[i]
    if (key === undefined) continue
    total += geometry.heights.get(key) ?? geometry.estimate
    sums[i + 1] = total
  }
  return sums
}

/**
 * First index whose prefix value is >= target. Prefix values are strictly
 * increasing (every row has a positive height), so binary search is exact.
 * @param sums - strictly increasing prefix sums.
 * @param target - pixel offset to locate.
 * @returns index in [0, sums.length - 1].
 */
function lowerBound(sums: readonly number[], target: number): number {
  let low = 0
  let high = sums.length - 1
  while (low < high) {
    const middle = low + ((high - low) >> 1)
    if ((sums[middle] as number) < target) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * First index whose prefix value is > target (upper bound). Rows are
 * positive-height so prefix[0] === 0 < any non-negative target.
 * @param sums - strictly increasing prefix sums.
 * @param target - pixel offset to locate.
 * @returns index in [1, sums.length - 1].
 */
function upperBound(sums: readonly number[], target: number): number {
  let low = 0
  let high = sums.length - 1
  while (low < high) {
    const middle = low + ((high - low) >> 1)
    if ((sums[middle] as number) <= target) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Compute the mounted row window for a viewport. The window starts at the
 * first row whose bottom edge clears the top buffer and ends after the last
 * row whose top edge precedes the bottom buffer, so a row straddling either
 * edge stays mounted. At least one row mounts when the order is non-empty.
 * @param order - ordered node keys.
 * @param geometry - height cache plus fallback estimate.
 * @param viewportTop - scrollport top offset (px).
 * @param viewportBottom - scrollport bottom offset (px).
 * @param buffer - extra pixels to keep mounted past each edge (0 disables).
 * @returns the half-open row range [start, end) to mount.
 */
export function computeWindow(
  order: readonly string[],
  geometry: RowGeometry,
  viewportTop: number,
  viewportBottom: number,
  buffer: number,
): { start: number; end: number } {
  if (order.length === 0) return { start: 0, end: 0 }
  const sums = prefixSums(order, geometry)
  const top = Math.max(0, viewportTop - buffer)
  const bottom = Math.max(top, viewportBottom + buffer)
  const start = Math.max(0, upperBound(sums, top) - 1)
  let end = lowerBound(sums, bottom)
  if (start >= end) {
    end = Math.min(order.length, start + 1)
  }
  return { start, end }
}

/**
 * The tail window: rows from the threshold that fills the viewport plus the
 * buffer down to the flow end, so a pinned reader always has the newest rows
 * mounted while streaming grows the tail.
 * @param order - ordered node keys.
 * @param geometry - height cache plus fallback estimate.
 * @param clientHeight - visible viewport height (px).
 * @param buffer - extra pixels kept mounted above the viewport.
 * @returns the half-open row range [start, order.length).
 */
export function tailWindow(
  order: readonly string[],
  geometry: RowGeometry,
  clientHeight: number,
  buffer: number,
): { start: number; end: number } {
  if (order.length === 0) return { start: 0, end: 0 }
  const sums = prefixSums(order, geometry)
  const total = sums[order.length] as number
  const threshold = Math.max(0, total - clientHeight - buffer)
  return { start: lowerBound(sums, threshold), end: order.length }
}
