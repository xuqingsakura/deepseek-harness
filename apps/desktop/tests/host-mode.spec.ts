/**
 * host-mode 单元测试（P2-10 为桌面主进程模块补的最小测试）。
 *
 * host-mode.ts 依赖 Electron 的 `app`，这里用 vi.mock 注入最小可替换实现，
 * 只验证「模式解析优先级 / 配置读写 / child 可用性」的纯逻辑，不拉起 Electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// hoisted 可变状态：让 mock 的 app.getPath('userData') 在测试内指向真实临时目录。
const electronMock = vi.hoisted(() => {
  const state = { userData: '' }
  return {
    state,
    app: {
      isPackaged: false,
      getPath: (name: string): string => (name === 'userData' ? state.userData : ''),
    },
  }
})

vi.mock('electron', () => ({ app: electronMock.app }))

import { resolveHostMode, writeHostMode, hostModeFile, childHostAvailable } from '../src/main/host-mode.ts'

let scratch: string[] = []

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hostmode-'))
  scratch.push(dir)
  electronMock.state.userData = dir
  delete process.env.DSH_DESKTOP_HOST
})

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch = []
})

describe('host-mode', () => {
  it('默认解析为 child（无环境变量/无配置，P0-A 默认改子进程）', () => {
    expect(resolveHostMode()).toBe('child')
  })

  it('环境变量 DSH_DESKTOP_HOST=child 优先于默认', () => {
    process.env.DSH_DESKTOP_HOST = 'child'
    expect(resolveHostMode()).toBe('child')
  })

  it('环境变量 DSH_DESKTOP_HOST=in-process 强制 in-process', () => {
    process.env.DSH_DESKTOP_HOST = 'in-process'
    expect(resolveHostMode()).toBe('in-process')
  })

  it('配置 host-mode.json 可覆盖默认（切回 in-process）', () => {
    writeHostMode('in-process')
    expect(resolveHostMode()).toBe('in-process')
  })

  it('配置 host-mode.json 设为 child 生效', () => {
    writeHostMode('child')
    expect(resolveHostMode()).toBe('child')
  })

  it('配置文件的非法值回退为默认 child', () => {
    writeFileSync(hostModeFile(), JSON.stringify({ mode: 'bogus' }), 'utf8')
    expect(resolveHostMode()).toBe('child')
  })

  it('开发（未打包）模式 child 始终可用', () => {
    expect(childHostAvailable()).toBe(true)
  })
})
