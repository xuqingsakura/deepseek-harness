/**
 * 桌面端系统托盘（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：托盘入口（图标、显示/隐藏、退出）与显示/隐藏切换逻辑。工作台模式下，
 * 托盘点击应聚焦/切换工作台窗口，而非同时显示主窗口。
 * @module @deepseek-ai/dsh-desktop/main/tray
 */

import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { TRAY_ICON } from './config.ts'
import { state } from './state.ts'

/**
 * 显示/隐藏目标窗口。若处于工作台模式（存在未销毁的工作台窗口），切换的是工作台窗口。
 * @param window - 普通主窗口（工作台模式外使用）。
 */
function toggleWindow(window: BrowserWindow | undefined): void {
  // 工作台模式下，托盘点击应聚焦/切换工作台窗口，避免同时显示主窗口。
  if (state.workbenchWindow !== undefined && !state.workbenchWindow.isDestroyed()) {
    if (state.workbenchWindow.isVisible() && !state.workbenchWindow.isMinimized()) {
      state.workbenchWindow.hide()
    } else {
      if (state.workbenchWindow.isMinimized()) state.workbenchWindow.restore()
      state.workbenchWindow.show()
      state.workbenchWindow.focus()
    }
    return
  }
  if (window === undefined) return
  if (window.isVisible() && !window.isMinimized()) {
    window.hide()
  } else {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}

/**
 * 创建系统托盘入口（图标、显示/隐藏、退出）。
 * @param window - 返回当前主窗口（或工作台窗口）的 getter。
 * @returns 创建好的托盘实例。
 */
function createTray(window: () => BrowserWindow | undefined): Tray {
  const icon = nativeImage.createFromPath(TRAY_ICON)
  const created = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  created.setToolTip('DeepSeek Harness')
  created.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () =>{  toggleWindow(window()) } },
    { type: 'separator' },
    { label: '退出 DeepSeek Harness', click: () => {
      state.quitting = true
      app.quit()
    } },
  ]))
  created.on('click', () =>{  toggleWindow(window()) })
  return created
}

export { toggleWindow, createTray }
