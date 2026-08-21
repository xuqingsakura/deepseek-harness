/**
 * Refresh the desktop runtime's `@deepseek-ai/dsh` lib from the freshly built
 * `apps/cli` output and regenerate the stable `embed.js` re-export shim.
 *
 * `pnpm run build:lib:host` emits content-hashed bundle names, so the desktop
 * cannot import `profile-boot.js` by a stable name. This script copies the new
 * lib into the runtime closure (`out/runtime/host-deploy`), drops stale hashed
 * files, and writes `lib/embed.js` that maps the bundle's (possibly aliased)
 * export line back to public names.
 * @module @deepseek-ai/dsh-desktop/deploy-runtime
 */

import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_LIB = resolve(APP_ROOT, '..', 'cli', 'lib')
const RUNTIME_DSH_LIB = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib')

if (!existsSync(CLI_LIB)) {
  console.error(`deploy-runtime: built CLI lib not found at ${CLI_LIB}; run \`pnpm run build:lib:host\` first`)
  process.exit(1)
}
// A fresh `pnpm deploy` materializes the closure without the @deepseek-ai/dsh
// bin package (pnpm skips bin-only workspace packages), so stage the dsh
// package from the built CLI output before refreshing it. A fully missing
// closure (no @deepseek-ai dir at all) is still an error: run package.mjs,
// which deploys it, or `pnpm deploy` the host-pkg manifest first.
const DSH_ROOT = resolve(RUNTIME_DSH_LIB, '..')
if (!existsSync(RUNTIME_DSH_LIB)) {
  if (!existsSync(join(DSH_ROOT, '..', '..'))) {
    console.error(`deploy-runtime: runtime closure not found at ${RUNTIME_DSH_LIB}; deploy the host closure first`)
    process.exit(1)
  }
  mkdirSync(RUNTIME_DSH_LIB, { recursive: true })
  copyFileSync(join(APP_ROOT, '..', 'cli', 'package.json'), join(DSH_ROOT, 'package.json'))
  const configSrc = join(APP_ROOT, '..', 'cli', 'config')
  if (existsSync(configSrc)) cpSync(configSrc, join(DSH_ROOT, 'config'), { recursive: true })
  console.log(`deploy-runtime: staged dsh package at ${DSH_ROOT}`)
}

/** Public exports declared by the profile-boot bundle, as `{ name, alias }`. */
function parseExports(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8')
  const match = /export\s*\{([^}]+)\}\s*;?\s*$/m.exec(source.trimEnd())
  if (!match) throw new Error(`deploy-runtime: no export statement in ${bundlePath}`)
  const entries = []
  for (const part of match[1].split(',')) {
    const [name, alias] = part.trim().split(/\s+as\s+/)
    if (name === undefined) continue
    entries.push({ name: name.trim(), alias: (alias ?? name).trim() })
  }
  return entries
}

// Copy fresh lib files, then drop stale ones no longer referenced by bin.js.
const fresh = new Set()
for (const file of readdirSync(CLI_LIB)) {
  if (!file.endsWith('.js') && !file.endsWith('.map') && !file.endsWith('.tsbuildinfo')) continue
  const destination = join(RUNTIME_DSH_LIB, file)
  copyFileSync(join(CLI_LIB, file), destination)
  fresh.add(file)
}
const binSource = readFileSync(join(RUNTIME_DSH_LIB, 'bin.js'), 'utf8')
const referenced = new Set([...binSource.matchAll(/["']([A-Za-z0-9_-]+\.js)["']/g)].map((m) => m[1]))
for (const file of readdirSync(RUNTIME_DSH_LIB)) {
  if (!file.endsWith('.js')) continue
  if (fresh.has(file) || file === 'embed.js') continue
  if (referenced.has(file)) continue
  if (/^profile-boot-[A-Za-z0-9_-]+\.js$/.test(file) && fresh.has(binSource.match(/profile-boot-[A-Za-z0-9_-]+\.js/)?.[0])) continue
  rmSync(join(RUNTIME_DSH_LIB, file), { force: true })
}

// Locate the real profile-boot bundle (the shim bin.js imports is 85 bytes of
// `import { c as runProfile } ...; export { runProfile }`; follow it to the bundle).
const shimName = binSource.match(/profile-boot-[A-Za-z0-9_-]+\.js/)?.[0]
const shimPath = join(RUNTIME_DSH_LIB, shimName)
const shimSource = readFileSync(shimPath, 'utf8')
const bundleName = shimSource.match(/from\s*["']\.\/(profile-boot-[A-Za-z0-9_-]+\.js)["']/)?.[1]
if (bundleName === undefined) throw new Error(`deploy-runtime: cannot locate profile-boot bundle from ${shimName}`)
const exportsList = parseExports(join(RUNTIME_DSH_LIB, bundleName))
const importParts = exportsList.map(({ name, alias }) => `  ${alias} as ${name},`)
const exportParts = exportsList.map(({ name }) => `  ${name},`)
const embed = `import {\n${importParts.join('\n')}\n} from './${bundleName}'\nexport {\n${exportParts.join('\n')}\n}\n`
writeFileSync(join(RUNTIME_DSH_LIB, 'embed.js'), embed)
/**
 * Prune dead weight from the deployed host closure so the NSIS installer is
 * smaller and installs faster (fewer files, less data to decompress):
 * - `.js.map`, `.d.ts`/`.d.mts`/`.d.cts`, `.pdb`, `.tsbuildinfo` are debug/build artifacts, never loaded at runtime.
 * - `typescript` + `@deepseek-ai/dsh-typert-generator` are build-time codegen, not mounted by the web profile.
 * - `vite` is declared by `dsh-web-frontend` for its dev workflow; no production module imports it.
 * - `node-pty` ships prebuilds for every platform; keep only `win32-x64`.
 * - Test toolchains (`vitest`/`@vitest`/`@testing-library`/`rollup`/`@rollup`), the
 *   dev TS runner (`tsx`/`esbuild`/`@esbuild`), and `@agentclientprotocol`
 *   (an ACP-only dep) has no runtime importer in the web profile.
 * - Test-support and non-web-profile packages (`dsh-acp*`, `dsh-headless`,
 *   `dsh-e2b*`, `dsh-subagent-acp`/`-dsh-sdk`/`-codex`) are never mounted.
 */
function pruneClosure() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  if (!existsSync(modulesRoot)) {
    console.error(`deploy-runtime: no closure at ${modulesRoot}`)
    process.exit(1)
  }
  let removedFiles = 0
  const removeDir = (dir) => {
    if (!existsSync(dir)) return
    const count = readdirSync(dir, { recursive: true }).length
    rmSync(dir, { recursive: true, force: true })
    removedFiles += count
    console.log(`deploy-runtime: pruned ${dir} (${count} entries)`)
  }
  const removeFile = (file) => {
    if (!existsSync(file)) return
    rmSync(file, { force: true })
    removedFiles += 1
  }
  removeDir(join(modulesRoot, 'typescript'))
  removeDir(join(modulesRoot, 'vite'))
  removeDir(join(modulesRoot, '@deepseek-ai', 'dsh-subagent-claude-code'))
  removeDir(join(modulesRoot, '@deepseek-ai', 'dsh-typert-generator'))
  // Test toolchains and dev runners: their only importers are the test-support
  // packages pruned below, and nothing in the web profile mounts them.
  removeDir(join(modulesRoot, 'vitest'))
  removeDir(join(modulesRoot, '@vitest'))
  removeDir(join(modulesRoot, '@testing-library'))
  removeDir(join(modulesRoot, 'rollup'))
  removeDir(join(modulesRoot, '@rollup'))
  removeDir(join(modulesRoot, 'tsx'))
  removeDir(join(modulesRoot, 'esbuild'))
  removeDir(join(modulesRoot, '@esbuild'))
  removeDir(join(modulesRoot, '@agentclientprotocol'))
  // Test-support and non-web-profile packages: the desktop boots the web
  // profile only, and none of these are mounted or imported at runtime.
  for (const pkg of [
    'dsh-acp-snapshot', 'dsh-agent-loop-testkit', 'dsh-client-test-runtime',
    'dsh-acp', 'dsh-acp-demo', 'dsh-headless',
    'dsh-e2b', 'dsh-fs-e2b', 'dsh-subprocess-e2b',
    'dsh-subagent-acp', 'dsh-subagent-dsh-sdk', 'dsh-subagent-codex',
  ]) {
    removeDir(join(modulesRoot, '@deepseek-ai', pkg))
  }
  const nodePty = join(modulesRoot, 'node-pty')
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-arm64']) {
    removeDir(join(nodePty, 'prebuilds', platform))
  }
  removeDir(join(nodePty, 'third_party'))
  removeDir(join(nodePty, 'deps'))
  removeDir(join(nodePty, 'src'))
  removeDir(join(nodePty, 'scripts'))
  removeDir(join(nodePty, 'typings'))
  // The conpty helper for the current platform lives inside prebuilds/win32-x64.
  for (const file of readdirSync(modulesRoot, { recursive: true })) {
    if (/\.(d\.[cm]?ts(\.map)?|js\.map|ts|pdb|tsbuildinfo)$/u.test(file)) {
      removeFile(join(modulesRoot, file))
    }
  }
  // The in-process host is the packaged default; the child fallback is dev-only.
  removeFile(join(APP_ROOT, 'out', 'runtime', 'node.exe'))
  // A legacy pnpm deploy copies the host-pkg source dir verbatim, dragging the
  // vendored pnpm (apps/desktop/runtime/pnpm) into the closure; it ships
  // separately via electron-builder extraResources for the plugin installer,
  // so this copy is pure duplication (~110 MB).
  removeDir(join(APP_ROOT, 'out', 'runtime', 'host-deploy', 'pnpm'))
  console.log(`deploy-runtime: closure pruned (${removedFiles} entries removed)`)
}

console.log(`deploy-runtime: refreshed ${RUNTIME_DSH_LIB}`)
console.log(`deploy-runtime: embed.js -> ${bundleName} (${exportsList.length} exports)`)
pruneClosure()

/**
 * Restore pi-ai full builtin provider catalog into the deployed closure.
 *
 * The desktop ships every provider the pi-ai catalog describes (DeepSeek,
 * Xiaomi/MiMo, OpenCode, Anthropic, OpenAI, Google, Bedrock, Azure, Mistral,
 * Qwen, Zai, ...) rather than a trimmed subset. The pristine catalog is copied
 * from the pnpm store on every deploy so a previously trimmed closure is
 * repaired; the per-provider removal and heavy-dependency (AWS) scope pruning
 * that used to shrink the installer are intentionally skipped.
 */
function trimPiAiProviders() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const dist = join(modulesRoot, '@earendil-works', 'pi-ai', 'dist')
  if (!existsSync(dist)) return
  const srcProviders = join(findInStore('@earendil-works/pi-ai'), 'dist', 'providers')
  if (existsSync(srcProviders)) {
    rmSync(join(dist, 'providers'), { recursive: true, force: true })
    copyDir(srcProviders, join(dist, 'providers'))
  }
  const srcModels = join(findInStore('@earendil-works/pi-ai'), 'dist', 'models.generated.js')
  if (existsSync(srcModels)) {
    rmSync(join(dist, 'models.generated.js'), { force: true })
    copyFileSync(srcModels, join(dist, 'models.generated.js'))
  }
  const srcApi = join(findInStore('@earendil-works/pi-ai'), 'dist', 'api')
  if (existsSync(srcApi)) {
    rmSync(join(dist, 'api'), { recursive: true, force: true })
    copyDir(srcApi, join(dist, 'api'))
  }
  console.log('deploy-runtime: pi-ai provider catalog kept in full (all providers)')
}

/** MiMo model ids the api.xiaomimimo.com endpoint actually accepts (verified by real calls, 2026-08-14). */
const XIAOMI_SUPPORTED_MODELS = new Set(['mimo-v2.5', 'mimo-v2.5-pro'])

/**
 * Narrow pi-ai's Xiaomi/MiMo model catalog to the ids the MiMo API actually
 * accepts. The shipped catalog lists mimo-v2-flash/omni/pro and
 * mimo-v2.5-pro-ultraspeed, which `https://api.xiaomimimo.com/v1` rejects with
 * 400 "Unsupported model"; mimo-v2.5 and mimo-v2.5-pro return real responses.
 */
function fixXiaomiModels() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const dataPath = join(modulesRoot, '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'xiaomi.json')
  if (!existsSync(dataPath)) return
  const data = JSON.parse(readFileSync(dataPath, 'utf8'))
  const completions = data['openai-completions']
  if (completions === undefined) return
  let removed = 0
  for (const id of Object.keys(completions)) {
    if (!XIAOMI_SUPPORTED_MODELS.has(id)) {
      delete completions[id]
      removed += 1
    }
  }
  writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n')
  console.log(`deploy-runtime: xiaomi catalog narrowed to supported MiMo models (${removed} removed)`)
}

fixXiaomiModels()

/** Debug/build artifacts skipped when syncing workspace libs into the closure. */
const SKIP_DEBUG_ARTIFACT = /\.(map|d\.ts|d\.mts|d\.cts|ts|tsbuildinfo|pdb)$/i

/** Locate one package's real directory inside the pnpm store. */
function findInStore(name) {
  const pnpmStore = resolve(APP_ROOT, '..', '..', 'node_modules', '.pnpm')
  const key = name.startsWith('@') ? name.replace('/', '+') : name
  for (const dir of readdirSync(pnpmStore)) {
    if (!dir.startsWith(key)) continue
    const candidate = join(pnpmStore, dir, 'node_modules', name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Recursively copy a directory, skipping debug/build artifacts. */
function copyDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const file of readdirSync(srcDir)) {
    const srcFile = join(srcDir, file)
    if (statSync(srcFile).isDirectory()) {
      copyDir(srcFile, join(destDir, file))
    } else if (!SKIP_DEBUG_ARTIFACT.test(file)) {
      copyFileSync(srcFile, join(destDir, file))
    }
  }
}

/**
 * Sync every workspace package's built lib/ into the deployed closure so a
 * "pnpm run build:lib:client" (or host) refresh reaches the packaged runtime
 * without a full redeploy. Only packages the closure already contains are
 * touched; debug artifacts stay out to preserve the prune.
 */
function syncWorkspaceLibs() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const packagesRoot = resolve(APP_ROOT, '..', '..', 'packages')
  if (!existsSync(packagesRoot)) return
  let copied = 0
  let skipped = 0
  for (const group of readdirSync(packagesRoot)) {
    const groupDir = join(packagesRoot, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, name)
      if (!statSync(pkgDir).isDirectory()) continue
      // Package names do not follow the directory names (client dirs are
      // ui-* but ship as dsh-client-ui-*), so read the real manifest name.
      const manifestPath = join(pkgDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifestName = JSON.parse(readFileSync(manifestPath, 'utf8')).name
      if (typeof manifestName !== 'string' || !manifestName.startsWith('@deepseek-ai/')) continue
      const srcLib = join(pkgDir, 'lib')
      if (!existsSync(srcLib)) continue
      const destLib = join(modulesRoot, '@deepseek-ai', manifestName.slice('@deepseek-ai/'.length), 'lib')
      if (!existsSync(destLib)) continue
      const walk = (cur) => {
        for (const file of readdirSync(cur)) {
          const src = join(cur, file)
          if (statSync(src).isDirectory()) {
            mkdirSync(join(destLib, relative(srcLib, src)), { recursive: true })
            walk(src)
          } else if (SKIP_DEBUG_ARTIFACT.test(file)) {
            skipped += 1
          } else {
            copyFileSync(src, join(destLib, relative(srcLib, src)))
            copied += 1
          }
        }
      }
      walk(srcLib)
    }
  }
  console.log('deploy-runtime: synced workspace libs (' + copied + ' files, ' + skipped + ' debug artifacts skipped)')
}

syncWorkspaceLibs()

/**
 * Restore the two OpenCode providers' runtime deps into the closure. The trim
 * above keeps their catalog entries and lazy API wrappers, whose non-lazy
 * backends import @anthropic-ai/sdk and @google/genai — both pruned by the
 * earlier size passes and, being optional pi-ai peers, absent from a plain
 * workspace install. Copy them (plus any dependency the closure still lacks)
 * out of the pnpm store into the flat closure.
 */
function restoreOpencodeDeps() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const copied = []
  const visit = (name) => {
    if (existsSync(join(modulesRoot, name))) return
    const src = findInStore(name)
    if (src === undefined) {
      console.error('deploy-runtime: opencode dep not in pnpm store: ' + name)
      return
    }
    copyDir(src, join(modulesRoot, name))
    copied.push(name)
    const manifest = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep)
  }
  // Restore every runtime dependency pi-ai needs for the full provider catalog
  // (Anthropic, Google, Bedrock/AWS, Mistral, OpenAI, ...), not just the OpenCode
  // pair. pnpm deploy may drop optional/peer packages a provider lazily imports;
  // walk pi-ai declared dependencies and copy any missing one from the store.
  const piAiSrc = findInStore("@earendil-works/pi-ai")
  if (piAiSrc !== undefined) {
    const piManifest = JSON.parse(readFileSync(join(piAiSrc, 'package.json'), 'utf8'))
    for (const dep of Object.keys(piManifest.dependencies ?? {})) visit(dep)
  }
  if (copied.length > 0) {
    console.log('deploy-runtime: restored opencode deps (' + copied.join(', ') + ')')
  }
}

restoreOpencodeDeps()

trimPiAiProviders()

/** Replace closure symlinks/junctions with real directories so the packaged
 * payload is self-contained: a junction points at the dev-machine workspace
 * path, which breaks both the NSIS 7z pass on CI ("cannot find the path") and
 * the installed app (the target does not exist there). pnpm's link: overrides
 * (cosmokit, schemastery) are the usual offenders. */
function materializeClosureLinks() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const scoped = join(modulesRoot, '@deepseek-ai')
  if (!existsSync(scoped)) return
  let materialized = 0
  for (const name of readdirSync(scoped)) {
    const entry = join(scoped, name)
    let stat
    try {
      stat = lstatSync(entry)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink()) continue
    const target = realpathSync(entry)
    rmSync(entry, { recursive: true, force: true })
    copyDir(target, entry)
    materialized += 1
    console.log(`deploy-runtime: materialized link @deepseek-ai/${name} <- ${target}`)
  }
  if (materialized > 0) {
    console.log(`deploy-runtime: materialized ${materialized} closure link(s)`)
  }
}

materializeClosureLinks()
