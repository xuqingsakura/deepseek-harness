/**
 * 桌面端主窗口与工作台窗口（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：创建主窗口（加载宿主 URL，支持窗口状态恢复、藏到托盘、崩溃重载、外链外开）
 * 与分离的 VSCode 风格工作台窗口（工作台模式）。二者共享 `state` 里的工作台窗口与托盘状态。
 * @module @deepseek-ai/dsh-desktop/main/windows
 */

import { BrowserWindow, Notification, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { APP_ICON, PRELOAD, harnessHome } from './config.ts'
import { debugLog } from './log.ts'
import { state, releaseMainRendererInWorkbench } from './state.ts'
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
    && w !== state.workbenchWindow
    && /^https?:\/\//.test(w.webContents.getURL()))
}

/**
 * 恢复主窗口：显示并聚焦；若进入工作台时卸载过渲染器（当前为 about:blank），
 * 从记录的地址重载；已显示同一地址时则幂等跳过，避免重复加载导致闪烁。
 */
function restoreMainWindow(): void {
  const mainWin = findMainWindow()
  if (mainWin === undefined) return
  if (mainWin.isMinimized()) mainWin.restore()
  if (!mainWin.isVisible()) mainWin.show()
  mainWin.focus()
  const saved = state.mainWindowUrl
  const current = mainWin.webContents.getURL()
  if (saved !== undefined && saved !== '' && /^https?:\/\//.test(saved) && current !== saved) {
    void mainWin.loadURL(saved)
  }
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
      // ESM preload requires an unsandboxed renderer; the page is trusted
      // loopback content owned by the host child.
      sandbox: false,
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

/**
 * 打开（或聚焦）绑定某一会话的分离工作台窗口（VSCode 风格工作台模式）。
 *
 * 窗口加载同样的宿主 origin，并带 `?dshWindow=workspace&session=`，让 web UI 直接进入
 * dsh-workspace 插件的整窗布局；共享的进程内宿主与同源 localStorage 使两个窗口互操作。
 * 进入工作台模式会隐藏主窗口；关闭工作台窗口会恢复主窗口。会话切换通过共享的 sessions 服务。
 *
 * @param sessionId - 要在工作台中打开的会话；缺省则沿用 URL 自身默认（持久化的当前会话）。
 * @returns 创建（或已存在）的工作台窗口。
 */
function createWorkspaceWindow(sessionId: string | undefined): BrowserWindow {
  if (state.workbenchWindow !== undefined && !state.workbenchWindow.isDestroyed()) {
    if (!state.workbenchWindow.isVisible()) state.workbenchWindow.show()
    state.workbenchWindow.focus()
    return state.workbenchWindow
  }
  const main = findMainWindow()
  const base = main === undefined ? undefined : main.webContents.getURL()
  const url = base === undefined ? undefined : new URL(base)
  const saved = loadWindowState('window-state-workspace')
  const window = new BrowserWindow({
    ...(saved !== undefined ? { width: saved.width, height: saved.height } : { width: 1440, height: 900 }),
    ...(saved !== undefined && saved.x !== undefined && saved.y !== undefined && onVisibleDisplay(saved.x, saved.y)
      ? { x: saved.x, y: saved.y } : {}),
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: initialBackground(),
    ...(existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.once('ready-to-show', () => {
    if (saved?.maximized === true) window.maximize()
    window.show()
  })
  // Persist workbench geometry (debounced) so a relaunch restores its layout.
  let wsSaveTimer: ReturnType<typeof setTimeout> | undefined
  const persistWs = (): void => {
    if (window.isDestroyed()) return
    if (wsSaveTimer !== undefined) clearTimeout(wsSaveTimer)
    wsSaveTimer = setTimeout(() => {
      const bounds = window.getBounds()
      void saveWindowState({
        width: bounds.width,
        height: bounds.height,
        ...(bounds.x !== 0 || bounds.y !== 0 ? { x: bounds.x, y: bounds.y } : {}),
        ...(window.isMaximized() ? { maximized: true } : {}),
      }, 'window-state-workspace')
    }, 500)
  }
  window.on('resize', persistWs)
  window.on('move', persistWs)
  // 工作台窗口点 X：隐藏到系统托盘（不关闭、不恢复主窗口）。真正退出用「回到原桌面」按钮。
  window.on('close', (event) => {
    if (!state.quitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    if (wsSaveTimer !== undefined) clearTimeout(wsSaveTimer)
    if (state.workbenchWindow === window) state.workbenchWindow = undefined
    // 离开工作台模式：恢复主窗口（进入时卸载过渲染器会重载）。工作台点 X 只是隐藏，
    // 只有真正关闭（回到原桌面/退出）才会走到这里。
    restoreMainWindow()
  })
  if (url !== undefined) {
    url.searchParams.set('dshWindow', 'workspace')
    if (sessionId !== undefined && sessionId !== '') url.searchParams.set('session', sessionId)
    void window.loadURL(url.toString())
  } else {
    void window.loadURL(splashDataUrl(harnessHome()))
  }
  // Keep the custom title bar's maximize/restore glyph in sync with the real
  // window state (the shared preload listens for dsh:maximized).
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.send('dsh:maximized', window.isMaximized())
  })
  const publishWorkspaceMaximized = (): void => {
    if (!window.isDestroyed()) window.webContents.send('dsh:maximized', window.isMaximized())
  }
  window.on('maximize', publishWorkspaceMaximized)
  window.on('unmaximize', publishWorkspaceMaximized)
  // Entering workspace mode hides the main window (the detached window is now
  // the user's active surface).
  const mainWin = findMainWindow()
  if (mainWin !== undefined && !mainWin.isDestroyed() && mainWin !== window) {
    // 记录主窗口地址并隐藏；可选地卸载渲染器释放内存（默认关闭，需 desktop-settings.json 的 releaseMainRenderer=true）。
    state.mainWindowUrl = mainWin.webContents.getURL()
    mainWin.hide()
    if (releaseMainRendererInWorkbench()) {
      void mainWin.webContents.loadURL('about:blank')
    }
  }
  state.workbenchWindow = window
  return window
}

export { createMainWindow, createWorkspaceWindow, findMainWindow, restoreMainWindow }
