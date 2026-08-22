/**
 * 桌面端自动更新（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：把 electron-updater 的事件接线、更新源解析、状态广播与手动检查封装到
 * 本模块。更新源可选 `DSH_UPDATE_FEED_URL` 环境变量或 `userData/update-config.json`
 * 的 `{"url": ...}`；两者都缺省时走打包内置的 `app-update.yml` 渠道。状态通过
 * `dsh:update-state` 广播给每个窗口。
 * @module @deepseek-ai/dsh-desktop/main/updater
 */

import { app, BrowserWindow, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdater } from 'electron-updater'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugLog } from './log.ts'

/** 平台自动更新器（Windows 上为 NsisUpdater）。 */
const { autoUpdater } = electronUpdater as { autoUpdater: AppUpdater }

/** 桌面更新状态，暴露给「设置 → 关于」区域。 */
export interface DesktopUpdateState {
  /** 自动更新器生命周期位置。 */
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  /** 当前运行的应用版本。 */
  currentVersion: string
  /** 已发现的更新版本（已知时）。 */
  availableVersion?: string
  /** 下载进度百分比（下载中）。 */
  progress?: number
  /** 错误与提示状态的人类可读详情。 */
  message?: string
}

/** update-feed 覆盖文件（应用 user-data 目录下）。 */
function updateFeedFile(): string {
  return join(app.getPath('userData'), 'update-config.json')
}

/**
 * 解析更新源 URL：`DSH_UPDATE_FEED_URL` 优先，然后读 `{"url": ...}` 覆盖文件。
 * 两者都没有时走打包内置渠道（app-update.yml），且仅在显式配置了源时才启用启动检查。
 * @returns 显式源 URL；仅存在打包渠道时返回 undefined。
 */
function resolveUpdateFeedUrl(): string | undefined {
  const envUrl = process.env.DSH_UPDATE_FEED_URL?.trim()
  if (envUrl !== undefined && envUrl !== '') return envUrl
  try {
    const parsed = JSON.parse(readFileSync(updateFeedFile(), 'utf8')) as { url?: unknown }
    if (typeof parsed.url === 'string' && parsed.url !== '') return parsed.url
  } catch {
    // 覆盖文件缺失或损坏：回退到打包渠道。
  }
  return undefined
}

/** 是否已配置显式更新源（未配置则启动检查保持静默）。 */
let updaterConfigured = false

/** 本次检查是否由用户触发（驱动结果通知）。 */
let manualUpdateCheck = false

/** 显示系统原生通知（平台支持时）。 */
function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

/** 最新更新器状态，变更时广播到所有窗口。 */
let updateState: DesktopUpdateState = { status: 'idle', currentVersion: app.getVersion() }

/** 读取当前更新器状态（供 IPC 读取，不触发检查）。 */
function getUpdateState(): DesktopUpdateState {
  return updateState
}

/** 更新一条状态并推送到所有窗口。 */
function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('dsh:update-state', updateState)
  }
}

/** 接线自动更新器事件；整个进程只调用一次。 */
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

/** 应用已配置的更新源（如有），在首次检查前只调用一次。 */
function configureUpdater(): void {
  const url = resolveUpdateFeedUrl()
  if (url !== undefined) {
    autoUpdater.setFeedURL({ provider: 'generic', url })
    updaterConfigured = true
    debugLog(`autoUpdater feed: ${url}`)
    return
  }
  // 打包内置版本把发布渠道写进 app-update.yml 的 `publish` 配置；
  // 让 electron-updater 在首次检查时加载它。开发模式保持静默（无打包渠道）。
  updaterConfigured = app.isPackaged
}

/**
 * 检查更新。除非用户触发，否则保持静默：启动检查只提示真实更新，绝不提示"无更新"噪音。
 * @param manual - 是否由用户触发（驱动失败/最新通知）。
 */
function checkForUpdates(manual: boolean): void {
  manualUpdateCheck = manual
  if (!app.isPackaged) {
    setUpdateState({ status: 'error', message: '开发模式（未打包）不支持自动更新。' })
    return
  }
  if (!updaterConfigured) {
    setUpdateState({ status: 'error', message: '未配置更新源。设置 DSH_UPDATE_FEED_URL 环境变量，或写入 update-config.json（{"url":"https://…/updates/"}）后重试。' })
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

/** 重启并安装已下载的更新（未就绪时无操作）。 */
function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

export { getUpdateState, wireAutoUpdater, configureUpdater, checkForUpdates, quitAndInstall }
