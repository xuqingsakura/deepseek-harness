/**
 * 桌面端窗口几何状态的持久化（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：负责「读取上次窗口宽高/位置/最大化状态，并在启动时校验坐标仍落在
 * 可见显示器上」。主窗口与工作台窗口通过不同的 `stem` 复用同一套能力（默认 `window-state`）。
 * @module @deepseek-ai/dsh-desktop/main/window-state
 */

import { app, screen } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 持久化的窗口几何状态，跨启动恢复。 */
interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

/**
 * 窗口状态持久化文件路径（userData 下）。
 * @param stem - 文件名主干，用于区分主窗口/工作台窗口等；默认 `window-state`。
 * @returns 窗口状态 JSON 文件的绝对路径。
 */
function windowStateFile(stem = 'window-state'): string {
  return join(app.getPath('userData'), `${stem}.json`)
}

/**
 * 读取上次保存的窗口状态。
 *
 * 只接受数值型 width/height（其它异常/缺字段直接返回 undefined，恢复为默认窗口），
 * 避免损坏的 JSON 或旧格式在启动时抛错。
 * @param stem - 可选状态文件名主干，默认 `window-state`。
 * @returns 可用的窗口状态；文件缺失、损坏或字段不合法时返回 undefined。
 */
function loadWindowState(stem = 'window-state'): WindowState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(windowStateFile(stem), 'utf8')) as WindowState
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 保存窗口状态到文件（先确保目录存在）。
 * @param state - 要持久化的窗口几何状态。
 * @param stem - 可选状态文件名主干，默认 `window-state`。
 */
async function saveWindowState(state: WindowState, stem = 'window-state'): Promise<void> {
  await mkdir(dirname(windowStateFile(stem)), { recursive: true })
  await writeFile(windowStateFile(stem), JSON.stringify(state))
}

/**
 * 判断保存的坐标是否仍落在某个已连接的显示器工作区内。
 *
 * 屏幕分辨率/显示器可能变化，恢复位置前要校验，避免窗口被恢复到不可见区域。
 * @param x - 保存的窗口左上角 x。
 * @param y - 保存的窗口左上角 y。
 * @returns 是否仍落在任一显示器的工作区范围内。
 */
function onVisibleDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
  })
}

export type { WindowState }
export { windowStateFile, loadWindowState, saveWindowState, onVisibleDisplay }
