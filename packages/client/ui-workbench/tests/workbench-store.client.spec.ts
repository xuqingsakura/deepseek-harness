// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createWorkbenchState } from '../src/client/workbench-store.ts'

describe('workbench state store', () => {
  it('opens a file: appends it once and activates it', () => {
    const workbench = createWorkbenchState()
    workbench.open('a.txt')
    expect(workbench.getSnapshot()).toEqual({ open: false, sessionId: undefined, openPaths: ['a.txt'], activePath: 'a.txt', tab: 'files', browserUrl: 'https://www.deepseek.com' })
    workbench.open('b.txt')
    workbench.open('a.txt') // re-open keeps the original position, activates
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt', 'b.txt'])
    expect(workbench.getSnapshot().activePath).toBe('a.txt')
  })

  it('closing the active tab activates the next neighbor, then the previous', () => {
    const workbench = createWorkbenchState()
    workbench.open('a.txt')
    workbench.open('b.txt')
    workbench.open('c.txt')
    workbench.set({ activePath: 'b.txt' })
    workbench.close('b.txt')
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt', 'c.txt'])
    expect(workbench.getSnapshot().activePath).toBe('c.txt')
    workbench.close('c.txt')
    expect(workbench.getSnapshot().activePath).toBe('a.txt')
    workbench.close('a.txt')
    expect(workbench.getSnapshot().openPaths).toEqual([])
    expect(workbench.getSnapshot().activePath).toBeUndefined()
  })

  it('closing a non-active tab leaves the active path untouched', () => {
    const workbench = createWorkbenchState()
    workbench.open('a.txt')
    workbench.open('b.txt')
    workbench.close('a.txt')
    expect(workbench.getSnapshot().openPaths).toEqual(['b.txt'])
    expect(workbench.getSnapshot().activePath).toBe('b.txt')
  })

  it('closing an unknown path is a no-op', () => {
    const workbench = createWorkbenchState()
    workbench.open('a.txt')
    workbench.close('missing.txt')
    expect(workbench.getSnapshot().openPaths).toEqual(['a.txt'])
  })

  it('notifies subscribers on open and close', () => {
    const workbench = createWorkbenchState()
    let count = 0
    const off = workbench.subscribe(() => { count += 1 })
    workbench.open('a.txt')
    workbench.close('a.txt')
    expect(count).toBe(2)
    off()
  })
  it('openDiff sets the diff target and open() clears it', () => {
    const workbench = createWorkbenchState()
    workbench.open('a.txt')
    workbench.openDiff('b.txt', false)
    expect(workbench.getSnapshot().diff).toEqual({ path: 'b.txt', staged: false })
    // Switching to a file tab exits the diff view.
    workbench.open('a.txt')
    expect(workbench.getSnapshot().diff).toBeUndefined()
  })

  it('openDiff keeps the staged flag; clearDiff returns to file view', () => {
    const workbench = createWorkbenchState()
    workbench.openDiff('c.txt', true)
    expect(workbench.getSnapshot().diff).toEqual({ path: 'c.txt', staged: true })
    workbench.clearDiff()
    expect(workbench.getSnapshot().diff).toBeUndefined()
    // Clearing an already-clear diff is a no-op (no notification).
    let count = 0
    const off = workbench.subscribe(() => { count += 1 })
    workbench.clearDiff()
    expect(count).toBe(0)
    off()
  })

})
