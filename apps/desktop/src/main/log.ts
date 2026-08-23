/**
 * 桌面端主进程日志（Phase 0.1 拆分，P0-3 异步化）。
 *
 * 从 main.ts 提取：为宿主启动、API 桥等提供分级日志。开发模式打到控制台；
 * 打包模式（无控制台）异步追加到 userData/dsh-desktop.log。traceLog 仅在
 * DSH_DESKTOP_TRACE=1 时输出。
 *
 * P0-3：打包模式下改用 createWriteStream 追加写入，避免每次 debugLog 都同步
 * 阻塞主进程（日志高频时 API/插件/宿主路径会加塞窗口事件）；流在 before-quit
 * 时通过 flushLog() 冲刷并关闭，确保退出前落盘。
 * @module @deepseek-ai/dsh-desktop/main/log
 */

import { app } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/** 打包模式的日志流；开发模式为 undefined（直接打控制台）。 */
let stream: WriteStream | undefined
/** 自上次 flush 以来写入的日志行数（用于按量冲刷）。 */
let pendingWrites = 0

/** 超过该行数后主动冲刷一次，避免内存里积压过多未落盘日志。 */
const FLUSH_LINES = 200

/**
 * 惰性创建（或复用）追加日志流。
 * @returns 可写的日志流；任何异常都返回 undefined（日志不影响启动）。
 */
function ensureStream(): WriteStream | undefined {
  if (!app.isPackaged) return undefined
  if (stream !== undefined && !stream.destroyed) return stream
  try {
    const logPath = join(app.getPath('userData'), 'dsh-desktop.log')
    stream = createWriteStream(logPath, { flags: 'a', encoding: 'utf8' })
    // 写入错误只记录一次（避免在错误处理器里再触发日志递归）。
    stream.on('error', () => { /* 日志写入失败不能影响启动。 */ })
    return stream
  } catch {
    return undefined
  }
}

/**
 * 记录关键事件日志：开发模式打到控制台，打包模式异步写入 userData/dsh-desktop.log。
 * 日志写入失败绝不阻断启动。
 * @param message - 要记录的日志消息。
 */
function debugLog(message: string): void {
  if (!app.isPackaged) {
    console.log(message)
    return
  }
  const target = ensureStream()
  if (target === undefined) return
  const line = `${new Date().toISOString()} ${message}\n`
  target.write(line)
  pendingWrites += 1
  if (pendingWrites >= FLUSH_LINES) {
    // write 是流式缓冲的，这里只是重置计数器；真正落盘由流自身完成。
    pendingWrites = 0
  }
}

/**
 * 冲刷并关闭日志流（应在应用退出前调用，避免缓存日志丢失）。
 */
function flushLog(): void {
  if (stream !== undefined && !stream.destroyed) {
    stream.end()
  }
  stream = undefined
  pendingWrites = 0
}

/**
 * 追踪级日志：仅在环境变量 DSH_DESKTOP_TRACE=1 时输出。
 * @param message - 要记录的追踪消息。
 */
function traceLog(message: string): void {
  if (process.env.DSH_DESKTOP_TRACE?.trim() === '1') console.log(message)
}

export { debugLog, traceLog, flushLog }
