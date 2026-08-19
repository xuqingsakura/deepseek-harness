import { describe, expect, it } from 'vitest'
import {
  leakGrowthMB, RENDER_MEMORY_LEAK_MB, RENDER_MEMORY_SAMPLES, recordSample,
  type RenderMemorySample,
} from '../src/client/render-memory.ts'

const sample = (heapMB: number | null, at: number): RenderMemorySample => ({ heapMB, at })

describe('recordSample', () => {
  it('appends readings in order', () => {
    const next = recordSample([sample(1, 0)], 2, 1000)
    expect(next.map(s => s.heapMB)).toEqual([1, 2])
  })

  it('caps the ring at the configured capacity', () => {
    let samples: RenderMemorySample[] = []
    for (let i = 0; i < RENDER_MEMORY_SAMPLES + 5; i++) samples = recordSample(samples, i, i * 1000)
    expect(samples).toHaveLength(RENDER_MEMORY_SAMPLES)
    expect(samples[0]!.heapMB).toBe(5)
  })

  it('keeps null readings (non-Chromium engines)', () => {
    const next = recordSample([sample(null, 0)], null, 1000)
    expect(next.map(s => s.heapMB)).toEqual([null, null])
  })
})

describe('leakGrowthMB', () => {
  it('returns null with too few usable readings', () => {
    expect(leakGrowthMB([sample(null, 0), sample(10, 1000)], 60_000)).toBeNull()
    expect(leakGrowthMB([sample(10, 0)], 60_000)).toBeNull()
  })

  it('returns null when growth stays below the threshold', () => {
    const span = Array.from({ length: 8 }, (_, i) => sample(100 + i * 5, i * 10_000))
    expect(leakGrowthMB(span, 60_000)).toBeNull()
  })

  it('reports growth across the window once it passes the threshold', () => {
    const span = Array.from({ length: 8 }, (_, i) => sample(100 + i * 12, i * 10_000))
    // 100 -> 184 MB over 70s: 84 MB >= 64.
    const growth = leakGrowthMB(span, 60_000)
    expect(growth).not.toBeNull()
    expect(growth).toBeGreaterThanOrEqual(RENDER_MEMORY_LEAK_MB)
  })

  it('ignores a spike followed by a large reclaim', () => {
    const span = [
      sample(100, 0), sample(180, 10_000), sample(170, 20_000),
      sample(160, 30_000), sample(150, 40_000), sample(140, 50_000), sample(130, 60_000),
    ]
    expect(leakGrowthMB(span, 60_000)).toBeNull()
  })
})
