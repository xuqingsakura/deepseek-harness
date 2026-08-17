#!/usr/bin/env node
/**
 * CLI wrapper for the Web→desktop data migration. Runs the compiled
 * migration module from apps/desktop/lib (tsc output); `pnpm --filter @deepseek-ai/dsh-desktop run build`
 * compiles it first.
 *
 * Usage:
 *   node migrate-web-data.mjs [--source <dir>] [--target <dir>] [--dry-run]
 *       [--include-settings] [--include-credentials] [--force] [--json]
 *
 * Safe by default: never overwrites target-owned sessions or storage keys.
 * @module dsh-desktop/migrate-web-data-cli
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ENTRY = join(APP_ROOT, 'lib', 'migrate-web-data.js')
if (!existsSync(LIB_ENTRY)) {
  process.stderr.write('migrate-web-data: lib not built — run `pnpm --filter @deepseek-ai/dsh-desktop run build` first\n')
  process.exit(2)
}
const { migrateWebData, renderReport } = await import(pathToFileURL(LIB_ENTRY).href)

/** @param {readonly string[]} argv */
function parseArgv(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') options.source = argv[++index]
    else if (arg === '--target') options.target = argv[++index]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--include-settings') options.includeSettings = true
    else if (arg === '--include-credentials') options.includeCredentials = true
    else if (arg === '--force') options.force = true
    else if (arg === '--json') { /* handled below */ }
    else throw new Error('unknown flag: ' + arg)
  }
  return options
}

const wantsJson = process.argv.includes('--json')
const report = await migrateWebData(parseArgv(process.argv.slice(2)))
process.stdout.write(wantsJson ? JSON.stringify(report, null, 2) + '\n' : renderReport(report) + '\n')
process.exit(report.errors.length > 0 ? 1 : 0)
