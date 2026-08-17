# @deepseek-ai/dsh-host-workbench

English | [中文](README.zh.md)

Session-scoped workbench Remote gateway: the session's authoritative working directory, lazy directory listings, text reads through a bounded window, version-guarded atomic writes, persistent terminal shells, and Git worktree operations — file access over the mounted `ctx.fs`, process access over direct child spawns, and repository access over the system `git` binary.

The desktop and web workbench UIs call this gateway instead of opening their own routes, so file access inherits the official filesystem seam: realpath-derived target identity, atomic mutation, version guards, and the mounted sandbox policy. Every operation is conversation-scoped: a request's `sessionId` resolves the session header's `cwd`, and relative paths resolve against it, mirroring the model-facing tools' execution world.

| Remote method | Result | Notes |
|---|---|---|
| `cwd(sessionId)` | `WorkbenchCwdResult` | Session header cwd; process cwd while a session is still hydrating |
| `listDir(sessionId, path)` | `WorkbenchDirEntry[]` | One level only — the client lazy-loads subtrees on expansion |
| `readText(sessionId, path)` | `WorkbenchReadResult` | NUL-probe binary detection; oversize files return the leading window with `truncated: true` |
| `writeText(sessionId, path, content, version?)` | `WorkbenchWriteResult` | Version-supplied writes are guarded; omission means unconditional create-or-overwrite |
| `terminalSpawn(sessionId, cwd?)` | `WorkbenchTerminalSpawnResult` | One persistent shell (PowerShell on Windows, bash elsewhere) over stdio pipes; Windows prefers `pwsh`, falling back to `powershell.exe` |
| `terminalWrite(sessionId, id, data)` | `void` | Raw input to the shell's stdin |
| `terminalRead(sessionId, id)` | `WorkbenchTerminalReadResult` | Consuming incremental output (the UI polls; no push channel) |
| `terminalClose(sessionId, id)` | `void` | Terminates the process tree and drops the record |
| `terminalCloseSession(sessionId)` | `void` | Terminates every shell of one conversation scope |
| `gitStatus(sessionId)` | `WorkbenchGitStatusResult` | `isRepo` flag, current branch, and porcelain-projected changes |
| `gitDiff(sessionId, path?, staged?)` | `WorkbenchGitDiffResult` | Unified diff of one path or the whole tree against the index/HEAD |
| `gitLog(sessionId, limit?)` | `WorkbenchGitLogEntry[]` | Recent commits, newest first |
| `gitBranches(sessionId)` | `WorkbenchGitBranch[]` | Local branches with the checked-out one flagged |
| `gitAdd(sessionId, paths?)` | `void` | Stages paths; empty stages everything |
| `gitRestore(sessionId, paths, staged?)` | `void` | Discards worktree changes or unstages index entries |
| `gitCommit(sessionId, message)` | `void` | Commits the staged changes |
| `gitCheckout(sessionId, branch)` | `void` | Checks out one local branch |

Terminal processes are owned by the gateway: closing the gateway terminates every live shell across all scopes. Git verbs run `git --no-color` with `-c color.ui=false` so captured output stays parseable, and mutations fail loud with the captured stderr.

## Model Experience

None, as the gateway projects host filesystem/process/repository state for a human workbench UI; nothing reaches a model request.

#### KV Cache effect

None; the gateway never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **No recursive listing** — directory trees are assembled client-side from one-level `listDir` calls; a deep tree pays one round-trip per expanded directory.
- **Text window only** — binary files report `binary: true` with empty content; media preview (images/PDF) belongs to a later preview surface reading through the same gateway.
- **No directory create/rename/delete yet** — the file tree ships read/list first; mutations beyond text writes are deferred work.
- **Pipe-backed terminal, not a PTY** — shells run over stdio pipes without a terminal device, so full-screen interactive programs (vim, top) are not supported; the panel targets command-driven workflows.
- **Git requires the system `git` binary** — no embedded git; a machine without git on PATH reports the repository as absent.