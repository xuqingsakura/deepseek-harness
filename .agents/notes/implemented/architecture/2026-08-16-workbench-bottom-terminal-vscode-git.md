# Agent Note: Workbench bottom terminal panel, VSCode-style Git, and arity fix

Status: implemented

English | [中文](2026-08-16-workbench-bottom-terminal-vscode-git.zh.md)

## Problem

Two regressions and one layout gap surfaced in the desktop workbench:
- The UI terminal reported `client api: workbench/terminalSpawn expected 2 argument(s), got 1` — the typert client rejects calls whose argument count differs from the descriptor's parameter list, so optional parameters must be passed `undefined` explicitly.
- Git change rows only previewed diffs in the sidebar; there was no way to open a changed file in the center viewer.
- The terminal lived inside the left tab strip, which is narrow; the layout gave no VSCode-style bottom panel.

## Decision

- **Arity fix**: pass `undefined` for every omitted optional argument in the four workbench client call sites (`terminalSpawn`, `gitFetch`, `gitPush`, `writeText`). This is a client-only change; the gateway descriptor is unchanged.
- **Bottom terminal panel**: the layout plugin's `AppFrame` gained a second grid row. The layout store tracks a `bottom` height (0 = closed) with `setBottom`/toggle/close actions exposed through `ctx.layout`; a vertical drag handle resizes the strip. The workbench plugin registers a `workbench.bottom` slot whose occupant (`WorkbenchBottomTerminal`) binds the tree's session and renders the shared terminal panel. The sidebar tab strip dropped the terminal tab in favor of a `>_` toggle button that opens the bottom panel.
- **VSCode-style Git**: `WorkbenchGitPanel` takes an `onOpenFile` callback wired to `workbench.open`; single-clicking a change row (or its ↗ button) opens the file in the center viewer while the diff preview stays selected.
- **Terminal polish**: the output strip renders ANSI SGR colors (foreground, background, bold, inverse) via a new pure `parseAnsi` (unit-tested); a copy button writes the current output to the clipboard.

## Consequences

The desktop workbench now has a resizable VSCode-style terminal strip at the bottom of the frame, Git rows open files in the center editor, and terminal output is colored. The arity fix restores terminal spawn, fetch, push, and file-create from the client. The bottom panel is root-scoped like the viewer: it renders whenever opened and resolves its session through the workbench state (pinned session, current as fallback).

## Alternatives considered

- xterm.js + node-pty for a true PTY terminal (DSH-better-sidebar approach): native-module ABI risk under Electron and extra install weight; the existing pipe-backed shell already serves the panel's needs. Revisit if interactive TUI support becomes a requirement.
- A fixed-position overlay terminal (CSS margin-push like DSH-better-sidebar): depends on the frame's DOM order and fights the grid; an explicit second grid row keeps the layout declarative and testable.
## Follow-up (same session)

- **Shell probe fix**: the old pickShell probed candidates with async
  `spawn()`, whose ENOENT arrives on the 'error' event the caller never sees,
  so it always picked `pwsh.exe` even when absent from the Electron PATH and
  the terminal reported `spawn pwsh.exe ENOENT`. `probeShell` now probes
  synchronously via `spawnSync()` (which throws ENOENT), falling back to
  `powershell.exe`; `pickShell` gained a test-seam probe parameter.
- **Git panel**: the overflow actions moved into a ⋯ menu (stage all, discard
  all, fetch, pull, push) so the narrow sidebar toolbar no longer wraps; the
  sidebar diff preview column was removed. Clicking a change row now opens
  that file's diff in the CENTER viewer via a new `DiffViewer` seat
  (`workbench.openDiff` state: path + staged flag), matching VSCode's
  source-control click-to-diff behavior.
- **Terminal strip**: the copy button was dropped; a ✕ button on the tab bar
  closes the whole bottom panel (reopen with the sidebar's `>_` toggle);
  the bottom row spans only the center + details columns
  (`grid-column: 2 / -1`), so the file-tree column keeps its full height.
- **Windows PowerShell encoding**: the UTF-8 pin moved from a UI-side stdin
  preamble (which PowerShell 5.1 echoed into the output and left output
  garbled) into the host spawn arguments — `powershell.exe` now starts with
  `-NoExit -Command` running `[Console]::OutputEncoding` /
  `$OutputEncoding` before the first prompt, so the init line never echoes
  and the shell stays interactive.
- **Git overflow menu**: the ⋯ anchor button gained its missing
  open/close onClick, so the menu now opens.
- **Git panel layout**: the "Source Control" title never wraps; the branch
  selector moved to its own full-width row under the title; the commit
  composer stacks vertically (message input above the commit button). The
  change list scrolls internally (`min-height: 0` + `overflow: hidden` on
  the panel) so a long change list no longer pushes the commit history out
  of view.
- **Collapsible change groups**: each group header (staged / changes /
  untracked) is now a folder-style button with a ▶/▼ arrow that folds or
  expands the whole file list.
- **History pinned on top**: the commit-history strip moved ABOVE the change
  list with a fixed height, so a long change list scrolls beneath it
  (overflow-y auto) instead of pushing the history out of view.
- **Sidebar full height**: the sidebar column now spans both grid rows
  (grid-row: 1 / -1), so opening the bottom terminal no longer leaves a
  blank rectangle under the file tree (the bottom row spans only columns
  2-3).
- **Git history adjacency**: the commit-history strip moved back BELOW the
  change list, sitting right above the commit composer, so it no longer
  floats at the top with the composer far below (empty-state gap). The
  change list scrolls above it.
- **List scrolling root cause**: the workbench sidebar panel lacked
  `min-height: 0`, so the nested change list stretched the panel instead of
  scrolling. Added it; the list now scrolls internally (pointer-drawn
  scrollbar, per the sidebar's quiet-bars behavior).
- **Terminal close**: closing the last shell tab now closes the whole
  bottom panel (VSCode-like) instead of leaving an empty strip; a poll that
  races a closed tab stops silently instead of surfacing `unknown terminal`.
- **History adjacency landed**: an earlier attempt only reordered the DOM
  textually without moving the block (the extracted span still covered body +
  history); rc.47 moves only the history block, so the composer finally sits
  directly under the change list with history between them.
