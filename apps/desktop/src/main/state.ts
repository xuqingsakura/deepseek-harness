/**
 * 桌面端主进程共享可变状态（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：主进程里跨多个功能模块（窗口/托盘/IPC/宿主/更新）共享的单例可变状态。
 * 通过一个类型化对象集中保管，避免在多个模块间互相传参；每个字段是可选/可置的，模块按需读写。
 * @module @deepseek-ai/dsh-desktop/main/state
 */

import type { BrowserWindow, Tray } from 'electron'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostHandle } from './host.ts'
import type { InProcessHostControls } from '../host-in-process.ts'

/** 主进程共享的可变状态。 */
export interface AppState {
  /** 正在运行/等待中的宿主（子进程或进程内 tree）。 */
  host?: HostHandle | undefined
  /** 是否正在退出（真实退出路径为 before-quit；关闭窗口只是藏到托盘）。 */
  quitting: boolean
  /** 系统托盘实例。 */
  tray?: Tray | undefined
  /** 分离的 VSCode 风格工作台窗口（工作台模式）。 */
  workbenchWindow?: BrowserWindow | undefined
  /** 主窗口引用（避免用 URL 正则猜测；卸载为 about:blank 后仍可定位）。 */
  mainWindow?: BrowserWindow | undefined
  /** 循环宿主服务器的 origin，供 IPC 桥使用。 */
  hostBaseUrl?: string | undefined
  /** 进程内宿主的实时 loader 控制（子进程模式为 undefined）。 */
  liveHostControls?: InProcessHostControls | undefined
  /** 工作台模式下隐藏主窗口前的地址（用于离开工作台时恢复重载）。 */
  mainWindowUrl?: string | undefined
}

/** userData 下的桌面端设置文件（host-mode 之外的通用开关）。 */
function desktopSettingsFile(): string {
  return join(app.getPath('userData'), 'desktop-settings.json')
}

/**
 * 工作台模式下是否释放主窗口渲染进程（卸载为 about:blank 以省内存）。
 * 读 userData/desktop-settings.json 的 `releaseMainRenderer` 字段；默认 false（保守，避免恢复卡顿）。
 * @returns 是否允许在工作台模式下卸载主窗口渲染器。
 */
function releaseMainRendererInWorkbench(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(desktopSettingsFile(), 'utf8')) as { releaseMainRenderer?: unknown }
    return parsed.releaseMainRenderer === true
  } catch {
    return false
  }
}

/** 全局单例状态（Electron 主进程只有一个）。 */
export const state: AppState = { quitting: false }

export { releaseMainRendererInWorkbench }
