/**
 * 桌面端主窗口与工作台窗口（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：创建主窗口（加载宿主 URL，支持窗口状态恢复、藏到托盘、崩溃重载、外链外开）
 * 与系统托盘状态。
 * @module @deepseek-ai/dsh-desktop/main/windows
 */

import { BrowserWindow, Notification, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { APP_ICON, PRELOAD, harnessHome } from './config.ts'
import { debugLog } from './log.ts'
import { state } from './state.ts'
import { splashDataUrl } from '../splash.ts'
import { loadWindowState, saveWindowState, onVisibleDisplay } from './window-state.ts'

/**
 * 创建主窗口（加载宿主 URL）。
 * @param url - 宿主就绪后的 loopback URL；为空则先加载 splash。
 * @param onClosed - 窗口关闭后的回调（用于任务完成/清理）。
 * @param isSmoke - 是否为 `--smoke` 自检模式（渲染进程崩溃时不自动重载）。
 * @returns 创建好的主窗口。
 */

/** 窗口未加载页面前的初始背景色：跟随系统明暗，避免白/黑闪屏与主题不符。 */
function initialBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f6f7f9'
}
/** 返回主窗口：优先用 state 引用，其次按 URL 兜底（兼容卸载为 about:blank 后的场景）。 */
function findMainWindow(): BrowserWindow | undefined {
  const ref = state.mainWindow
  if (ref !== undefined && !ref.isDestroyed()) return ref
  // URL 兜底：挑一个非工作台的 http(s) 窗口。
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()
    && /^https?:\/\//.test(w.webContents.getURL()))
}

function createMainWindow(url: string | undefined, onClosed: () => void, isSmoke: boolean): BrowserWindow {
  const saved = loadWindowState()
  const window = new BrowserWindow({
    ...(saved !== undefined
      ? { width: saved.width, height: saved.height }
      : { width: 1440, height: 900 }),
    ...(saved !== undefined && saved.x !== undefined && saved.y !== undefined && onVisibleDisplay(saved.x, saved.y)
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: 940,
    minHeight: 600,
    show: false,
    // Frameless: the preload mounts a custom title bar with window controls.
    frame: false,
    backgroundColor: initialBackground(),
    // The generated ICO gives the window, alt-tab, and taskbar their favicon face.
    ...(existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // P1-C: preload 已是单文件 CJS(bundle-preload)，可安全开启沙箱，降低渲染层攻击面。
      sandbox: true,
    },
  })
  // 记录主窗口引用，供工作台模式（卸载/恢复）与窗口定位使用。
  state.mainWindow = window
  window.once('ready-to-show', () => {
    if (saved?.maximized === true) window.maximize()
    window.show()
  })
  window.on('closed', () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    if (state.mainWindow === window) state.mainWindow = undefined
    onClosed()
  })
  // Closing the window parks it in the tray instead of quitting; the tray's
  // quit item (or before-quit) is the real exit path.
  window.on('close', (event) => {
    if (!state.quitting && state.tray !== undefined) {
      event.preventDefault()
      window.hide()
      // Hidden windows keep the renderer for the tray resume; keep Chromium's
      // background throttling on so hidden-page timers/animations drop CPU.
      window.webContents.setBackgroundThrottling(true)
      if (Notification.isSupported()) {
        new Notification({ title: 'DeepSeek Harness', body: '已最小化到系统托盘，点击托盘图标恢复窗口。' }).show()
      }
    }
  })
  // Persist geometry (debounced) so a relaunch restores position and size.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (window.isDestroyed()) return
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const bounds = window.getBounds()
      void saveWindowState({
        width: bounds.width,
        height: bounds.height,
        ...(bounds.x !== 0 || bounds.y !== 0 ? { x: bounds.x, y: bounds.y } : {}),
        ...(window.isMaximized() ? { maximized: true } : {}),
      })
    }, 500)
  }
  window.on('resize', persist)
  window.on('move', persist)
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.send('dsh:maximized', window.isMaximized())
  })
  const publishMaximized = (): void => {
    if (!window.isDestroyed()) window.webContents.send('dsh:maximized', window.isMaximized())
  }
  window.on('maximize', publishMaximized)
  window.on('unmaximize', publishMaximized)
  // Renderer crashes auto-reload once; a second crash within 10s leaves the
  // shell for the user to restart instead of reload-looping.
  let rendererGoneAt = 0
  window.webContents.on('render-process-gone', (_event, details) => {
    debugLog(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
    if (state.quitting || isSmoke || window.isDestroyed()) return
    const now = Date.now()
    const reload = now - rendererGoneAt > 10_000
    rendererGoneAt = now
    if (reload) {
      setTimeout(() => {
        if (!window.isDestroyed()) window.reload()
      }, 500)
    } else if (Notification.isSupported()) {
      new Notification({ title: 'DeepSeek Harness', body: `界面进程异常退出（${details.reason}），请重启应用。` }).show()
    }
  })
  // External links open in the system browser; the shell window never leaves
  // the host origin (and never spawns a second frameless window).
  const openExternal = (url: string): void => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    try {
      if (new URL(url).origin !== new URL(current).origin) {
        event.preventDefault()
        openExternal(url)
      }
    } catch {
      event.preventDefault()
    }
  })

  if (url !== undefined) {
    void window.loadURL(url)
  } else {
    // Host still booting: paint the splash so the launch feels immediate.
    void window.loadURL(splashDataUrl(harnessHome()))
  }
  return window
}

export { createMainWindow, findMainWindow }
