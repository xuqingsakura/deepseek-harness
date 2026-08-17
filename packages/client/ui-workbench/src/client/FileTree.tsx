/** Lazy-loading file tree for the workbench panel, with a right-click context
 * menu for new file / new folder / rename / delete over the workbench Remote
 * filesystem verbs. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkbenchDirEntry, WorkbenchWriteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './FileTree.module.css'

/** The injected verbs the tree panel hands down (listing + filesystem ops). */
export interface FileTreeInjected {
  /** List one directory level; an empty path is the session cwd itself. */
  listDir(sessionId: string, path: string): Promise<WorkbenchDirEntry[]>
  /** Create one directory (and parents). */
  fsMkdir(sessionId: string, path: string): Promise<void>
  /** Rename or move one file or directory. */
  fsRename(sessionId: string, path: string, nextPath: string): Promise<void>
  /** Delete one file or (recursively) directory. */
  fsRemove(sessionId: string, path: string, recursive?: boolean): Promise<void>
  /** Write a new file's content (version omitted = create-or-overwrite). */
  writeText(sessionId: string, path: string, content: string, version?: WorkbenchWriteResult['version']): Promise<WorkbenchWriteResult>
}

/** Full props for the file tree. */
export type FileTreeProps = FileTreeInjected & {
  /** The conversation whose cwd this tree browses. */
  sessionId: string
  /** The session cwd ('' resolves to it). */
  cwd: string
  /** Open a file for viewing. */
  onOpen(path: string): void
  /** The active file path, highlighted when it matches a row. */
  activePath?: string | undefined
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

/**
 * The lazy directory tree: one level per expansion, no recursion. Root
 * children load on mount (or on session/cwd change); each directory expands
 * on click, caches its listing, and collapses on a second click. Right-click
 * opens a context menu with filesystem actions that refresh the affected
 * parent listing after they settle.
 */
export function FileTree({
  sessionId, cwd, listDir, fsMkdir, fsRename, fsRemove, writeText, onOpen, activePath, t,
}: FileTreeProps) {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkbenchDirEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
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
    setExpanded(new Set())
    setErrorPath(undefined)
    void verbs.current.listDir(sessionId, '')
      .then((entries) => { if (alive) setChildrenByPath({ '': entries }) })
      .catch(() => { if (alive) setErrorPath('') })
    return () => { alive = false }
  }, [sessionId, cwd])

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

  const toggle = useCallback(async (path: string) => {
    setErrorPath(undefined)
    if (expanded.has(path)) {
      setExpanded(prev => new Set([...prev].filter(p => p !== path)))
      return
    }
    if (childrenByPath[path] !== undefined) {
      setExpanded(prev => new Set([...prev, path]))
      return
    }
    setLoadingPath(path)
    try {
      const entries = await verbs.current.listDir(sessionId, path)
      setChildrenByPath(prev => ({ ...prev, [path]: entries }))
      setExpanded(prev => new Set([...prev, path]))
    } catch {
      setErrorPath(path)
    } finally {
      setLoadingPath(undefined)
    }
  }, [expanded, childrenByPath, sessionId])

  /** Reload one directory level after a mutation. */
  const reload = useCallback(async (path: string) => {
    try {
      const entries = await verbs.current.listDir(sessionId, path)
      setChildrenByPath(prev => ({ ...prev, [path]: entries }))
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

  const root = childrenByPath['']

  return (
    <div className={css.tree} role="tree" aria-label={t('tree.aria')}
      onContextMenu={(event) => {
        // Blank-area right-click targets the tree root.
        event.preventDefault()
        setMenuError(undefined)
        setMenu({ path: '', name: '', kind: 'directory', x: event.clientX, y: event.clientY })
      }}
    >
      {root === undefined ? (
        <div className={css.hint}>{t('tree.loading')}</div>
      ) : root.length === 0 ? (
        <div className={css.hint}>{t('tree.empty')}</div>
      ) : (
        <ul className={css.list} role="group">
          {root.map(entry => (
            <TreeRow
              key={entry.name}
              entry={entry}
              path={childPath('', entry.name)}
              depth={0}
              childrenByPath={childrenByPath}
              expanded={expanded}
              loadingPath={loadingPath}
              errorPath={errorPath}
              onToggle={toggle}
              onOpen={onOpen}
              onContextMenu={(event, path, name, kind) => {
                event.preventDefault()
                event.stopPropagation()
                setMenuError(undefined)
                setMenu({ path, name, kind, x: event.clientX, y: event.clientY })
              }}
              activePath={activePath}
              t={t}
            />
          ))}
        </ul>
      )}
      {menu !== undefined ? (
        <div ref={menuRef} className={css.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t('tree.menuAria')}>
          {menuError !== undefined ? <div className={css.menuError}>{menuError}</div> : null}
          <button type="button" role="menuitem" className={css.menuItem} onClick={() => newFile(parentOf(menu.path))}>
            {t('tree.newFile')}
          </button>
          <button type="button" role="menuitem" className={css.menuItem} onClick={() => newFolder(parentOf(menu.path))}>
            {t('tree.newFolder')}
          </button>
          {menu.path !== '' ? (
            <>
              <button type="button" role="menuitem" className={css.menuItem} onClick={() => rename(menu)}>
                {t('tree.rename')}
              </button>
              <button type="button" role="menuitem" className={css.menuItemDanger} onClick={() => remove(menu)}>
                {t('tree.delete')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface TreeRowProps {
  entry: WorkbenchDirEntry
  path: string
  depth: number
  childrenByPath: Record<string, WorkbenchDirEntry[]>
  expanded: ReadonlySet<string>
  loadingPath: string | undefined
  errorPath: string | undefined
  onToggle(path: string): void
  onOpen(path: string): void
  onContextMenu(event: React.MouseEvent, path: string, name: string, kind: 'file' | 'directory'): void
  activePath?: string | undefined
  t: TranslateNS<typeof NS>
}

function TreeRow({
  entry, path, depth, childrenByPath, expanded, loadingPath, errorPath,
  onToggle, onOpen, onContextMenu, activePath, t,
}: TreeRowProps) {
  const isDir = entry.type === 'directory'
  const isExpanded = expanded.has(path)
  const children = childrenByPath[path]
  const isLoading = loadingPath === path
  const isError = errorPath === path
  const isActive = activePath === path

  return (
    <li role="treeitem" aria-expanded={isDir ? isExpanded : undefined}>
      <button
        type="button"
        className={isActive ? css.rowActive : css.row}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => (isDir ? onToggle(path) : onOpen(path))}
        onContextMenu={event => onContextMenu(event, path, entry.name, isDir ? 'directory' : 'file')}
        title={path}
      >
        <span className={isDir ? css.chevron : css.chevronSpacer} aria-hidden="true">
          {isDir ? (isExpanded ? '▾' : '▸') : ''}
        </span>
        <span className={isDir ? css.folder : css.file}>{entry.name}</span>
      </button>
      {isDir && isExpanded && (
        <ul className={css.list} role="group">
          {isLoading ? (
            <li className={css.hintRow}>{t('tree.loading')}</li>
          ) : isError ? (
            <li className={css.hintRow}>{t('tree.error')}</li>
          ) : children === undefined || children.length === 0 ? (
            <li className={css.hintRow}>{t('tree.empty')}</li>
          ) : (
            children.map(child => (
              <TreeRow
                key={child.name}
                entry={child}
                path={childPath(path, child.name)}
                depth={depth + 1}
                childrenByPath={childrenByPath}
                expanded={expanded}
                loadingPath={loadingPath}
                errorPath={errorPath}
                onToggle={onToggle}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
                activePath={activePath}
                t={t}
              />
            ))
          )}
        </ul>
      )}
    </li>
  )
}
