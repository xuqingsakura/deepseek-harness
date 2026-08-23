/**
 * 桌面端宿主运行模式解析（P0-1）。
 *
 * DSH 宿主（harness）可在两种模式下运行：
 * - `in-process`（默认）：整个 harness 直接跑在 Electron 主进程内（host-in-process），
 *   启动快、无需额外 Node；但 agent/LLM/工具等重活与窗口 UI 争抢主线程，长任务时易卡顿。
 * - `child`：把 `dsh web` 作为真实 Node 子进程拉起（main/host.ts 的 startHost），
 *   重活移出主进程，运行时 CPU 更平稳；但打包模式需要内置 node.exe，会增大体积。
 *
 * 模式来源优先级：环境变量 `DSH_DESKTOP_HOST` > userData/host-mode.json > 默认 in-process。
 * 提供 write 能力供设置 UI 后续做切换；并暴露 `childHostAvailable()` 以便在不受支持的
 * 打包构建下优雅回退（改用 in-process），而不是启动即崩。
 * @module @deepseek-ai/dsh-desktop/main/host-mode
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 宿主运行模式。 */
export type HostMode = 'in-process' | 'child'

/** 模式配置文件名（userData 下）。 */
const HOST_MODE_FILE = 'host-mode.json'

/** 打包模式下 child 宿主所需的内置 Node 可执行文件。 */
function bundledNodeExecutable(): string {
  return join(process.resourcesPath, 'runtime', 'node.exe')
}

/** 模式覆盖文件路径（userData 下）。 */
function hostModeFile(): string {
  return join(app.getPath('userData'), HOST_MODE_FILE)
}

/**
 * 读取模式覆盖文件。
 * 只接受 `{"mode": "in-process" | "child"}`；缺失/损坏/非法值均返回 undefined（走默认/环境变量）。
 * @returns 配置的宿主模式；无有效配置时返回 undefined。
 */
function readHostModeConfig(): HostMode | undefined {
  try {
    const parsed = JSON.parse(readFileSync(hostModeFile(), 'utf8')) as { mode?: unknown }
    const mode = parsed.mode
    if (mode === 'in-process' || mode === 'child') return mode
  } catch {
    // 文件缺失或损坏：由调用方走默认逻辑。
  }
  return undefined
}

/**
 * 解析当前应使用的宿主模式。
 * 优先级：环境变量 > 配置文件 > 默认 in-process。
 * @returns 当前选择的宿主模式。
 */
function resolveHostMode(): HostMode {
  const envMode = process.env.DSH_DESKTOP_HOST?.trim()
  if (envMode === 'child') return 'child'
  if (envMode === 'in-process') return 'in-process'
  return readHostModeConfig() ?? 'child'
}

/**
 * child 模式在当前构建下是否真正可运行。
 * - dev（未打包）：走 PATH 中的真实 Node，可用。
 * - 打包：需要 resources/runtime/node.exe 存在；缺失则不可用。
 * @returns child 模式是否可运行。
 */
function childHostAvailable(): boolean {
  return app.isPackaged ? existsSync(bundledNodeExecutable()) : true
}

/**
 * 写入宿主模式配置（供设置 UI 调用；生效需重启应用）。
 * @param mode - 目标宿主模式。
 */
function writeHostMode(mode: HostMode): void {
  const file = hostModeFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ mode }, null, 2))
}

/**
 * 读取当前模式的诊断信息（供 IPC / smoke 使用）。
 * @returns 当前模式、以及 child 模式是否可用。
 */
function hostModeInfo(): { mode: HostMode; childAvailable: boolean } {
  const mode = resolveHostMode()
  return { mode, childAvailable: childHostAvailable() }
}

export { resolveHostMode, writeHostMode, childHostAvailable, hostModeInfo, hostModeFile }
