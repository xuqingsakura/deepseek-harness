/**
 * Vocabulary for the workbench Remote gateway: opaque version tokens, the
 * directory-entry projection, and the read/write result shapes. All types are
 * plain JSON to cross the Typert wire unchanged.
 * @module @deepseek-ai/dsh-host-workbench/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque freshness token minted by the workbench gateway from the backing
 * `ctx.fs` version. Consumers MUST NOT interpret it; they hand it back to
 * {@link WorkbenchGateway.writeText} to guard a save against concurrent edits.
 */
export type WorkbenchVersion = Branded<'WorkbenchVersion'>

/**
 * Brand a string as a {@link WorkbenchVersion}. The gateway converts the
 * backing filesystem version at its owning boundary; consumers never
 * manufacture a token.
 * @param value - the backing `ctx.fs` version string.
 * @returns the same string, branded.
 */
export function WorkbenchVersion(value: string): WorkbenchVersion {
  return value as WorkbenchVersion
}

/** One child of a listed directory, projected for the workbench file tree. */
export interface WorkbenchDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}

/** The session's authoritative working directory. */
export interface WorkbenchCwdResult {
  /** Canonical absolute path of the session cwd. */
  path: string
}

/** Outcome of a workbench text read. */
export interface WorkbenchReadResult {
  /** Decoded text; empty for a binary file. */
  content: string
  /** Whether the file exceeds the gateway read window and was truncated. */
  truncated: boolean
  /** Whether the file is binary (NUL-probed) and therefore not text-editable. */
  binary: boolean
  /** Byte size of the file as reported by the backing filesystem. */
  size: number
  /** Freshness token to hand back to a guarded save. */
  version: WorkbenchVersion
}

/** Outcome of a workbench text write. */
export interface WorkbenchWriteResult {
  /** Freshness token of the file after the write. */
  version: WorkbenchVersion
}

/**
 * One live terminal session created by the workbench gateway. Backed by a
 * persistent child shell process (PowerShell on Windows, bash elsewhere) over
 * stdio pipes — no PTY allocation, so the UI renders the session prompt and
 * command echo itself.
 */
export interface WorkbenchTerminalSession {
  /** Gateway-minted terminal id, unique within the session scope. */
  id: string
  /** Whether the underlying shell process is still running. */
  status: 'running' | 'exited'
  /** Process exit code once the shell exited; null while running. */
  exitCode: number | null
}

/** Result of one terminal spawn. */
export interface WorkbenchTerminalSpawnResult {
  /** The minted terminal session. */
  session: WorkbenchTerminalSession
  /** The shell program actually launched (for display). */
  shell: string
}

/** Incremental output read from one terminal session. */
export interface WorkbenchTerminalReadResult {
  /** Output produced since the previous read (stdout and stderr merged). */
  delta: string
  /** The session snapshot at read time. */
  session: WorkbenchTerminalSession
}

/** How one working-tree file differs from the index or HEAD. */
export type WorkbenchGitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed path in the working tree. */
export interface WorkbenchGitChange {
  /** Path relative to the repository root. */
  path: string
  /** Whether the change is already staged in the index. */
  staged: boolean
  /** How the file differs from the previous tree. */
  kind: WorkbenchGitChangeKind
}

/** The workbench Git status projection (VSCode-style). */
export interface WorkbenchGitStatusResult {
  /** Whether the session cwd is inside a git work tree. */
  isRepo: boolean
  /** The current branch name ('' when in detached HEAD). */
  branch: string
  /** Working-tree changes; staged entries sort first. */
  changes: WorkbenchGitChange[]
}

/** One commit from the recent history. */
export interface WorkbenchGitLogEntry {
  /** Full commit hash. */
  hash: string
  /** Abbreviated hash (7 chars). */
  shortHash: string
  /** Author name. */
  author: string
  /** ISO author date. */
  date: string
  /** First subject line. */
  message: string
}

/** The unified diff of one path against the index/HEAD. */
export interface WorkbenchGitDiffResult {
  /** Unified diff text (empty for binary content). */
  diff: string
  /** Whether the file was treated as binary and diffed as metadata only. */
  binary: boolean
}

/** One local branch. */
export interface WorkbenchGitBranch {
  /** Branch name. */
  name: string
  /** Whether this is the checked-out branch. */
  current: boolean
}
