/**
 * 桌面端主进程 IPC 注册与 API 桥（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：把插件管理、工作台窗口、更新、数据迁移、window-control、
 * 通知与窗口状态等全部 ipcMain handler 聚到
 * 一个 registerIpc()。依赖（插件管理器、更新器、窗口、共享状态、日志）由本模块直接 import，
 * 从而让 main.ts 的 boot 只负责"注册一次"。
 * @module @deepseek-ai/dsh-desktop/main/ipc
 */

import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessHome } from './config.ts'
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
  // ── Renderer transport: the host serves the page over http://127.0.0.1, so every
  // /api request and Remote stream rides the host's loopback HTTP/WebSocket directly
  // (the browser's own fetch + WebSocket). No IPC API carrier is used.
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
