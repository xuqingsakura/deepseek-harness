/**
 * Preload to CJS bundle（P1-C 沙箱加固）。
 *
 * Electron 沙箱化渲染器（webPreferences.sandbox: true）只支持**单个 CJS** preload，
 * 不能是 ESM、也不能有运行时相对 import。本脚本用仓库内置的 esbuild 把 src/preload.ts
 * 连同 preload-icons.ts 打进 lib/preload.cjs；electron 保持 external（沙箱 preload 用
 * require('electron') 取 contextBridge/ipcRenderer）。
 * @module @deepseek-ai/dsh-desktop/bundle-preload
 */
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const store = join(REPO_ROOT, 'node_modules', '.pnpm')
const dirs = readdirSync(store).filter((d) => /^esbuild@/.test(d)).sort()
if (dirs.length === 0) throw new Error('bundle-preload: esbuild not found in pnpm store')
const esbuildMain = join(store, dirs[dirs.length - 1], 'node_modules', 'esbuild', 'lib', 'main.js')
const require = createRequire(import.meta.url)
const esbuild = require(esbuildMain)

await esbuild.build({
  entryPoints: [join(APP_ROOT, 'src', 'preload.ts')],
  outfile: join(APP_ROOT, 'lib', 'preload.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['electron'],
  logLevel: 'info',
  sourcemap: false,
})
console.log('bundle-preload: lib/preload.cjs written')
