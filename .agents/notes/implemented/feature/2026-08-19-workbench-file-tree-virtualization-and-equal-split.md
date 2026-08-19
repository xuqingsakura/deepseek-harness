# Agent Note: Workbench file-tree virtualization, equal three-column split, Git history polish

Status: implemented

English | [中文](2026-08-19-workbench-file-tree-virtualization-and-equal-split.zh.md)

## Problem

The workbench file tree rendered every row of a directory at once, so large
directories (thousands of files) materialized thousands of DOM rows and
stalled scrolling. The three-column layout (sidebar | center | details) opened
with arbitrary widths and could not be equalized or resized by dragging. The
Git panel stacked the commit history and the changes list with no stable
ordering, and its "select a change to view the diff" region duplicated the
center-column preview. The file tree also lacked VSCode-style interactions:
file-name search, path reference/copy, and durable expansion state.

## Decision

- **File-tree virtualization** (`FileTree.tsx`): `flattenVisibleRows()` flattens
  the expanded tree into one row list and windows it by a fixed 24px row
  height (±12 rows of buffer), so a huge directory renders only the visible
  slice; `sortEntries` orders directories first with natural name ordering.
- **Equal three-column split** (`columns.ts` / `stores.ts` / `AppFrame.tsx`):
  `computeEqualColumns()` plus a `workbenchEqual` layout flag; opening the
  workbench defaults the three columns to 1:1:1 and dragging a handle or
  collapsing a column exits the equal state.
- **Host workbench enrichment** (`packages/host/workbench` + `packages/fs`):
  `listDir` now returns a listing with a 1000-entry cap and a `truncated`
  flag; new `searchFiles` runs a budgeted recursive file-name search (200
  matches / 100k visits, skips `.git`, never descends symlink directories);
  `WorkbenchDirEntry` carries `hidden`/`isSymlink`/`broken`.
- **Tree client upgrade**: symlink and broken-link icons, dimmed hidden rows,
  hover @-reference (appends `@<relative path>` to the composer draft) and
  copy-path buttons, a truncated-listing hint row, and per-session expansion
  persistence in localStorage; `WorkbenchTreePanel` gains a debounced
  search box, refresh/close actions, and a cwd breadcrumb.
- **Git panel** (`WorkbenchGitPanel.tsx`): commit history moves above the
  changes list (border-bottom, fixed 128px), and the redundant
  "select a change to view the diff" region is removed (the center column
  previews the selected file).

## Consequences

Opening a workbench with a large tree no longer stalls on DOM materialization;
the three columns open equal and resize by drag; file-name search, path
reference/copy, and expansion memory match the VSCode explorer model the
project references (DSH-better-sidebar); Git history stays visible above
long change lists.

## Alternatives considered

- Loading only the expanded levels without windowing: still materializes
  every row of a large expanded directory. Rejected: the fixed-height window
  is the only way to keep huge directories cheap.
- Equalizing columns by mutating drag widths at open: polluted persisted
  widths. The separate `workbenchEqual` flag keeps equality as a transient
  layout mode that dragging exits.
- Keeping the Git "select a change" region: duplicated by the center-column
  preview. Removed for the P3 milestone.
