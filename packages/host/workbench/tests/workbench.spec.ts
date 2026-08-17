/**
 * Tests for the session-scoped workbench Remote gateway: cwd resolution,
 * lazy directory listing, text/binary/oversize reads through the read window,
 * and version-guarded atomic writes over the backing ctx.fs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import WorkbenchGateway, { WorkbenchVersion, type WorkbenchReadResult } from '../src/index.ts'
import { pickShell } from '../src/terminal.ts'

let dir: string
let ctx: Context
let gateway: WorkbenchGateway
let fiber: Awaited<ReturnType<Context['plugin']>>

/** A minimal session store stub: every id reports one header with the test cwd. */
function stubSessions(cwd: string): SessionStore {
  const sessions = {
    get(id: SessionId) {
      return id === undefined ? undefined : { header: { cwd } }
    },
  }
  return sessions as unknown as SessionStore
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-workbench-'))
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  ctx.provide('sessions', stubSessions(dir))
  await ctx.plugin(WorkbenchGateway)
  gateway = ctx.workbench
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('WorkbenchGateway registration', () => {
  it('publishes the workbench face with the four direct methods', () => {
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'workbench',
      namespace: 'workbench',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'cwd', invocation: { kind: 'direct' } },
      { method: 'listDir', invocation: { kind: 'direct' } },
      { method: 'readText', invocation: { kind: 'direct' } },
      { method: 'writeText', invocation: { kind: 'direct' } },
      { method: 'terminalSpawn', invocation: { kind: 'direct' } },
      { method: 'terminalWrite', invocation: { kind: 'direct' } },
      { method: 'terminalRead', invocation: { kind: 'direct' } },
      { method: 'terminalClose', invocation: { kind: 'direct' } },
      { method: 'terminalCloseSession', invocation: { kind: 'direct' } },
      { method: 'gitStatus', invocation: { kind: 'direct' } },
      { method: 'gitDiff', invocation: { kind: 'direct' } },
      { method: 'gitLog', invocation: { kind: 'direct' } },
      { method: 'gitBranches', invocation: { kind: 'direct' } },
      { method: 'gitAdd', invocation: { kind: 'direct' } },
      { method: 'gitRestore', invocation: { kind: 'direct' } },
      { method: 'gitCommit', invocation: { kind: 'direct' } },
      { method: 'gitCheckout', invocation: { kind: 'direct' } },
      { method: 'gitFetch', invocation: { kind: 'direct' } },
      { method: 'gitPull', invocation: { kind: 'direct' } },
      { method: 'gitPush', invocation: { kind: 'direct' } },
      { method: 'fsMkdir', invocation: { kind: 'direct' } },
      { method: 'fsRename', invocation: { kind: 'direct' } },
      { method: 'fsRemove', invocation: { kind: 'direct' } },
    ])
  })
})

describe('cwd', () => {
  it('returns the session header cwd', async () => {
    expect(gateway.cwd('session-1')).toEqual({ path: dir })
  })
})

describe('listDir', () => {
  it('lists one level of children without recursion', async () => {
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'src', 'b.txt'), 'b')

    const entries = await gateway.listDir('session-1', '')
    expect(entries.map(entry => entry.name).sort()).toEqual(['a.txt', 'src'])
    const src = entries.find(entry => entry.name === 'src')
    expect(src?.type).toBe('directory')
    const file = entries.find(entry => entry.name === 'a.txt')
    expect(file?.type).toBe('file')
    expect(file?.size).toBe(1)
  })

  it('resolves relative paths against the session cwd', async () => {
    await writeFile(join(dir, 'deep', '..', 'nested.txt'), 'x').catch(async () => {
      await mkdir(join(dir, 'deep'))
      await writeFile(join(dir, 'nested.txt'), 'x')
    })
    const entries = await gateway.listDir('session-1', '.')
    expect(entries.some(entry => entry.name === 'nested.txt')).toBe(true)
  })
})

describe('readText', () => {
  it('reads text files with a freshness token', async () => {
    await writeFile(join(dir, 'hello.txt'), 'hello workbench', 'utf8')
    const result = await gateway.readText('session-1', 'hello.txt')
    expect(result.content).toBe('hello workbench')
    expect(result.binary).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.size).toBe('hello workbench'.length)
    expect(typeof result.version).toBe('string')
  })

  it('flags binary files and returns no content', async () => {
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const result = await gateway.readText('session-1', 'blob.bin')
    expect(result.binary).toBe(true)
    expect(result.content).toBe('')
  })

  it('truncates files above the read window', async () => {
    const big = 'x'.repeat(1024 * 1024 + 64)
    await writeFile(join(dir, 'big.txt'), big, 'utf8')
    const result = await gateway.readText('session-1', 'big.txt')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThan(big.length)
    expect(result.size).toBe(big.length)
  })

  it('fails loud for missing paths', async () => {
    await expect(gateway.readText('session-1', 'nope.txt')).rejects.toThrow(/no such file/)
  })
})

describe('writeText', () => {
  it('writes unconditionally when no version is supplied', async () => {
    const outcome = await gateway.writeText('session-1', 'new.txt', 'first')
    expect(outcome.version).toBeTruthy()
    await expect(gateway.readText('session-1', 'new.txt')).resolves.toMatchObject({ content: 'first' })
  })

  it('guards stale writes against a prior version', async () => {
    await writeFile(join(dir, 'v.txt'), 'v1', 'utf8')
    const read: WorkbenchReadResult = await gateway.readText('session-1', 'v.txt')
    await writeFile(join(dir, 'v.txt'), 'external edit', 'utf8')
    await expect(
      gateway.writeText('session-1', 'v.txt', 'v2', WorkbenchVersion(read.version)),
    ).rejects.toThrow(/changed since it was read/)
  })

  it('accepts a current version and reports the fresh token', async () => {
    await writeFile(join(dir, 'v.txt'), 'v1', 'utf8')
    const read: WorkbenchReadResult = await gateway.readText('session-1', 'v.txt')
    const outcome = await gateway.writeText('session-1', 'v.txt', 'v2', WorkbenchVersion(read.version))
    expect(outcome.version).toBeTruthy()
    await expect(gateway.readText('session-1', 'v.txt')).resolves.toMatchObject({ content: 'v2' })
  })
})

/** Echo command that works in both PowerShell and POSIX shells. */
const ECHO_MARKER = 'dsh-term-marker'
const ECHO_COMMAND = `echo ${ECHO_MARKER}`

/** Poll a terminal read until the marker appears or the deadline passes. */
async function waitForTerminalOutput(
  read: () => Promise<{ delta: string; session: { status: string; exitCode: number | null } }>,
  marker: string,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let accumulated = ''
  while (Date.now() < deadline) {
    const result = await read()
    accumulated += result.delta
    if (accumulated.includes(marker)) return accumulated
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return accumulated
}

describe('terminal', () => {
  it('spawns a shell and reports it running', async () => {
    const spawned = gateway.terminalSpawn('session-1')
    expect(spawned.session.status).toBe('running')
    expect(spawned.session.exitCode).toBeNull()
    expect(spawned.shell.length).toBeGreaterThan(0)
    await gateway.terminalClose('session-1', spawned.session.id)
  })

  it('writes a command and reads its echo', async () => {
    const spawned = gateway.terminalSpawn('session-1')
    gateway.terminalWrite('session-1', spawned.session.id, `${ECHO_COMMAND}\n`)
    const output = await waitForTerminalOutput(
      async () => {
        const result = gateway.terminalRead('session-1', spawned.session.id)
        return { delta: result.delta, session: result.session }
      },
      ECHO_MARKER,
    )
    expect(output).toContain(ECHO_MARKER)
    await gateway.terminalClose('session-1', spawned.session.id)
  })

  it('reports exited sessions after close', async () => {
    const spawned = gateway.terminalSpawn('session-1')
    await gateway.terminalClose('session-1', spawned.session.id)
    expect(() => gateway.terminalRead('session-1', spawned.session.id)).toThrow(/unknown terminal/)
  })

  it('clears every terminal of a session scope', async () => {
    const first = gateway.terminalSpawn('session-1')
    const second = gateway.terminalSpawn('session-1')
    await gateway.terminalCloseSession('session-1')
    expect(() => gateway.terminalRead('session-1', first.session.id)).toThrow(/unknown terminal/)
    expect(() => gateway.terminalRead('session-1', second.session.id)).toThrow(/unknown terminal/)
  })
})

describe('git', () => {
  let savedHome: string | undefined
  let savedProfile: string | undefined

  beforeEach(() => {
    // The sandbox denies git's global excludesFile under the real home; point
    // git at the throwaway repo dir so every command runs clean.
    savedHome = process.env.HOME
    savedProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  })

  /** Run a raw git command in the test dir; used only for test setup. */
  async function rawGit(...args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('git', args, { cwd: dir }, (error) => {
        if (error !== null) reject(new Error(error.message))
        else resolve()
      })
    })
  }

  it('reports a non-repo status', async () => {
    const status = await gateway.gitStatus('session-1')
    expect(status.isRepo).toBe(false)
    expect(status.changes).toEqual([])
  })

  it('lists staged, modified, and untracked changes', async () => {
    await rawGit('init')
    await rawGit('config', 'user.name', 'Test')
    await rawGit('config', 'user.email', 'test@example.com')
    await writeFile(join(dir, 'tracked.txt'), 'one', 'utf8')
    await rawGit('add', 'tracked.txt')
    await rawGit('commit', '-m', 'initial')
    await writeFile(join(dir, 'tracked.txt'), 'two', 'utf8')
    await writeFile(join(dir, 'untracked.txt'), 'new', 'utf8')

    const status = await gateway.gitStatus('session-1')
    expect(status.branch.length).toBeGreaterThan(0)
    expect(status.changes).toContainEqual({ path: 'tracked.txt', staged: false, kind: 'modified' })
    expect(status.changes).toContainEqual({ path: 'untracked.txt', staged: false, kind: 'untracked' })
  })

  it('stages, commits, diffs, and restores', async () => {
    await rawGit('init')
    await rawGit('config', 'user.name', 'Test')
    await rawGit('config', 'user.email', 'test@example.com')
    await writeFile(join(dir, 'a.txt'), 'v1', 'utf8')
    await rawGit('add', 'a.txt')
    await rawGit('commit', '-m', 'first')

    await writeFile(join(dir, 'a.txt'), 'v2', 'utf8')
    const worktreeDiff = await gateway.gitDiff('session-1', 'a.txt', false)
    expect(worktreeDiff.diff).toContain('-v1')
    expect(worktreeDiff.diff).toContain('+v2')

    await gateway.gitAdd('session-1', ['a.txt'])
    let status = await gateway.gitStatus('session-1')
    expect(status.changes).toContainEqual({ path: 'a.txt', staged: true, kind: 'modified' })

    const stagedDiff = await gateway.gitDiff('session-1', 'a.txt', true)
    expect(stagedDiff.diff).toContain('+v2')

    await gateway.gitCommit('session-1', 'second')
    const log = await gateway.gitLog('session-1', 10)
    expect(log.length).toBe(2)
    expect(log[0]?.message).toBe('second')
    // The newest commit carries its parent hash for the graph layout.
    expect(log[0]?.parents).toHaveLength(1)
    expect(log[1]?.hash).toBe(log[0]?.parents[0])
    expect(log[1]?.parents).toEqual([])

    const branches = await gateway.gitBranches('session-1')
    expect(branches.some(branch => branch.current)).toBe(true)

    await writeFile(join(dir, 'a.txt'), 'dirty', 'utf8')
    await gateway.gitRestore('session-1', ['a.txt'], false)
    status = await gateway.gitStatus('session-1')
    expect(status.changes).toHaveLength(0)

    await gateway.gitAdd('session-1', [])
    await gateway.gitRestore('session-1', ['a.txt'], true)
    status = await gateway.gitStatus('session-1')
    expect(status.changes).toHaveLength(0)
  })

  it('fails loud for a missing git binary directory', async () => {
    await expect(gateway.gitCommit('session-1', 'x')).rejects.toThrow(/git commit failed/)
  })
})


describe('filesystem operations', () => {
  it('creates a directory recursively', async () => {
    await gateway.fsMkdir('session-1', 'src/lib')
    const entries = await gateway.listDir('session-1', 'src')
    expect(entries.some(entry => entry.name === 'lib' && entry.type === 'directory')).toBe(true)
  })

  it('renames a file or directory', async () => {
    await writeFile(join(dir, 'old.txt'), 'x', 'utf8')
    await gateway.fsRename('session-1', 'old.txt', 'new.txt')
    const entries = await gateway.listDir('session-1', '')
    expect(entries.some(entry => entry.name === 'new.txt')).toBe(true)
    expect(entries.some(entry => entry.name === 'old.txt')).toBe(false)
  })

  it('removes a file', async () => {
    await writeFile(join(dir, 'gone.txt'), 'x', 'utf8')
    await gateway.fsRemove('session-1', 'gone.txt')
    const entries = await gateway.listDir('session-1', '')
    expect(entries.some(entry => entry.name === 'gone.txt')).toBe(false)
  })

  it('removes a directory recursively', async () => {
    await mkdir(join(dir, 'tree', 'deep'), { recursive: true })
    await writeFile(join(dir, 'tree', 'deep', 'a.txt'), 'x', 'utf8')
    await gateway.fsRemove('session-1', 'tree', true)
    const entries = await gateway.listDir('session-1', '')
    expect(entries.some(entry => entry.name === 'tree')).toBe(false)
  })

  it('refuses non-recursive directory removal and path escapes', async () => {
    await mkdir(join(dir, 'keep'))
    await expect(gateway.fsRemove('session-1', 'keep')).rejects.toThrow(/recursive/)
    await expect(gateway.fsRemove('session-1', '..')).rejects.toThrow(/escapes/)
    await expect(gateway.fsRename('session-1', 'keep', '..')).rejects.toThrow(/escapes/)
  })
})

describe('git network operations', () => {
  /** Init a bare repo with the throwaway home env (same sandbox workaround). */
  async function initRepo(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['init'], { cwd: dir }, (error) => {
        if (error !== null) reject(new Error(error.message))
        else resolve()
      })
    })
  }

  it('fetch without a remote is a silent no-op (git exit 0)', async () => {
    await initRepo()
    await expect(gateway.gitFetch('session-1')).resolves.toBeUndefined()
  })

  it('push fails loud without a remote', async () => {
    await initRepo()
    await expect(gateway.gitPush('session-1')).rejects.toThrow(/git push failed/)
  })
})


describe('pickShell', () => {
  it('skips a candidate missing on PATH and picks the next one', () => {
    const probe = (candidate: { file: string }): boolean => candidate.file !== 'pwsh.exe'
    const picked = pickShell(probe)
    expect(picked.file).toBe(process.platform === 'win32' ? 'powershell.exe' : 'sh')
  })

  it('keeps the first candidate when every probe succeeds', () => {
    const picked = pickShell(() => true)
    expect(picked.file).toBe(process.platform === 'win32' ? 'pwsh.exe' : 'bash')
  })

  it('falls back to the first candidate when no probe succeeds (spawn surfaces the error)', () => {
    const picked = pickShell(() => false)
    expect(picked.file).toBe(process.platform === 'win32' ? 'pwsh.exe' : 'bash')
  })
})
