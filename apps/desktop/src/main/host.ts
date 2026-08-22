/**
 * 桌面端宿主启动与等待（Phase 0.1 拆分）。
 *
 * 从 main.ts 提取：`--smoke` 自检等场景下，把 `dsh web` 宿主作为子进程拉起并等待它就绪，
 * 或等待渲染层 React 根目录、播放 splash 退出动画。默认采用进程内宿主（host-in-process），
 * 此模块仅提供子进程模式与通用等待/动画。
 * @module @deepseek-ai/dsh-desktop/main/host
 */

import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { CLI_BIN, DEFAULT_DSH_HOME } from './config.ts'
import { debugLog } from './log.ts'

/** web profile 就绪时打印的地址行。 */
const HOST_URL_RE = /dsh web: (https?:\/\/\S+)/

/** smoke 模式渲染等待：轮询 React 根目录多久后认为失败。 */
const SMOKE_TIMEOUT_MS = 20_000

/** 延迟 Promise 的手动控制句柄。 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/** 创建一个可手动 resolve/reject 的延迟 Promise。 */
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
 * 解析运行宿主的真实 Node 可执行文件。
 *
 * 宿主必须跑在真实 Node 下，而非 Electron 内嵌 Node：vendored Loader 通过
 * `node-addon-require-builtin` 原生插件访问 Node 内部 ESM loader，该插件按系统 Node ABI
 * 编译——在 `ELECTRON_RUN_AS_NODE` 下会加载失败，插件树无法解析 profile 包。
 * pnpm 脚本通过 `npm_node_execPath` 暴露真实 Node；否则回退到 PATH 中的 `node`。
 * @returns 要 spawn 的可执行文件。
 */
function resolveNodeExecutable(): string {
  const npmNode = process.env.npm_node_execPath
  if (npmNode !== undefined && npmNode !== '') return npmNode
  return 'node'
}

/** 一个运行中的 harness 宿主（子进程）：就绪 URL、退出结算与 kill 句柄。 */
interface HostHandle {
  url: Promise<string>
  /** 子进程退出后结算（忽略 resolve 值）。 */
  exited: Promise<void>
  kill: () => void
  /** 已解析的目录选择交互；仅进程内启动会设置。 */
  picker?: 'browse' | 'auto' | 'none'
}

/**
 * 拉起 `dsh web` 宿主子进程并解析它打印的 URL。
 * @param onLine - 可选宿主 stdout 行接收器（用于日志）。
 * @returns 就绪 URL Promise 与 kill 句柄。
 */
function startHost(port: number, overlayPath: string, onLine?: (line: string) => void): HostHandle {
  // 打包模式自带 Node 与部署的宿主闭包（resources/runtime）；源码/开发模式使用
  // 检出目录的启动器与环境中的真实 Node。
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
 * 等待页面渲染出 React 根目录（轮询 DOM）。
 * @param window - 加载 harness UI 的 BrowserWindow。
 * @param timeoutMs - 总等待预算。
 * @returns 渲染出的 `#root` 子节点数，超时返回 0。
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

/** 播放 splash 退出动画（鲸鱼移出 + 淡出），让跳到真实 UI 落在平滑的深色过渡上。 */
async function playSplashExit(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return
  try {
    const result: unknown = await window.webContents.executeJavaScript(
      'window.__dshSplashExit ? window.__dshSplashExit() : null',
    )
    // 没有退出函数的老旧/插件 splash 页用一个固定淡出兜底。
    if (result === null) await new Promise(resolve => setTimeout(resolve, 450))
  } catch {
    // 页面不可执行（已销毁/导航中）：固定淡出，绝不阻塞 UI。
    await new Promise(resolve => setTimeout(resolve, 450))
  }
}

export { startHost, waitForRender, playSplashExit, SMOKE_TIMEOUT_MS }
export type { HostHandle }
