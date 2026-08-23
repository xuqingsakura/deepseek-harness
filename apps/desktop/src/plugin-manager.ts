/**
 * Desktop plugin management: drive the harness's official profile-plugin flow
 * from the packaged runtime. The desktop ships a vendored pnpm executable
 * (resources/pnpm) and reuses the harness app-boot's own profile APIs, so
 * "add a plugin" is exactly `dsh plugin --profile web add <spec>`: pnpm
 * installs into profiles/web/node_modules and the official reconcile step
 * registers every dependency declaring `dsh.bundle` into
 * `dsh.profile.bundles`. Restarting the shell activates the new layer
 * (in-process host has no config HMR).
 * @module @deepseek-ai/dsh-desktop/plugin-manager
 */

import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_PROFILE = 'web'
const PROFILES_DIR = 'profiles'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The runtime closure root: dev uses the deployed copy, packaged uses resources. */
function closureRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'host-deploy')
    : join(APP_ROOT, 'out', 'runtime', 'host-deploy')
}

/** Absolute path of the vendored pnpm executable. */
function pnpmExecutable(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pnpm', 'pnpm.exe')
    : join(APP_ROOT, 'runtime', 'pnpm', 'pnpm.exe')
}

/** Official app-boot surface the desktop plugin manager consumes. */
interface AppBootApi {
  initProfile(dir: string, bundles: readonly string[]): void
  readProfileManifest(binName: string, dir: string): ProfileManifest
  writeProfileManifest(dir: string, manifest: ProfileManifest): void
  resolveBundleDir(binName: string, packageName: string, installAnchor: string, profileDir: string): string
  resolveProfileDir(name: string, home: string): string
  PROFILE_TEMPLATES: Record<string, readonly string[]>
  DEFAULT_PROFILE_BUNDLES: readonly string[]
}

/** A profile manifest: package name, dependencies, and the bundle layer list. */
interface ProfileManifest {
  name?: string
  version?: string
  description?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: {
    profile?: { bundles?: string[]; disabled?: string[] }
    bundle?: { patch?: string }
  }
}

/** Where an external plugin came from, derived from its pnpm dependency spec. */
export type PluginSourceKind = 'npm' | 'git' | 'local'

/** Resolved plugin state returned to the UI. */
export interface DesktopPluginInfo {
  name: string
  version: string | undefined
  /** Whether the package declares `dsh.bundle` (and therefore mounts as a layer). */
  isBundle: boolean
  patch: string | undefined
  /** The raw pnpm dependency spec recorded in the profile manifest. */
  spec: string
  /** Where the plugin came from (registry / git host / local path). */
  source: PluginSourceKind
  /** Whether the bundle plugin is active (installed, in the layer stack, and not in `disabled`). */
  enabled: boolean
}

export interface PluginManagerResult {
  ok: boolean
  exitCode: number | null
  output: string
  bundles: string[]
  /** Exact `allowBuilds` keys pnpm wants before running a git dependency's prepare script. */
  allowBuilds: string[]
}

let appBootPromise: Promise<AppBootApi> | undefined

/** Load the official app-boot API once from the runtime closure. */
async function appBoot(): Promise<AppBootApi> {
  appBootPromise ??= import(pathToFileURL(join(
    closureRoot(), 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js',
  )).href) as Promise<AppBootApi>
  return appBootPromise
}

/** The installation anchor: the runtime's own dsh package.json (first resolveBundleDir anchor). */
function installAnchor(): string {
  return join(closureRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
}

/** A profile's directory under the harness home (same contract as resolveProfileDir). */
function profileDirFor(home: string): string {
  return join(home, PROFILES_DIR, WEB_PROFILE)
}
/** The application install root (parent of resources/); plugin homes must never live inside it. */
function installRoot(): string | undefined {
  return process.resourcesPath ? resolve(dirname(process.resourcesPath)) : undefined
}

/**
 * Validate a harness home before any plugin operation. The desktop never
 * writes plugin state under the install directory (Program Files is not
 * writable), and a home containing a literal unresolved segment such as
 * `undefined` means boot-time path resolution failed — fail loud instead of
 * surfacing a raw EPERM from the first mkdir.
 * @param home - the harness home to validate.
 */
function assertSafePluginHome(home: string): void {
  const trimmed = home.trim()
  if (trimmed === '') throw new Error('dsh-plugin: harness home 为空，无法管理插件')
  if (!isAbsolute(trimmed)) throw new Error(`dsh-plugin: harness home 必须是绝对路径，实际为 ${JSON.stringify(home)}`)
  const segments = trimmed.split(/[\\/]+/).filter(segment => segment !== '')
  if (segments.some(segment => segment === 'undefined' || segment === 'null' || segment === 'NaN')) {
    throw new Error(
      `dsh-plugin: harness home 包含未解析的路径段（${JSON.stringify(home)}），请完全退出应用后重新启动再试`,
    )
  }
  const root = installRoot()
  if (root !== undefined) {
    const rel = relative(root, trimmed)
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      throw new Error(
        `dsh-plugin: harness home ${JSON.stringify(home)} 位于应用安装目录 ${JSON.stringify(root)} 内，没有写入权限；` +
        '插件应安装到用户数据目录，请完全退出应用（托盘图标右键 → 退出）后重新启动再试',
      )
    }
  }
}

/** Proxy settings applied to the plugin installer's pnpm and git subprocesses. */
interface PluginProxyConfig {
  readonly http: string | undefined
  readonly https: string | undefined
  readonly noProxy: string | undefined
}

/**
 * Resolve the proxy the plugin installer should use. The browser follows the
 * system (WinINET) proxy, but spawned pnpm and git do not: pnpm's own HTTP
 * client ignores both the system proxy and git's `http.proxy` config, so a
 * GitHub install can die on a direct-connection reset even while the browser
 * works. Prefer explicit HTTP(S)_PROXY environment variables, then fall back
 * to the user's global git proxy — the one place a desktop user has already
 * configured the route.
 * @returns the proxy URLs to apply; fields are undefined when unset.
 */
function resolveProxyConfig(): PluginProxyConfig {
  const envHttps = process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy
  const envHttp = process.env.HTTP_PROXY ?? process.env.http_proxy
  if (envHttps !== undefined || envHttp !== undefined) {
    return { http: envHttp, https: envHttps, noProxy: process.env.NO_PROXY ?? process.env.no_proxy }
  }
  const gitHttps = gitConfigProxy('https.proxy')
  const gitHttp = gitConfigProxy('http.proxy')
  const https = gitHttps ?? gitHttp
  const http = gitHttp ?? gitHttps
  if (https === undefined && http === undefined) {
    return { http: undefined, https: undefined, noProxy: undefined }
  }
  // A git-derived proxy is a local client (Clash-style); loopback stays direct.
  return { http, https, noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? '127.0.0.1,localhost' }
}

/** Read one global git config value; absent or unreadable yields undefined. */
function gitConfigProxy(key: string): string | undefined {
  try {
    const result = spawnSync('git', ['config', '--global', '--get', key], { encoding: 'utf8', windowsHide: true })
    const value = result.status === 0 ? result.stdout.trim() : ''
    return value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the subprocess environment with the resolved proxy, so both pnpm's
 * HTTP client (env fallback) and the git it spawns (https_proxy/all_proxy)
 * use it. Returns the parent environment unchanged when no proxy is set.
 */
function pnpmEnv(proxy: PluginProxyConfig): NodeJS.ProcessEnv {
  if (proxy.http === undefined && proxy.https === undefined) return process.env
  const https = proxy.https ?? proxy.http ?? ''
  const http = proxy.http ?? proxy.https ?? ''
  const noProxy = proxy.noProxy ?? '127.0.0.1,localhost'
  return {
    ...process.env,
    HTTP_PROXY: http,
    HTTPS_PROXY: https,
    http_proxy: http,
    https_proxy: https,
    ALL_PROXY: https,
    all_proxy: https,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

/**
 * Ensure the profile's pnpm reads the vendored binary without phoning home:
 * `update-notifier=false` kills pnpm's startup version check (which would
 * stall behind a blocked registry for ~70 s). An optional registry override
 * comes from DSH_PNPM_REGISTRY; otherwise pnpm's own/default config applies.
 * A resolved proxy is written as http-proxy/https-proxy/no-proxy so pnpm's
 * own HTTP client follows the same route as the browser's system proxy.
 */
function ensureNpmrc(dir: string, proxy: PluginProxyConfig): void {
  const lines = ['update-notifier=false']
  const registry = process.env.DSH_PNPM_REGISTRY?.trim()
  if (registry !== undefined && registry !== '') lines.push(`registry=${registry}`)
  if (proxy.http !== undefined && proxy.http !== '') lines.push(`http-proxy=${proxy.http}`)
  if (proxy.https !== undefined && proxy.https !== '') lines.push(`https-proxy=${proxy.https}`)
  if (proxy.noProxy !== undefined && proxy.noProxy !== '') lines.push(`no-proxy=${proxy.noProxy}`)
  const path = join(dir, '.npmrc')
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (existing.trim() === lines.join('\n')) return
  writeFileSync(path, `${lines.join('\n')}\n`)
}

/** Run vendored pnpm in the profile directory, capturing output. */
function runPnpm(dir: string, args: readonly string[], proxy: PluginProxyConfig): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmExecutable(), [...args], {
      cwd: dir,
      windowsHide: true,
      env: pnpmEnv(proxy),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      reject(new Error(`pnpm failed to start: ${String(error.message)}`))
    })
    child.on('close', (code) => {
      resolve({ status: code, output: stdout + stderr })
    })
  })
}

/** Strip ANSI color escapes pnpm may emit even when stdout is a pipe. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/**
 * Extract the exact `allowBuilds` keys pnpm prints when it refuses to run a
 * git-hosted dependency's prepare script (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`).
 * The key pnpm wants under `allowBuilds:` is the depPath form it echoes in the
 * hint block (`name@git+https://...#sha`), so take it verbatim from there.
 * @param output - captured pnpm stdout + stderr.
 */
export function parseAllowBuildHints(output: string): string[] {
  const text = stripAnsi(output)
  const keys: string[] = []
  const hintBlock = /allowBuilds:\s*\r?\n[ \t]+(.+?):[ \t]*true[ \t]*(?:\r?\n|$)/g
  for (const match of text.matchAll(hintBlock)) {
    const key = match[1]?.trim()
    if (key !== undefined && key !== '' && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/** Classify a pnpm dependency spec by its install source. */
function pluginSource(spec: string): PluginSourceKind {
  if (/^(github:|git\+|git:|https?:\/\/)/.test(spec)) return 'git'
  if (/^(file:|link:)/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec) || /^\.{1,2}[\\/]/.test(spec)) return 'local'
  return 'npm'
}

/** Whether a resolved dependency exports a profile patch, i.e. is a bundle. */
function exportsPatch(api: AppBootApi, packageName: string, profileDir: string): boolean {
  try {
    const dir = api.resolveBundleDir('dsh-desktop', packageName, installAnchor(), profileDir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProfileManifest
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state — the official
 * rule from apps/cli/src/plugin.ts: a dependency that resolves to a
 * `dsh.bundle`-declaring package joins the layer stack; a dependency-listed
 * name that no longer does leaves it.
 */
async function reconcilePlugins(before: ProfileManifest, profileDir: string): Promise<void> {
  const api = await appBoot()
  const after = api.readProfileManifest('dsh-desktop', profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  const disabled = new Set(after.dsh?.profile?.disabled ?? [])
  let changed = false
  for (const packageName of dependencies) {
    if (exportsPatch(api, packageName, profileDir) && !disabled.has(packageName) && !plugins.includes(packageName)) {
      plugins.push(packageName)
      changed = true
    }
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...plugins]) {
    const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
    // `disabled` toggles a row inside the layer stack; it never evicts the
    // bundle, so a stopped plugin can re-enable live through the running tree.
    const stillBundle = dependencySet.has(packageName) && exportsPatch(api, packageName, profileDir)
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(packageName), 1)
      changed = true
    }
  }
  if (!changed) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles: plugins } }
  api.writeProfileManifest(profileDir, after)
}

/** Initialize the web profile on first use (official initProfile template). */
async function ensureProfile(home: string, proxy: PluginProxyConfig): Promise<string> {
  const api = await appBoot()
  const dir = profileDirFor(home)
  if (!existsSync(join(dir, 'package.json'))) {
    api.initProfile(dir, api.PROFILE_TEMPLATES[WEB_PROFILE] ?? api.DEFAULT_PROFILE_BUNDLES)
  }
  ensureNpmrc(dir, proxy)
  return dir
}

/**
 * 启用本次安装新增的 bundle 插件（P1-7 防御性修复）。
 *
 * pnpm add 后的官方 reconcile 可能为了安全把新插件加入 disabled 作为默认，
 * 让用户误以为“装完就不能用”。此函数把本次新增且声明了 bundle patch 的依赖
 * 从 disabled 移除并确保出现在 bundles 里，使“安装即启用”符合直觉。
 * 已有（update/移除再装）且被用户手动停用的插件不受影响，因为只处理新出现的依赖名。
 */
async function enableNewBundles(before: ProfileManifest, profileDir: string): Promise<void> {
  const api = await appBoot()
  const manifest = api.readProfileManifest('dsh-desktop', profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const deps = Object.keys(manifest.dependencies ?? {})
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  const disabled = new Set(manifest.dsh?.profile?.disabled ?? [])
  let changed = false
  for (const name of deps) {
    if (beforeDeps.has(name)) continue
    if (!exportsPatch(api, name, profileDir)) continue
    if (!bundles.includes(name)) { bundles.push(name); changed = true }
    if (disabled.has(name)) { disabled.delete(name); changed = true }
  }
  if (!changed) return
  const profile = { ...manifest.dsh?.profile, bundles }
  if (disabled.size > 0) profile.disabled = [...disabled]
  else delete profile.disabled
  manifest.dsh = { ...manifest.dsh, profile }
  api.writeProfileManifest(profileDir, manifest)
}

export async function installPlugin(home: string, spec: string): Promise<PluginManagerResult> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const before = api.readProfileManifest('dsh-desktop', dir)
  const { status, output } = await runPnpm(dir, ['add', spec], proxy)
  if (status === 0) {
    await reconcilePlugins(before, dir)
    // P1-7：安装即启用，避免新装 bundle 默认被官方 reconcile 置为禁用。
    await enableNewBundles(before, dir)
  }
  const after = api.readProfileManifest('dsh-desktop', dir)
  return {
    ok: status === 0,
    exitCode: status,
    output,
    bundles: after.dsh?.profile?.bundles ?? [],
    allowBuilds: parseAllowBuildHints(output),
  }
}

/** A bundled plugin shipped inside the desktop resources (dev: apps/desktop/plugins). */
export interface BuiltinPluginInfo {
  name: string
  version: string | undefined
  description: string | undefined
  /** Absolute directory of the bundled plugin package. */
  dir: string
}

/** Absolute directory of the bundled plugins root (resources/plugins packaged, apps/desktop/plugins dev). */
function builtinPluginsRoot(): string {
  return process.resourcesPath
    ? join(process.resourcesPath, 'plugins')
    : join(APP_ROOT, 'plugins')
}

/**
 * List the bundled plugins shipped with the desktop. Each is a directory
 * under the bundled plugins root declaring `dsh.bundle.patch`, ready to
 * install with a one-click `file:` spec (no path typing needed).
 * @returns the bundled plugin descriptors present in the current build.
 */
export function listBuiltinPlugins(): BuiltinPluginInfo[] {
  const root = builtinPluginsRoot()
  if (!existsSync(root)) return []
  const out: BuiltinPluginInfo[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
      if (manifest.dsh?.bundle?.patch === undefined) continue
      out.push({
        name: entry.name,
        version: manifest.version,
        description: manifest.description,
        dir,
      })
    } catch {
      // A malformed bundled plugin is not a user-facing plugin; skip it.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Install a bundled plugin by its directory name (e.g. "dsh-workbench")
 * through the official `file:` profile-plugin flow — the same reconcile as
 * any external plugin, with no manual path entry.
 * @param home - the harness home.
 * @param name - the bundled plugin directory name.
 * @returns the standard plugin-operation result.
 */
export async function installBuiltinPlugin(home: string, name: string): Promise<PluginManagerResult> {
  const found = listBuiltinPlugins().find(plugin => plugin.name === name)
  if (found === undefined) {
    throw new Error('dsh-plugin: 内置插件 ' + JSON.stringify(name) + ' 不存在')
  }
  return installPlugin(home, 'file:' + found.dir)
}

/** Remove a plugin by package name (pnpm remove + reconcile). */
export async function removePlugin(home: string, name: string): Promise<PluginManagerResult> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const before = api.readProfileManifest('dsh-desktop', dir)
  const { status, output } = await runPnpm(dir, ['remove', name], proxy)
  if (status === 0) await reconcilePlugins(before, dir)
  const after = api.readProfileManifest('dsh-desktop', dir)
  return {
    ok: status === 0,
    exitCode: status,
    output,
    bundles: after.dsh?.profile?.bundles ?? [],
    allowBuilds: parseAllowBuildHints(output),
  }
}

/** Update one plugin: pnpm re-resolves registry ranges and git refs. */
export async function updatePlugin(home: string, name: string): Promise<PluginManagerResult> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const before = api.readProfileManifest('dsh-desktop', dir)
  const { status, output } = await runPnpm(dir, ['update', name], proxy)
  if (status === 0) await reconcilePlugins(before, dir)
  const after = api.readProfileManifest('dsh-desktop', dir)
  return {
    ok: status === 0,
    exitCode: status,
    output,
    bundles: after.dsh?.profile?.bundles ?? [],
    allowBuilds: parseAllowBuildHints(output),
  }
}

/** Update every external plugin in one pnpm invocation. */
export async function updateAllPlugins(home: string): Promise<PluginManagerResult> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const before = api.readProfileManifest('dsh-desktop', dir)
  const { status, output } = await runPnpm(dir, ['update'], proxy)
  if (status === 0) await reconcilePlugins(before, dir)
  const after = api.readProfileManifest('dsh-desktop', dir)
  return {
    ok: status === 0,
    exitCode: status,
    output,
    bundles: after.dsh?.profile?.bundles ?? [],
    allowBuilds: parseAllowBuildHints(output),
  }
}

/** Remove several plugins in one pnpm invocation (batch path). */
export async function removePlugins(home: string, names: readonly string[]): Promise<PluginManagerResult> {
  assertSafePluginHome(home)
  if (names.length === 0) throw new Error('dsh-plugin: 没有选择要移除的插件')
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const before = api.readProfileManifest('dsh-desktop', dir)
  const { status, output } = await runPnpm(dir, ['remove', ...names], proxy)
  if (status === 0) await reconcilePlugins(before, dir)
  const after = api.readProfileManifest('dsh-desktop', dir)
  return {
    ok: status === 0,
    exitCode: status,
    output,
    bundles: after.dsh?.profile?.bundles ?? [],
    allowBuilds: parseAllowBuildHints(output),
  }
}

/**
 * Toggle a bundle plugin's layer membership without running pnpm: the profile
 * manifest's `dsh.profile.disabled` list keeps it installed but out of the
 * layer stack (a restart applies the change; the in-process host has no HMR).
 * @param home - the harness home.
 * @param name - the installed package name.
 * @param enabled - whether the plugin joins the layer stack.
 * @returns the resulting bundle list.
 */
export async function setPluginEnabled(
  home: string, name: string, enabled: boolean,
): Promise<{ ok: boolean; bundles: string[]; enabled: boolean }> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const api = await appBoot()
  const manifest = api.readProfileManifest('dsh-desktop', dir)
  if (!(name in (manifest.dependencies ?? {}))) {
    throw new Error(`dsh-plugin: ${name} 未安装，无法切换启用状态`)
  }
  if (!exportsPatch(api, name, dir)) {
    throw new Error(`dsh-plugin: ${name} 不是 bundle 层插件，无需启用/停用`)
  }
  const disabled = new Set(manifest.dsh?.profile?.disabled ?? [])
  if (disabled.has(name) === !enabled) {
    const bundles = manifest.dsh?.profile?.bundles ?? []
    return { ok: true, bundles, enabled: !disabled.has(name) }
  }
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  // The layer stack stays constant: toggling only edits `disabled`, so the
  // entry keeps mounting in the running loader tree (disabled rows still
  // exist) and the in-process host can apply the change live. Enabling an
  // installed bundle the pre-fix manager had evicted from the stack adds it
  // back so the enable actually loads it.
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  if (enabled && !bundles.includes(name)) bundles.push(name)
  const profile = { ...manifest.dsh?.profile, bundles }
  if (disabled.size > 0) profile.disabled = [...disabled]
  else delete profile.disabled
  manifest.dsh = { ...manifest.dsh, profile }
  api.writeProfileManifest(dir, manifest)
  return { ok: true, bundles, enabled }
}

/**
 * Map installed package names to the newest registry version, parsed from
 * `pnpm outdated --format json`. Git and local-path plugins are not reported
 * by pnpm and therefore never appear. A parse failure yields an empty map.
 * @returns package name to latest version.
 */
export async function checkOutdated(home: string): Promise<Record<string, string>> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const { status, output } = await runPnpm(dir, ['outdated', '--format', 'json'], proxy)
  if (status !== 0 && status !== 1) return {}
  const text = stripAnsi(output).trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text) as Record<string, { latest?: string | null; current?: string | null }>
    const result: Record<string, string> = {}
    for (const [packageName, info] of Object.entries(parsed)) {
      const latest = info.latest
      if (typeof latest === 'string' && latest !== '' && latest !== info.current) result[packageName] = latest
    }
    return result
  } catch {
    return {}
  }
}

/** List installed profile dependencies with their bundle status and version. */
export async function listPlugins(home: string): Promise<DesktopPluginInfo[]> {
  assertSafePluginHome(home)
  const dir = profileDirFor(home)
  if (!existsSync(join(dir, 'package.json'))) return []
  const api = await appBoot()
  const manifest = api.readProfileManifest('dsh-desktop', dir)
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const disabled = new Set(manifest.dsh?.profile?.disabled ?? [])
  const infos: DesktopPluginInfo[] = []
  for (const name of Object.keys(dependencies)) {
    let version: string | undefined
    let patch: string | undefined
    try {
      const pkgDir = api.resolveBundleDir('dsh-desktop', name, installAnchor(), dir)
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as ProfileManifest & { version?: string }
      version = pkg.version
      patch = pkg.dsh?.bundle?.patch
    } catch {
      version = undefined
      patch = undefined
    }
    const spec = dependencies[name] ?? ''
    infos.push({
      name,
      version,
      // `isBundle` is the package's DECLARATION (`dsh.bundle.patch`), not its
      // current layer membership: a disabled bundle is still a bundle and must
      // keep its enable button.
      isBundle: patch !== undefined,
      patch,
      spec,
      source: pluginSource(spec),
      enabled: bundles.includes(name) && !disabled.has(name),
    })
  }
  return infos
}

/** The profile pnpm settings that out-of-tree plugins need (mirrors app-boot's initProfile). */
const DEFAULT_PNPM_WORKSPACE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n')

/** Quote a YAML scalar key so pnpm reads it verbatim (keys embed `@`, `#`, `:`). */
function quoteYamlKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`
}

/**
 * Merge `allowBuilds` keys into the profile's pnpm-workspace.yaml, preserving
 * existing keys - the file-level equivalent of `pnpm approve-builds` for the
 * profile pnpm manages. Never executes package code.
 * @param dir - the profile directory.
 * @param keys - depPath allowBuilds keys pnpm printed.
 * @returns the workspace file path.
 */
function writeAllowBuilds(dir: string, keys: readonly string[]): string {
  const path = join(dir, 'pnpm-workspace.yaml')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : DEFAULT_PNPM_WORKSPACE.split('\n')
  let blockIndex = -1
  let blockEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (/^allowBuilds:\s*$/.test(lines[i] ?? '')) {
      blockIndex = i
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j] ?? ''
        if (line.trim() !== '' && !/^[ \t]/.test(line)) {
          blockEnd = j
          break
        }
      }
      break
    }
  }
  const existing = new Set<string>()
  // lastContent tracks the final non-empty key line so new keys land right
  // after it instead of after trailing blank lines inside the block.
  let lastContent = blockIndex
  if (blockIndex !== -1) {
    for (let j = blockIndex + 1; j < blockEnd; j += 1) {
      const line = lines[j] ?? ''
      if (line.trim() !== '') lastContent = j
      const match = /^[ \t]+(['"]?)(.+?)\1:[ \t]*true[ \t]*$/.exec(line)
      if (match !== null) existing.add(match[2] ?? '')
    }
  }
  const missing = [...new Set(keys)].filter(key => key.trim() !== '' && !existing.has(key))
  if (missing.length === 0) return path
  const rendered = missing.map(key => `  ${quoteYamlKey(key)}: true`)
  if (blockIndex === -1) {
    // No block yet: append a new top-level block (with a separating blank
    // line when the file does not already end with one).
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('')
    lines.push('allowBuilds:')
    lastContent = lines.length - 1
  }
  lines.splice(lastContent + 1, 0, ...rendered)
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`)
  return path
}

/**
 * Authorize git-hosted build scripts the pnpm way: write the printed
 * `allowBuilds` keys into the profile's pnpm-workspace.yaml and return the
 * file path. The caller re-runs the add afterwards; this never runs package
 * code itself.
 */
export async function authorizeBuilds(home: string, keys: readonly string[]): Promise<{ path: string }> {
  assertSafePluginHome(home)
  const proxy = resolveProxyConfig()
  const dir = await ensureProfile(home, proxy)
  const path = writeAllowBuilds(dir, keys)
  return { path }
}

/** The default profile patch filename, exported for the UI's copy. */
export { PROFILE_PATCH_FILENAME }
