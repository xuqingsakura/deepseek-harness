/**
 * recovery 单元测试（P2-A）。
 *
 * 验证启动失败计数 / 成功清零 / 安全模式判定。vi.mock 注入最小 electron app。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronMock = vi.hoisted(() => {
  const state = { userData: '' }
  return { state, app: { getPath: (name: string): string => (name === 'userData' ? state.userData : '') } }
})
vi.mock('electron', () => ({ app: electronMock.app }))

import { readBootState, recordBootSuccess, recordBootFailure, shouldRecoverSafe, clearRecovery } from '../src/main/recovery.ts'

let scratch: string[] = []
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
  scratch.push(dir)
  electronMock.state.userData = dir
})
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch = []
})

describe('recovery', () => {
  it('初始状态为 0 次失败（不进入安全模式）', () => {
    expect(readBootState()).toEqual({ failures: 0 })
    expect(shouldRecoverSafe()).toBe(false)
  })
  it('failures 累加，达到失败即进入安全模式', () => {
    recordBootFailure()
    recordBootFailure()
    expect(readBootState().failures).toBe(2)
    expect(shouldRecoverSafe()).toBe(true)
  })
  it('recordBootSuccess 清零', () => {
    recordBootFailure()
    recordBootSuccess()
    expect(readBootState()).toEqual({ failures: 0 })
    expect(shouldRecoverSafe()).toBe(false)
  })
  it('clearRecovery（进入安全模式后）清零', () => {
    recordBootFailure()
    clearRecovery()
    expect(readBootState().failures).toBe(0)
  })
})
