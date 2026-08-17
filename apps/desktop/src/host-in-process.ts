/**
 * In-process harness host for the desktop shell (A3).
 *
 * Instead of supervising a `dsh web` child under a real Node, the Electron main
 * process boots the web profile directly by dynamically importing the deployed
 * runtime closure (`out/runtime/host-deploy` in dev,
 * `resources/runtime/host-deploy` packaged) and driving the shared profile boot
 * against its flat `node_modules`. The renderer and the IPC bridge are
 * unchanged: the shell still points at the loopback URL the in-process
 * `webServer` service listens on, and `/api` traffic still rides IPC.
 *
 * Why the runtime closure and not the repo source: the vendored Loader's bare
 * `@deepseek-ai/*` resolution requires either Node's internal ESM loader (the
 * `node-addon-require-builtin` addon, compiled for the system Node ABI and
 * unavailable under Electron) or a flat `node_modules` above the loader's own
 * file. The deployed closure is that flat layout; the repo's pnpm workspace is
 * not, so a source-mode in-process boot fails with `ERR_MODULE_NOT_FOUND`.
 *
 * The CLI's `runProfile` also mounts a config-HMR watcher that requires the
 * internal loader; this boot deliberately skips that post-boot glue and the
 * process-level signal/fail-loud wiring, which belong to a standalone process
 * rather than an Electron app.
 * @module @deepseek-ai/dsh-desktop/host-in-process
 */

import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The web profile the shell boots. */
const WEB_PROFILE = 'web'

/** Preferred loopback port: a stable renderer origin keeps the web UI's
 * localStorage (current session, chat view, workspace view) across launches. */
export const DEFAULT_WEB_PORT = 17890

/** Fallback candidates tried in order before deferring to an OS-assigned port. */
const WEB_PORT_CANDIDATES = [DEFAULT_WEB_PORT, DEFAULT_WEB_PORT + 1, DEFAULT_WEB_PORT + 2]

/** The overlay pinning the renderer-side browse directory picker (see the
 * overlay file for why the native Win32 worker cannot run under Electron). */
const BROWSE_PICKER_OVERLAY = fileURLToPath(new URL('../assets/desktop-browse-picker.yml', import.meta.url))

/** Absolute path of the browse-picker overlay, shared with the child-host path. */
export function browsePickerOverlayPath(): string {
  return BROWSE_PICKER_OVERLAY
}

/**
 * Whether a loopback listen on `port` succeeds right now.
 * @param port - the port to probe.
 * @returns whether the port is free on 127.0.0.1.
 */
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () =>{  resolve(false) })
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() =>{  resolve(true) })
    })
  })
}

/**
 * Pick the first free loopback port from `candidates`, or 0 for an
 * OS-assigned port when none is free.
 * @param candidates - ports to try, in order.
 * @returns the chosen port.
 */
export async function pickLoopbackPort(candidates: readonly number[] = WEB_PORT_CANDIDATES): Promise<number> {
  for (const port of candidates) {
    if (await isLoopbackPortFree(port)) return port
  }
  return 0
}

/** A promise that resolves exactly once, on demand. */
interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

/** The settled root context surface this module reads from the runtime. */
interface BootContext {
  get: (key: string) => unknown
  fiber: { dispose(): Promise<void> }
}

/** The runtime's `dsh-app-boot` entry surface. */
interface AppBootModule {
  boot(
    binName: string,
    absoluteConfigPath: string,
    patches?: readonly unknown[],
    prepare?: (ctx: BootContext) => Promise<void> | void,
    bareModuleBaseUrl?: string,
  ): Promise<BootContext>
  loadLayeredEnv(binName: string): unknown
}

/** The runtime's `dsh` profile-boot entry surface (`lib/embed.js`). */
interface DshEmbedModule {
  prepareProfile(name: string): { dir: string }
  composeProfile(name: string, patchFiles: readonly string[]): { profile: { dir: string } }
  allPatches(composed: unknown): unknown[]
  PROFILE_ROOT_FILENAME: string
}

interface CmdlineModule {
  provideCmdline: (ctx: BootContext, host: { args: readonly string[]; exit: (code: number) => void }) => void
}

interface LaunchEnvironmentModule {
  DSH_LAUNCH_ENVIRONMENT_KEY: string
}

function entry(runtimeRoot: string, ...segments: string[]): string {
  return join(runtimeRoot, 'node_modules', ...segments)
}

/** One live Loader row the host controller can toggle. */
interface HostLoaderEntry {
  readonly options: { readonly name: string }
  readonly disabled: boolean
  update(options: { disabled: boolean }): Promise<void>
}

/**
 * Live host controls the shell drives without config HMR. The Loader accepts
 * runtime row updates (the same mechanism config HMR uses), so plugin
 * enable/disable can apply immediately instead of waiting for a restart.
 */
export interface InProcessHostControls {
  /**
   * Toggle one mounted loader row live. Returns false when the row is not in
   * the running tree (the manifest change still applies on the next boot).
   */
  setPluginEnabled(name: string, enabled: boolean): Promise<boolean>
}

/**
 * Boot the web profile inside this process and expose its loopback URL.
 * @param options - runtime root, harness home, optional overlay and port, and
 * an exit callback.
 * @returns the loopback URL, an exit promise, and a dispose function.
 */
export async function startHostInProcess(options: {
  runtimeRoot: string
  home: string
  overlayPath?: string
  port?: number
  onExit?: (code: number) => void
}): Promise<{
  url: string
  exited: Promise<void>
  dispose(): Promise<void>
  /** Resolved directory-picker interaction: 'browse' (pinned by overlay), 'auto', or 'none'. */
  directoryPicker: 'browse' | 'auto' | 'none'
  /** Live loader controls (plugin enable/disable without restart). */
  controls: InProcessHostControls
}> {
  const { runtimeRoot, home, onExit } = options
  const overlayPath = options.overlayPath ?? browsePickerOverlayPath()
  const port = options.port ?? await pickLoopbackPort()
  const webArgs = ['--port', String(port)]
  const embedPath = entry(runtimeRoot, '@deepseek-ai', 'dsh', 'lib', 'embed.js')
  if (!existsSync(embedPath)) {
    throw new Error(`dsh-desktop: in-process runtime not deployed (${runtimeRoot}); deploy it before running`)
  }
  const appBoot = await import(pathToFileURL(entry(runtimeRoot, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href) as AppBootModule
  const embed = await import(pathToFileURL(embedPath).href) as DshEmbedModule
  const { provideCmdline } = await import(pathToFileURL(entry(runtimeRoot, '@deepseek-ai', 'dsh-cmdline', 'lib', 'index.js')).href) as CmdlineModule
  const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import(pathToFileURL(entry(runtimeRoot, '@deepseek-ai', 'dsh-launch-environment', 'lib', 'index.js')).href) as LaunchEnvironmentModule

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const exited = deferred()
  let ctx: BootContext | undefined
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      await ctx?.fiber.dispose()
    } finally {
      exited.resolve()
    }
  }
  try {
    const environment = appBoot.loadLayeredEnv('dsh-desktop')
    const composed = embed.composeProfile(WEB_PROFILE, [overlayPath])
    const rootConfig = join(composed.profile.dir, embed.PROFILE_ROOT_FILENAME)
    ctx = await appBoot.boot('dsh-desktop', rootConfig, structuredClone(embed.allPatches(composed)), (hostCtx) => {
      (hostCtx as unknown as { provide(key: string, value: unknown): void }).provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      provideCmdline(hostCtx, {
        args: webArgs,
        exit: code => void dispose().then(() => onExit?.(code)),
      })
    })
    const webserver = ctx.get('webServer') as { port: number } | undefined
    if (webserver === undefined) {
      throw new Error('dsh-desktop: in-process host booted without a webServer service')
    }
    // Report which directory-picker interaction the composed tree actually
    // mounted, so the shell (and its smoke) can verify the browse pin.
    const loader = ctx.get('loader') as { entries(): Iterable<{ id: string; disabled: boolean }> } | undefined
    let directoryPicker: 'browse' | 'auto' | 'none' = 'none'
    if (loader !== undefined) {
      // Row ids arrive include-prefixed (e.g. `include:directory-picker`).
      const ids = new Set([...loader.entries()].map(entry => entry.id.split(':').pop() ?? entry.id))
      if (ids.has('directory-picker-browse')) directoryPicker = 'browse'
      else if (ids.has('directory-picker')) directoryPicker = 'auto'
    }
    const controls: InProcessHostControls = {
      async setPluginEnabled(name, enabled) {
        if (ctx === undefined) return false
        const loader = ctx.get('loader') as { entries(): Iterable<HostLoaderEntry> } | undefined
        if (loader === undefined) return false
        for (const entry of loader.entries()) {
          if (entry.options.name !== name) continue
          if (entry.disabled === !enabled) return true
          await entry.update({ disabled: !enabled })
          return true
        }
        return false
      },
    }
    return { url: `http://127.0.0.1:${String(webserver.port)}`, exited: exited.promise, dispose, directoryPicker, controls }
  } finally {
    // Assigning `process.env.DSH_HOME = undefined` would stringify the value
    // to "undefined" (Node coerces env writes), which a later harnessHome()
    // read would treat as a configured home; delete the variable instead when
    // it was unset before boot.
    if (previousHome === undefined) {
      delete process.env.DSH_HOME
    } else {
      process.env.DSH_HOME = previousHome
    }
  }
}
