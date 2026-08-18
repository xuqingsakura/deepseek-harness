/**
 * One-command Windows packaging for the desktop shell. Builds the client
 * libraries, refreshes the deployed runtime closure (dsh lib + every
 * workspace package's lib + prune + pi-ai trim), compiles the shell, runs
 * electron-builder, and lands the Setup.exe in dist-installer/.
 *
 * Requires "pnpm run build:lib:host" to have run at least once (deploy-runtime
 * copies apps/cli/lib into the closure); re-run it whenever host packages
 * change. Client-only changes need no extra step.
 * @module @deepseek-ai/dsh-desktop/package
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const CLI_LIB = resolve(REPO_ROOT, 'apps', 'cli', 'lib')
const DIST_INSTALLER = join(APP_ROOT, 'dist-installer')
const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))

/** Run one step with inherited stdio; exit with its status on failure. */
function run(label, command, args, cwd, env = {}) {
  console.log('')
  console.log('=== ' + label + ' ===')
  // pnpm/npx are .cmd shims on Windows; running them needs a shell. The args
  // are hard-coded literals in this script, so no injection surface exists.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    console.error('package: step failed (exit ' + String(result.status) + '): ' + label)
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(CLI_LIB)) {
  console.error("package: apps/cli/lib not found — run 'pnpm run build:lib:host' once first")
  process.exit(1)
}

/** Ensure the vendored pnpm executable (runtime/pnpm/pnpm.exe) exists; a clean
 * tree (CI) has none and electron-builder ships it as resources/pnpm for the
 * plugin installer. The official standalone zip is downloaded (version from the
 * root packageManager field) and its pnpm.exe extracted. */
function ensureVendoredPnpm() {
  const exe = join(APP_ROOT, 'runtime', 'pnpm', 'pnpm.exe')
  if (existsSync(exe)) return
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const match = /^pnpm@(.+)$/.exec(rootManifest.packageManager ?? '')
  if (match === null) {
    throw new Error('package: cannot derive pnpm version from packageManager in package.json')
  }
  const version = match[1]
  const zipUrl = `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-win32-x64.zip`
  const tmpDir = join(process.env.TEMP ?? APP_ROOT, 'dsh-vendored-pnpm')
  const tmpZip = join(tmpDir, 'pnpm-win32-x64.zip')
  const extractDir = join(tmpDir, 'extract')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  console.log(`package: downloading vendored pnpm v${version} (${zipUrl})`)
  // curl follows the GitHub release redirect; tar (bsdtar) extracts the zip.
  run('download pnpm standalone', 'curl.exe', ['-L', '--fail', '-o', tmpZip, zipUrl], APP_ROOT)
  run('extract pnpm standalone', 'tar', ['-xf', tmpZip, '-C', extractDir], APP_ROOT)
  mkdirSync(dirname(exe), { recursive: true })
  copyFileSync(join(extractDir, 'pnpm.exe'), exe)
  console.log('package: vendored pnpm ready at ' + exe)
}

ensureVendoredPnpm()

// 1. Client bundles feed the web profile the shell boots in-process.
run('build client libs', 'pnpm', ['run', 'build:lib:client'], REPO_ROOT)
// 2. A clean tree (CI) has no deployed closure yet; materialize it with pnpm
// deploy. Local trees already have it and skip this step.
const deployTarget = join(APP_ROOT, 'out', 'runtime', 'host-deploy')
const runtimeDshLib = join(deployTarget, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
if (!existsSync(runtimeDshLib)) {
  // pnpm deploy refuses a non-empty target, so clear a stale closure first
  // (a fresh pnpm deploy also skips the @deepseek-ai/dsh bin package; the
  // deploy-runtime step stages it). CI=true skips any non-TTY purge prompt.
  if (existsSync(deployTarget)) rmSync(deployTarget, { recursive: true, force: true })
  const previousCi = process.env.CI
  process.env.CI = 'true'
  run('deploy host closure', 'pnpm', [
    '--filter', '@deepseek-ai/dsh-desktop-host-pkg',
    'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    // Peers must auto-install: pnpm deploy otherwise drops workspace
    // packages that declare only peerDependencies (dsh-shell, dsh-bash-local,
    // dsh-subagent-in-process-driver, the hooks/sdk seam packages), and the
    // web profile imports several of them at loader-entry time.
    '--config.link-workspace-packages=true',
    '--config.confirm-modules-purge=false',
    deployTarget,
  ], REPO_ROOT)
  if (previousCi === undefined) delete process.env.CI
  else process.env.CI = previousCi
}
// 3. Refresh the packaged runtime closure with all freshly built workspace libs.
run('deploy runtime closure', 'node', ['apps/desktop/scripts/deploy-runtime.mjs'], REPO_ROOT)
// 4. Compile the Electron shell (main + preload).
run('build desktop shell', 'pnpm', ['run', 'build'], APP_ROOT)
// 5. Package the NSIS installer. CI overrides the machine-specific output
// directory from electron-builder.yml via DSH_PKG_OUTPUT_DIR.
const pkgArgs = ['electron-builder', '--win', 'nsis', '--publish', 'never']
const pkgOutputOverride = process.env.DSH_PKG_OUTPUT_DIR?.trim()
if (pkgOutputOverride !== undefined && pkgOutputOverride !== '') {
  pkgArgs.push('-c.directories.output=' + pkgOutputOverride)
}
run('package NSIS installer', 'npx', pkgArgs, APP_ROOT)

// 6. Land the installer next to its siblings.
const builderYml = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf8')
const outputMatch = /^\s*output:\s*(.+)$/m.exec(builderYml)
const outputDir = pkgOutputOverride !== undefined && pkgOutputOverride !== ''
  ? pkgOutputOverride
  : (outputMatch === null ? join(APP_ROOT, 'dist') : outputMatch[1].trim())
const productName = manifest.productName ?? 'DeepSeek Harness'
const setupName = productName + ' Setup ' + manifest.version + '.exe'
const source = join(outputDir, setupName)
if (!existsSync(source)) {
  console.error('package: installer not found at ' + source)
  process.exit(1)
}
mkdirSync(DIST_INSTALLER, { recursive: true })
const target = join(DIST_INSTALLER, setupName)
copyFileSync(source, target)
console.log('')
console.log('installer: ' + target)
