# Agent Note: Workbench viewer column collapses to 0 height (CSS grid auto placement)

Status: implemented

English | [中文](2026-08-16-workbench-viewer-grid-row-auto-placement.zh.md)

## Problem

The desktop workbench three-column view (file tree | file viewer | conversation) showed a blank white center column for 12 installer versions (rc.20–rc.31): the file tree and conversation rendered, but the middle viewer never displayed content even though the DOM contained the file text.

## Root cause

`AppFrame` is a three-column CSS grid with `grid-template-rows: 100%`. In the workbench view the layout swaps columns via `[data-workbench]` rules (`centerCol` 2→3, `detailsCol` 3→2) while keeping the DOM order (sidebar, center, details). With default `grid-auto-flow: row`, the auto-placement cursor, after placing `centerCol` at column 3, has already passed column 2 of row 1, so the later `detailsCol` (column 2) is placed into an implicit second row. That row's auto height collapses to 0 because the viewer uses `flex: 1` children (flex-basis 0 contributes no intrinsic height) and the columns clip with `overflow: hidden` — so the entire center column disappeared below the frame. Fixing the flex/height chain (12 attempts) could never work: the defect is row placement, not sizing.

## Decision

Pin every column to the single row with explicit `grid-row: 1` on `.sidebarCol`, `.centerCol`, and `.detailsCol` in `packages/client/ui-layout/src/client/AppFrame.module.css` (the bundler compiles these to `grid-area: 1/1`, `1/2`, `1/3`). The workbench `grid-column` swaps keep working (they only change the column); the row never changes.

## Alternatives considered

- `grid-auto-rows: 100%` on the frame. Rejected: the item still lands in the implicit second row at y = frame height, so the full-height column renders entirely below the visible frame and is clipped away.
- `grid-auto-flow: column`. Rejected as the primary fix: it also works, but changing the flow direction is a broader behavioral change than pinning the row, and `grid-row: 1` documents the invariant directly.

## Consequences

The workbench center column (file viewer) now fills the row height on every viewport and the viewer content (header + scrollable body) renders. Future column-count or placement changes must keep every column on row 1; the CSS comment records the auto-placement gotcha.
