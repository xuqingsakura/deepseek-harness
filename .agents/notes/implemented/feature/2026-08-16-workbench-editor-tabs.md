# Agent Note: Workbench editor tabs

Status: implemented

English | [中文](2026-08-16-workbench-editor-tabs.zh.md)

## Problem

The workbench file viewer showed one file at a time with no way to keep several files open side by side or switch quickly between them.

## Decision

Add a VS Code-style editor tab bar above the workbench viewer. Opening a file in the tree appends it to the tab list (deduplicated by path) and activates it; clicking a tab activates that file; the × button closes a tab, and closing the active tab activates its right neighbor (falling back to the left one). The tab shows a file-type badge (extension-derived label + accent color), the file basename, and a hover close button.

State lives in the shared workbench state handle: `openPaths` (open order) plus the existing `activePath`, with `open(path)` / `close(path)` mutators. The tree calls `open`; the viewer renders `WorkbenchTabs` above the `FileViewer`. Switching the bound conversation through the header toggle drops the previous session's tabs. The extension→language mapping previously private to `FileViewer` moved to `file-lang.ts`, which now also owns the tab-badge metadata.

## Alternatives considered

- Keep the mapping duplicated inside the tab bar. Rejected: two extension tables would drift; one shared module owns both the highlight hint and the badge.
- Persist open tabs across sessions. Rejected: paths are session-relative and would silently re-read (or fail) against a different cwd, so switching conversations clears the tab list.

## Consequences

Multiple files can stay open in the workbench center column; the active file keeps the tree highlight and the viewer re-reads on tab switch. Tab state is transient (not persisted), matching the read-only viewer's session-scoped nature.
