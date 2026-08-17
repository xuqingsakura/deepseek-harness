# Agent Note: Sidebar foot toggle collapses and reopens; workbench header removed

Status: implemented

English | [中文](2026-08-16-desktop-sidebar-toggle-and-workbench-header.zh.md)

## Problem

Two UI annoyances in the sidebar/workbench:

1. The foot "collapse sidebar" button in the activity rail only collapsed
   (`if (!collapsed)` guard) — clicking it again while collapsed did nothing,
   while the top brand button toggled both ways.
2. The workbench file-tree panel rendered a redundant header row ("工作台" +
   the session cwd + a ✕ close button) under the sidebar's own panel header.

## Decision

1. Remove the `if (!collapsed)` guard so the foot button is a full toggle
   (same label/aria semantics as the brand button). `toggleSidebar` in the
   layout store is now view-aware: re-expanding in the workbench view restores
   `WORKBENCH_SIDEBAR_WIDTH` (300px) instead of the browser default.
2. Remove the workbench panel header entirely (title, cwd, ✕). The sidebar's
   own panel header already shows "工作台"; the cwd stays resolved internally
   because the file tree is rooted on it. The now-unused `layout` prop was
   dropped from the tree panel.

## Consequences

The foot button collapses and reopens the sidebar in both views; the workbench
panel shows just the "文件" tab row above the tree, matching the sidebar
header. The tree is closed via the activity rail (collapse button / view
switch), not a panel-local ✕.

## Alternatives considered

- **Fix only the foot button, leave the store as-is** — the button would
  toggle again, but re-expanding in the workbench view would restore the
  browser default width instead of the workbench's 300px, so the file tree
  would jump. Rejected: the store had to become view-aware.
- **Keep the panel header but restyle it** — the sidebar already renders its
  own "工作台" panel header above the slot, so the in-panel row duplicated
  it. Rejected as redundant; the ✕ was also reachable via the activity rail.
