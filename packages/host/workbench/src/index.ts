/**
 * Session-scoped workbench Remote gateway. Exposes the session's authoritative
 * working directory and file-tree/read/write operations over the mounted
 * `ctx.fs`, so the desktop and web workbench UIs share the official filesystem
 * seam (atomic mutation, version guards, sandbox policy) instead of opening
 * their own routes.
 *
 * Every operation is conversation-scoped: the session header's `cwd` resolves
 * relative paths, mirroring the model-facing tools' execution world.
 * @module @deepseek-ai/dsh-host-workbench
 */

import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion, type FsDirEntry, type FsTarget, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  WorkbenchVersion,
  type WorkbenchCwdResult,
  type WorkbenchDirEntry,
  type WorkbenchReadResult,
  type WorkbenchWriteResult,
  type WorkbenchTerminalSpawnResult,
  type WorkbenchTerminalReadResult,
  type WorkbenchGitStatusResult,
  type WorkbenchGitLogEntry,
  type WorkbenchGitDiffResult,
  type WorkbenchGitBranch,
} from './types.ts'
import { WorkbenchTerminalHost } from './terminal.ts'
import {
  gitAdd,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitLog,
  gitRestore,
  gitFetch as repoFetch,
  gitPull as repoPull,
  gitPush as repoPush,
  gitStatus,
} from './git.ts'

export {
  WorkbenchVersion,
  type WorkbenchCwdResult,
  type WorkbenchDirEntry,
  type WorkbenchReadResult,
  type WorkbenchWriteResult,
  type WorkbenchTerminalSession,
  type WorkbenchTerminalSpawnResult,
  type WorkbenchTerminalReadResult,
  type WorkbenchGitChange,
  type WorkbenchGitChangeKind,
  type WorkbenchGitStatusResult,
  type WorkbenchGitLogEntry,
  type WorkbenchGitDiffResult,
  type WorkbenchGitBranch,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbench: WorkbenchGateway
  }
}

/** Read-window ceiling for text reads, so one giant file cannot stall the UI. */
const TEXT_READ_LIMIT_BYTES = 1 * 1024 * 1024
/** NUL-probe window for binary detection, matching the tool layer's sniffing. */
const BINARY_PROBE_BYTES = 4096

/**
 * Resolve a session's authoritative working directory. The session header
 * wins; a session still hydrating from persistence falls back to the process
 * cwd so the workbench works from first paint. Never throws for a missing cwd.
 * @param sessions - the mounted session store.
 * @param sessionId - the conversation whose cwd to resolve.
 * @returns the canonical cwd path.
 */
function sessionCwdOf(sessions: SessionStore, sessionId: string): string {
  const session = sessions.get(SessionId(sessionId))
  const headerCwd = session?.header.cwd
  return headerCwd !== undefined && headerCwd !== '' ? headerCwd : process.cwd()
}

/** Project one filesystem listing entry to the workbench wire shape. */
function projectDirEntry(entry: FsDirEntry): WorkbenchDirEntry {
  return {
    name: entry.name,
    type: entry.type,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  }
}

/** Remote-only service exposing the session-scoped workbench file face. */
export class WorkbenchGateway extends TypertRemoteService {
  static inject = ['fs', 'sessions']

  /** Session-scoped terminal shells (PowerShell on Windows, bash elsewhere). */
  private terminals: WorkbenchTerminalHost

  constructor(ctx: Context) {
    super(ctx, 'workbench')
    this.terminals = new WorkbenchTerminalHost()
    ctx.effect(() => () => this.terminals.dispose(), 'workbench terminal teardown')
  }

  /**
   * Resolve a workbench path (empty = the session cwd itself) against the
   * session's authoritative cwd.
   * @param sessionId - the conversation scope.
   * @param path - absolute path, or a path relative to the session cwd.
   * @param signal - aborts the backing filesystem resolution.
   * @returns the stable filesystem target.
   */
  private async resolveIn(sessionId: string, path: string, signal?: AbortSignal): Promise<FsTarget> {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    const opts = signal === undefined ? { cwd } : { cwd, signal }
    return this.ctx.fs.resolve(path === '' ? cwd : path, opts)
  }

  /**
   * Read the session's authoritative working directory.
   * @param sessionId - the conversation scope.
   * @returns the canonical cwd path.
   */
  @Remote('cwd')
  cwd(sessionId: string): WorkbenchCwdResult {
    return { path: sessionCwdOf(this.ctx.sessions, sessionId) }
  }

  /**
   * List one directory (the session cwd when {@link path} is empty), with no
   * recursion — the client lazy-loads subtrees on expansion.
   * @param sessionId - the conversation scope.
   * @param path - absolute path, or a path relative to the session cwd.
   * @param signal - aborts the backing filesystem listing.
   * @returns the directory's children in backend order.
   */
  @Remote('listDir')
  async listDir(sessionId: string, path: string, signal?: AbortSignal): Promise<WorkbenchDirEntry[]> {
    const target = await this.resolveIn(sessionId, path, signal)
    const entries = await this.ctx.fs.listDir(target, signal)
    return entries.map(projectDirEntry)
  }

  /**
   * Read one text file through the workbench window. Binary files return an
   * empty content with `binary: true` (detected by a leading NUL probe); a
   * file larger than the read window returns the leading window with
   * `truncated: true`.
   * @param sessionId - the conversation scope.
   * @param path - absolute path, or a path relative to the session cwd.
   * @param signal - aborts the backing filesystem read.
   * @returns the read result with a freshness token for guarded saves.
   */
  @Remote('readText')
  async readText(sessionId: string, path: string, signal?: AbortSignal): Promise<WorkbenchReadResult> {
    const target = await this.resolveIn(sessionId, path, signal)
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) throw new Error(`workbench: no such file "${path}"`)
    if (info.type !== 'file') throw new Error(`workbench: "${path}" is not a regular file`)
    const size = info.size ?? 0
    if (size > TEXT_READ_LIMIT_BYTES) {
      // readBytes is whole-file with a size cap, so oversize files go through
      // the text stream; a binary stream rejection reports binary instead.
      try {
        const chunks: string[] = []
        let total = 0
        for await (const chunk of await this.ctx.fs.streamText(target, signal)) {
          const remaining = TEXT_READ_LIMIT_BYTES - total
          if (chunk.length >= remaining) {
            chunks.push(chunk.slice(0, remaining))
            break
          }
          chunks.push(chunk)
          total += chunk.length
        }
        return {
          content: chunks.join(''),
          truncated: true,
          binary: false,
          size,
          version: WorkbenchVersion(info.version),
        }
      } catch {
        return {
          content: '',
          truncated: true,
          binary: true,
          size,
          version: WorkbenchVersion(info.version),
        }
      }
    }
    const bytes = await this.ctx.fs.readBytes(target, signal, size > 0 ? size : BINARY_PROBE_BYTES)
    const binary = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES)).includes(0)
    if (binary) {
      return {
        content: '',
        truncated: false,
        binary: true,
        size,
        version: WorkbenchVersion(info.version),
      }
    }
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      truncated: false,
      binary: false,
      size,
      version: WorkbenchVersion(info.version),
    }
  }

  /**
   * Write one text file atomically through the backing filesystem. When
   * {@link version} is supplied the write is guarded (stale content fails
   * loud); omitting it means an unconditional create-or-overwrite.
   * @param sessionId - the conversation scope.
   * @param path - absolute path, or a path relative to the session cwd.
   * @param content - the full new file content.
   * @param version - freshness token from a prior read; omit to overwrite unconditionally.
   * @param signal - aborts before atomic publication takes effect.
   * @returns the freshness token after the write.
   */
  @Remote('writeText')
  async writeText(
    sessionId: string,
    path: string,
    content: string,
    version?: WorkbenchVersion,
    signal?: AbortSignal,
  ): Promise<WorkbenchWriteResult> {
    const target = await this.resolveIn(sessionId, path, signal)
    const intent: FsWriteIntent | undefined = version === undefined
      ? undefined
      : { kind: 'replaceIfVersion', version: FsVersion(version) }
    const outcome = await this.ctx.fs.writeText(target, content, intent, signal)
    return { version: WorkbenchVersion(outcome.version) }
  }

  /**
   * Spawn one persistent terminal shell for the session scope.
   * @param sessionId - the conversation scope.
   * @param cwd - initial working directory; defaults to the session cwd.
   * @returns the minted terminal session and the shell program name.
   */
  @Remote('terminalSpawn')
  terminalSpawn(sessionId: string, cwd?: string): WorkbenchTerminalSpawnResult {
    const workdir = cwd ?? sessionCwdOf(this.ctx.sessions, sessionId)
    return this.terminals.spawn(sessionId, workdir)
  }

  /**
   * Write raw input to one terminal's stdin.
   * @param sessionId - the conversation scope.
   * @param id - the terminal id.
   * @param data - bytes to write.
   */
  @Remote('terminalWrite')
  terminalWrite(sessionId: string, id: string, data: string): void {
    this.terminals.write(sessionId, id, data)
  }

  /**
   * Consume the output produced since the previous read.
   * @param sessionId - the conversation scope.
   * @param id - the terminal id.
   * @returns the incremental output plus the session snapshot.
   */
  @Remote('terminalRead')
  terminalRead(sessionId: string, id: string): WorkbenchTerminalReadResult {
    return this.terminals.read(sessionId, id)
  }

  /**
   * Terminate one terminal and drop its record.
   * @param sessionId - the conversation scope.
   * @param id - the terminal id.
   * @returns after the process tree has exited.
   */
  @Remote('terminalClose')
  async terminalClose(sessionId: string, id: string): Promise<void> {
    await this.terminals.close(sessionId, id)
  }

  /**
   * Terminate every terminal owned by one session scope (used when the UI
   * switches conversations and drops the whole terminal strip).
   * @param sessionId - the conversation scope.
   */
  @Remote('terminalCloseSession')
  async terminalCloseSession(sessionId: string): Promise<void> {
    await this.terminals.closeSession(sessionId)
  }

  /**
   * Project the working-tree Git status of the session cwd.
   * @param sessionId - the conversation scope.
   * @returns the current branch and changed paths.
   */
  @Remote('gitStatus')
  async gitStatus(sessionId: string): Promise<WorkbenchGitStatusResult> {
    return gitStatus(sessionCwdOf(this.ctx.sessions, sessionId))
  }

  /**
   * Unified diff of one path (or the whole tree) against the index or HEAD.
   * @param sessionId - the conversation scope.
   * @param path - optional path filter, relative to the session cwd.
   * @param staged - diff the index against HEAD when true, else the worktree against the index.
   * @returns the diff text and binary flag.
   */
  @Remote('gitDiff')
  async gitDiff(sessionId: string, path?: string, staged?: boolean): Promise<WorkbenchGitDiffResult> {
    return gitDiff(sessionCwdOf(this.ctx.sessions, sessionId), path, staged === true)
  }

  /**
   * Recent commit history of the session cwd.
   * @param sessionId - the conversation scope.
   * @param limit - how many commits to return (default 50).
   * @returns commits, newest first.
   */
  @Remote('gitLog')
  async gitLog(sessionId: string, limit?: number): Promise<WorkbenchGitLogEntry[]> {
    return gitLog(sessionCwdOf(this.ctx.sessions, sessionId), limit ?? 50)
  }

  /**
   * Local branches of the session cwd.
   * @param sessionId - the conversation scope.
   * @returns branches with the checked-out one flagged.
   */
  @Remote('gitBranches')
  async gitBranches(sessionId: string): Promise<WorkbenchGitBranch[]> {
    return gitBranches(sessionCwdOf(this.ctx.sessions, sessionId))
  }

  /**
   * Stage one or more paths (or all changes when empty).
   * @param sessionId - the conversation scope.
   * @param paths - paths to stage; empty stages everything.
   */
  @Remote('gitAdd')
  async gitAdd(sessionId: string, paths?: string[]): Promise<void> {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    await gitAdd(cwd, paths)
  }

  /**
   * Discard worktree changes or unstage index entries.
   * @param sessionId - the conversation scope.
   * @param paths - paths to restore.
   * @param staged - restore the index (unstage) when true, else the worktree.
   */
  @Remote('gitRestore')
  async gitRestore(sessionId: string, paths: string[], staged?: boolean): Promise<void> {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    await gitRestore(cwd, paths, staged === true)
  }

  /**
   * Commit the staged changes with one message.
   * @param sessionId - the conversation scope.
   * @param message - the commit message.
   */
  @Remote('gitCommit')
  async gitCommit(sessionId: string, message: string): Promise<void> {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    await gitCommit(cwd, message)
  }

  /**
   * Check out one local branch.
   * @param sessionId - the conversation scope.
   * @param branch - the branch name.
   */
  @Remote('gitCheckout')
  async gitCheckout(sessionId: string, branch: string): Promise<void> {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    await gitCheckout(cwd, branch)
  }

  /**
   * Fetch changes from the configured upstream.
   * @param sessionId - the conversation scope.
   * @param remote - optional remote name; defaults to the configured upstream.
   */
  @Remote('gitFetch')
  async gitFetch(sessionId: string, remote?: string): Promise<void> {
    await repoFetch(sessionCwdOf(this.ctx.sessions, sessionId), remote)
  }

  /**
   * Pull the current branch from its upstream.
   * @param sessionId - the conversation scope.
   */
  @Remote('gitPull')
  async gitPull(sessionId: string): Promise<void> {
    await repoPull(sessionCwdOf(this.ctx.sessions, sessionId))
  }

  /**
   * Push the current branch to its upstream (or a named remote).
   * @param sessionId - the conversation scope.
   * @param remote - optional remote name.
   * @param branch - optional branch name.
   */
  @Remote('gitPush')
  async gitPush(sessionId: string, remote?: string, branch?: string): Promise<void> {
    await repoPush(sessionCwdOf(this.ctx.sessions, sessionId), remote, branch)
  }

  /**
   * Resolve a UI-supplied path inside the session cwd and ensure it stays
   * within that directory (no traversal outside the working tree).
   * @param sessionId - the conversation scope.
   * @param path - absolute path, or a path relative to the session cwd.
   * @returns the normalized absolute path inside the cwd.
   */
  private resolveLocal(sessionId: string, path: string): string {
    const cwd = sessionCwdOf(this.ctx.sessions, sessionId)
    const target = resolvePath(cwd, path)
    const cwdPrefix = cwd.endsWith(pathSep) ? cwd : cwd + pathSep
    if (target !== cwd && !target.startsWith(cwdPrefix)) {
      throw new Error('workbench: path "' + path + '" escapes the session working directory')
    }
    return target
  }

  /**
   * Create one directory (and parents) inside the session cwd.
   * @param sessionId - the conversation scope.
   * @param path - directory path, relative to the session cwd.
   */
  @Remote('fsMkdir')
  async fsMkdir(sessionId: string, path: string): Promise<void> {
    const target = this.resolveLocal(sessionId, path)
    await mkdir(target, { recursive: true })
  }

  /**
   * Rename or move one file or directory inside the session cwd.
   * @param sessionId - the conversation scope.
   * @param path - current path, relative to the session cwd.
   * @param nextPath - new path, relative to the session cwd.
   */
  @Remote('fsRename')
  async fsRename(sessionId: string, path: string, nextPath: string): Promise<void> {
    const from = this.resolveLocal(sessionId, path)
    const to = this.resolveLocal(sessionId, nextPath)
    await rename(from, to)
  }

  /**
   * Delete one file or empty directory inside the session cwd.
   * @param sessionId - the conversation scope.
   * @param path - path to delete, relative to the session cwd.
   * @param recursive - remove directories recursively when true.
   */
  @Remote('fsRemove')
  async fsRemove(sessionId: string, path: string, recursive?: boolean): Promise<void> {
    const target = this.resolveLocal(sessionId, path)
    let isDirectory = false
    try {
      isDirectory = (await stat(target)).isDirectory()
    } catch {
      // Missing target: nothing to remove.
      return
    }
    if (isDirectory) {
      if (recursive !== true) {
        throw new Error('workbench: "' + path + '" is a directory; pass recursive to remove it')
      }
      await rm(target, { recursive: true, force: true })
    } else {
      await unlink(target)
    }
  }
}

export default WorkbenchGateway
