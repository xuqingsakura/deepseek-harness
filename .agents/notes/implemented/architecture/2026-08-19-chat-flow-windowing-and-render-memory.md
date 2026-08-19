# Agent Note: Chat-flow windowing, render-memory observation, resident-window LRU

Status: implemented

English | [中文](2026-08-19-chat-flow-windowing-and-render-memory.zh.md)

## Problem

A long conversation rendered every business node at once; even with
`content-visibility: auto` the DOM and reconciliation cost grew linearly with
message count, and very long replies kept the whole flow mounted. Resident
`Session` instances held their event windows forever, so opening many
sessions accumulated memory that a restart was required to reclaim, and there
was no in-app way to observe renderer heap growth. Windowing itself also
crashed in the real browser: measuring rows shifted the spacer, Chromium's
scroll anchoring adjusted scrollTop to keep the viewport stable, the window
recomputed, and the two oscillated until React's update-depth guard tore the
conversation view down (an infinite start/end toggle between adjacent rows).

## Decision

- **Chat-flow windowing** (`chat-window.ts` + `ChatView.tsx`): a pure
  geometry core (`prefixSums`/`computeWindow`/`tailWindow`) drives a spacer
  window — only the viewport ± 12 rows mount, with top/bottom spacers
  preserving scrollHeight. Rows get kind-level height estimates before first
  paint and a ResizeObserver measures mounted rows. Windowing engages only
  when `ResizeObserver` exists and the flow is ≥ `WINDOW_THRESHOLD` (200)
  nodes, so jsdom tests and small sessions keep the full-mount path. Prepend
  ("load older") anchoring falls back to the height table when the anchor row
  is unmounted; switching sessions clears the height cache.
- **Stable measurement** (the crash fix): the measurement callback only
  recomputes spacer heights (`applyMeasured`) and never moves the window, so
  measuring a row cannot cascade into mounting new rows; while windowed the
  flow disables `content-visibility` on rows and sets
  `overflow-anchor: none` on the scrollport, eliminating the scroll-anchoring
  feedback oscillation verified in-browser (115 wheel notches plus return to
  top, no crash).
- **Render-memory observation** (`render-memory.ts`): a mount-counted hook on
  `ConversationRoot` samples `performance.memory` every 10s, warns once when
  idle heap grows ≥ 64 MB over 5 minutes, and exposes
  `window.__dshRenderMemory` for DevTools inspection.
- **Resident-window LRU** (`Session`/`SessionManager`): `Session` records
  `lastActiveAt` on open and gains `releaseWindow()`/`hasOpenWindow()`;
  the manager caps concurrently open windows at `MAX_RESIDENT_WINDOWS = 20`
  and, on selection, releases the oldest non-selected, non-running window
  (instance stays warm; the next open refetches history).

## Consequences

A 900+ node session mounts only ~20–60 rows and scrolls without the
scroll-anchoring crash that the first rc.56 build shipped; heap growth is
observable and large session sets stop accumulating stale windows. jsdom and
small sessions are byte-for-byte unchanged in behavior.

## Alternatives considered

- Absolute-positioned rows (FileTree-style): maximally efficient but hostile
  to dynamic streaming heights. The spacer window keeps mounted rows in normal
  flow and reuses the existing anchoring/ledger machinery.
- Owning scroll anchoring ourselves by compensating scrollTop after each
  measurement: fights the browser's own anchoring on every frame. Disabling
  `overflow-anchor` while windowed is one line and the existing reader-
  attribution ledger already owns positions.
- Dropping windows entirely (drop the `Session`): loses queue/address/blank
  state; `releaseWindow()` keeps the instance warm and refetches on reopen.
