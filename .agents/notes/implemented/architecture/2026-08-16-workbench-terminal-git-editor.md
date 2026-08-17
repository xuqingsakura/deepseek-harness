# Agent Note: Workbench P0–P2 — CodeMirror editor, terminal, Git, and tasks panels

Status: implemented

English | [中文](2026-08-16-workbench-terminal-git-editor.zh.md)

## Problem

The workbench view shipped read-only: a lazy file tree plus a CodeBlock
viewer. Editing, running commands, source control, and observing background
jobs all required leaving the panel.

## Decision

Grow the single `dsh-host-workbench` Remote gateway with terminal and Git
verbs (rather than new packages: both are UI-support projections over host
processes, sharing the gateway's session-cwd binding and teardown), and grow
the browser half's `sidebar.workbench` seat into a tabbed panel.

- **Editor (P0-4)**: CodeMirror replaces the read-only viewer for non-Markdown
  files. Language support maps the shared `file-lang` hint to `@codemirror/*`
  bundles; Markdown keeps MarkdownText rendering. Saving goes through the
  existing version-guarded `writeText` (Ctrl+S / header button), with a dirty
  dot and save/error notices. CodeMirror inlines into the client bundle
  (tsdown `noExternal`), so the runtime closure needs no extra packages. Theme
  follows `body[data-ds-dark-theme]` live via a MutationObserver reconfigure.
- **Terminal (P0-2)**: `terminalSpawn/Write/Read/Close/CloseSession` run one
  persistent shell per session scope over stdio pipes — Windows PowerShell
  (`pwsh` preferred, `powershell.exe` fallback with a UTF-8 output preamble),
  POSIX bash/sh. No PTY: full-screen interactive programs are unsupported by
  design; the UI polls `terminalRead` for incremental output.
- **Git (P1-1)**: `gitStatus/Diff/Log/Branches/Add/Restore/Commit/Checkout`
  drive the system `git` binary with `-c color.ui=false` for parseable output.
  The panel shows VSCode-style staged/unstaged/untracked groups, a unified
  diff preview, per-file and all-file stage/discard, a commit composer, and
  branch switching. `isRepo` distinguishes a non-repository directory from a
  clean one.
- **Tasks**: the sidebar's tasks tab reuses the `jobsBySession` mirror the
  session-header popover uses — read-only list with live durations.

Windows terminal teardown uses `taskkill /T /F` with a fallback to
`child.kill()` (sandboxed environments deny taskkill) and awaits the process
`exit` event so the cwd directory unlocks before callers delete it (EBUSY).

## Consequences

The workbench sidebar is now a tab strip over four session-scoped views; the
center column edits and saves real files; Git mutations fail loud with the
captured stderr. The terminal is deliberately pipe-backed, not a PTY, and Git
requires the system `git` binary — both documented in the package READMEs.

## Alternatives considered

- node-pty/ConPTY for a true terminal: native-module ABI risk under Electron
  and extra install weight; the subprocess seam already owns node-pty for the
  model-facing terminal tool, but the UI panel does not need full-screen
  programs. Revisit if interactive TUI support becomes a requirement.
- Separate `dsh-host-terminal-ui` / `dsh-host-git` packages: more boilerplate
  for two UI-support projections that already share the workbench gateway's
  session-scoping and teardown; the gateway's `remoteMethods()` test pins the
  exact method list either way.

## Follow-up polish (same session)

- **Filesystem verbs** — the gateway gained `fsMkdir`/`fsRename`/`fsRemove`
  (node:fs/promises, path-normalized inside the session cwd, traversal
  rejected); the file tree gained a right-click context menu (new file /
  folder, rename, delete) that refreshes the affected listing after each
  mutation. `dsh-fs` deliberately stays untouched: these are UI mutations,
  not a new capability seam.
- **Git network verbs** — `gitFetch`/`gitPull`/`gitPush` joined the gateway;
  the panel now has fetch/pull/push buttons, a highlighted per-line diff
  view, and a recent-commit history strip.
- **Editor tabs** — right-click batch close (this/others/all) plus an
  unsaved-changes confirm guard wired through the viewer's dirty-path set.
- **Terminal** — multiple shell tabs (spawn with +), per-terminal clear and
  Up/Down command history; session switches still tear every shell down.
