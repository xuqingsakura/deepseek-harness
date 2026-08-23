/**
 * window-state 单元测试（P2-10）。
 *
 * 验证窗口几何持久化的纯逻辑：保存/读取往返、损坏 JSON 回退、以及保存坐标是否
 * 仍落在可见显示器工作区内。用 vi.mock 注入最小的 electron app/screen。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronMock = vi.hoisted(() => {
  const state = {
    userData: '',
    displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  }
  return {
    state,
    app: { getPath: (name: string): string => (name === 'userData' ? state.userData : '') },
    screen: { getAllDisplays: () => state.displays },
  }
})

vi.mock('electron', () => ({ app: electronMock.app, screen: electronMock.screen }))

import { saveWindowState, loadWindowState, onVisibleDisplay } from '../src/main/window-state.ts'

let scratch: string[] = []

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-winstate-'))
  scratch.push(dir)
  electronMock.state.userData = dir
})

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch = []
})

describe('window-state', () => {
  it('保存后可完整读回', async () => {
    await saveWindowState({ width: 800, height: 600, x: 10, y: 20, maximized: true })
    expect(loadWindowState()).toEqual({ width: 800, height: 600, x: 10, y: 20, maximized: true })
  })

  it('损坏的 JSON 返回 undefined（走默认窗口）', async () => {
    writeFileSync(join(electronMock.state.userData, 'window-state.json'), 'not json', 'utf8')
    expect(loadWindowState()).toBeUndefined()
  })

  it('缺少数值型 width/height 时返回 undefined', async () => {
    writeFileSync(join(electronMock.state.userData, 'window-state.json'), JSON.stringify({ width: 'bad' }), 'utf8')
    expect(loadWindowState()).toBeUndefined()
  })

  it('onVisibleDisplay 判断保存坐标是否仍落于工作区', () => {
    expect(onVisibleDisplay(100, 100)).toBe(true)
    expect(onVisibleDisplay(3000, 100)).toBe(false)
  })
})
