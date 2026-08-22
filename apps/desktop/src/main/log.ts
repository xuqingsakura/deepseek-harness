/**
 * 桌面端主进程日志（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：为宿主启动、API 桥等提供分级日志。开发模式打到控制台；
 * 打包模式（无控制台）镜像到 userData/dsh-desktop.log；`traceLog` 仅在
 * `DSH_DESKTOP_TRACE=1` 时输出。
 * @module @deepseek-ai/dsh-desktop/main/log
 */

import { app } from 'electron'
import { join } from 'node:path'

/** 延迟导入 node:fs（require），保持文件顶部依赖轻量；仅供 debugLog 使用。 */
function awaitImportFs(): { appendFileSync: (path: string, data: string) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs') as { appendFileSync(path: string, data: string): void }
}

/**
 * 记录关键事件日志：开发模式打到控制台，打包模式写入 userData/dsh-desktop.log。
 * 日志写入失败绝不阻断启动。
 * @param message - 要记录的日志消息。
 */
function debugLog(message: string): void {
  if (!app.isPackaged) {
    console.log(message)
    return
  }
  try {
    const logPath = join(app.getPath('userData'), 'dsh-desktop.log')
    const line = `${new Date().toISOString()} ${message}\n`
    const { appendFileSync } = awaitImportFs()
    appendFileSync(logPath, line)
  } catch {
    // 日志写入失败不能影响启动。
  }
}

/**
 * 追踪级日志：仅在环境变量 `DSH_DESKTOP_TRACE=1` 时输出。
 * @param message - 要记录的追踪消息。
 */
function traceLog(message: string): void {
  if (process.env.DSH_DESKTOP_TRACE?.trim() === '1') console.log(message)
}

export { debugLog, traceLog }
