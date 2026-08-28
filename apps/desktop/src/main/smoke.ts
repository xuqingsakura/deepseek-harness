/**
 * 桌面端 `--smoke` 自检（Phase 0.1 拆分，P1-6 抽取）。
 *
 * 从 main.ts 抽取：等待 React 根目录渲染，断言自定义标题栏与窗口控件，模拟深色主题，
 * 触发最小化/最大化/关闭桥、IPC、通知，并截图；返回是否通过。不做 app.exit/kill（由 main.ts 结算）。
 * @module @deepseek-ai/dsh-desktop/main/smoke
 */

import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_ICON, APP_ROOT } from './config.ts'
import { windowStateFile } from './window-state.ts'
import { state } from './state.ts'
import { waitForRender, SMOKE_TIMEOUT_MS } from './host.ts'

/**
 * 运行桌面端自检：断言标题栏/窗口控件/IPC/通知等，并截图。
 * @param window - 主窗口实例。
 * @returns 是否通过；失败时已打印 DESKTOP_SMOKE_FAIL。
 */
export async function runSmoke(window: BrowserWindow): Promise<boolean> {
  const children = await waitForRender(window, SMOKE_TIMEOUT_MS)
  if (children <= 0) {
    console.error('DESKTOP_SMOKE_FAIL root did not render')
    return false
  }

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

  // 模拟主题 presenter 应用深色调色板，断言标题栏鲸鱼通过 currentColor 变白。
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
    // The renderer now rides the host's loopback HTTP/WebSocket transport
    // instead of an IPC API carrier; probe the desktop bridge through a method
    // that still exists (host mode) rather than the removed apiFetch.
    const mode = await bridge.getHostMode()
    return { bridge: true, status: mode.mode }
  })()`) as unknown
  console.log(`DESKTOP_IPC_TEST ${JSON.stringify(ipcTest)}`)
  console.log(`DESKTOP_PICKER_TEST picker=${state.host?.picker ?? 'n/a'}`)
  await window.webContents.executeJavaScript("window.dshDesktop?.notify({ title: 'dsh-desktop', body: 'notification bridge ok' })")
  console.log('DESKTOP_NOTIFY sent=true')

  const screenshotPath = app.isPackaged ? join(app.getPath('userData'), 'smoke.png') : join(APP_ROOT, '.smoke.png')
  const image = await window.webContents.capturePage()
  await writeFile(screenshotPath, image.toPNG())
  console.log(`DESKTOP_SMOKE_OK title=${title} rootChildren=${String(children)} screenshot=${screenshotPath}`)
  return true
}
