/**
 * DeepSeek Harness desktop shell.
 *
 * The Electron main process renders the harness Web GUI in a native window and
 * boots the `web` profile either in-process (the default, A3: the harness
 * closure runs inside this process and its loopback `webServer` serves the UI)
 * or, when `$DSH_DESKTOP_HOST=child`, as a `dsh web` host child under a real
 * Node. Either way every `/api` request and event stream rides the IPC bridge,
 * so the renderer behaves exactly as the browser surface does; the host owns
 * the agent loop, tools, and persistence, and quitting the shell disposes it.
 *
 * `--smoke` runs a self-check instead of staying open: it waits for the React
 * root to render, asserts the custom title bar and window controls, captures a
 * screenshot, and prints `DESKTOP_SMOKE_OK` (exit 0) or `DESKTOP_SMOKE_FAIL`
 * (exit 1).
 *
 * `--gen-icon <dir>` renders apps/web/public/favicon.svg to multi-size PNGs and
 * an ICO, writes them into <dir>, and exits (no host, no window).
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
// electron-updater exposes autoUpdater as a lazy CJS getter, so the ESM named
// import is undefined; take it off the default namespace instead.
import electronUpdater from 'electron-updater'
import type { AppUpdater } from 'electron-updater'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { browsePickerOverlayPath, pickLoopbackPort, startHostInProcess, type InProcessHostControls } from './host-in-process.ts'
import {
  authorizeBuilds,
  checkOutdated,
  installBuiltinPlugin,
  installPlugin,
  listBuiltinPlugins,
  listPlugins,
  removePlugin,
  removePlugins,
  setPluginEnabled,
  updateAllPlugins,
  updatePlugin,
} from './plugin-manager.ts'
import { migrateWebData, type MigrateOptions } from './migrate-web-data.ts'
import { fileURLToPath } from 'node:url'

/** apps/desktop — one level up from src/ and lib/ (same relative hop from either artifact). */
const APP_ROOT = fileURLToPath(new URL('../', import.meta.url))
/** Repository root — three levels up from src/ and lib/. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** The built `dsh` launcher; the real entry path under plain Node. */
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js')
/** Harness home used unless the caller sets $DSH_HOME; kept under the app so the prototype never writes outside the checkout. */

/**
 * Harness home for plugin management, mirroring the boot-time resolution.
 * Literal "undefined"/"null"/"NaN" values count as unset: Node stringifies an
 * env write of `undefined`, so a polluted $DSH_HOME must not override the app
 * home (it would make every plugin operation fail on a relative path).
 */
function harnessHome(): string {
  const configuredHome = process.env.DSH_HOME?.trim()
  if (configuredHome !== undefined && configuredHome !== ''
    && configuredHome !== 'undefined' && configuredHome !== 'null' && configuredHome !== 'NaN') {
    return configuredHome
  }
  return app.isPackaged ? join(app.getPath('userData'), 'dsh-home') : DEFAULT_DSH_HOME
}
const DEFAULT_DSH_HOME = join(APP_ROOT, '.dsh-home')
/** The favicon that doubles as the title-bar and window/taskbar icon source. */
const FAVICON = join(REPO_ROOT, 'apps', 'web', 'public', 'favicon.svg')
/** Generated window icon (ICO, multi-size) consumed by the BrowserWindow constructor. */
const APP_ICON = join(APP_ROOT, 'assets', 'icon.ico')
/** Preload script exposing the window-control bridge and mounting the title bar. */
const PRELOAD = join(APP_ROOT, 'lib', 'preload.js')
/** Tray icon asset (the 256px favicon render doubles as the tray face). */
const TRAY_ICON = join(APP_ROOT, 'assets', 'icon.png')

/** Persisted window geometry, restored across launches. */
interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function windowStateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as WindowState
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function saveWindowState(state: WindowState): Promise<void> {
  await mkdir(dirname(windowStateFile()), { recursive: true })
  await writeFile(windowStateFile(), JSON.stringify(state))
}

/** Whether saved coordinates still land on a connected display. */
function onVisibleDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
  })
}

/** The readiness line the web profile prints once its Loader tree settles. */
const HOST_URL_RE = /dsh web: (https?:\/\/\S+)/

/** Smoke-mode render wait: how long to poll the React root before failing. */
const SMOKE_TIMEOUT_MS = 20_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Resolve the Node executable that runs the host child.
 *
 * The host must run under a REAL Node, never Electron's embedded one: the
 * vendored loader reaches Node's internal ESM loader through the
 * `node-addon-require-builtin` native addon, and that addon is compiled
 * against the system Node ABI — under `ELECTRON_RUN_AS_NODE` it fails to
 * load and the plugin tree cannot resolve profile packages.
 *
 * pnpm scripts expose the real Node through `npm_node_execPath`; otherwise
 * resolve `node` from PATH.
 * @returns the executable to spawn.
 */
function resolveNodeExecutable(): string {
  const npmNode = process.env.npm_node_execPath
  if (npmNode !== undefined && npmNode !== '') return npmNode
  return 'node'
}

/** A running harness host (child process or in-process tree): readiness URL, exit settlement, and a kill handle. */
interface HostHandle {
  url: Promise<string>
  /** Settles (resolution ignored) once the child process has exited. */
  exited: Promise<void>
  kill: () => void
  /** Resolved directory-picker interaction; in-process boot only. */
  picker?: 'browse' | 'auto' | 'none'
}

/**
 * Spawn the `dsh web` host child and resolve its printed URL.
 * @param onLine - optional sink for host stdout lines (logging).
 * @returns the URL promise plus a kill handle.
 */
function startHost(port: number, overlayPath: string, onLine?: (line: string) => void): HostHandle {
  // Packaged runs carry their own Node plus the deployed host closure under
  // resources/runtime; source/dev runs use the checked-out launcher and a real
  // Node from the environment.
  const packaged = app.isPackaged
  const executable = packaged ? join(process.resourcesPath, 'runtime', 'node.exe') : resolveNodeExecutable()
  const launcher = packaged
    ? join(process.resourcesPath, 'runtime', 'host-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : CLI_BIN
  if (packaged && !existsSync(executable)) {
    throw new Error('dsh-desktop: DSH_DESKTOP_HOST=child needs the bundled node.exe, which this build omits for size; use the in-process host (default) or run from source')
  }
  if (!existsSync(launcher)) {
    throw new Error(`dsh-desktop: host launcher not built (${launcher}); run 'pnpm run build' from the repository root first`)
  }
  debugLog(`startHost packaged=${String(packaged)} node=${executable}`)
  const packagedHome = join(app.getPath('userData'), 'dsh-home')
  console.log(`[dsh-desktop] host node: ${executable}`)
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env }
  const configuredHome = process.env.DSH_HOME?.trim()
  spawnEnv.DSH_HOME = configuredHome !== undefined && configuredHome !== '' ? configuredHome : packaged ? packagedHome : DEFAULT_DSH_HOME

  debugLog(`spawn node=${executable} launcher=${launcher} cwd=${packaged ? join(process.resourcesPath, 'runtime', 'host-deploy') : 'default'}`)
  const child: ChildProcess = spawn(executable, [launcher, 'web', '--patch', overlayPath, '--port', String(port)], {
    env: spawnEnv,
    ...(packaged ? { cwd: join(process.resourcesPath, 'runtime', 'host-deploy') } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const url = deferred<string>()
  const exited = deferred<void>()
  let settled = false
  const settleUrl = (fn: () => void): void => {
    if (!settled) {
      settled = true
      fn()
    }
  }
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })
  lines.on('line', (line) => {
    onLine?.(line)
    const match = HOST_URL_RE.exec(line)
    if (match?.[1] !== undefined) settleUrl(() =>{  url.resolve(match[1] as string) })
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = String(chunk).trimEnd()
    if (text !== '') console.error(`[dsh-host] ${text}`)
  })
  child.on('error', (error) => {
    debugLog(`host spawn error: ${error.message}`)
    settleUrl(() =>{  url.reject(error) })
    exited.resolve()
  })
  child.on('exit', (code) => {
    debugLog(`host exited code=${String(code)}`)
    settleUrl(() =>{  url.reject(new Error(`dsh-host exited before readiness (code ${String(code)})`)) })
    exited.resolve()
  })
  return {
    url: url.promise,
    exited: exited.promise,
    kill: () => {
      if (!child.killed) child.kill()
    },
  }
}

/**
 * Wait until the page has rendered its React root, polling the DOM.
 * @param window - the BrowserWindow loading the harness UI.
 * @param timeoutMs - total wait budget.
 * @returns the rendered `#root` child count, or 0 on timeout.
 */
async function waitForRender(window: BrowserWindow, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const children: number = await window.webContents.executeJavaScript(
      "Number(document.getElementById('root')?.children.length ?? 0)",
    ) as number
    if (children > 0) return children
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return 0
}

/** Create the main window over the host URL. */
function createMainWindow(url: string, onClosed: () => void): BrowserWindow {
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
    backgroundColor: '#0d1117',
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
  window.once('ready-to-show', () => {
    if (saved?.maximized === true) window.maximize()
    window.show()
  })
  window.on('closed', onClosed)
  // Closing the window parks it in the tray instead of quitting; the tray's
  // quit item (or before-quit) is the real exit path.
  window.on('close', (event) => {
    if (!quitting && tray !== undefined) {
      event.preventDefault()
      window.hide()
      // Hidden windows keep the renderer for tray resume; keep Chromium's
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
    if (quitting || SMOKE || window.isDestroyed()) return
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
  void window.loadURL(url)
  return window
}

/** Toggle the shell window between shown/focused and tray-hidden. */
function toggleWindow(window: BrowserWindow | undefined): void {
  if (window === undefined) return
  if (window.isVisible() && !window.isMinimized()) {
    window.hide()
  } else {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}

/** Create the system tray entry (icon, show/hide, quit). */
function createTray(window: () => BrowserWindow | undefined): Tray {
  const icon = nativeImage.createFromPath(TRAY_ICON)
  const created = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  created.setToolTip('DeepSeek Harness')
  created.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () =>{  toggleWindow(window()) } },
    { type: 'separator' },
    { label: '退出 DeepSeek Harness', click: () => {
      quitting = true
      app.quit()
    } },
  ]))
  created.on('click', () =>{  toggleWindow(window()) })
  return created
}

/** Packaged GUI apps have no console; mirror key events to a log file. */
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
    // Logging must never break startup.
  }
}

/** Deferred fs import keeps the top of the file dependency-light. */
function awaitImportFs(): { appendFileSync: (path: string, data: string) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs') as { appendFileSync(path: string, data: string): void }
}

/** Packaged GUI apps may have no console at all, or a pipe the parent closed:
 * an EPIPE from a log write must not surface as an uncaught main-process
 * exception (Electron shows a "JavaScript error" dialog for those).
 */
function silenceBrokenConsole(): void {
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
}

/** The platform auto-updater (NsisUpdater on Windows). */
const { autoUpdater } = electronUpdater as { autoUpdater: AppUpdater }

/** The update-feed override file under the app's user-data directory. */
function updateFeedFile(): string {
  return join(app.getPath('userData'), 'update-config.json')
}

/**
 * Resolve the update feed URL: `DSH_UPDATE_FEED_URL` wins, then the
 * `{"url": "\u2026"}` override file. Absent both, the packaged channel
 * (`app-update.yml`) applies, and startup checks stay disabled unless a feed
 * is explicitly configured here.
 * @returns the explicit feed URL, or undefined when only the packaged channel exists.
 */
function resolveUpdateFeedUrl(): string | undefined {
  const envUrl = process.env.DSH_UPDATE_FEED_URL?.trim()
  if (envUrl !== undefined && envUrl !== '') return envUrl
  try {
    const parsed = JSON.parse(readFileSync(updateFeedFile(), 'utf8')) as { url?: unknown }
    if (typeof parsed.url === 'string' && parsed.url !== '') return parsed.url
  } catch {
    // Missing or malformed override: fall through to the packaged channel.
  }
  return undefined
}

/** Whether an explicit feed is configured (startup checks stay silent without one). */
let updaterConfigured = false

/** Whether the in-flight check was user-triggered (drives result notifications). */
let manualUpdateCheck = false

/** Show a native notification when the platform supports it. */
function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

/** Desktop update state surfaced to the Settings -> About section. */
export interface DesktopUpdateState {
  /** Lifecycle position of the auto-updater. */
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  /** The running app version. */
  currentVersion: string
  /** Version of the discovered update, when one is known. */
  availableVersion?: string
  /** Download progress percent, present while downloading. */
  progress?: number
  /** Human-readable detail for error and notice states. */
  message?: string
}

/** Latest updater state, broadcast to every shell window on change. */
let updateState: DesktopUpdateState = { status: 'idle', currentVersion: app.getVersion() }

/** Update one updater state and push it to every shell window. */
function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('dsh:update-state', updateState)
  }
}

/** Wire the auto-updater events; safe to call once per process. */
function wireAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    setUpdateState({ status: 'available', availableVersion: info.version })
    notify('发现新版本', `v${info.version} 正在后台下载，完成后会提示重启安装。`)
  })
  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({ status: 'not-available', availableVersion: info.version })
    if (manualUpdateCheck) notify('检查更新', `已是最新版本（v${info.version}）。`)
  })
  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({ status: 'downloading', progress: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', availableVersion: info.version })
    const notice = new Notification({ title: 'DeepSeek Harness', body: `新版本 v${info.version} 已下载，点击重启并安装。` })
    notice.on('click', () =>{  autoUpdater.quitAndInstall() })
    notice.show()
  })
  autoUpdater.on('error', (error) => {
    debugLog(`autoUpdater error: ${error.message}`)
    setUpdateState({ status: 'error', message: error.message })
    if (manualUpdateCheck) notify('检查更新失败', error.message)
  })
}

/** Apply the configured feed (if any) once, before the first check. */
function configureUpdater(): void {
  const url = resolveUpdateFeedUrl()
  if (url === undefined) return
  autoUpdater.setFeedURL({ provider: 'generic', url })
  updaterConfigured = true
  debugLog(`autoUpdater feed: ${url}`)
}

/**
 * Check for updates. Silent unless the user triggered it: a startup check
 * only ever surfaces a real update, never "no update" noise.
 * @param manual - whether the user asked (drives failure/up-to-date notices).
 */
function checkForUpdates(manual: boolean): void {
  manualUpdateCheck = manual
  if (!app.isPackaged) {
    setUpdateState({ status: 'error', message: '开发模式（未打包）不支持自动更新。' })
    return
  }
  if (!updaterConfigured) {
    setUpdateState({ status: 'error', message: '未配置更新源。设置 DSH_UPDATE_FEED_URL 环境变量，或写入 update-config.json（{"url":"https://\u2026/updates/"}）后重试。' })
    if (manual) notify('检查更新', updateState.message ?? '未配置更新源')
    return
  }
  setUpdateState({ status: 'checking' })
  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    debugLog(`autoUpdater check failed: ${message}`)
    setUpdateState({ status: 'error', message })
    if (manual) notify('检查更新失败', message)
  })
}

/** Whether this invocation is the `--smoke` self-check. */
const SMOKE = process.argv.includes('--smoke')

let host: HostHandle | undefined
let quitting = false
let tray: Tray | undefined

/** `--gen-icon <dir>` output directory, absent in normal and smoke runs. */
const genIconIndex = process.argv.indexOf('--gen-icon')
const GEN_ICON_DIR = genIconIndex !== -1 ? process.argv[genIconIndex + 1] : undefined

if (app.isPackaged) silenceBrokenConsole()

// Windows taskbar identity and a stable per-app data directory.
app.setName('dsh-desktop')
app.setAppUserModelId('com.deepseek-ai.dsh-desktop')

/**
 * Assemble an ICO container from PNG-compressed entries (Vista+ format).
 * @param entries - size-tagged PNG buffers; the byte 0 encodes 256px.
 * @returns the ICO file bytes.
 */
function buildIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.size - b.size)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sorted.length, 4)
  const directory = Buffer.alloc(16 * sorted.length)
  let offset = 6 + 16 * sorted.length
  sorted.forEach((entry, index) => {
    const base = index * 16
    const encoded = entry.size >= 256 ? 0 : entry.size
    directory.writeUInt8(encoded, base)
    directory.writeUInt8(encoded, base + 1)
    directory.writeUInt8(0, base + 2)
    directory.writeUInt8(0, base + 3)
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...sorted.map(entry => entry.png)])
}

/**
 * Render favicon.svg at the standard Windows icon sizes and write PNGs plus an
 * ICO into the output directory. Runs in a hidden renderer because SVG
 * rasterization needs a DOM canvas.
 * @param outDir - absolute output directory (created when absent).
 */
async function generateIconAssets(outDir: string): Promise<void> {
  console.log('[dsh-icon] reading favicon')
  const svg = await readFile(FAVICON, 'utf8')
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  console.log('[dsh-icon] creating hidden renderer')
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await window.loadURL('data:text/html,<meta charset="utf-8"><title>dsh icon generator</title><body></body>')
  console.log('[dsh-icon] renderer loaded')
  const code = `(async () => {
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const out = []
    for (const size of sizes) {
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('favicon svg decode failed'))
        image.src = ${JSON.stringify(svgDataUrl)}
      })
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('2d canvas context unavailable')
      ctx.drawImage(img, 0, 0, size, size)
      out.push({ size, dataUrl: canvas.toDataURL('image/png') })
    }
    return out
  })()`
  console.log('[dsh-icon] running rasterizer')
  const results = await window.webContents.executeJavaScript(code) as Array<{ size: number; dataUrl: string }>
  console.log(`[dsh-icon] rasterized ${String(results.length)} sizes`)
  // Keep the hidden window alive: destroying it fires window-all-closed and the
  // default handler quits the app before the writes below finish. app.exit(0)
  // after generateIconAssets returns tears everything down.
  await mkdir(outDir, { recursive: true })
  const entries: Array<{ size: number; png: Buffer }> = []
  for (const { size, dataUrl } of results) {
    // The canvas already produced a valid PNG; decode it directly instead of
    // round-tripping through nativeImage (which decodes empty on Windows here).
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    entries.push({ size, png })
    await writeFile(join(outDir, `icon-${size}.png`), png)
    console.log(`[dsh-icon] wrote icon-${size}.png (${String(png.length)} bytes)`)
  }
  const icon256 = entries.find(entry => entry.size === 256)
  if (icon256 !== undefined) await writeFile(join(outDir, 'icon.png'), icon256.png)
  await writeFile(join(outDir, 'icon.ico'), buildIco(entries))
  console.log(`DESKTOP_ICON_OK ${join(outDir, 'icon.ico')} (${String(entries.length)} sizes)`)
}

if (GEN_ICON_DIR !== undefined) {
  void app.whenReady().then(async () => {
    try {
      await generateIconAssets(resolve(GEN_ICON_DIR))
      app.exit(0)
    } catch (error) {
      console.error('DESKTOP_ICON_FAIL', error)
      app.exit(1)
    }
  })
} else {
  // Custom title bar controls: the preload's buttons reach the owning window here.
  ipcMain.on('dsh:window-control', (event, action: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (target === null) return
    switch (action) {
      case 'minimize':
        target.minimize()
        break
      case 'maximize-toggle':
        if (target.isMaximized()) target.unmaximize()
        else target.maximize()
        break
      case 'close':
        target.close()
        break
      default:
        break
    }
  })


  /** Normalize a plugin spec: a local path resolves to pnpm's file: form. */
  function normalizePluginSpec(spec: string): string {
    if (spec.startsWith('file:') || spec.startsWith('link:') || spec.includes('://')) return spec
    try {
      if (existsSync(spec)) return `file:${resolve(spec).replaceAll('\\', '/')}`
    } catch {
    // Not a path the filesystem can check (e.g. a bare package spec); pass through.
    }
    return spec
  }

  /** Render a plugin failure with an actionable permission/home hint. */
  function pluginErrorMessage(action: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error)
    if (/EPERM|EACCES|operation not permitted/i.test(detail)) {
      return `${action}失败：没有写入权限。插件目录应位于用户数据目录（%APPDATA%\\dsh-desktop\\dsh-home），` +
      '而不是应用安装目录；请完全退出应用（托盘图标右键 → 退出）后重新启动，再重试。\n' + detail
    }
    return `${action}失败。\n` + detail
  }
  // ── IPC bridge: the renderer's ElectronApiClient reaches the host here ──
  // The renderer page is served by the host, but every /api request and event
  // stream rides IPC instead of the browser's HTTP/WebSocket transport.
  // ── Plugin management: the official dsh profile-plugin flow, driven from
  // the renderer's Settings → Plugins surface (desktop-only bridge methods).
  ipcMain.handle('dsh:plugin-add', async (_event, spec: unknown) => {
    if (typeof spec !== 'string' || spec.trim() === '') throw new Error('dsh-plugin: 插件标识不能为空')
    try {
      return await installPlugin(harnessHome(), normalizePluginSpec(spec.trim()))
    } catch (error) {
      throw new Error(pluginErrorMessage('添加插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-remove', async (_event, name: unknown) => {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('dsh-plugin: 插件名不能为空')
    try {
      return await removePlugin(harnessHome(), name.trim())
    } catch (error) {
      throw new Error(pluginErrorMessage('移除插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-list', async () => {
    try {
      return await listPlugins(harnessHome())
    } catch (error) {
      throw new Error(pluginErrorMessage('读取插件列表', error))
    }
  })
  ipcMain.handle('dsh:plugin-allow-builds', async (_event, keys: unknown) => {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || key.trim() === '')) {
      throw new Error('dsh-plugin: allowBuilds 包键列表不合法')
    }
    try {
      return await authorizeBuilds(harnessHome(), keys.map(key => String(key).trim()))
    } catch (error) {
      throw new Error(pluginErrorMessage('授权构建脚本', error))
    }
  })
  ipcMain.handle('dsh:plugin-update', async (_event, name: unknown) => {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('dsh-plugin: 插件名不能为空')
    try {
      return await updatePlugin(harnessHome(), name.trim())
    } catch (error) {
      throw new Error(pluginErrorMessage('更新插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-update-all', async () => {
    try {
      return await updateAllPlugins(harnessHome())
    } catch (error) {
      throw new Error(pluginErrorMessage('更新全部插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-remove-many', async (_event, names: unknown) => {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || name.trim() === '')) {
      throw new Error('dsh-plugin: 待移除插件名列表不合法')
    }
    try {
      return await removePlugins(harnessHome(), names.map(name => String(name).trim()))
    } catch (error) {
      throw new Error(pluginErrorMessage('移除插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-set-enabled', async (_event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('dsh-plugin: 插件名不能为空')
    if (typeof enabled !== 'boolean') throw new Error('dsh-plugin: 启用状态必须是布尔值')
    try {
      const result = await setPluginEnabled(harnessHome(), name.trim(), enabled)
      const liveApplied = await liveHostControls?.setPluginEnabled(name.trim(), enabled) ?? false
      return { ...result, liveApplied }
    } catch (error) {
      throw new Error(pluginErrorMessage(enabled ? '启用插件' : '停用插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-outdated', async () => {
    try {
      return await checkOutdated(harnessHome())
    } catch (error) {
      throw new Error(pluginErrorMessage('检查插件更新', error))
    }
  })
  ipcMain.handle('dsh:plugin-builtin-list', () => {
    try {
      return listBuiltinPlugins()
    } catch (error) {
      throw new Error(pluginErrorMessage('读取内置插件', error))
    }
  })
  ipcMain.handle('dsh:plugin-builtin-install', async (_event, name: unknown) => {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('dsh-plugin: 内置插件名不能为空')
    try {
      return await installBuiltinPlugin(harnessHome(), name.trim())
    } catch (error) {
      throw new Error(pluginErrorMessage('安装内置插件', error))
    }
  })
  ipcMain.handle('dsh:update-status', () => updateState)
  ipcMain.handle('dsh:update-check', () => {
    checkForUpdates(true)
    return updateState
  })
  ipcMain.handle('dsh:update-install', () => {
    if (updateState.status === 'downloaded') autoUpdater.quitAndInstall()
    return true
  })

  // Web→desktop data migration: the renderer asks the main process to import
  // Web-harness data (~/.dsh) into the desktop home. The target is always the
  // desktop home; the source defaults to the Web home unless the renderer
  // names one. The migration itself never overwrites target-owned data.
  ipcMain.handle('dsh:migrate-web-data', async (_event, options: unknown) => {
    const parsed = (typeof options === 'object' && options !== null ? options : {}) as Partial<MigrateOptions>
    try {
      return await migrateWebData({
        target: harnessHome(),
        ...(typeof parsed.source === 'string' ? { source: parsed.source } : {}),
        ...(parsed.dryRun === true ? { dryRun: true } : {}),
        ...(parsed.includeSettings === true ? { includeSettings: true } : {}),
        ...(parsed.includeCredentials === true ? { includeCredentials: true } : {}),
        ...(parsed.force === true ? { force: true } : {}),
      })
    } catch (error) {
      throw new Error('迁移 Web 数据失败。\n' + (error instanceof Error ? error.message : String(error)))
    }
  })

  ipcMain.handle('dsh:api-fetch', async (_event, request: unknown) => {
    if (hostBaseUrl === undefined) throw new Error('dsh-bridge: host not ready')
    if (typeof request !== 'object' || request === null) throw new Error('dsh-bridge: malformed request')
    const { url, method, headers, body } = request as {
      url?: unknown
      method?: unknown
      headers?: unknown
      body?: unknown
    }
    if (typeof url !== 'string' || typeof method !== 'string') throw new Error('dsh-bridge: malformed request fields')
    const incoming = new URL(url)
    // Always route to the host origin: the renderer's own origin must not
    // dictate where the bridge may send (and the host URL is the only target).
    const target = new URL(incoming.pathname + incoming.search, hostBaseUrl)
    console.log('[dsh-bridge] api-fetch', target.pathname)
    const response = await fetch(target, {
      method,
      ...(typeof headers === 'object' && headers !== null ? { headers: headers as Record<string, string> } : {}),
      ...(typeof body === 'string' ? { body } : {}),
    })
    const text = await response.text()
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      text,
    }
  })

  const apiSockets = new Map<string, { socket: WebSocket }>()

  ipcMain.on('dsh:api-stream-subscribe', (event, channel: unknown) => {
    if (hostBaseUrl === undefined) return
    if (channel !== 'mux' && channel !== 'host') return
    const key = `${event.sender.id}:${channel}`
    if (apiSockets.has(key)) return
    const socketUrl = new URL(`/api/events.${channel}`, hostBaseUrl)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(socketUrl)
    apiSockets.set(key, { socket })
    console.log('[dsh-bridge] stream subscribe', channel)
    socket.addEventListener('open', () => {
      if (!event.sender.isDestroyed()) event.sender.send('dsh:api-stream-open', channel)
    })
    socket.addEventListener('message', (message: MessageEvent) => {
      if (event.sender.isDestroyed()) return
      let envelope: unknown
      try {
        envelope = JSON.parse(String(message.data))
      } catch {
        return
      }
      notifyForAttention(envelope)
      event.sender.send('dsh:api-frame', channel, envelope)
    })
    socket.addEventListener('close', () => {
      if (apiSockets.get(key)?.socket === socket) apiSockets.delete(key)
      if (!event.sender.isDestroyed()) event.sender.send('dsh:api-stream-end', channel)
    })
    socket.addEventListener('error', () =>{  socket.close() })
  })

  ipcMain.on('dsh:api-stream-unsubscribe', (event, channel: unknown) => {
    if (typeof channel !== 'string') return
    apiSockets.get(`${event.sender.id}:${channel}`)?.socket.close()
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => {
      for (const [key, entry] of apiSockets) {
        if (key.startsWith(`${contents.id}:`)) entry.socket.close()
      }
    })
  })

  /**
   * Native notification when the agent needs the operator's attention and the
   * shell is not in the foreground: approval/requested and question/requested
   * mux frames (the renderer already handles them when visible).
   */
  function notifyForAttention(envelope: unknown): void {
    const frame = (envelope as { payload?: { type?: string; toolName?: string; sessionId?: unknown } } | null)?.payload
    if (frame === undefined) return
    if (frame.type !== 'approval/requested' && frame.type !== 'question/requested') return
    const [window] = BrowserWindow.getAllWindows()
    if (window !== undefined && window.isVisible() && !window.isMinimized()) return
    if (!Notification.isSupported()) return
    const title = 'DeepSeek Harness'
    const body = frame.type === 'approval/requested'
      ? `需要你确认：工具「${frame.toolName ?? '未知'}」请求执行权限`
      : '有新的问题需要你回答'
    new Notification({ title, body }).show()
  }

  // Native desktop notifications (e.g. the tray-park hint or future session events).
  ipcMain.on('dsh:notify', (_event, options: unknown) => {
    if (typeof options !== 'object' || options === null) return
    const { title, body } = options as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || typeof body !== 'string') return
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })

  ipcMain.handle('dsh:window-state', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    return { maximized: target?.isMaximized() ?? false }
  })

  /** Origin of the loopback host server, used by the IPC bridge. */
  let hostBaseUrl: string | undefined
  /** Live loader controls from the in-process host (undefined in child mode). */
  let liveHostControls: InProcessHostControls | undefined

  // The host child owns the server; the desktop shell is one window over it.
  app.on('before-quit', () => {
    quitting = true
    host?.kill()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const [window] = BrowserWindow.getAllWindows()
      if (window !== undefined) {
        if (window.isMinimized()) window.restore()
        window.focus()
      }
    })

    void app.whenReady().then(async () => {
      // In-process boot is the default; DSH_DESKTOP_HOST=child keeps the A2
      // subprocess host available as a fallback (e.g. for runtime debugging).
      const home = harnessHome()
      const desktopPort = await pickLoopbackPort()
      const overlayPath = browsePickerOverlayPath()
      if (process.env.DSH_DESKTOP_HOST?.trim() === 'child') {
        host = startHost(desktopPort, overlayPath, (line) =>{  console.log(`[dsh-host] ${line}`) })
      } else {
        const runtimeRoot = app.isPackaged
          ? join(process.resourcesPath, 'runtime', 'host-deploy')
          : join(APP_ROOT, 'out', 'runtime', 'host-deploy')
        const inProcess = await startHostInProcess({
          runtimeRoot,
          home,
          overlayPath,
          port: desktopPort,
          onExit: (code) => {
            if (!SMOKE) app.exit(code)
          },
        })
        liveHostControls = inProcess.controls
        host = {
          url: Promise.resolve(inProcess.url),
          exited: inProcess.exited,
          kill: () => void inProcess.dispose(),
          picker: inProcess.directoryPicker,
        }
        console.log(`[dsh-desktop] host mode: in-process (${inProcess.url})`)
      }
      // An unexpected host death tears the shell down too; a deliberate quit
      // already killed it in `before-quit`, so `quitting` suppresses this path.
      void host.exited.then(() => {
        if (!quitting) {
          console.error('[dsh-desktop] host exited unexpectedly; closing the shell')
          app.quit()
        }
      })
      try {
        const url = await host.url
        hostBaseUrl = url
        debugLog(`host ready at ${url}`)
        console.log(`[dsh-desktop] host ready at ${url}`)
        const window = createMainWindow(url, () => {
          if (!SMOKE) app.quit()
        })
        if (!SMOKE) {
          tray = createTray(() => window)
          console.log('[dsh-desktop] tray created')
          // Auto-update: only with a configured feed; the startup check is
          // silent (real updates notify, "no update" never does).
          wireAutoUpdater()
          configureUpdater()
          setTimeout(() =>{  checkForUpdates(false) }, 12_000)
        }
        if (SMOKE) {
          const children = await waitForRender(window, SMOKE_TIMEOUT_MS)
          if (children > 0) {
            const title: string = await window.webContents.executeJavaScript('document.title') as string
            const chrome = await window.webContents.executeJavaScript(`(() => {
              const bar = document.getElementById('dsh-titlebar')
              const title = document.getElementById('dsh-titlebar-title')
              const icon = document.getElementById('dsh-titlebar-icon')
              return {
                titlebar: bar !== null,
                title: title?.textContent ?? null,
                titleCentered: bar !== null && title !== null ? (() => {
                  const barRect = bar.getBoundingClientRect()
                  const titleRect = title.getBoundingClientRect()
                  const delta = Math.abs((titleRect.left + titleRect.width / 2) - (barRect.left + barRect.width / 2))
                  return delta <= 2
                })() : false,
                iconSvg: icon?.querySelector('svg') !== null,
                buttons: ['dsh-btn-min', 'dsh-btn-max', 'dsh-btn-close'].map((id) => document.getElementById(id) !== null),
                bodyPaddingTop: getComputedStyle(document.body).paddingTop,
                titlebarBg: bar !== null ? getComputedStyle(bar).backgroundColor : null,
                bodyBg: getComputedStyle(document.body).backgroundColor,
              }
            })()`) as unknown
            console.log(`DESKTOP_TITLEBAR ${JSON.stringify(chrome)}`)
            // Simulate the theme presenter applying the dark palette (root
            // color-scheme + body attribute + label-primary token) and assert
            // the title-bar whale turns near-white via currentColor.
            const darkChrome = await window.webContents.executeJavaScript(`(() => {
              document.documentElement.style.colorScheme = 'dark'
              document.body.setAttribute('data-ds-dark-theme', '')
              document.body.style.setProperty('--dsw-alias-label-primary', '#eef0f3')
              const path = document.querySelector('#dsh-titlebar-icon path')
              const bar = document.getElementById('dsh-titlebar')
              return {
                scheme: document.documentElement.style.colorScheme,
                iconFill: path === null ? null : getComputedStyle(path).fill,
                titlebarColor: bar === null ? null : getComputedStyle(bar).color,
                titlebarBg: bar === null ? null : getComputedStyle(bar).backgroundColor,
              }
            })()`) as unknown
            console.log(`DESKTOP_TITLEBAR_DARK ${JSON.stringify(darkChrome)}`)

            // Plugin-skin smoke assertion: the composed client boot manifest and
            // the applied theme token show whether a profile-installed plugin
            // (the aurora skin) was discovered and mounted by the browser half.
            const skinChrome = await window.webContents.executeJavaScript(`(async () => {
              const boot = window.__DSH_BOOT__
              const rows = boot !== null && typeof boot === 'object' && Array.isArray(boot.entries) ? boot.entries : []
              const skin = rows.find((row) => row.id === 'dsh-skin-aurora')
              let fetchStatus = null
              if (skin !== undefined) {
                try { fetchStatus = (await fetch(skin.url)).status } catch (error) { fetchStatus = 'ERR:' + String(error) }
              }
              return {
                skinUrl: skin === undefined ? null : skin.url,
                fetchStatus,
                bgToken: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
              }
            })()`) as unknown
            console.log(`DESKTOP_SKIN ${JSON.stringify(skinChrome)}`)
            await window.webContents.executeJavaScript("document.getElementById('dsh-btn-min')?.click()")
            await new Promise(resolve => setTimeout(resolve, 400))
            console.log(`DESKTOP_WINDOW_TEST minimized=${String(window.isMinimized())}`)
            window.restore()
            await window.webContents.executeJavaScript("document.getElementById('dsh-btn-max')?.click()")
            await new Promise(resolve => setTimeout(resolve, 900))
            console.log(`DESKTOP_WINDOW_TEST maximized=${String(window.isMaximized())}`)
            window.unmaximize()
            console.log(`DESKTOP_WINDOW_TEST iconAssetExists=${String(existsSync(APP_ICON))}`)
            console.log(`DESKTOP_TRAY created=${String(tray !== undefined)}`)
            window.setSize(1280, 800)
            await new Promise(resolve => setTimeout(resolve, 800))
            console.log(`DESKTOP_WINDOW_STATE saved=${String(existsSync(windowStateFile()))}`)
            const ipcTest = await window.webContents.executeJavaScript(`(async () => {
              const bridge = window.dshDesktop
              if (bridge === undefined) return { bridge: false }
              const response = await bridge.apiFetch({
                url: window.location.origin + '/api/host.describe',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-ipc', method: 'host.describe', payload: {} }),
              })
              return { bridge: true, status: response.status }
            })()`) as unknown
            console.log(`DESKTOP_IPC_TEST ${JSON.stringify(ipcTest)}`)
            console.log(`DESKTOP_PICKER_TEST picker=${host.picker ?? 'n/a'}`)
            await window.webContents.executeJavaScript("window.dshDesktop?.notify({ title: 'dsh-desktop', body: 'notification bridge ok' })")
            console.log('DESKTOP_NOTIFY sent=true')
            const screenshotPath = app.isPackaged ? join(app.getPath('userData'), 'smoke.png') : join(APP_ROOT, '.smoke.png')
            const image = await window.webContents.capturePage()
            await writeFile(screenshotPath, image.toPNG())
            console.log(`DESKTOP_SMOKE_OK title=${title} rootChildren=${String(children)} screenshot=${screenshotPath}`)
            host.kill()
            app.exit(0)
          } else {
            console.error('DESKTOP_SMOKE_FAIL root did not render')
            host.kill()
            app.exit(1)
          }
        }
      } catch (error) {
        console.error('[dsh-desktop] host failed to start:', error)
        host.kill()
        app.exit(1)
      }
    })
  }
}
