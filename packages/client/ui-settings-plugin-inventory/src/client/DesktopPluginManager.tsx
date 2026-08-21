/**
 * Desktop-only plugin management block rendered inside the Plugins Settings
 * tab. It drives the official `dsh plugin --profile web` flow through the
 * Electron bridge (`window.dshDesktop.pluginAdd/Remove/Update/...`), so
 * installs land in `profiles/web/node_modules` and register into
 * `dsh.profile.bundles` exactly as the CLI would; a restart activates a new
 * bundle layer (the in-process host has no config HMR). The block is the
 * unified manager for EXTERNAL plugins (installed from npm / GitHub / local
 * paths): source badge, version, update, enable/disable, batch remove, and a
 * runtime phase badge matched from the Loader inventory. Renders nothing in
 * the browser build, where the bridge is absent.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-inventory/desktop
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
import css from './DesktopPluginManager.module.css'

interface DesktopPluginBridge {
  pluginAdd(spec: string): Promise<PluginOpResult>
  pluginRemove(name: string): Promise<PluginOpResult>
  pluginRemoveMany(names: string[]): Promise<PluginOpResult>
  pluginList(): Promise<DesktopPluginInfo[]>
  pluginUpdate(name: string): Promise<PluginOpResult>
  pluginUpdateAll(): Promise<PluginOpResult>
  pluginAuthorizeBuilds(keys: string[]): Promise<{ path: string }>
  pluginSetEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; bundles: string[]; enabled: boolean; liveApplied: boolean }>
  pluginOutdated(): Promise<Record<string, string>>
}

interface PluginOpResult {
  ok: boolean
  exitCode: number | null
  output: string
  bundles: string[]
  allowBuilds: string[]
}

interface DesktopPluginInfo {
  name: string
  version: string | undefined
  isBundle: boolean
  patch: string | undefined
  spec: string
  source: 'npm' | 'git' | 'local'
  enabled: boolean
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]

declare global {
  interface Window {
    dshDesktop?: DesktopPluginBridge
  }
}

type OpState =
  | { readonly status: 'idle' }
  | { readonly status: 'busy' }
  | { readonly status: 'done'; readonly ok: boolean; readonly message: string; readonly pendingAllowBuilds?: string[] }

/** Runtime phase vocabulary shared with the inventory tab. */
const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} as const

/** The manager's own props: the tab passes the Loader inventory snapshot for runtime state. */
export interface DesktopPluginManagerProps {
  t: PluginInventorySettingsTabProps['t']
  /** Loader inventory entries, matched to external plugins by module name. */
  entries?: readonly PluginInventoryEntry[] | undefined
  /** Called after a successful mutation so the tab can refresh the inventory. */
  onChanged?: (() => void) | undefined
}

/** Desktop plugin manager: install, update, enable/disable, remove, runtime state. */
export function DesktopPluginManager({ t, entries, onChanged }: DesktopPluginManagerProps): ReactNode {
  const bridge: DesktopPluginBridge | undefined = window.dshDesktop as DesktopPluginBridge | undefined
  const [plugins, setPlugins] = useState<DesktopPluginInfo[]>([])
  const [outdated, setOutdated] = useState<Record<string, string>>({})
  const [spec, setSpec] = useState('')
  const [op, setOp] = useState<OpState>({ status: 'idle' })
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmBatch, setConfirmBatch] = useState(false)

  const entryByModule = useMemo(() => {
    const map = new Map<string, PluginInventoryEntry>()
    for (const entry of entries ?? []) map.set(entry.moduleName, entry)
    return map
  }, [entries])

  const reload = useCallback((): void => {
    if (bridge === undefined) return
    void bridge.pluginList().then(setPlugins, () =>{  setPlugins([]) })
  }, [bridge])

  const refreshOutdated = useCallback((): void => {
    if (bridge === undefined) return
    void bridge.pluginOutdated().then(setOutdated, () =>{  setOutdated({}) })
  }, [bridge])

  useEffect(reload, [reload])
  useEffect(refreshOutdated, [refreshOutdated])
  useEffect(() => {
    if (bridge === undefined) return
  }, [bridge])

  const run = async (
    action: (target: DesktopPluginBridge) => Promise<PluginOpResult>,
    successHint: string,
    refreshVersions = false,
  ): Promise<void> => {
    const target = window.dshDesktop as DesktopPluginBridge | undefined
    if (target === undefined) return
    setOp({ status: 'busy' })
    try {
      const result = await action(target)
      reload()
      if (refreshVersions) refreshOutdated()
      onChanged?.()
      const hint = result.ok ? successHint : `${t('opFailed')} (exit ${String(result.exitCode)})`
      const tail = result.output.trim().split('\n').slice(-3).join(' ')
      const pendingAllowBuilds = result.ok ? undefined : result.allowBuilds
      const message = tail.length > 0 ? `${hint} — ${tail}` : hint
      setOp(
        pendingAllowBuilds !== undefined && pendingAllowBuilds.length > 0
          ? { status: 'done', ok: result.ok, message, pendingAllowBuilds }
          : { status: 'done', ok: result.ok, message },
      )
    } catch (error) {
      setOp({ status: 'done', ok: false, message: String(error) })
    }
  }

  const toggleEnabled = async (plugin: DesktopPluginInfo): Promise<void> => {
    const target = window.dshDesktop as DesktopPluginBridge | undefined
    if (target === undefined) return
    setOp({ status: 'busy' })
    try {
      const result = await target.pluginSetEnabled(plugin.name, !plugin.enabled)
      if (result.ok) {
        setPlugins(current => current.map(item => (
          item.name === plugin.name ? { ...item, enabled: result.enabled } : item
        )))
        onChanged?.()
        const live = result.liveApplied
        const message = plugin.enabled
          ? (live ? t('disabledLive') : t('disabledDone'))
          : (live ? t('enabledLive') : t('enabledDone'))
        setOp({ status: 'done', ok: true, message })
      } else {
        setOp({ status: 'done', ok: false, message: t('opFailed') })
      }
    } catch (error) {
      setOp({ status: 'done', ok: false, message: String(error) })
    }
  }

  const toggleSelected = (name: string): void => {
    setConfirmBatch(false)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const removeSelected = async (): Promise<void> => {
    const target = window.dshDesktop as DesktopPluginBridge | undefined
    if (target === undefined || selected.size === 0) return
    if (!confirmBatch) {
      setConfirmBatch(true)
      return
    }
    setConfirmBatch(false)
    await run(target => target.pluginRemoveMany([...selected]), t('removedMany', { count: selected.size }))
    setSelected(new Set())
  }

  const authorizeAndRetry = async (): Promise<void> => {
    const target = window.dshDesktop as DesktopPluginBridge | undefined
    if (target === undefined || op.status !== 'done' || op.pendingAllowBuilds === undefined || op.pendingAllowBuilds.length === 0) return
    const specToRetry = spec.trim()
    if (specToRetry === '') return
    setOp({ status: 'busy' })
    try {
      await target.pluginAuthorizeBuilds(op.pendingAllowBuilds)
      const result = await target.pluginAdd(specToRetry)
      reload()
      refreshOutdated()
      onChanged?.()
      const hint = result.ok ? t('authorizedAndRetried') : `${t('opFailed')} (exit ${String(result.exitCode)})`
      const tail = result.output.trim().split('\n').slice(-3).join(' ')
      const pendingAllowBuilds = result.ok ? undefined : result.allowBuilds
      const message = tail.length > 0 ? `${hint} — ${tail}` : hint
      setOp(
        pendingAllowBuilds !== undefined && pendingAllowBuilds.length > 0
          ? { status: 'done', ok: result.ok, message, pendingAllowBuilds }
          : { status: 'done', ok: result.ok, message },
      )
    } catch (error) {
      setOp({ status: 'done', ok: false, message: String(error) })
    }
  }

  const isGitSpec = /^(github:|git\+|https?:\/\/)/.test(spec.trim())
  const busy = op.status === 'busy'
  const sourceLabel = (source: DesktopPluginInfo['source']): string => (
    source === 'npm' ? t('sourceNpm') : source === 'git' ? t('sourceGit') : t('sourceLocal')
  )

  const entryOf = (name: string): PluginInventoryEntry | undefined => {
    const exact = entryByModule.get(name)
    if (exact !== undefined) return exact
    for (const [moduleName, entry] of entryByModule) {
      if (moduleName.startsWith(`${name}/`)) return entry
    }
    return undefined
  }

  return (
    <section className={css.manager} data-desktop-plugin-manager>
      <h3 className={css.heading}>{t('desktopHeading')}</h3>
      <p className={css.hint}>{t('desktopHint')}</p>
      <p className={css.hint}>{t('externalHint')}</p>
      <div className={css.form}>
        <label className={css.visuallyHidden} htmlFor="dsh-desktop-plugin-spec">{t('specLabel')}</label>
        <input
          id="dsh-desktop-plugin-spec"
          className={css.spec}
          type="text"
          value={spec}
          placeholder={t('specPlaceholder')}
          aria-label={t('specLabel')}
          onChange={(event) => { setSpec(event.currentTarget.value) }}
        />
        <button
          className={css.action}
          type="button"
          disabled={busy || spec.trim().length === 0}
          onClick={() => { void run(target => target.pluginAdd(spec.trim()), t('added'), true) }}
        >
          {t('add')}
        </button>
        <button
          className={css.action}
          type="button"
          disabled={busy || plugins.length === 0}
          onClick={() => { void run(target => target.pluginUpdateAll(), t('updatedAll'), true) }}
        >
          {t('updateAll')}
        </button>
      </div>
      {spec.trim() !== '' && isGitSpec ? (
        <p className={css.hint} data-git-spec-note>{t('gitSpecNote')}</p>
      ) : null}
      {op.status === 'done' ? (
        <p className={css.result} role="status" data-ok={op.ok ? 'true' : 'false'}>{op.message}</p>
      ) : null}
      {op.status === 'done' && op.pendingAllowBuilds !== undefined && op.pendingAllowBuilds.length > 0 ? (
        <div className={css.buildGate} data-allow-builds>
          <p className={css.buildWarning}>{t('allowBuildsWarning')}</p>
          <ul className={css.buildKeys}>
            {op.pendingAllowBuilds.map(key => (
              <li key={key}><code>{key}</code></li>
            ))}
          </ul>
          <button className={css.action} type="button" onClick={() => { void authorizeAndRetry() }}>
            {t('authorizeAndRetry')}
          </button>
        </div>
      ) : null}
      {selected.size > 0 ? (
        <div className={css.batchBar} data-batch-bar>
          <span>{t('selectedCount', { count: selected.size })}</span>
          <button className={css.miniButton} type="button" disabled={busy} onClick={() => { void removeSelected() }}>
            {confirmBatch ? t('confirmRemoveSelected') : t('removeSelected')}
          </button>
          <button
            className={css.miniButton}
            type="button"
            onClick={() => { setSelected(new Set()); setConfirmBatch(false) }}
          >
            {t('clearSelection')}
          </button>
        </div>
      ) : null}
      {plugins.length > 0 ? (
        <ul className={css.list}>
          {plugins.map((plugin) => {
            const entry = entryOf(plugin.name)
            const phase = entry?.fiberPhase ?? null
            const phaseKey = phase === null ? null : PHASE_KEYS[phase]
            return (
              <li className={css.item} key={plugin.name}>
                <label className={css.selectBox}>
                  <input
                    type="checkbox"
                    checked={selected.has(plugin.name)}
                    onChange={() => { toggleSelected(plugin.name) }}
                    aria-label={t('selectForBatch')}
                  />
                </label>
                <div className={css.itemBody}>
                  <span className={css.itemName}>
                    <code>{plugin.name}</code>
                    <span className={css.sourceTag} data-source={plugin.source}>{sourceLabel(plugin.source)}</span>
                    {plugin.isBundle ? <span className={css.bundleTag}>{t('bundle')}</span> : null}
                    {plugin.isBundle ? (
                      <span className={css.stateTag} data-enabled={plugin.enabled ? 'true' : 'false'}>
                        {plugin.enabled ? t('enabledTag') : t('disabledTag')}
                      </span>
                    ) : null}
                    {phaseKey !== null ? (
                      <span className={css.phaseTag} data-phase={phase}>{t(phaseKey)}</span>
                    ) : null}
                  </span>
                  <span className={css.itemMeta}>
                    {plugin.version !== undefined ? <span className={css.version}>{plugin.version}</span> : null}
                    {outdated[plugin.name] !== undefined ? (
                      <span className={css.outdated}>{t('updateAvailable', { version: outdated[plugin.name] })}</span>
                    ) : null}
                  </span>
                  {phase === 'failed' && entry?.error !== undefined ? (
                    <p className={css.error} title={entry.error}>{t('mountFailed')}: {entry.error}</p>
                  ) : null}
                  <span className={css.rowActions}>
                    <button
                      className={css.miniButton}
                      type="button"
                      disabled={busy}
                      onClick={() => { void run(target => target.pluginUpdate(plugin.name), t('updated'), true) }}
                    >
                      {t('update')}
                    </button>
                    {plugin.isBundle ? (
                      <button
                        className={css.miniButton}
                        type="button"
                        disabled={busy}
                        onClick={() => { void toggleEnabled(plugin) }}
                      >
                        {plugin.enabled ? t('disable') : t('enable')}
                      </button>
                    ) : null}
                    <button
                      className={css.miniButton}
                      type="button"
                      disabled={busy}
                      onClick={() => { void run(target => target.pluginRemove(plugin.name), t('removed')) }}
                    >
                      {t('remove')}
                    </button>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className={css.empty}>{t('desktopEmpty')}</p>
      )}
      <p className={css.restart}>{t('restartHint')}</p>
    </section>
  )
}
