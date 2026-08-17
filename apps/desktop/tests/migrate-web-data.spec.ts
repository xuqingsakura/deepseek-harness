/* oxlint-disable typescript/no-unsafe-assignment */
/* oxlint-disable typescript/no-unsafe-call */
/* oxlint-disable typescript/no-unsafe-member-access */
/* oxlint-disable typescript/no-unsafe-argument */
/* oxlint-disable typescript/no-unsafe-return */
/**
 * Web→desktop migration safety contract: never overwrites target-owned data,
 * merges JSON storage records key-by-key, and skips sensitive files unless
 * explicitly opted in. Exercises the pure migration module with temp homes.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateWebData } from '../src/migrate-web-data.ts'

const scratch: string[] = []
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-migrate-spec-'))
  scratch.push(root)
  return root
}

function makeSource(home: string): void {
  mkdirSync(join(home, 'sessions', 'projA', 'session-1'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'projA', 'session-1', 'session.jsonl.zstd'), 'S1')
  mkdirSync(join(home, 'sessions', 'projA', 'session-2'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'projA', 'session-2', 'session.jsonl.zstd'), 'S2')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ web: { a: 1 }, shared: { w: 2 } }))
  writeFileSync(join(home, 'settings.yaml'), 'persona: web-user\n')
  writeFileSync(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: xyz\n')
  writeFileSync(join(home, '.anonymous-user-id'), 'anon-web-123')
}

function makeTarget(home: string): void {
  mkdirSync(join(home, 'sessions', 'projA', 'session-1'), { recursive: true })
  writeFileSync(join(home, 'sessions', 'projA', 'session-1', 'session.jsonl.zstd'), 'T1')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ desktop: { b: 2 }, shared: { d: 3 } }))
}

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('migrateWebData', () => {
  it('copies missing sessions, skips existing ones, and never touches target-owned files', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)
    makeTarget(target)

    const report = await migrateWebData({ source, target })

    expect(report.errors).toEqual([])
    expect(report.sessionsCopied).toBe(1)
    expect(report.sessionsSkipped).toBe(1)
    expect(readFileSync(join(target, 'sessions', 'projA', 'session-1', 'session.jsonl.zstd'), 'utf8')).toBe('T1')
    expect(readFileSync(join(target, 'sessions', 'projA', 'session-2', 'session.jsonl.zstd'), 'utf8')).toBe('S2')
  })

  it('merges storage JSON with target keys winning', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)
    makeTarget(target)

    await migrateWebData({ source, target })

    const workspace = JSON.parse(readFileSync(join(target, 'storages', 'workspace.json'), 'utf8'))
    expect(workspace.desktop.b).toBe(2)
    expect(workspace.shared.d).toBe(3)
    expect(workspace.web.a).toBe(1)
  })

  it('skips settings and credentials unless flagged, and only when absent', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)

    const plain = await migrateWebData({ source, target })
    expect(plain.steps.filter(step => step.kind === 'settings')[0]?.action).toBe('skip-flag')
    expect(plain.steps.filter(step => step.kind === 'credentials')[0]?.action).toBe('skip-flag')
    expect(existsSync(join(target, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(target, '.credentials.yaml'))).toBe(false)

    const flagged = await migrateWebData({ source, target, includeSettings: true, includeCredentials: true })
    expect(flagged.steps.filter(step => step.kind === 'settings' && step.action === 'copy')).toHaveLength(1)
    expect(flagged.steps.filter(step => step.kind === 'credentials' && step.action === 'copy')).toHaveLength(1)
    expect(readFileSync(join(target, 'settings.yaml'), 'utf8')).toBe('persona: web-user\n')
    expect(readFileSync(join(target, '.credentials.yaml'), 'utf8')).toBe('DEEPSEEK_API_KEY: xyz\n')

    const second = await migrateWebData({ source, target, includeSettings: true, includeCredentials: true })
    expect(second.steps.filter(step => step.kind === 'settings' && step.action === 'copy')).toHaveLength(0)
  })

  it('copies the anonymous id only when the target has none', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)
    writeFileSync(join(target, '.anonymous-user-id'), 'existing')

    await migrateWebData({ source, target })
    expect(readFileSync(join(target, '.anonymous-user-id'), 'utf8')).toBe('existing')

    const emptyTarget = tempHome()
    await migrateWebData({ source, target: emptyTarget })
    expect(readFileSync(join(emptyTarget, '.anonymous-user-id'), 'utf8')).toBe('anon-web-123')
  })

  it('force replaces an existing session directory', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)
    makeTarget(target)

    const report = await migrateWebData({ source, target, force: true })
    expect(report.sessionsCopied).toBe(2)
    expect(report.sessionsSkipped).toBe(0)
    expect(readFileSync(join(target, 'sessions', 'projA', 'session-1', 'session.jsonl.zstd'), 'utf8')).toBe('S1')
  })

  it('dry-run reports the plan without writing', async () => {
    const source = tempHome()
    const target = tempHome()
    makeSource(source)

    const report = await migrateWebData({ source, target, dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.sessionsCopied).toBe(2)
    expect(existsSync(join(target, 'sessions', 'projA', 'session-2', 'session.jsonl.zstd'))).toBe(false)
    expect(existsSync(join(target, 'storages'))).toBe(false)
  })

  it('reports a missing source home without throwing', async () => {
    const report = await migrateWebData({ source: join(tempHome(), 'nope'), target: tempHome() })
    expect(report.errors.length).toBeGreaterThan(0)
    expect(report.sessionsCopied).toBe(0)
  })
})
