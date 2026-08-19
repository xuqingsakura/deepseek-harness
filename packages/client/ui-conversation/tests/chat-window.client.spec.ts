import { describe, expect, it } from 'vitest'
import {
  computeWindow, prefixSums, ROW_ESTIMATE_HEIGHT, tailWindow, WINDOW_BUFFER_ROWS, WINDOW_THRESHOLD,
} from '../src/client/chat/chat-window.ts'

const keys = (count: number): string[] => Array.from({ length: count }, (_, i) => `n${i}`)

const uniform = (count: number, height = 100): { order: string[]; heights: Map<string, number> } => {
  const order = keys(count)
  const heights = new Map<string, number>()
  for (const key of order) heights.set(key, height)
  return { order, heights }
}

describe('prefixSums', () => {
  it('builds a zero-headed strictly increasing table', () => {
    const { order, heights } = uniform(3, 40)
    expect(prefixSums(order, { heights, estimate: ROW_ESTIMATE_HEIGHT })).toEqual([0, 40, 80, 120])
  })

  it('falls back to the estimate for unmeasured rows', () => {
    const order = keys(3)
    const heights = new Map<string, number>([['n0', 10]])
    expect(prefixSums(order, { heights, estimate: 96 })).toEqual([0, 10, 106, 202])
  })

  it('is empty for an empty order', () => {
    expect(prefixSums([], { heights: new Map(), estimate: 96 })).toEqual([0])
  })
})

describe('computeWindow', () => {
  it('mounts every row when the viewport spans the whole flow', () => {
    const { order, heights } = uniform(10, 100)
    const window = computeWindow(order, { heights, estimate: 96 }, 0, 1000, 0)
    expect(window).toEqual({ start: 0, end: 10 })
  })

  it('starts at the row straddling the top edge', () => {
    const { order, heights } = uniform(10, 100)
    // Row 3 spans [300, 400); viewport top 350 cuts it.
    const window = computeWindow(order, { heights, estimate: 96 }, 350, 1350, 0)
    expect(window.start).toBe(3)
    expect(window.end).toBe(10)
  })

  it('keeps the buffer rows mounted past each edge', () => {
    const { order, heights } = uniform(100, 100)
    const window = computeWindow(order, { heights, estimate: 96 }, 3500, 4500, 500)
    // Top edge 3500 - 500 = 3000 -> straddler row 30; bottom edge 4500 + 500 = 5000 -> row 50.
    expect(window.start).toBe(30)
    expect(window.end).toBe(50)
  })

  it('keeps one row for a degenerate zero-height viewport', () => {
    const { order, heights } = uniform(10, 100)
    const window = computeWindow(order, { heights, estimate: 96 }, 0, 0, 0)
    expect(window.start).toBe(0)
    expect(window.end).toBe(1)
  })

  it('clamps an out-of-range viewport to the flow bounds', () => {
    const { order, heights } = uniform(5, 100)
    expect(computeWindow(order, { heights, estimate: 96 }, 10_000, 20_000, 0)).toEqual({ start: 4, end: 5 })
    expect(computeWindow(order, { heights, estimate: 96 }, -10_000, -9_000, 0)).toEqual({ start: 0, end: 1 })
  })

  it('returns an empty window for an empty order', () => {
    expect(computeWindow([], { heights: new Map(), estimate: 96 }, 0, 100, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('tailWindow', () => {
  it('covers the viewport plus buffer from the flow tail', () => {
    const { order, heights } = uniform(100, 100)
    const window = tailWindow(order, { heights, estimate: 96 }, 800, 200)
    // Total 10000 - 1000 = 9000 -> first row top >= 9000 is row 90.
    expect(window).toEqual({ start: 90, end: 100 })
  })

  it('mounts the whole flow when it is shorter than the viewport', () => {
    const { order, heights } = uniform(5, 100)
    expect(tailWindow(order, { heights, estimate: 96 }, 800, 200)).toEqual({ start: 0, end: 5 })
  })

  it('returns an empty window for an empty order', () => {
    expect(tailWindow([], { heights: new Map(), estimate: 96 }, 800, 200)).toEqual({ start: 0, end: 0 })
  })
})

describe('windowing constants', () => {
  it('keeps the threshold above a generous buffer so small sessions never window', () => {
    expect(WINDOW_THRESHOLD).toBeGreaterThan(WINDOW_BUFFER_ROWS * 4)
  })
})
