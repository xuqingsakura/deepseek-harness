/**
 * 桌面端主进程 IPC 注册与 API 桥（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：把插件管理、工作台窗口、更新、数据迁移、window-control、API fetch/stream、
 * 通知与窗口状态等全部 ipcMain handler，以及 API 流批量转发（apiFrameBatches/apiSockets）聚到
 * 一个 registerIpc()。依赖（插件管理器、更新器、窗口、共享状态、日志）由本模块直接 import，
 * 从而让 main.ts 的 boot 只负责"注册一次"。
 * @module @deepseek-ai/dsh-desktop/main/ipc
 */

import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessHome } from './config.ts'
import { traceLog } from './log.ts'
import { hostModeInfo, writeHostMode } from './host-mode.ts'
import { state } from './state.ts'
import { createWorkspaceWindow, restoreMainWindow } from './windows.ts'
import { getUpdateState, checkForUpdates, quitAndInstall } from './updater.ts'
import { migrateWebData, type MigrateOptions } from '../migrate-web-data.ts'
import {
  authorizeBuilds, checkOutdated, installBuiltinPlugin, installPlugin, listBuiltinPlugins,
  listPlugins, removePlugin, removePlugins, setPluginEnabled, disableNonBasePlugins, cancelPluginOp, updateAllPlugins, updatePlugin,
} from '../plugin-manager.ts'

/** 注册桌面端全部 IPC 处理器与 API 流桥（应用生命周期内只需调用一次）。 */
export function registerIpc(): void {
  // Detached workspace window (VSCode-style workbench mode): the web UI reads ?dshWindow=workspace.
  ipcMain.handle('dsh:open-workbench-window', (_event, sessionId: unknown) => {
    createWorkspaceWindow(typeof sessionId === 'string' ? sessionId : undefined)
  })

  // 工作台窗口「回到原桌面」：显示主窗口并强制关闭工作台窗口。
  ipcMain.handle('dsh:leave-workbench', () => {
    // 恢复主窗口（若进入工作台时卸载过渲染器会重载），再关闭工作台窗口。
    restoreMainWindow()
    if (state.workbenchWindow !== undefined && !state.workbenchWindow.isDestroyed()) {
      state.workbenchWindow.destroy()
    }
  })

  // 宿主运行模式诊断：供设置界面展示当前模式与 child 是否可用（只读，生效需重启）。
  ipcMain.handle('dsh:get-host-mode', () => hostModeInfo())

  // 写入宿主运行模式（设置项）：校验后写 host-mode.json，生效需重启应用。
  ipcMain.handle('dsh:set-host-mode', (_event, mode: unknown) => {
    if (mode !== 'child' && mode !== 'in-process') throw new Error('dsh-host-mode: 非法宿主模式')
    writeHostMode(mode)
    return hostModeInfo()
  })

  // 诊断信息：版本 / 宿主模式 / 已装插件数 / 日志路径（P2-B）。
  ipcMain.handle('dsh:get-diagnostics', async () => {
    const host = hostModeInfo()
    let pluginCount = 0
    try {
      pluginCount = (await listPlugins(harnessHome())).length
    } catch {
      pluginCount = 0
    }
    return { version: app.getVersion(), host, pluginCount, logPath: join(app.getPath('userData'), 'dsh-desktop.log') }
  })

  // 安全模式重启（P2-A）：禁用非基础插件后重启，用于绕过坏插件导致的启动失败。
  ipcMain.handle('dsh:relaunch-safe', async () => {
    try { await disableNonBasePlugins(harnessHome()) } catch { /* 尽力而为 */ }
    state.quitting = true
    app.relaunch()
    app.exit()
  })

  // 用系统默认方式打开日志文件（P2-B）。
  ipcMain.handle('dsh:open-log-file', async () => {
    const logPath = join(app.getPath('userData'), 'dsh-desktop.log')
    await shell.openPath(logPath)
  })

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
      const liveApplied = await state.liveHostControls?.setPluginEnabled(name.trim(), enabled) ?? false
      return { ...result, liveApplied }
    } catch (error) {
      throw new Error(pluginErrorMessage(enabled ? '启用插件' : '停用插件', error))
    }
  })
  // 取消正在运行的插件操作（P1-B）。
  ipcMain.handle('dsh:plugin-cancel', () => ({ cancelled: cancelPluginOp() }))

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
  ipcMain.handle('dsh:update-status', () => getUpdateState())
  ipcMain.handle('dsh:update-check', () => {
    checkForUpdates(true)
    return getUpdateState()
  })
  ipcMain.handle('dsh:update-install', () => {
    if (getUpdateState().status === 'downloaded') quitAndInstall()
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
    if (state.hostBaseUrl === undefined) throw new Error('dsh-bridge: host not ready')
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
    const target = new URL(incoming.pathname + incoming.search, state.hostBaseUrl)
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




  /** Pending frames for one (sender, channel) stream before its IPC flush. */
  interface ApiFrameBatch {
    sender: Electron.WebContents
    channel: 'mux' | 'host'
    frames: unknown[]
    timer: NodeJS.Timeout | undefined
  }
  const apiFrameBatches = new Map<string, ApiFrameBatch>()
  /** Coalesce window: at most one IPC send per interval per stream. */
  const API_FRAME_FLUSH_MS = 8
  /** Hard cap so a runaway stream cannot grow the pending queue unboundedly. */
  const API_FRAME_MAX_BATCH = 256

  /**
   * Forward one host frame to the renderer through a coalescing batch. Bursts
   * of session events (token deltas, tool views) collapse into a few IPC
   * messages instead of one round-trip per frame, which keeps the renderer's
   * event loop from drowning during fast streams.
   */
  function queueApiFrame(sender: Electron.WebContents, channel: 'mux' | 'host', envelope: unknown): void {
    const key = `${sender.id}:${channel}`
    let batch = apiFrameBatches.get(key)
    if (batch === undefined) {
      batch = { sender, channel, frames: [], timer: undefined }
      apiFrameBatches.set(key, batch)
    }
    batch.frames.push(envelope)
    if (batch.frames.length >= API_FRAME_MAX_BATCH) {
      flushApiFrame(key, batch)
      return
    }
    if (batch.timer === undefined) {
      batch.timer = setTimeout(() => { flushApiFrame(key, batch) }, API_FRAME_FLUSH_MS)
    }
  }

  /** Send a batch's accumulated frames (if any) as one IPC message. */
  function flushApiFrame(key: string, batch: ApiFrameBatch): void {
    if (batch.timer !== undefined) {
      clearTimeout(batch.timer)
      batch.timer = undefined
    }
    apiFrameBatches.delete(key)
    if (batch.frames.length === 0 || batch.sender.isDestroyed()) return
    batch.sender.send('dsh:api-frame', batch.channel, batch.frames)
  }

  /** Drop pending batches owned by a destroyed renderer. */
  function dropApiFrameBatches(contentsId: number): void {
    for (const [key, batch] of apiFrameBatches) {
      if (batch.sender.id !== contentsId) continue
      if (batch.timer !== undefined) clearTimeout(batch.timer)
      apiFrameBatches.delete(key)
    }
  }

  const apiSockets = new Map<string, { socket: WebSocket; retryTimer?: NodeJS.Timeout; attempts: number }>()

  /** 为一条 (sender, channel) 流打开 WebSocket，断连时按退避自动重连。 */
  function apiStreamConnect(event: Electron.IpcMainEvent, channel: 'mux' | 'host'): void {
    const key = `${event.sender.id}:${channel}`
    if (state.hostBaseUrl === undefined) return
    const socketUrl = new URL(`/api/events.${channel}`, state.hostBaseUrl)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(socketUrl)
    apiSockets.set(key, { socket, attempts: 0 })
    traceLog(`[dsh-bridge] stream subscribe ${channel}`)
    socket.addEventListener('open', () => {
      const entry = apiSockets.get(key)
      if (entry !== undefined) entry.attempts = 0
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
      queueApiFrame(event.sender, channel, envelope)
    })
    socket.addEventListener('close', () => {
      const entry = apiSockets.get(key)
      if (entry === undefined || entry.socket !== socket) return
      apiSockets.delete(key)
      if (event.sender.isDestroyed()) return
      // 订阅仍在但连接被服务端关闭/网络中断：退避重连，长会话不因瞬时断连卡死。
      if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
      const backoff = Math.min(1000 * 2 ** entry.attempts, 30_000)
      entry.attempts += 1
      entry.retryTimer = setTimeout(() => {
        if (!event.sender.isDestroyed() && state.hostBaseUrl !== undefined) apiStreamConnect(event, channel)
      }, backoff)
    })
    socket.addEventListener('error', () =>{  socket.close() })
  }

  /** 关闭并彻底终止一条流（去掉重连定时器）。 */
  function apiStreamClose(key: string): void {
    const entry = apiSockets.get(key)
    if (entry === undefined) return
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
    apiSockets.delete(key)
    entry.socket.close()
  }

  ipcMain.on('dsh:api-stream-subscribe', (event, channel: unknown) => {
    if (channel !== 'mux' && channel !== 'host') return
    apiStreamConnect(event, channel)
  })

  ipcMain.on('dsh:api-stream-unsubscribe', (event, channel: unknown) => {
    if (typeof channel !== 'string') return
    apiStreamClose(`${event.sender.id}:${channel}`)
    dropApiFrameBatches(event.sender.id)
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => {
      for (const [key] of apiSockets) {
        if (key.startsWith(`${contents.id}:`)) apiStreamClose(key)
      }
      dropApiFrameBatches(contents.id)
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
}
