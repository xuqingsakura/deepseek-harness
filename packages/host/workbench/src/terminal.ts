/**
 * Persistent shell sessions for the workbench terminal UI. Each session is a
 * plain child process over stdio pipes (no PTY), keyed by session scope and a
 * gateway-minted id; output is buffered and consumed incrementally so the UI
 * can poll for deltas. Windows prefers PowerShell 7 (`pwsh`) and falls back
 * to Windows PowerShell (`powershell.exe`); POSIX uses bash and then sh.
 * @module @deepseek-ai/dsh-host-workbench/terminal
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { WorkbenchTerminalReadResult, WorkbenchTerminalSession, WorkbenchTerminalSpawnResult } from './types.ts'

/** One live terminal record inside a session scope. */
interface TerminalRecord {
  /** The shell process. */
  process: ChildProcessWithoutNullStreams
  /** Output produced since the last read. */
  buffer: string
  /** Whether the shell process has exited. */
  exited: boolean
  /** Exit code once exited; null while running. */
  exitCode: number | null
}

/** Ordered shell candidates for the current platform. */
function shellCandidates(): readonly { file: string; args: readonly string[] }[] {
  if (process.platform === 'win32') {
    // PowerShell 7 first (UTF-8 by default), then Windows PowerShell 5.1.
    // Windows PowerShell writes the OEM code page to pipes; start it with
    // -NoExit -Command so the UTF-8 pin runs before the first prompt (no
    // stdin preamble echo) and the shell stays interactive.
    return [
      { file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'] },
      {
        file: 'powershell.exe',
        args: [
          '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-NoExit', '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        ],
      },
    ]
  }
  return [
    { file: 'bash', args: ['--noprofile', '--norc', '-i'] },
    { file: 'sh', args: [] },
  ]
}

/** Probe arguments that make a shell exit immediately (used for PATH probes). */
function probeArgs(): readonly string[] {
  if (process.platform === 'win32') return ['-NoLogo', '-NoProfile', '-Command', 'exit 0']
  // POSIX: -c "exit 0" — bash and sh both accept it.
  return ['-c', 'exit 0']
}

/**
 * Probe whether a shell candidate resolves on PATH.
 *
 * The probe must be synchronous: spawn() reports ENOENT through the async
 * 'error' event, which a caller checking the return value never sees, so the
 * old pickShell always picked the first candidate even when it was missing.
 * spawnSync() throws ENOENT synchronously, so a missing candidate is
 * detected here and skipped.
 * @param candidate - the shell candidate to probe.
 * @returns true when the probe process starts and exits cleanly.
 */
export function probeShell(candidate: { file: string }): boolean {
  try {
    const probe = spawnSync(candidate.file, probeArgs(), {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    })
    return probe.error === undefined
  } catch {
    return false
  }
}

/**
 * Pick the first shell candidate present on PATH.
 * @param probe - PATH probe override (test seam); defaults to probeShell.
 * @returns the first candidate whose probe succeeds, or the first candidate
 * when none resolve (the spawn itself then surfaces the failure).
 */
export function pickShell(
  probe: (candidate: { file: string }) => boolean = probeShell,
): { file: string; args: readonly string[] } {
  for (const candidate of shellCandidates()) {
    if (probe(candidate)) return candidate
  }
  const candidates = shellCandidates()
  return candidates[0] as (typeof candidates)[number]
}

/**
 * Session-scoped terminal registry: spawns shells, buffers output, and clears
 * every process when the owning gateway disposes.
 */
export class WorkbenchTerminalHost {
  private readonly terminals = new Map<string, Map<string, TerminalRecord>>()
  private readonly counters = new Map<string, number>()

  /**
   * Spawn one persistent shell for a session scope.
   * @param sessionId - the conversation scope owning the terminal.
   * @param cwd - initial working directory; falls back to the session cwd when absent.
   * @returns the minted session and the shell program name.
   */
  spawn(sessionId: string, cwd?: string): WorkbenchTerminalSpawnResult {
    const { file, args } = pickShell()
    const workingDir = cwd !== undefined && existsSync(cwd) ? cwd : process.cwd()
    const child = spawn(file, [...args], {
      cwd: workingDir,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
    })
    const id = String(this.counters.get(sessionId) ?? 0)
    this.counters.set(sessionId, (this.counters.get(sessionId) ?? 0) + 1)
    const record: TerminalRecord = { process: child, buffer: '', exited: false, exitCode: null }
    const sessionMap = this.terminals.get(sessionId) ?? new Map<string, TerminalRecord>()
    sessionMap.set(id, record)
    this.terminals.set(sessionId, sessionMap)

    const append = (chunk: Buffer): void => {
      record.buffer += chunk.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error: Error) => {
      record.buffer += `[shell error] ${error.message}\n`
    })
    child.on('exit', (code) => {
      record.exited = true
      record.exitCode = code
    })
    return { session: { id, status: 'running', exitCode: null }, shell: file }
  }

  /**
   * Write raw input to one terminal's stdin.
   * @param sessionId - the owning conversation scope.
   * @param id - the terminal id.
   * @param data - bytes to write.
   */
  write(sessionId: string, id: string, data: string): void {
    const record = this.expect(sessionId, id)
    if (record.exited) throw new Error(`workbench: terminal ${id} has exited`)
    record.process.stdin.write(data)
  }

  /**
   * Consume the output produced since the previous read.
   * @param sessionId - the owning conversation scope.
   * @param id - the terminal id.
   * @returns the incremental output plus the session snapshot.
   */
  read(sessionId: string, id: string): WorkbenchTerminalReadResult {
    const record = this.expect(sessionId, id)
    const delta = record.buffer
    record.buffer = ''
    const session: WorkbenchTerminalSession = {
      id,
      status: record.exited ? 'exited' : 'running',
      exitCode: record.exitCode,
    }
    return { delta, session }
  }

  /**
   * Terminate one terminal and drop its record. Unknown ids are a no-op.
   * @param sessionId - the owning conversation scope.
   * @param id - the terminal id.
   * @returns after the process tree has exited.
   */
  async close(sessionId: string, id: string): Promise<void> {
    const sessionMap = this.terminals.get(sessionId)
    const record = sessionMap?.get(id)
    if (record === undefined) return
    await this.killTree(record)
    sessionMap?.delete(id)
    if (sessionMap?.size === 0) this.terminals.delete(sessionId)
  }

  /**
   * Terminate every terminal owned by one session scope.
   * @param sessionId - the owning conversation scope.
   * @returns after every process tree has exited.
   */
  async closeSession(sessionId: string): Promise<void> {
    const sessionMap = this.terminals.get(sessionId)
    if (sessionMap === undefined) return
    await Promise.all([...sessionMap.values()].map(record => this.killTree(record)))
    this.terminals.delete(sessionId)
  }

  /**
   * Terminate every terminal across all scopes (gateway disposal).
   * @returns after every process tree has exited.
   */
  async dispose(): Promise<void> {
    const all = [...this.terminals.values()].flatMap(sessionMap => [...sessionMap.values()])
    await Promise.all(all.map(record => this.killTree(record)))
    this.terminals.clear()
    this.counters.clear()
  }

  private expect(sessionId: string, id: string): TerminalRecord {
    const record = this.terminals.get(sessionId)?.get(id)
    if (record === undefined) throw new Error(`workbench: unknown terminal ${id}`)
    return record
  }

  private killTree(record: TerminalRecord): Promise<void> {
    if (record.exited) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        record.process.off('exit', onExit)
        record.process.off('error', onError)
        record.process.stdin.end()
        resolve()
      }, 3_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        record.process.off('exit', onExit)
        record.process.off('error', onError)
        record.process.stdin.end()
        resolve()
      }
      const onExit = (): void => { cleanup() }
      const onError = (): void => { cleanup() }
      record.process.once('exit', onExit)
      record.process.once('error', onError)
      if (process.platform === 'win32') {
        // taskkill terminates the whole process tree (PowerShell may own children);
        // a denied or missing taskkill falls back to the direct process kill.
        try {
          const killed = spawnSync('taskkill', ['/pid', String(record.process.pid), '/T', '/F'], { windowsHide: true })
          if (killed.status !== 0) record.process.kill()
        } catch {
          record.process.kill()
        }
      } else {
        record.process.kill('SIGTERM')
      }
    })
  }
}

export default WorkbenchTerminalHost
