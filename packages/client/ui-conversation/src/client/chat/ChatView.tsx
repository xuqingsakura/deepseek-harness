// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { PendingSteeringBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'
import {
  computeWindow, prefixSums, ROW_ESTIMATE_HEIGHT, tailWindow,
  WINDOW_BUFFER_ROWS, WINDOW_THRESHOLD,
} from './chat-window.ts'
import type { RowGeometry } from './chat-window.ts'
const FOLLOW_THRESHOLD = 24

/** Pixel buffer kept mounted above/below the viewport while windowed
 *  (WINDOW_BUFFER_ROWS rows at the estimate height). */
const WINDOW_BUFFER_PX = WINDOW_BUFFER_ROWS * ROW_ESTIMATE_HEIGHT

/** Kind-level fallback heights (px) used before a row is measured, so the
 *  scrollbar and spacers track long flows from the first paint. */
const KIND_ESTIMATES: Readonly<Record<string, number>> = {
  'assistant-step': 160,
  user: 84,
  steering: 72,
  context: 84,
  'tool-call': 132,
  command: 64,
  'manual-compaction': 96,
  compaction: 132,
  'model-retry': 96,
  'turn-error': 84,
  'turn-max-tokens': 84,
  'turn-tail': 56,
  unknown: 64,
}

function kindEstimate(kind: string | undefined): number {
  return kind === undefined ? ROW_ESTIMATE_HEIGHT : (KIND_ESTIMATES[kind] ?? ROW_ESTIMATE_HEIGHT)
}

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** One mounted windowing view: the half-open row range plus the spacer
 *  heights that preserve scrollHeight for rows mounted out of the window. */
interface WindowView {
  readonly start: number
  readonly end: number
  readonly top: number
  readonly bottom: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the full mounted set. The fallback keeps jsdom
  // and pre-layout states deterministic; a virtualizer naturally bounds it.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row !== null && list.contains(row)) return row
      }
    }
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      // Skipping while hidden saves the per-second wakeups and state churn
      // (Chromium also throttles hidden-page timers; this removes the work).
      if (document.visibilityState !== 'visible') return
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    // Re-sync the instant the document becomes visible again.
    const onVisibility = (): void => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, inspectCall, chatScroll, forkAt,
  fileMentions, t,
}: ChatViewSlotProps) {
  const order = useSession(s => s.chat.order)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const inbox = useSession(s => s.queue)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)
  /** Coalesces scroll passes to one per animation frame. */
  const scrollRafRef = useRef<number | null>(null)
  /** Guard against a second schedule while one pass is pending (also correct
   *  under a synchronous requestAnimationFrame shim). */
  const scrollScheduledRef = useRef(false)
  /** Windowing is enabled only in a real browser (ResizeObserver present)
   *  on long flows; jsdom and small sessions keep the full-mount path. */
  const windowing = typeof ResizeObserver !== 'undefined' && typeof ResizeObserverEntry !== 'undefined'
    && order.length >= WINDOW_THRESHOLD

  // Scroll anchoring would fight the spacer math: a measured height change
  // shifts the top spacer, the browser adjusts scrollTop to keep the viewport
  // content stable, the window recomputes, and the two oscillate until React
  // gives up. While windowed, anchor the scrollport to nothing and own the
  // position ourselves (the existing reader-attribution ledger already does).
  useEffect(() => {
    const local = listRef.current
    if (local === null) return
    const el = scrollerOf(local)
    const previous = el.style.overflowAnchor
    if (windowedRef.current) el.style.overflowAnchor = 'none'
    return () => {
      el.style.overflowAnchor = previous
    }
    // Re-run when windowing toggles (the ref mirrors it during render).
  }, [windowing])
  const windowedRef = useRef(false)
  windowedRef.current = windowing
  const orderRef = useRef(order)
  orderRef.current = order
  const heightsRef = useRef(new Map<string, number>())
  const geometry = useMemo<RowGeometry>(
    () => ({ heights: heightsRef.current, estimate: ROW_ESTIMATE_HEIGHT }),
    [],
  )
  const heights = geometry.heights
  /** Mounted row window plus spacer heights; null while windowing is off. */
  const [windowView, setWindowView] = useState<WindowView | null>(null)
  const windowViewRef = useRef<WindowView | null>(null)
  const measureRafRef = useRef<number | null>(null)
  const sessionIdRef = useRef(sessionId)

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    if (windowedRef.current) {
      // Pinned readers see the flow tail: mount the tail window and place the
      // scrollport at the content floor computed from the height table (the
      // DOM scrollHeight lags measurement by a frame; the observer converges).
      const next = tailWindow(orderRef.current, geometry, el.clientHeight, WINDOW_BUFFER_PX)
      const sums = prefixSums(orderRef.current, geometry)
      windowViewRef.current = {
        start: next.start,
        end: next.end,
        top: sums[next.start] ?? 0,
        bottom: (sums[orderRef.current.length] ?? 0) - (sums[next.end] ?? 0),
      }
      setWindowView(windowViewRef.current)
      el.scrollTop = Math.max(0, (sums[orderRef.current.length] ?? 0) - el.clientHeight)
    } else {
      el.scrollTop = el.scrollHeight
    }
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }

  /** Seed kind-level height estimates for unmeasured rows (measurement
   *  replaces them as rows paint); prunes keys that left the flow. */
  const seedHeights = (): void => {
    const keys = orderRef.current
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      if (key === undefined) continue
      if (heightsRef.current.has(key)) continue
      heightsRef.current.set(key, kindEstimate(nodeStore.get(key)?.kind))
    }
    if (heightsRef.current.size > keys.length + 128) {
      const live = new Set(keys)
      for (const key of heightsRef.current.keys()) {
        if (!live.has(key)) heightsRef.current.delete(key)
      }
    }
  }

  /** Recompute the mounted window and spacer heights from the latest scroll
   *  geometry and height cache; a no-op when the view is unchanged. */
  const refreshWindow = (): void => {
    if (!windowedRef.current) return
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: refresh runs from effects that own a live list. */
    if (local === null) return
    seedHeights()
    const el = scrollerOf(local)
    const range = computeWindow(orderRef.current, geometry, el.scrollTop, el.scrollTop + el.clientHeight, WINDOW_BUFFER_PX)
    const sums = prefixSums(orderRef.current, geometry)
    const next: WindowView = {
      start: range.start,
      end: range.end,
      top: sums[range.start] ?? 0,
      bottom: (sums[orderRef.current.length] ?? 0) - (sums[range.end] ?? 0),
    }
    const prev = windowViewRef.current
    if (prev === null || prev.start !== next.start || prev.end !== next.end
      || prev.top !== next.top || prev.bottom !== next.bottom) {
      windowViewRef.current = next
      setWindowView(next)
    }
  }
  /** Measurement-only refresh: keep the mounted window range, recompute only
   *  the spacer heights from the latest height cache. Unlike refreshWindow this
   *  never moves the window, so measuring a row cannot cascade into mounting
   *  new rows (the loop that starved the main thread on wheel scrolls). */
  const applyMeasured = (): void => {
    const prev = windowViewRef.current
    if (!windowedRef.current || prev === null) return
    const sums = prefixSums(orderRef.current, geometry)
    const next: WindowView = {
      start: prev.start,
      end: prev.end,
      top: sums[prev.start] ?? 0,
      bottom: (sums[orderRef.current.length] ?? 0) - (sums[prev.end] ?? 0),
    }
    if (next.top !== prev.top || next.bottom !== prev.bottom) {
      windowViewRef.current = next
      setWindowView(next)
    }
  }
  const applyMeasuredRef = useRef<() => void>(() => {})
  applyMeasuredRef.current = applyMeasured

  const refreshWindowRef = useRef<() => void>(() => {})
  refreshWindowRef.current = refreshWindow


  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      openedRef.current = true
      const saved = chatScroll.read()
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      refreshWindowRef.current()
      followSigRef.current = followSig
      return
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) {
        el.scrollTop += flowTop(row, el) - anchor.top
      } else if (windowedRef.current) {
        // Windowing may have unmounted the anchor row: place it from the
        // height table (its content top is the prefix sum before its index).
        const index = orderRef.current.indexOf(anchor.key)
        if (index >= 0) {
          const sums = prefixSums(orderRef.current, geometry)
          el.scrollTop = Math.max(0, (sums[index] ?? 0) - anchor.top)
        }
      }
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      refreshWindowRef.current()
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering || (tipMoved && atBottomRef.current)) toBottom(el)
    refreshWindowRef.current()
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    // Coalesce per animation frame: wheel/touch deltas can fire several
    // scroll events per frame, and each pass reads layout (elementsFromPoint
    // + getBoundingClientRect). One pass per frame keeps fast scrolling
    // cheap; the painted frame is identical either way.
    if (scrollScheduledRef.current) return
    scrollScheduledRef.current = true
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollScheduledRef.current = false
      scrollRafRef.current = null
      // The window follows reader geometry; refresh before the anchor pass so
      // saved positions and spacer math agree with the mounted window.
      refreshWindowRef.current()
      const local = listRef.current
      /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
      if (local === null) return
      const el = scrollerOf(local)
      // Only reader input may make raw scroll geometry change follow ownership:
      // a delivered position that deviates from the observed-top ledger (every
      // programmatic write records itself there synchronously). This covers
      // wheel, touch, scrollbar, and keyboard alike without naming devices.
      // Browser shrink-clamps land exactly on the floor min and delayed
      // programmatic deliveries land on the ledger itself, so both preserve
      // the current ownership state.
      const floor = Math.max(0, el.scrollHeight - el.clientHeight)
      const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
      const isAtBottom = movedByReader
        ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
        : atBottomRef.current
      if (!movedByReader && isAtBottom) {
        toBottom(el)
        return
      }
      atBottomRef.current = isAtBottom
      setAtBottom(isAtBottom)
      const position = isAtBottom ? null : scrollPosition(local, el)
      if (isAtBottom) {
        anchorRef.current = null
      } else if (anchorRef.current !== null && position !== null) {
        anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
      }
      // Continuous save (unmount happens after ref detach, so saving there is
      // too late); pinned-to-bottom clears so a remount keeps following.
      if (isAtBottom) chatScroll.save(null)
      else if (position !== null) chatScroll.save(position)
      observedTopRef.current = el.scrollTop
    })
  }

  // Bind the scroll listener on the resolved scrollport once per mount;
  // reader-input attribution rides the observed-top ledger, not per-device
  // input listeners.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // Windowing height cache: measure every mounted row and feed the cache back
  // into spacer math. Unmeasured rows already carry kind-level estimates, so
  // the first measurement just tightens the scrollbar; streaming growth of a
  // mounted row is captured on the same observer (the column follower already
  // owns pinned-scroll re-pinning; this effect only refreshes window geometry).
  useEffect(() => {
    if (!windowedRef.current || typeof ResizeObserver === 'undefined') return
    const column = columnRef.current
    if (column === null) return
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const key = target.dataset.chatFlowKey
        if (key === undefined || target.offsetHeight <= 0) continue
        if (heightsRef.current.get(key) !== target.offsetHeight) {
          heightsRef.current.set(key, target.offsetHeight)
          changed = true
        }
      }
      if (changed && measureRafRef.current === null) {
        measureRafRef.current = requestAnimationFrame(() => {
          measureRafRef.current = null
          // Spacers only: never re-derive the window from measured heights here
          // (see applyMeasured — remounting rows from a height change loops).
          applyMeasuredRef.current()
        })
      }
    })
    for (const row of column.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) observer.observe(row)
    return () => {
      observer.disconnect()
      if (measureRafRef.current !== null) cancelAnimationFrame(measureRafRef.current)
      measureRafRef.current = null
    }
  }, [heights, windowView])


  // A different session on the same mounted seat clears the windowing state:
  // node keys are session-local and stale heights must not leak across sessions.
  useEffect(() => {
    if (sessionIdRef.current === sessionId) return
    sessionIdRef.current = sessionId
    heightsRef.current.clear()
    windowViewRef.current = null
    setWindowView(null)
  }, [sessionId])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <div ref={columnRef} className={css.column} data-chat-flow="" data-windowed={windowing && windowView !== null ? '' : undefined}>
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          {hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          {windowing && windowView !== null && windowView.end <= order.length ? (
            <>
              {windowView.top > 0 && (
                <div className={css.windowSpacer} style={{ height: windowView.top }} aria-hidden="true" />
              )}
              {order.slice(windowView.start, windowView.end).map(nodeKey => (
                <ChatNodeSeat
                  key={nodeKey}
                  nodeKey={nodeKey}
                  useSession={useSession}
                  selectedCallId={selectedCallId}
                  cwd={cwd}
                  openFile={openFile}
                  inspectCall={inspectCall}
                  forkAt={forkAt}
                  loadImage={loadImage}
                  fileMentions={fileMentions}
                  renderSlot={renderSlot}
                  t={t}
                />
              ))}
              {windowView.bottom > 0 && (
                <div className={css.windowSpacer} style={{ height: windowView.bottom }} aria-hidden="true" />
              )}
            </>
          ) : order.map(nodeKey => (
            <ChatNodeSeat
              key={nodeKey}
              nodeKey={nodeKey}
              useSession={useSession}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={openFile}
              inspectCall={inspectCall}
              forkAt={forkAt}
              loadImage={loadImage}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />
          ))}
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus startTime={runningTurnStart} t={t} />}
          {pendingSteering.map(item => (
            <PendingSteeringBubble key={item.id} content={item.content} loadImage={loadImage} t={t} />
          ))}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
