/**
 * Render-memory observation: a lightweight Chromium-only sampler that feeds a
 * ring of JS-heap readings, exposes the window.__dshRenderMemory debug handle,
 * and warns once when the heap keeps growing across a window while the app is
 * idle (a leak signature). Pure core + one React hook; the hook is idempotent
 * across ConversationRoot instances via a mount counter.
 */
import { useEffect } from 'react'

/** Sample period (ms). */
export const RENDER_MEMORY_INTERVAL_MS = 10_000
/** Ring capacity (readings). */
export const RENDER_MEMORY_SAMPLES = 60
/** Growth (MB) over the window that trips the leak warning. */
export const RENDER_MEMORY_LEAK_MB = 64

/** One heap reading. */
export interface RenderMemorySample {
  /** Used JS heap size (MB), or null while Chromium's performance.memory is absent. */
  readonly heapMB: number | null
  /** Epoch ms of the reading. */
  readonly at: number
}

/** jsdom and non-Chromium engines lack performance.memory; null means absent. */
function currentHeapMB(): number | null {
  const memory = (globalThis as { performance?: Performance }).performance as
    (Performance & { memory?: { usedJSHeapSize?: number } }) | undefined
  const used = memory?.memory?.usedJSHeapSize
  return typeof used === 'number' && Number.isFinite(used) ? used / (1024 * 1024) : null
}

/** Push one sample into a capped ring. */
export function recordSample(samples: readonly RenderMemorySample[], heapMB: number | null, at: number): RenderMemorySample[] {
  const next = [...samples, { heapMB, at }]
  return next.length > RENDER_MEMORY_SAMPLES ? next.slice(next.length - RENDER_MEMORY_SAMPLES) : next
}

/**
 * Leak signature: the newest sample is >= LEAK_MB above the sample closest to
 * (now - window) and the growth is monotone across the intervening readings
 * (no large reclaim), so transient GC noise does not trip it.
 * @param samples - newest-last ring.
 * @param windowMs - comparison span.
 * @returns growth in MB, or null when the window has too few usable readings.
 */
export function leakGrowthMB(samples: readonly RenderMemorySample[], windowMs: number): number | null {
  const usable = samples.filter(sample => sample.heapMB !== null)
  if (usable.length < 2) return null
  const newest = usable[usable.length - 1]
  if (newest === undefined || newest.heapMB === null) return null
  const target = newest.at - windowMs
  let oldest: RenderMemorySample | null = null
  for (let i = usable.length - 2; i >= 0; i--) {
    const sample = usable[i]
    if (sample !== undefined && sample.at <= target) { oldest = sample; break }
  }
  if (oldest === null || oldest.heapMB === null) return null
  const growth = newest.heapMB - oldest.heapMB
  if (growth < RENDER_MEMORY_LEAK_MB) return null
  // Monotone growth check between the two edges.
  const span = usable.filter(sample => sample.at >= oldest.at && sample.at <= newest.at)
  for (let i = 1; i < span.length; i++) {
    const current = span[i]
    const previous = span[i - 1]
    if (current === undefined || previous === undefined || current.heapMB === null || previous.heapMB === null) return null
    const delta = current.heapMB - previous.heapMB
    if (delta < -16) return null // a large reclaim reset the baseline
  }
  return growth
}

declare global {
  interface Window {
    /** Debug handle: latest readings and leak growth, for DevTools inspection. */
    __dshRenderMemory?: {
      heapMB: number | null
      samples: readonly RenderMemorySample[]
      leakGrowthMB: number | null
    }
  }
}

let mounted = 0
let timer: ReturnType<typeof setInterval> | null = null
let samples: RenderMemorySample[] = []
let warnedAt = 0

function sampleOnce(): void {
  const at = Date.now()
  samples = recordSample(samples, currentHeapMB(), at)
  const growth = leakGrowthMB(samples, 5 * 60_000)
  // Warn at most once per five minutes to keep idle consoles quiet.
  if (growth !== null && at - warnedAt > 5 * 60_000) {
    warnedAt = at
    console.warn(
      `[render-memory] JS heap grew ${growth.toFixed(0)} MB over 5 minutes while idle ` +
      '(possible leak; inspect window.__dshRenderMemory)',
    )
  }
  if (typeof window !== 'undefined') {
    window.__dshRenderMemory = { heapMB: currentHeapMB(), samples, leakGrowthMB: growth }
  }
}

function start(): void {
  sampleOnce()
  timer = setInterval(sampleOnce, RENDER_MEMORY_INTERVAL_MS)
}

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/**
 * Mount the render-memory observer exactly once per app process even when
 * several ConversationRoot instances coexist (workbench views): the first
 * mount starts sampling, the last unmount stops it.
 */
export function useRenderMemoryMonitor(): void {
  useEffect(() => {
    mounted++
    if (mounted === 1) start()
    return () => {
      mounted--
      if (mounted === 0) stop()
    }
  }, [])
}
