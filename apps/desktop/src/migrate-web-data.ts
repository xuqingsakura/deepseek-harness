/**
 * Migrate Web-version harness data (~/.dsh) into the desktop harness home.
 *
 * A standalone, dependency-free migration: copies conversation sessions and
 * merges storage records from a Web harness home into a target home without
 * ever overwriting data the target already owns. The desktop shell calls
 * {@link migrateWebData} over IPC; the thin CLI wrapper in
 * 'scripts/migrate-web-data.mjs' exposes the same function on the command line.
 *
 * Migration semantics (safe by default):
 *  - sessions: only session directories absent from the target are copied;
 *    an existing session id is skipped unless {@link MigrateOptions.force} replaces it.
 *  - storages/*.json: merged key-by-key; keys the target already has win.
 *  - settings.yaml / .credentials.yaml: NOT migrated unless the matching
 *    flag is passed, and even then only when the target file is absent.
 *  - .anonymous-user-id: copied only when the target has none.
 * @module @deepseek-ai/dsh-desktop/migrate-web-data
 */

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

/** One planned or performed file action. */
export interface MigrationStep {
  kind: 'session' | 'storage' | 'settings' | 'credentials' | 'anonymous-id'
  source: string
  target: string
  action: 'copy' | 'merge' | 'skip-existing' | 'skip-flag' | 'dry-run'
}

/** Full migration report. */
export interface MigrationReport {
  source: string
  target: string
  dryRun: boolean
  steps: MigrationStep[]
  sessionsCopied: number
  sessionsSkipped: number
  storagesMerged: number
  errors: string[]
}

/** Options controlling what the migration may do. */
export interface MigrateOptions {
  source?: string
  target?: string
  dryRun?: boolean
  includeSettings?: boolean
  includeCredentials?: boolean
  force?: boolean
}

/** Resolve the default Web home the same way the Web CLI does. */
function defaultWebHome(): string {
  return process.env.DSH_WEB_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the default target home; \$DSH_HOME wins when set. */
function defaultTargetHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** True when a directory exists and is readable. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Recursively list every session directory: <root>/<project>/<session>. */
async function listSessionDirs(root: string): Promise<string[]> {
  const out: string[] = []
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    const sessions = await readdir(projectPath, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      out.push(join(projectPath, session.name))
    }
  }
  return out
}

/** Deep-merge one JSON record: target keys always win, source adds missing keys. */
function mergeJson(target: unknown, source: unknown): unknown {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return target
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return target
  const out: Record<string, unknown> = { ...(source as Record<string, unknown>) }
  for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
    out[key] = mergeJson(value, out[key])
  }
  return out
}

/** Merge a JSON storage file from source into target (target keys win). */
async function mergeStorageFile(source: string, target: string): Promise<boolean> {
  const [rawSource, rawTarget] = await Promise.all([readFile(source, 'utf8'), readFile(target, 'utf8')])
  const parsedSource = JSON.parse(rawSource) as unknown
  const parsedTarget = JSON.parse(rawTarget) as unknown
  const merged = mergeJson(parsedTarget, parsedSource)
  await writeFile(target, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return true
}

/**
 * Build the migration plan; performs it unless dryRun.
 * @param options - source/target resolution and flag overrides.
 * @returns the report (steps carry the outcome).
 */
export async function migrateWebData(options: MigrateOptions = {}): Promise<MigrationReport> {
  const source = resolve(options.source ?? defaultWebHome())
  const target = resolve(options.target ?? defaultTargetHome())
  const dryRun = options.dryRun ?? false
  const force = options.force ?? false
  const report: MigrationReport = {
    source,
    target,
    dryRun,
    steps: [],
    sessionsCopied: 0,
    sessionsSkipped: 0,
    storagesMerged: 0,
    errors: [],
  }

  if (!(await isDirectory(source))) {
    report.errors.push(`source home not found: ${source}`)
    return report
  }
  await mkdir(target, { recursive: true })

  // 1) Conversation sessions: copy only what the target does not already own.
  const sourceSessionsRoot = join(source, 'sessions')
  const targetSessionsRoot = join(target, 'sessions')
  if (await isDirectory(sourceSessionsRoot)) {
    for (const sessionDirPath of await listSessionDirs(sourceSessionsRoot)) {
      const rel = relative(sourceSessionsRoot, sessionDirPath)
      const targetSession = join(targetSessionsRoot, rel)
      const existing = await isDirectory(targetSession)
      if (existing && !force) {
        report.steps.push({
          kind: 'session', source: sessionDirPath, target: targetSession,
          action: 'skip-existing',
        })
        report.sessionsSkipped += 1
        continue
      }
      report.steps.push({
        kind: 'session', source: sessionDirPath, target: targetSession,
        action: dryRun ? 'dry-run' : 'copy',
      })
      if (!dryRun) {
        await mkdir(dirname(targetSession), { recursive: true })
        await cp(sessionDirPath, targetSession, { recursive: true, force: true })
      }
      report.sessionsCopied += 1
    }
  }

  // 2) Storage records: key-wise JSON merge; the target's own keys win.
  const sourceStorages = join(source, 'storages')
  const targetStorages = join(target, 'storages')
  if (await isDirectory(sourceStorages)) {
    for (const entry of await readdir(sourceStorages)) {
      if (!entry.endsWith('.json')) continue
      const sourceFile = join(sourceStorages, entry)
      const targetFile = join(targetStorages, entry)
      report.steps.push({
        kind: 'storage', source: sourceFile, target: targetFile,
        action: dryRun ? 'dry-run' : 'merge',
      })
      if (!dryRun) {
        await mkdir(targetStorages, { recursive: true })
        if (existsSync(targetFile)) {
          try {
            await mergeStorageFile(sourceFile, targetFile)
            report.storagesMerged += 1
          } catch (error) {
            report.errors.push(`storage merge failed ${entry}: ${String(error)}`)
          }
        } else {
          await cp(sourceFile, targetFile)
          report.storagesMerged += 1
        }
      }
    }
  }

  // 3) settings.yaml: only with an explicit flag and only when absent.
  const settingsSource = join(source, 'settings.yaml')
  const settingsTarget = join(target, 'settings.yaml')
  if (existsSync(settingsSource)) {
    const copySettings = (options.includeSettings ?? false) && !existsSync(settingsTarget)
    report.steps.push({
      kind: 'settings', source: settingsSource, target: settingsTarget,
      action: !(options.includeSettings ?? false)
        ? 'skip-flag'
        : existsSync(settingsTarget)
          ? 'skip-existing'
          : dryRun ? 'dry-run' : 'copy',
    })
    if (copySettings && !dryRun) {
      await mkdir(dirname(settingsTarget), { recursive: true })
      await cp(settingsSource, settingsTarget)
    }
  }

  // 4) credentials: only with an explicit flag and only when absent.
  const credentialsSource = join(source, '.credentials.yaml')
  const credentialsTarget = join(target, '.credentials.yaml')
  if (existsSync(credentialsSource)) {
    const copyCredentials = (options.includeCredentials ?? false) && !existsSync(credentialsTarget)
    report.steps.push({
      kind: 'credentials', source: credentialsSource, target: credentialsTarget,
      action: !(options.includeCredentials ?? false)
        ? 'skip-flag'
        : existsSync(credentialsTarget)
          ? 'skip-existing'
          : dryRun ? 'dry-run' : 'copy',
    })
    if (copyCredentials && !dryRun) {
      await mkdir(dirname(credentialsTarget), { recursive: true })
      await cp(credentialsSource, credentialsTarget)
    }
  }

  // 5) anonymous identity: copy only when the target has none.
  const idSource = join(source, '.anonymous-user-id')
  const idTarget = join(target, '.anonymous-user-id')
  if (existsSync(idSource) && !existsSync(idTarget)) {
    report.steps.push({
      kind: 'anonymous-id', source: idSource, target: idTarget,
      action: dryRun ? 'dry-run' : 'copy',
    })
    if (!dryRun) {
      await mkdir(dirname(idTarget), { recursive: true })
      await cp(idSource, idTarget)
    }
  }

  return report
}

/**
 * Human-readable one-line-per-step rendering of a report.
 * @param report - the migration report to render.
 * @returns the report text.
 */
export function renderReport(report: MigrationReport): string {
  const lines = [
    `source: ${report.source}`,
    `target: ${report.target}`,
    `mode: ${report.dryRun ? 'dry-run (no changes)' : 'apply'}`,
    '',
    `sessions copied: ${report.sessionsCopied}`,
    `sessions skipped (already exist): ${report.sessionsSkipped}`,
    `storage records merged: ${report.storagesMerged}`,
    '',
  ]
  for (const step of report.steps) {
    lines.push(`  [${step.kind}] ${step.action}: ${relative(report.source, step.source)} -> ${relative(report.target, step.target)}`)
  }
  if (report.errors.length > 0) {
    lines.push('', 'errors:')
    for (const error of report.errors) lines.push(`  ! ${error}`)
  }
  return lines.join('\n')
}
