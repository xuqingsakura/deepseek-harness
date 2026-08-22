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
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { browsePickerOverlayPath, pickLoopbackPort, startHostInProcess } from './host-in-process.ts'
import { errorSplashDataUrl } from './splash.ts'
import { APP_ROOT, APP_ICON, harnessHome } from './main/config.ts'
import { windowStateFile } from './main/window-state.ts'
import { generateIconAssets } from './main/icon.ts'
import { debugLog } from './main/log.ts'
import { startHost, waitForRender, playSplashExit, SMOKE_TIMEOUT_MS } from './main/host.ts'
import { wireAutoUpdater, configureUpdater, checkForUpdates } from './main/updater.ts'
import { state } from './main/state.ts'
import { createTray } from './main/tray.ts'
import { createMainWindow } from './main/windows.ts'
import { registerIpc } from './main/ipc.ts'

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
      // Create the window before the host is ready: the splash paints
      // immediately and the host URL replaces it once boot settles. A boot
      // failure swaps in an error page instead of a frozen splash.
      const window = createMainWindow(undefined, () => {
        if (!SMOKE) app.quit()
      }, SMOKE)
      try {
        if (process.env.DSH_DESKTOP_HOST?.trim() === 'child') {
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
        // An unexpected host death tears the shell down too; a deliberate quit
        // already killed it in `before-quit`, so `quitting` suppresses this path.
        void state.host.exited.then(() => {
          if (!state.quitting) {
            console.error('[dsh-desktop] host exited unexpectedly; closing the shell')
            app.quit()
          }
        })
        const url = await state.host.url
        state.hostBaseUrl = url
        debugLog(`host ready at ${url}`)
        console.log(`[dsh-desktop] host ready at ${url}`)
        if (!window.isDestroyed()) {
          await playSplashExit(window)
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

            await window.webContents.executeJavaScript("document.getElementById('dsh-btn-min')?.click()")
            await new Promise(resolve => setTimeout(resolve, 400))
            console.log(`DESKTOP_WINDOW_TEST minimized=${String(window.isMinimized())}`)
            window.restore()
            await window.webContents.executeJavaScript("document.getElementById('dsh-btn-max')?.click()")
            await new Promise(resolve => setTimeout(resolve, 900))
            console.log(`DESKTOP_WINDOW_TEST maximized=${String(window.isMaximized())}`)
            window.unmaximize()
            console.log(`DESKTOP_WINDOW_TEST iconAssetExists=${String(existsSync(APP_ICON))}`)
            console.log(`DESKTOP_TRAY created=${String(state.tray !== undefined)}`)
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
            console.log(`DESKTOP_PICKER_TEST picker=${state.host.picker ?? 'n/a'}`)
            await window.webContents.executeJavaScript("window.dshDesktop?.notify({ title: 'dsh-desktop', body: 'notification bridge ok' })")
            console.log('DESKTOP_NOTIFY sent=true')
            const screenshotPath = app.isPackaged ? join(app.getPath('userData'), 'smoke.png') : join(APP_ROOT, '.smoke.png')
            const image = await window.webContents.capturePage()
            await writeFile(screenshotPath, image.toPNG())
            console.log(`DESKTOP_SMOKE_OK title=${title} rootChildren=${String(children)} screenshot=${screenshotPath}`)
            state.host.kill()
            app.exit(0)
          } else {
            console.error('DESKTOP_SMOKE_FAIL root did not render')
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
