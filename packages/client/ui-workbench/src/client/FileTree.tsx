/** Lazy-loading file tree for the workbench panel, with a right-click context
 * menu for new file / new folder / rename / delete over the workbench Remote
 * filesystem verbs. Rows are windowed: a fixed 24px row height lets a huge
 * directory render only the visible slice plus a scroll buffer, so expanding
 * a large tree never materializes every row's DOM. Hidden (dot-prefixed)
 * entries render dimmed, symlinks show a link badge (broken ones disabled),
 * and every row exposes hover actions: an @-reference button (appends
 * `@<relative path>` to the composer draft) and a copy-path button. */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchDirEntry, WorkbenchDirListing, WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCodeOutline16, IconFolderClose16, IconFolderOpen16, IconLinkOutline16, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './FileTree.module.css'

/** The injected verbs the tree panel hands down (listing + filesystem ops). */
export interface FileTreeInjected {
  /** List one directory level; an empty path is the session cwd itself. */
  listDir: (sessionId: string, path: string) => Promise<WorkbenchDirListing>
  /** Create one directory (and parents). */
  fsMkdir: (sessionId: string, path: string) => Promise<void>
  /** Rename or move one file or directory. */
  fsRename: (sessionId: string, path: string, nextPath: string) => Promise<void>
  /** Delete one file or (recursively) directory. */
  fsRemove: (sessionId: string, path: string, recursive?: boolean) => Promise<void>
  /** Write a new file's content (version omitted = create-or-overwrite). */
  writeText: (sessionId: string, path: string, content: string, version?: WorkbenchWriteResult['version']) => Promise<WorkbenchWriteResult>
}

/** Full props for the file tree. */
export type FileTreeProps = FileTreeInjected & {
  /** The conversation whose cwd this tree browses. */
  sessionId: string
  /** The session cwd ('' resolves to it). */
  cwd: string
  /** Open a file for viewing. */
  onOpen: (path: string) => void
  /** The active file path, highlighted when it matches a row. */
  activePath?: string | undefined
  /** Append `@<relative path>` to the composer draft (absent hides the button). */
  onReference?: ((relativePath: string) => void) | undefined
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** Locale-bound copy. */
  t: TranslateNS<typeof NS>
}

/** Join a child path under its parent; the root path is ''. */
function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

/** Context menu target: a row path, its kind, and the pointer position. */
interface TreeMenuState {
  path: string
  name: string
  kind: 'file' | 'directory'
  x: number
  y: number
}

/** Fixed row height in px; the windowing math slices rows by it. */
const ROW_HEIGHT = 24
/** Extra rows rendered above/below the viewport while scrolling. */
const RENDER_BUFFER = 12
/** Rows rendered before the container's first measurement (tests, SSR). */
const FALLBACK_ROWS = 60

/** localStorage key of one session's expanded directory set. */
const expandedKey = (sessionId: string): string => `dsh-workbench:tree-expanded:${sessionId}`

/** Restore a session's persisted expansion set (best-effort; malformed data falls back to empty). */
function loadExpanded(sessionId: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(expandedKey(sessionId))
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

/** Persist one session's expansion set (best-effort; storage failure is ignored). */
function saveExpanded(sessionId: string, expanded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(expandedKey(sessionId), JSON.stringify([...expanded]))
  } catch {
    // Quota / privacy mode: expansion persistence is a convenience, never a hard failure.
  }
}

/** One flat, visible tree row fed to the windowing renderer. */
interface VisibleRow {
  /** Stable identity (the path; placeholder rows suffix their state). */
  key: string
  /** The row's tree path (placeholder rows reuse the owning directory's path). */
  path: string
  /** Row label; empty for loading/error/empty placeholders. */
  name: string
  /** Indent depth (0 = root child). */
  depth: number
  kind: 'file' | 'directory'
  /** Whether a directory row is expanded. */
  expanded: boolean
  /** loaded rows carry a file/directory; the rest render a hint. */
  state: 'loaded' | 'loading' | 'error' | 'empty' | 'truncated'
  /** Dot-prefixed entry (rendered dimmed). */
  hidden: boolean
  /** Symbolic link (its type describes the target). */
  isSymlink: boolean
  /** For a symlink: the target is missing or unreadable. */
  broken: boolean
}

/** Directories first, then natural name order (VSCode-like). */
function sortEntries(entries: readonly WorkbenchDirEntry[]): WorkbenchDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/**
 * Flatten the expanded tree into one ordered row list. Each expanded
 * directory contributes its own row plus a loading/error/empty/truncated
 * placeholder or its sorted children; collapsed directories contribute one
 * row. Pure and deterministic so the renderer can window it by fixed row
 * height.
 * @param root - root children (undefined while the root listing is pending).
 * @param childrenByPath - cached listings per directory path.
 * @param truncatedByPath - whether each listing hit the row bound.
 * @param expanded - the set of expanded directory paths.
 * @param loadingPath - directory whose listing is in flight ('' = root).
 * @param errorPath - directory whose listing failed ('' = root).
 * @returns the flattened visible rows in render order.
 */
function flattenVisibleRows(
  root: readonly WorkbenchDirEntry[] | undefined,
  childrenByPath: Readonly<Record<string, WorkbenchDirEntry[]>>,
  truncatedByPath: Readonly<Record<string, boolean>>,
  expanded: ReadonlySet<string>,
  loadingPath: string | undefined,
  errorPath: string | undefined,
): VisibleRow[] {
  const rows: VisibleRow[] = []
  const pushPlaceholder = (path: string, depth: number, state: VisibleRow['state']): void => {
    rows.push({ key: `${path}\u0000${state}`, path, name: '', depth, kind: 'file', expanded: false, state, hidden: false, isSymlink: false, broken: false })
  }
  const pushDirectory = (path: string, entry: WorkbenchDirEntry, depth: number): void => {
    const isExpanded = expanded.has(path)
    rows.push({
      key: path, path, name: entry.name, depth, kind: 'directory', expanded: isExpanded,
      state: 'loaded', hidden: entry.hidden, isSymlink: entry.isSymlink, broken: entry.broken,
    })
    if (!isExpanded) return
    if (loadingPath === path) { pushPlaceholder(path, depth + 1, 'loading'); return }
    if (errorPath === path) { pushPlaceholder(path, depth + 1, 'error'); return }
    const children = childrenByPath[path]
    if (children === undefined || children.length === 0) {
      pushPlaceholder(path, depth + 1, 'empty')
      if (truncatedByPath[path] === true) pushPlaceholder(path, depth + 1, 'truncated')
      return
    }
    for (const child of sortEntries(children)) {
      const sub = childPath(path, child.name)
      if (child.type === 'directory') pushDirectory(sub, child, depth + 1)
      else rows.push({
        key: sub, path: sub, name: child.name, depth: depth + 1, kind: 'file', expanded: false,
        state: 'loaded', hidden: child.hidden, isSymlink: child.isSymlink, broken: child.broken,
      })
    }
    if (truncatedByPath[path] === true) pushPlaceholder(path, depth + 1, 'truncated')
  }
  if (root !== undefined) {
    for (const entry of sortEntries(root)) {
      const path = childPath('', entry.name)
      if (entry.type === 'directory') pushDirectory(path, entry, 0)
      else rows.push({
        key: path, path, name: entry.name, depth: 0, kind: 'file', expanded: false,
        state: 'loaded', hidden: entry.hidden, isSymlink: entry.isSymlink, broken: entry.broken,
      })
    }
  }
  return rows
}

/** Relative path of `path` under `cwd` ('/'-separated), for @-references. */
function relativeTo(cwd: string, path: string): string {
  const base = cwd.replace(/[\\/]+$/, '')
  const full = path.replace(/\\/g, '/')
  if (full === base) return ''
  return full.startsWith(base + '/') ? full.slice(base.length + 1) : full
}

/** Props shared by every rendered row. */
interface RowDispatchProps {
  activePath: string | undefined
  cwd: string
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onReference: ((relativePath: string) => void) | undefined
  onCopy: (path: string) => void
  onContextMenu: (event: React.MouseEvent, path: string, name: string, kind: 'file' | 'directory') => void
  t: TranslateNS<typeof NS>
}

/** One windowed row: absolute-positioned at `index * ROW_HEIGHT`. */
const VirtualTreeRow = memo(function VirtualTreeRow(props: RowDispatchProps & {
  row: VisibleRow
  index: number
  total: number
}) {
  const { row, index, total, activePath, cwd, onToggle, onOpen, onReference, onCopy, onContextMenu, t } = props
  const style = { top: `${index * ROW_HEIGHT}px`, paddingLeft: `${8 + row.depth * 14}px` }
  if (row.state !== 'loaded') {
    const label = row.state === 'loading' ? t('tree.loading')
      : row.state === 'error' ? t('tree.error')
        : row.state === 'truncated' ? t('tree.truncated') : t('tree.empty')
    return (
      <div className={css.virtualRow} style={style} role="treeitem" aria-level={row.depth + 1} aria-setsize={total} aria-posinset={index + 1}>
        <span className={css.hintRow}>{label}</span>
      </div>
    )
  }
  const isDir = row.kind === 'directory'
  const isActive = activePath === row.path
  const rowClass = isActive ? css.rowActive : css.row
  const cls = [
    rowClass,
    row.hidden ? css.rowHidden : undefined,
    row.broken ? css.rowBroken : undefined,
  ].filter(Boolean).join(' ')
  return (
    <div className={css.virtualRow} style={style} role="treeitem" aria-level={row.depth + 1} aria-setsize={total} aria-posinset={index + 1} aria-expanded={isDir ? row.expanded : undefined}>
      <button
        type="button"
        className={cls}
        title={row.broken ? `${row.path} — ${t('tree.brokenSymlink')}` : row.path}
        onClick={() => { if (isDir) onToggle(row.path); else onOpen(row.path) }}
        onContextMenu={(event) => { onContextMenu(event, row.path, row.name, isDir ? 'directory' : 'file') }}
      >
        {isDir
          ? row.expanded
            ? <IconFolderOpen16 size={14} className={css.iconDir} />
            : <IconFolderClose16 size={14} className={css.iconDir} />
          : <IconCodeOutline16 size={14} className={css.iconFile} />}
        {row.isSymlink ? <IconLinkOutline16 size={12} className={css.iconSymlink} /> : null}
        <span className={css.rowName}>{row.name}</span>
        <span className={css.rowActions} onClick={(event) => { event.stopPropagation() }}>
          {onReference !== undefined ? (
            <button
              type="button"
              className={css.rowAction}
              title={t('tree.reference')}
              aria-label={t('tree.reference')}
              onClick={(event) => { event.stopPropagation(); onReference(relativeTo(cwd, row.path)) }}
            >
              @
            </button>
          ) : null}
          <button
            type="button"
            className={css.rowAction}
            title={t('tree.copyPath')}
            aria-label={t('tree.copyPath')}
            onClick={(event) => { event.stopPropagation(); onCopy(row.path) }}
          >
            ⧉
          </button>
        </span>
      </button>
    </div>
  )
})

/** Windowed row list: a fixed-height spacer plus only the visible slice. */
function VirtualTreeRows(props: { rows: readonly VisibleRow[] } & RowDispatchProps) {
  const { rows, activePath, cwd, onToggle, onOpen, onReference, onCopy, onContextMenu, t } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const [slice, setSlice] = useState<{ start: number; end: number }>(() => ({
    start: 0,
    end: Math.min(FALLBACK_ROWS, rows.length),
  }))

  // Measure the scrollport once its height is known; keep the slice in range
  // when rows grow/shrink (expand/collapse) without jumping the scrollbar.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      if (el.clientHeight <= 0) return
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - RENDER_BUFFER)
      const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + RENDER_BUFFER)
      setSlice(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [rows.length])

  const onScroll = useCallback((): void => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollRef.current
      if (el === null) return
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - RENDER_BUFFER)
      const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + RENDER_BUFFER)
      setSlice(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
    })
  }, [rows.length])

  const start = Math.min(slice.start, rows.length)
  const end = Math.min(slice.end, rows.length)
  const visible = rows.slice(start, end)

  return (
    <div ref={scrollRef} className={css.tree} role="tree" aria-label={t('tree.aria')} onScroll={onScroll}>
      <div className={css.spacer} style={{ height: `${rows.length * ROW_HEIGHT}px` }}>
        {visible.map((row, offset) => (
          <VirtualTreeRow
            key={row.key}
            row={row}
            index={start + offset}
            total={rows.length}
            activePath={activePath}
            cwd={cwd}
            onToggle={onToggle}
            onOpen={onOpen}
            onReference={onReference}
            onCopy={onCopy}
            onContextMenu={onContextMenu}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The lazy directory tree: one level per expansion, no recursion in the DOM.
 * Root children load on mount (or on session/cwd change); each directory
 * expands on click, caches its listing, and collapses on a second click.
 * Right-click opens a context menu with filesystem actions that refresh the
 * affected parent listing after they settle. Rendering is windowed by fixed
 * row height (see VirtualTreeRows).
 */
export function FileTree({
  sessionId, cwd, listDir, fsMkdir, fsRename, fsRemove, writeText, onOpen, activePath, onReference, refreshTick, t,
}: FileTreeProps) {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkbenchDirEntry[]>>({})
  const [truncatedByPath, setTruncatedByPath] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => loadExpanded(sessionId))
  const [loadingPath, setLoadingPath] = useState<string | undefined>(undefined)
  const [errorPath, setErrorPath] = useState<string | undefined>(undefined)
  const [menu, setMenu] = useState<TreeMenuState | undefined>(undefined)
  const [menuError, setMenuError] = useState<string | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Keep the latest verbs without retriggering on inline prop identity.
  const verbs = useRef({ listDir, fsMkdir, fsRename, fsRemove, writeText })
  verbs.current = { listDir, fsMkdir, fsRename, fsRemove, writeText }

  // Reset the tree whenever the bound session or cwd changes.
  useEffect(() => {
    let alive = true
    setChildrenByPath({})
    setTruncatedByPath({})
    setExpanded(loadExpanded(sessionId))
    setErrorPath(undefined)
    void verbs.current.listDir(sessionId, '')
      .then((listing) => { if (alive) { setChildrenByPath({ '': listing.entries }); setTruncatedByPath({ '': listing.truncated }) } })
      .catch(() => { if (alive) setErrorPath('') })
    return () => { alive = false }
  }, [sessionId, cwd])

  // The caller's refresh tick wipes the level cache and reloads the root
  // plus every currently expanded directory (expansion set survives).
  const lastTick = useRef(refreshTick)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    setChildrenByPath({})
    setTruncatedByPath({})
    setErrorPath(undefined)
    const reload = (path: string): void => {
      void verbs.current.listDir(sessionId, path)
        .then((listing) => {
          setChildrenByPath(prev => ({ ...prev, [path]: listing.entries }))
          setTruncatedByPath(prev => ({ ...prev, [path]: listing.truncated }))
        })
        .catch(() => { setErrorPath(path) })
    }
    reload('')
    for (const dir of stateRef.current.expanded) reload(dir)
  }, [refreshTick, sessionId])

  // Persist the expansion set per session (refresh-safe restore).
  useEffect(() => { saveExpanded(sessionId, expanded) }, [sessionId, expanded])

  // Dismiss the context menu on outside pointer-down or Escape.
  useEffect(() => {
    if (menu === undefined) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  // Stable toggle: read the latest expand/cache state through a ref so the
  // callback identity never changes and memoized rows skip re-renders.
  const stateRef = useRef({ expanded, childrenByPath })
  stateRef.current = { expanded, childrenByPath }
  const toggle = useCallback(async (path: string) => {
    setErrorPath(undefined)
    const current = stateRef.current
    if (current.expanded.has(path)) {
      setExpanded(prev => new Set([...prev].filter(p => p !== path)))
      return
    }
    if (current.childrenByPath[path] !== undefined) {
      setExpanded(prev => new Set([...prev, path]))
      return
    }
    setLoadingPath(path)
    try {
      const listing = await verbs.current.listDir(sessionId, path)
      setChildrenByPath(prev => ({ ...prev, [path]: listing.entries }))
      setTruncatedByPath(prev => ({ ...prev, [path]: listing.truncated }))
      setExpanded(prev => new Set([...prev, path]))
    } catch {
      setErrorPath(path)
    } finally {
      setLoadingPath(undefined)
    }
  }, [sessionId])

  /** Reload one directory level after a mutation. */
  const reload = useCallback(async (path: string) => {
    try {
      const listing = await verbs.current.listDir(sessionId, path)
      setChildrenByPath(prev => ({ ...prev, [path]: listing.entries }))
      setTruncatedByPath(prev => ({ ...prev, [path]: listing.truncated }))
      setErrorPath(undefined)
    } catch {
      setErrorPath(path)
    }
  }, [sessionId])

  const runMutation = useCallback(async (action: () => Promise<unknown>, parent: string) => {
    setMenuError(undefined)
    try {
      await action()
      await reload(parent)
      setMenu(undefined)
      return true
    } catch (error: unknown) {
      setMenuError(error instanceof Error ? error.message : String(error))
      return false
    }
  }, [reload])

  /** Parent path of a tree path ('' for root children). */
  const parentOf = useCallback((path: string): string => {
    const index = path.lastIndexOf('/')
    return index === -1 ? '' : path.slice(0, index)
  }, [])

  const newFile = useCallback((parent: string) => {
    const name = window.prompt(t('tree.newFilePrompt'))
    if (name === null || name.trim() === '') return
    const target = childPath(parent, name.trim())
    void runMutation(() => verbs.current.writeText(sessionId, target, '', undefined), parent)
  }, [runMutation, sessionId, t])

  const newFolder = useCallback((parent: string) => {
    const name = window.prompt(t('tree.newFolderPrompt'))
    if (name === null || name.trim() === '') return
    const target = childPath(parent, name.trim())
    void runMutation(() => verbs.current.fsMkdir(sessionId, target), parent)
  }, [runMutation, sessionId, t])

  const rename = useCallback((state: TreeMenuState) => {
    const name = window.prompt(t('tree.renamePrompt'), state.name)
    if (name === null || name.trim() === '' || name.trim() === state.name) return
    const parent = parentOf(state.path)
    void runMutation(() => verbs.current.fsRename(sessionId, state.path, childPath(parent, name.trim())), parent)
  }, [parentOf, runMutation, sessionId, t])

  const remove = useCallback((state: TreeMenuState) => {
    if (!window.confirm(t('tree.deleteConfirm', { name: state.name }))) return
    void runMutation(() => verbs.current.fsRemove(sessionId, state.path, state.kind === 'directory'), parentOf(state.path))
  }, [parentOf, runMutation, sessionId, t])

  const openMenu = useCallback((event: React.MouseEvent, path: string, name: string, kind: 'file' | 'directory') => {
    event.preventDefault()
    event.stopPropagation()
    setMenuError(undefined)
    setMenu({ path, name, kind, x: event.clientX, y: event.clientY })
  }, [])

  /** Copy a row's absolute path with a transient "copied" state. */
  const copyPath = useCallback((path: string) => {
    void writeClipboard(path).then((ok) => { if (!ok) return })
  }, [])

  const rows = useMemo(() => flattenVisibleRows(childrenByPath[''], childrenByPath, truncatedByPath, expanded, loadingPath, errorPath),
    [childrenByPath, truncatedByPath, expanded, loadingPath, errorPath])
  const root = childrenByPath['']
  const rootTruncated = truncatedByPath[''] === true

  return (
    <div className={css.treeWrap}
      onContextMenu={(event) => {
        // Blank-area right-click targets the tree root.
        event.preventDefault()
        setMenuError(undefined)
        setMenu({ path: '', name: '', kind: 'directory', x: event.clientX, y: event.clientY })
      }}
    >
      {root === undefined ? (
        errorPath === undefined
          ? <div className={css.hint}>{t('tree.loading')}</div>
          : <div className={css.hint}>{t('tree.error')}</div>
      ) : root.length === 0 ? (
        <div className={css.hint}>{rootTruncated ? t('tree.truncated') : t('tree.empty')}</div>
      ) : (
        <VirtualTreeRows
          rows={rows}
          activePath={activePath}
          cwd={cwd}
          onToggle={toggle}
          onOpen={onOpen}
          onReference={onReference}
          onCopy={copyPath}
          onContextMenu={openMenu}
          t={t}
        />
      )}
      {menu !== undefined ? (
        <div ref={menuRef} className={css.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('tree.menuAria')}>
          {menuError !== undefined ? <div className={css.menuError}>{menuError}</div> : null}
          <button type="button" role="menuitem" className={css.menuItem} onClick={() => { newFile(parentOf(menu.path)) }}>
            {t('tree.newFile')}
          </button>
          <button type="button" role="menuitem" className={css.menuItem} onClick={() => { newFolder(parentOf(menu.path)) }}>
            {t('tree.newFolder')}
          </button>
          {menu.path !== '' ? (
            <>
              <button type="button" role="menuitem" className={css.menuItem} onClick={() => { rename(menu) }}>
                {t('tree.rename')}
              </button>
              <button type="button" role="menuitem" className={css.menuItemDanger} onClick={() => { remove(menu) }}>
                {t('tree.delete')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
