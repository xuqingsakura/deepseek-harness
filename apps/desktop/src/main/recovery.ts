/**
 * 桌面端启动/崩溃安全恢复（P2-A）。
 *
 * 记录「上次启动是否成功」：成功清零，失败累加。若上一次启动失败，下次进入安全模式——
 * main.ts 会据此禁用非基础插件（disableNonBasePlugins），避免坏插件把启动打崩成死循环。
 * 安全模式成功后重新清零。标记文件在 userData/boot-state.json。
 * @module @deepseek-ai/dsh-desktop/main/recovery
 */

import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 启动状态标记。 */
interface BootState {
  /** 连续失败次数；>0 表示上次启动失败，下次进入安全模式。 */
  failures: number
}

/** 标记文件路径（userData）。 */
function bootStateFile(): string {
  return join(app.getPath('userData'), 'boot-state.json')
}

/** 读取启动状态；缺失/损坏返回 0 次失败。 */
function readBootState(): BootState {
  try {
    const parsed = JSON.parse(readFileSync(bootStateFile(), 'utf8')) as Partial<BootState>
    return { failures: typeof parsed.failures === 'number' ? parsed.failures : 0 }
  } catch {
    return { failures: 0 }
  }
}

/** 写入启动状态；失败不影响启动。 */
function writeBootState(state: BootState): void {
  try {
    const file = bootStateFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state))
  } catch {
    // 标记写入失败不影响启动。
  }
}

/** 启动成功：清零失败计数。 */
function recordBootSuccess(): void {
  writeBootState({ failures: 0 })
}

/** 启动失败：累加失败计数。 */
function recordBootFailure(): void {
  const state = readBootState()
  writeBootState({ failures: state.failures + 1 })
}

/** 是否应进入安全模式（上次启动失败）。 */
function shouldRecoverSafe(): boolean {
  return readBootState().failures > 0
}

/** 进入安全模式时清除失败标记（避免每次都触发）。 */
function clearRecovery(): void {
  writeBootState({ failures: 0 })
}

export { bootStateFile, readBootState, recordBootSuccess, recordBootFailure, shouldRecoverSafe, clearRecovery }
