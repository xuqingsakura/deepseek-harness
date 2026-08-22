/**
 * 桌面端主进程的路径常量与宿主环境判定（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取，集中管理「应用根 / 仓库根 / 发布产物 / 图标资源 / 桌面应用宿主目录」等
 * 一次性路径，避免散落在各模块。针对 fork 桌面端的定制：开发模式 DSH_HOME 落到
 * `apps/desktop/.dsh-home`，打包模式落到 `userData/dsh-home`。
 * @module @deepseek-ai/dsh-desktop/main/config
 */

import { app } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** apps/desktop —— 比 src/ 和 lib/ 各高一级（源码/产物同一相对位置）。 */
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** 仓库根 —— 比 src/ 和 lib/ 高三级：apps/desktop -> apps -> 仓库。 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
/** 已构建的 `dsh` 启动入口；在纯 Node 下是真正的入口路径。 */
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'lib', 'bin.js')
/**
 * 开发模式默认 DSH_HOME；打包模式由 harnessHome() 落到 userData/dsh-home。
 * 归在应用目录下，保证原型不会写到检出目录之外。
 */
const DEFAULT_DSH_HOME = join(APP_ROOT, '.dsh-home')
/** 兼作标题栏与窗口/任务栏图标的 favicon 源。 */
const FAVICON = join(REPO_ROOT, 'apps', 'web', 'public', 'favicon.svg')
/** 生成的窗口图标（ICO，多尺寸），供 BrowserWindow 构造使用。 */
const APP_ICON = join(APP_ROOT, 'assets', 'icon.ico')
/** 预加载脚本：暴露窗口控制桥并挂载自定义标题栏。 */
const PRELOAD = join(APP_ROOT, 'lib', 'preload.js')
/** 托盘图标资源（favicon 的 256px 渲染同时充当托盘图标）。 */
const TRAY_ICON = join(APP_ROOT, 'assets', 'icon.png')

/**
 * 解析桌面应用宿主目录（DSH_HOME）。
 *
 * 优先读 `$DSH_HOME`；但 Node 会把 `undefined` 等写入为字符串，因此要拒绝
 * "undefined"/"null"/"NaN" 这类被污染的值，避免插件操作都落到相对路径而失败。
 * 未配置时，开发模式回退到 `DEFAULT_DSH_HOME`，打包模式回退到 `userData/dsh-home`。
 * @returns 可用的宿主目录绝对路径。
 */
function harnessHome(): string {
  const configuredHome = process.env.DSH_HOME?.trim()
  if (configuredHome !== undefined && configuredHome !== ''
    && configuredHome !== 'undefined' && configuredHome !== 'null' && configuredHome !== 'NaN') {
    return configuredHome
  }
  return app.isPackaged ? join(app.getPath('userData'), 'dsh-home') : DEFAULT_DSH_HOME
}

export {
  APP_ROOT, REPO_ROOT, CLI_BIN, DEFAULT_DSH_HOME, FAVICON, APP_ICON, PRELOAD, TRAY_ICON, harnessHome,
}
