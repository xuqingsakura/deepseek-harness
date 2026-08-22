/**
 * 桌面端主进程共享可变状态（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：主进程里跨多个功能模块（窗口/托盘/IPC/宿主/更新）共享的单例可变状态。
 * 通过一个类型化对象集中保管，避免在多个模块间互相传参；每个字段是可选/可置的，模块按需读写。
 * @module @deepseek-ai/dsh-desktop/main/state
 */

import type { BrowserWindow, Tray } from 'electron'
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
  /** 循环宿主服务器的 origin，供 IPC 桥使用。 */
  hostBaseUrl?: string | undefined
  /** 进程内宿主的实时 loader 控制（子进程模式为 undefined）。 */
  liveHostControls?: InProcessHostControls | undefined
}

/** 全局单例状态（Electron 主进程只有一个）。 */
export const state: AppState = { quitting: false }
