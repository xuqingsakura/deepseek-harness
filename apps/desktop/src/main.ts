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

import { app, BrowserWindow } from 'electron'
// electron-updater exposes autoUpdater as a lazy CJS getter, so the ESM named
// import is undefined; take it off the default namespace instead.
import { join, resolve } from 'node:path'
import { browsePickerOverlayPath, pickLoopbackPort, startHostInProcess } from './host-in-process.ts'
import { errorSplashDataUrl } from './splash.ts'
import { APP_ROOT, harnessHome } from './main/config.ts'
import { generateIconAssets } from './main/icon.ts'
import { debugLog, flushLog } from './main/log.ts'
import { startHost, playSplashExit } from './main/host.ts'
import { wireAutoUpdater, configureUpdater, checkForUpdates } from './main/updater.ts'
import { state } from './main/state.ts'
import { createTray } from './main/tray.ts'
import { createMainWindow } from './main/windows.ts'
import { registerIpc } from './main/ipc.ts'
import { resolveHostMode, childHostAvailable } from './main/host-mode.ts'
import { runSmoke } from './main/smoke.ts'

/** The readiness line the web profile prints once its Loader tree settles. */
/** Create the main window over the host URL. */
function silenceBrokenConsole(): void {
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
}

/** Whether this invocation is the `--smoke` self-check. */
const SMOKE = process.argv.includes('--smoke')


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
  registerIpc()

  // The host child owns the server; the desktop shell is one window over it.
  app.on('before-quit', () => {
    state.quitting = true
    state.host?.kill()
    // 冲刷日志流，避免退出前缓存日志丢失。
    flushLog()
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
      // P0-B: 启动链路打点，用于定位启动耗时（dev 打到控制台，打包写入日志）。
      const bootStart = Date.now()
      const mark = (phase: string): void => debugLog(`[dsh-desktop] boot:${phase} +${Date.now() - bootStart}ms`)
      mark('app-ready')
      // In-process boot is the default; DSH_DESKTOP_HOST=child keeps the A2
      // subprocess host available as a fallback (e.g. for runtime debugging).
      const home = harnessHome()
      const desktopPort = await pickLoopbackPort()
      mark('port-picked')
      const overlayPath = browsePickerOverlayPath()
      // Create the window before the host is ready: the splash paints
      // immediately and the host URL replaces it once boot settles. A boot
      // failure swaps in an error page instead of a frozen splash.
      const window = createMainWindow(undefined, () => {
        if (!SMOKE) app.quit()
      }, SMOKE)
      try {
        const hostMode = resolveHostMode()
        const useChild = hostMode === 'child' && childHostAvailable()
        if (hostMode === 'child' && !useChild) {
          console.warn('[dsh-desktop] child host requested but unavailable in this build; falling back to in-process')
        }
        if (useChild) {
          state.host = startHost(desktopPort, overlayPath, (line) =>{  console.log(`[dsh-host] ${line}`) })
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
          state.liveHostControls = inProcess.controls
          state.host = {
            url: Promise.resolve(inProcess.url),
            exited: inProcess.exited,
            kill: () => void inProcess.dispose(),
            picker: inProcess.directoryPicker,
          }
          console.log(`[dsh-desktop] host mode: in-process (${inProcess.url})`)
        }
        mark('host-started')
        // An unexpected host death tears the shell down too; a deliberate quit
        // already killed it in `before-quit`, so `quitting` suppresses this path.
        void state.host.exited.then(() => {
          if (!state.quitting) {
            console.error('[dsh-desktop] host exited unexpectedly; closing the shell')
            app.quit()
          }
        })
        const url = await state.host.url
        mark('host-ready')
        state.hostBaseUrl = url
        debugLog(`host ready at ${url}`)
        console.log(`[dsh-desktop] host ready at ${url}`)
        if (!window.isDestroyed()) {
          await playSplashExit(window)
          mark('splash-exit')
          if (!window.isDestroyed()) void window.loadURL(url)
        }
        if (!SMOKE) {
          state.tray = createTray(() => window)
          console.log('[dsh-desktop] state.tray created')
          // Auto-update: only with a configured feed; the startup check is
          // silent (real updates notify, "no update" never does).
          wireAutoUpdater()
          configureUpdater()
          setTimeout(() =>{  checkForUpdates(false) }, 12_000)
        }
        if (SMOKE) {
          // 自检逻辑抽取到 main/smoke.ts（P1-6）。
          const ok = await runSmoke(window)
          if (ok) {
            state.host.kill()
            app.exit(0)
          } else {
            state.host.kill()
            app.exit(1)
          }
        }
      } catch (error) {
        console.error('[dsh-desktop] host failed to start:', error)
        // Swap the splash for an error page and let it paint before closing.
        if (!window.isDestroyed()) void window.loadURL(errorSplashDataUrl(error))
        state.host?.kill()
        setTimeout(() =>{  app.exit(1) }, 3000)
      }
    })
  }
}

export type { DesktopUpdateState } from './main/updater.ts'
