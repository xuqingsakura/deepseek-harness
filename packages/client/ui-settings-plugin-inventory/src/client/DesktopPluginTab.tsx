/** Desktop plugin management as a standalone Plugins tab: loads the Loader
 * inventory (for runtime-state matching) and renders the desktop plugin
 * manager as a peer of the configuration and inventory tabs, so operators no
 * longer scroll to the bottom of the plugin list to reach it.
 * @module @deepseek-ai/dsh-client-ui-settings-plugin-inventory/desktop-tab
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DesktopPluginManager } from './DesktopPluginManager.tsx'
import type { PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import css from './DesktopPluginTab.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type DesktopPluginTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

/** Render the desktop plugin manager behind a loading/error gate. */
export function DesktopPluginTab({ list, t }: DesktopPluginTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  // The manager is local (Electron bridge), so a failed inventory read only
  // drops the runtime-phase matching, never the management surface.
  const entries = state.status === 'ready' ? state.snapshot.entries : undefined

  return (
    <div className={css.section}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      <DesktopPluginManager
        t={t}
        entries={entries}
        onChanged={() => { setRequest(value => value + 1) }}
      />
    </div>
  )
}
