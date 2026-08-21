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
  /** Import Web-harness data (~/.dsh) into the desktop home (safe merge). */
  migrateWebData(options?: MigrateOptions): Promise<MigrationReport>
  /** Open (or focus) a detached VSCode-style workbench window for one session. */
  openWorkbenchWindow(sessionId?: string): Promise<unknown>
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
const FAVICON_MARK = '<svg width="18" height="18" viewBox="0 0 50 50" fill="none" aria-hidden="true"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#000" fill-opacity="1.000000" fill-rule="nonzero"/></svg>'

const MAXIMIZE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>'
const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 0.5v7h7v-7z" fill="none" stroke="currentColor"/><path d="M0.5 2.5v7h7" fill="none" stroke="currentColor"/></svg>'
const MINIMIZE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg>'
const CLOSE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg>'

/** Local bridge: the preload's own listeners use this, not window.dshDesktop. */
const bridge: DesktopBridge = {
  platform: process.platform,
  windowControl: (action: WindowControlAction): void => {
    ipcRenderer.send('dsh:window-control', action)
  },
  getWindowState: (): Promise<{ maximized: boolean }> => ipcRenderer.invoke('dsh:window-state'),
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountTitleBar, { once: true })
} else {
  mountTitleBar()
}
