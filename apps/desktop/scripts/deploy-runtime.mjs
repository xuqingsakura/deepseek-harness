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

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_LIB = resolve(APP_ROOT, '..', 'cli', 'lib')
const RUNTIME_DSH_LIB = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules', '@deepseek-ai', 'dsh', 'lib')

if (!existsSync(CLI_LIB)) {
  console.error(`deploy-runtime: built CLI lib not found at ${CLI_LIB}; run \`pnpm run build:lib:host\` first`)
  process.exit(1)
}
if (!existsSync(RUNTIME_DSH_LIB)) {
  console.error(`deploy-runtime: runtime closure not found at ${RUNTIME_DSH_LIB}; deploy the host closure first`)
  process.exit(1)
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
 *   dev TS runner (`tsx`/`esbuild`/`@esbuild`), and dropped-provider deps
 *   (`@google`, `@agentclientprotocol`) have no runtime importers.
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
  removeDir(join(modulesRoot, '@anthropic-ai'))
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
  removeDir(join(modulesRoot, '@google'))
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
  console.log(`deploy-runtime: closure pruned (${removedFiles} entries removed)`)
}

console.log(`deploy-runtime: refreshed ${RUNTIME_DSH_LIB}`)
console.log(`deploy-runtime: embed.js -> ${bundleName} (${exportsList.length} exports)`)
pruneClosure()

/** Provider slugs the desktop keeps in pi-ai's builtin catalog (DeepSeek + Xiaomi/MiMo family + shared image provider). */
const PI_AI_KEEP_PROVIDERS = new Set([
  'deepseek', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp', 'openrouter-images', 'faux',
])
/** Non-lazy pi-ai API implementations for dropped providers; their .lazy wrappers stay (dsh-llm-pi-ai imports them). */
const PI_AI_DROPPED_API_IMPLS = new Set([
  'anthropic-messages.js', 'azure-openai-responses.js', 'bedrock-converse-stream.js',
  'google-generative-ai.js', 'google-vertex.js', 'mistral-conversations.js',
  'openai-codex-responses.js',
])

/**
 * Trim pi-ai's builtin provider catalog to DeepSeek + the Xiaomi (MiMo) family.
 * The web profile only mounts `llm-deepseek` and `llm-pi-ai`, yet pi-ai's
 * `providers/all.js` catalog (loaded eagerly by dsh-llm-pi-ai) statically
 * imports ~33 vendor entries. Keep the deepseek/xiaomi entries and drop the
 * rest: per-provider files, model data, the non-lazy API implementations of
 * dropped providers, and their unique dependency scopes (@aws-sdk for Bedrock).
 * The `openai` npm package stays: the kept Xiaomi provider talks through the
 * OpenAI-compatible completions API, which imports it.
 */
function trimPiAiProviders() {
  const modulesRoot = resolve(APP_ROOT, 'out', 'runtime', 'host-deploy', 'node_modules')
  const dist = join(modulesRoot, '@earendil-works', 'pi-ai', 'dist')
  if (!existsSync(dist)) return
  let removed = 0
  const removeFile = (file) => {
    if (!existsSync(file)) return
    rmSync(file, { force: true })
    removed += 1
  }
  const rewrite = (relative, dropLine) => {
    const path = join(dist, relative)
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    const kept = lines.filter((line) => !dropLine(line))
    writeFileSync(path, kept.join('\n'))
    removed += lines.length - kept.length
  }
  const droppedImports = new Set()
  const keptAllExports = new Set(['deepseekProvider', 'xiaomiProvider', 'xiaomiTokenPlanAmsProvider',
    'xiaomiTokenPlanCnProvider', 'xiaomiTokenPlanSgpProvider', 'openrouterImagesProvider',
    'getBuiltinModel', 'getBuiltinProviders', 'getBuiltinModelDataGeneratedAt', 'getBuiltinModels',
    'builtinProviders', 'builtinModels', 'builtinImagesProviders', 'builtinImagesModels'])
  rewrite(join('providers', 'all.js'), (line) => {
    const imp = /^import \{ (\w+) \} from "\.\/([a-z0-9-]+)\.js";$/.exec(line)
    if (imp !== null && !PI_AI_KEEP_PROVIDERS.has(imp[2])) {
      droppedImports.add(imp[1])
      return true
    }
    const entry = /^(\w+)\(\),$/.exec(line.trim())
    if (entry !== null && droppedImports.has(entry[1])) return true
    const exp = /^export \{ (\w+) \};$/.exec(line)
    if (exp !== null && !keptAllExports.has(exp[1])) return true
  })
  rewrite(join('models.generated.js'), (line) => {
    const imp = /^import \{ \w+ \} from "\.\/providers\/([a-z0-9-]+)\.models\.js";$/.exec(line)
    if (imp !== null && !PI_AI_KEEP_PROVIDERS.has(imp[1])) return true
    const entry = /^\s*"([a-z0-9-]+)":/.exec(line)
    return entry !== null && !PI_AI_KEEP_PROVIDERS.has(entry[1])
  })
  const providersDir = join(dist, 'providers')
  for (const file of readdirSync(providersDir)) {
    if (!file.endsWith('.js') || file === 'all.js') continue
    const slug = file.replace(/\.models\.js$/, '').replace(/\.js$/, '')
    if (PI_AI_KEEP_PROVIDERS.has(slug)) continue
    removeFile(join(providersDir, file))
  }
  const dataDir = join(providersDir, 'data')
  for (const file of readdirSync(dataDir)) {
    if (file === '.manifest.json') continue
    const slug = file.replace(/\.json$/, '')
    if (PI_AI_KEEP_PROVIDERS.has(slug)) continue
    removeFile(join(dataDir, file))
  }
  for (const file of PI_AI_DROPPED_API_IMPLS) {
    removeFile(join(dist, 'api', file))
  }
  for (const scope of ['@aws-sdk', '@smithy', '@aws-crypto']) {
    const dir = join(modulesRoot, scope)
    if (!existsSync(dir)) continue
    removed += readdirSync(dir, { recursive: true }).length
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`deploy-runtime: pi-ai trimmed to DeepSeek + Xiaomi/MiMo (${removed} entries removed)`)
}

trimPiAiProviders()

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
