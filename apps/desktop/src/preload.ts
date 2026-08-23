/**
 * Desktop shell preload: exposes the window-control bridge to the renderer and
 * mounts the custom title bar over the harness UI.
 *
 * The preload runs in an isolated world but shares the page DOM, so the title
 * bar and the top-padding reservation are injected here and the product UI
 * stays untouched — the browser build never loads this file. The renderer
 * reaches the bridge as `window.dshDesktop` (main world only); the preload's
 * own listeners call the local bridge directly, never `window.dshDesktop`,
 * which does not exist in the isolated world.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { FAVICON_MARK, MINIMIZE_ICON, MAXIMIZE_ICON, RESTORE_ICON, CLOSE_ICON } from './preload-icons.ts'
import type { BuiltinPluginInfo, DesktopPluginInfo, PluginManagerResult } from './plugin-manager.ts'
import type { MigrationReport, MigrateOptions } from './migrate-web-data.ts'

/** Must match the strip height the main process reserves (see main.ts). */
const TITLEBAR_HEIGHT = 32

/** Window-control actions the custom title bar can request. */
type WindowControlAction = 'minimize' | 'maximize-toggle' | 'close'

/** Desktop auto-update state pushed by the main process (dsh:update-state). */
export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
}

/** The bridge exposed to the renderer as `window.dshDesktop`. */
export interface DesktopBridge {
  platform: string
  windowControl(action: WindowControlAction): void
  getWindowState(): Promise<{ maximized: boolean }>
  getHostMode(): Promise<{ mode: 'in-process' | 'child'; childAvailable: boolean }>
  setHostMode(mode: 'in-process' | 'child'): Promise<{ mode: 'in-process' | 'child'; childAvailable: boolean }>
  onMaximized(callback: (maximized: boolean) => void): () => void
  apiFetch(request: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number
    statusText: string
    headers: Record<string, string>
    text: string
  }>
  subscribeApiStream(
    channel: 'mux' | 'host',
    onFrame: (envelope: unknown) => void,
    onOpen: () => void,
    onEnd: () => void,
  ): () => void
  notify(options: { title: string; body: string }): void
  pluginAdd(spec: string): Promise<PluginManagerResult>
  pluginRemove(name: string): Promise<PluginManagerResult>
  pluginList(): Promise<DesktopPluginInfo[]>
  pluginAuthorizeBuilds(keys: string[]): Promise<{ path: string }>
  pluginUpdate(name: string): Promise<PluginManagerResult>
  pluginUpdateAll(): Promise<PluginManagerResult>
  pluginCancel(): Promise<{ cancelled: boolean }>
  pluginRemoveMany(names: string[]): Promise<PluginManagerResult>
  pluginSetEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; bundles: string[]; enabled: boolean; liveApplied: boolean }>
  pluginOutdated(): Promise<Record<string, string>>
  /** List bundled plugins shipped with this desktop build. */
  pluginBuiltinList(): Promise<BuiltinPluginInfo[]>
  /** One-click install of a bundled plugin by directory name. */
  pluginInstallBuiltin(name: string): Promise<PluginManagerResult>
  /** Return the current updater state without triggering a check. */
  updateStatus(): Promise<DesktopUpdateState>
  /** Trigger an update check and return the current updater state. */
  updateCheck(): Promise<DesktopUpdateState>
  /** Restart and install a downloaded update (no-op unless one is ready). */
  updateInstall(): void
  /** Subscribe to updater-state pushes; returns the unsubscriber. */
  onUpdateState(callback: (state: DesktopUpdateState) => void): () => void
  getDiagnostics(): Promise<{ version: string; host: { mode: 'in-process' | 'child'; childAvailable: boolean }; pluginCount: number; logPath: string }>
  openLogFile(): Promise<void>
  relaunchSafe(): Promise<void>
  reportAppReady(): void
  /** Import Web-harness data (~/.dsh) into the desktop home (safe merge). */
  migrateWebData(options?: MigrateOptions): Promise<MigrationReport>
  /** Open (or focus) a detached VSCode-style workbench window for one session. */
  openWorkbenchWindow(sessionId?: string): Promise<unknown>
  /** 工作台窗口「回到原桌面」：显示主窗口并关闭工作台窗口。 */
  leaveWorkbench(): Promise<unknown>
}

declare global {
  interface Window {
    dshDesktop: DesktopBridge
  }
}

/**
 * The DeepSeek favicon (apps/web/public/favicon.svg) verbatim, minus its
 * `prefers-color-scheme` rule: the desktop title bar paints the whale through
 * `fill: currentColor` (see mountTitleBar), so it tracks the app's
 * `--dsw-alias-label-primary` token like the sidebar FishLogo instead of the
 * OS/browser scheme.
 */


/** Local bridge: the preload's own listeners use this, not window.dshDesktop. */
const bridge: DesktopBridge = {
  platform: process.platform,
  windowControl: (action: WindowControlAction): void => {
    ipcRenderer.send('dsh:window-control', action)
  },
  getWindowState: (): Promise<{ maximized: boolean }> => ipcRenderer.invoke('dsh:window-state'),
  getHostMode: () => ipcRenderer.invoke('dsh:get-host-mode'),
  setHostMode: (mode: 'in-process' | 'child') => ipcRenderer.invoke('dsh:set-host-mode', mode),
  getDiagnostics: () => ipcRenderer.invoke('dsh:get-diagnostics'),
  openLogFile: () => ipcRenderer.invoke('dsh:open-log-file'),
  relaunchSafe: () => ipcRenderer.invoke('dsh:relaunch-safe'),
  reportAppReady: () => { fadeLoadingOverlay(); ipcRenderer.send('dsh:app-ready') },
  onMaximized: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void =>{  callback(maximized) }
    ipcRenderer.on('dsh:maximized', listener)
    return () => ipcRenderer.removeListener('dsh:maximized', listener)
  },
  notify: (options: { title: string; body: string }): void => {
    ipcRenderer.send('dsh:notify', options)
  },
  pluginAdd: (spec: string) => ipcRenderer.invoke('dsh:plugin-add', spec) as Promise<PluginManagerResult>,
  pluginRemove: (name: string) => ipcRenderer.invoke('dsh:plugin-remove', name) as Promise<PluginManagerResult>,
  pluginList: () => ipcRenderer.invoke('dsh:plugin-list') as Promise<DesktopPluginInfo[]>,
  pluginAuthorizeBuilds: (keys: string[]) => ipcRenderer.invoke('dsh:plugin-allow-builds', keys) as Promise<{ path: string }>,
  pluginUpdate: (name: string) => ipcRenderer.invoke('dsh:plugin-update', name) as Promise<PluginManagerResult>,
  pluginUpdateAll: () => ipcRenderer.invoke('dsh:plugin-update-all') as Promise<PluginManagerResult>,
  pluginCancel: () => ipcRenderer.invoke('dsh:plugin-cancel') as Promise<{ cancelled: boolean }>,
  pluginRemoveMany: (names: string[]) => ipcRenderer.invoke('dsh:plugin-remove-many', names) as Promise<PluginManagerResult>,
  pluginSetEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('dsh:plugin-set-enabled', name, enabled) as Promise<{ ok: boolean; bundles: string[]; enabled: boolean; liveApplied: boolean }>,
  pluginOutdated: () => ipcRenderer.invoke('dsh:plugin-outdated') as Promise<Record<string, string>>,
  pluginBuiltinList: () => ipcRenderer.invoke('dsh:plugin-builtin-list') as Promise<BuiltinPluginInfo[]>,
  pluginInstallBuiltin: (name: string) => ipcRenderer.invoke('dsh:plugin-builtin-install', name) as Promise<PluginManagerResult>,
  updateStatus: () => ipcRenderer.invoke('dsh:update-status') as Promise<DesktopUpdateState>,
  updateCheck: () => ipcRenderer.invoke('dsh:update-check') as Promise<DesktopUpdateState>,
  updateInstall: () => { void ipcRenderer.invoke('dsh:update-install') },
  migrateWebData: (options?: MigrateOptions) => ipcRenderer.invoke('dsh:migrate-web-data', options ?? {}) as Promise<MigrationReport>,
  /** Open (or focus) a detached VSCode-style workbench window for one session. */
  openWorkbenchWindow: (sessionId?: string) => ipcRenderer.invoke('dsh:open-workbench-window', sessionId),
  leaveWorkbench: () => ipcRenderer.invoke('dsh:leave-workbench'),
  onUpdateState: (callback: (state: DesktopUpdateState) => void) => {
    const listener = (_event: IpcRendererEvent, state: DesktopUpdateState): void =>{  callback(state) }
    ipcRenderer.on('dsh:update-state', listener)
    return () => ipcRenderer.removeListener('dsh:update-state', listener)
  },
  apiFetch: (request: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
    return ipcRenderer.invoke('dsh:api-fetch', request)
  },
  subscribeApiStream: (
    channel: 'mux' | 'host',
    onFrame: (envelope: unknown) => void,
    onOpen: () => void,
    onEnd: () => void,
  ): (() => void) => {
    const frameListener = (_event: IpcRendererEvent, source: string, envelopes: unknown): void => {
      if (source !== channel) return
      // The main process coalesces bursts into one message carrying an array;
      // a single frame arrives unwrapped (kept for older/plain senders).
      if (Array.isArray(envelopes)) {
        for (const envelope of envelopes) onFrame(envelope)
      } else {
        onFrame(envelopes)
      }
    }
    const openListener = (_event: IpcRendererEvent, source: string): void => {
      if (source === channel) onOpen()
    }
    const endListener = (_event: IpcRendererEvent, source: string): void => {
      if (source === channel) onEnd()
    }
    ipcRenderer.on('dsh:api-frame', frameListener)
    ipcRenderer.on('dsh:api-stream-open', openListener)
    ipcRenderer.on('dsh:api-stream-end', endListener)
    ipcRenderer.send('dsh:api-stream-subscribe', channel)
    return () => {
      ipcRenderer.removeListener('dsh:api-frame', frameListener)
      ipcRenderer.removeListener('dsh:api-stream-open', openListener)
      ipcRenderer.removeListener('dsh:api-stream-end', endListener)
      ipcRenderer.send('dsh:api-stream-unsubscribe', channel)
    }
  },
}

contextBridge.exposeInMainWorld('dshDesktop', bridge)

/** Title-bar caption: the detached workspace window names itself, the main window stays branded. */
function titleBarText(): string {
  return new URLSearchParams(window.location.search).get('dshWindow') === 'workspace'
    ? 'DeepSeek Harness 工作台'
    : 'DeepSeek Harness'
}

/** Mount the title bar and reserve its strip once the document exists. */
function mountTitleBar(): void {
  // 仅真实宿主页面(web app/工作台)挂标题栏；启动动画(splash, data:)不显示，使其为纯动画。
  if (window.location.protocol !== 'http:') return
  const host = document.createElement('div')
  host.id = 'dsh-titlebar'
  host.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'right: 0',
    `height: ${TITLEBAR_HEIGHT}px`,
    'z-index: 2147483647',
    'display: flex',
    'align-items: center',
    'background: var(--dsw-alias-bg-base, #ffffff)',
    'color: var(--dsw-alias-label-primary, #111418)',
    'border-bottom: 1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 10%))',
    '-webkit-app-region: drag',
    'user-select: none',
    'overflow: hidden',
  ].join('; ')
  host.innerHTML = [
    `<span id="dsh-titlebar-icon" style="display: flex; height: 100%; align-items: center; padding-left: 12px;">${FAVICON_MARK}</span>`,
    `<span id="dsh-titlebar-title" style="position: absolute; left: 50%; transform: translateX(-50%); font-size: 12px; line-height: ${TITLEBAR_HEIGHT}px; letter-spacing: 0.02em; white-space: nowrap; pointer-events: none;">${titleBarText()}</span>`,
    '<div id="dsh-titlebar-controls" style="display: flex; height: 100%; margin-left: auto; -webkit-app-region: no-drag;">',
    `  <button id="dsh-btn-min" title="最小化">${MINIMIZE_ICON}</button>`,
    `  <button id="dsh-btn-max" title="最大化">${MAXIMIZE_ICON}</button>`,
    `  <button id="dsh-btn-close" title="关闭">${CLOSE_ICON}</button>`,
    '</div>',
  ].join('')
  // Mount inside body: the theme presenter writes its --dsw-* alias tokens as
  // inline variables on body, and a fixed element here inherits them, so the
  // title bar follows the app's light/dark theme instead of a hardcoded face.
  document.body.appendChild(host)

  const styles = document.createElement('style')
  styles.textContent = [
    // The whale fill follows the app text color (label-primary) like the
    // sidebar FishLogo: dark ink in light mode, near-white in dark mode.
    '#dsh-titlebar-icon path { fill: currentColor; }',
    '#dsh-titlebar button { width: 46px; height: 100%; border: none; margin: 0; padding: 0;',
    '  display: inline-flex; align-items: center; justify-content: center; background: transparent;',
    '  color: inherit; cursor: default; -webkit-app-region: no-drag; }',
    '#dsh-titlebar button:hover { background: rgb(128 128 128 / 0.18); }',
    '#dsh-titlebar #dsh-btn-close:hover { background: #e81123; color: #ffffff; }',
    `body { padding-top: ${TITLEBAR_HEIGHT}px !important; box-sizing: border-box; }`,
  ].join('\n')
  document.head.appendChild(styles)

  const min = document.getElementById('dsh-btn-min')
  const max = document.getElementById('dsh-btn-max')
  const close = document.getElementById('dsh-btn-close')
  const controls = document.getElementById('dsh-titlebar-controls')
  min?.addEventListener('click', () =>{  bridge.windowControl('minimize') })
  max?.addEventListener('click', () =>{  bridge.windowControl('maximize-toggle') })
  close?.addEventListener('click', () =>{  bridge.windowControl('close') })
  host.addEventListener('dblclick', (event) => {
    if (controls !== null && controls.contains(event.target as Node)) return
    bridge.windowControl('maximize-toggle')
  })

  const applyMaximized = (maximized: boolean): void => {
    if (max === null) return
    max.innerHTML = maximized ? RESTORE_ICON : MAXIMIZE_ICON
    max.title = maximized ? '还原' : '最大化'
  }
  void bridge.getWindowState().then((state) =>{  applyMaximized(state.maximized) })
  bridge.onMaximized(applyMaximized)
}

/** 启动加载层相关（P0-C）：web app 数据就绪(reportAppReady)后淡出，超时兜底。 */
const READY_TIMEOUT_MS = 8_000
let loadingOverlay: HTMLDivElement | null = null

/** 淡出并移除启动加载层。 */
function fadeLoadingOverlay(): void {
  if (loadingOverlay === null) return
  loadingOverlay.style.transition = 'opacity 320ms ease'
  loadingOverlay.style.opacity = '0'
  const overlay = loadingOverlay
  loadingOverlay = null
  setTimeout(() => overlay.remove(), 360)
}

/** 在 web app 页注入全屏启动加载层（跳过 splash 与工作台窗口），并设超时兜底。 */
function mountLoadingOverlay(): void {
  // 仅真实宿主页面注入；splash(data:) 与工作台(dshWindow=workspace)跳过。
  if (window.location.protocol !== 'http:') return
  if (new URLSearchParams(window.location.search).get('dshWindow') === 'workspace') return
  if (loadingOverlay !== null) return
  const host = document.createElement('div')
  host.id = 'dsh-loading-overlay'
  host.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483646',
    'display: flex',
    'flex-direction: column',
    'align-items: center',
    'justify-content: center',
    'gap: 12px',
    'background: var(--dsw-alias-bg-base, #ffffff)',
    'color: var(--dsw-alias-label-primary, #111418)',
    '-webkit-app-region: no-drag',
  ].join('; ')
  host.innerHTML = '<div style="font-size: 14px; letter-spacing: 0.02em;">正在加载对话…</div>'
  document.body.appendChild(host)
  loadingOverlay = host
  setTimeout(() => { fadeLoadingOverlay() }, READY_TIMEOUT_MS)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountTitleBar, { once: true })
  document.addEventListener('DOMContentLoaded', mountLoadingOverlay, { once: true })
} else {
  mountTitleBar()
  mountLoadingOverlay()
}
