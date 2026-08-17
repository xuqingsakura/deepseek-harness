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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const CLI_LIB = resolve(REPO_ROOT, 'apps', 'cli', 'lib')
const DIST_INSTALLER = join(APP_ROOT, 'dist-installer')
const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'))

/** Run one step with inherited stdio; exit with its status on failure. */
function run(label, command, args, cwd) {
  console.log('')
  console.log('=== ' + label + ' ===')
  // pnpm/npx are .cmd shims on Windows; running them needs a shell. The args
  // are hard-coded literals in this script, so no injection surface exists.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error('package: step failed (exit ' + String(result.status) + '): ' + label)
    process.exit(result.status ?? 1)
  }
}

if (!existsSync(CLI_LIB)) {
  console.error("package: apps/cli/lib not found — run 'pnpm run build:lib:host' once first")
  process.exit(1)
}

// 1. Client bundles feed the web profile the shell boots in-process.
run('build client libs', 'pnpm', ['run', 'build:lib:client'], REPO_ROOT)
// 2. Refresh the packaged runtime closure with all freshly built workspace libs.
run('deploy runtime closure', 'node', ['apps/desktop/scripts/deploy-runtime.mjs'], REPO_ROOT)
// 3. Compile the Electron shell (main + preload).
run('build desktop shell', 'pnpm', ['run', 'build'], APP_ROOT)
// 4. Package the NSIS installer.
run('package NSIS installer', 'npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], APP_ROOT)

// 5. Land the installer next to its siblings.
const builderYml = readFileSync(join(APP_ROOT, 'electron-builder.yml'), 'utf8')
const outputMatch = /^\s*output:\s*(.+)$/m.exec(builderYml)
const outputDir = outputMatch === null ? join(APP_ROOT, 'dist') : outputMatch[1].trim()
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
