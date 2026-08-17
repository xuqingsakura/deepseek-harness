/**
 * Desktop About & Updates section: current version, update check, download
 * progress, and restart-to-install. The section only mounts in the Electron
 * shell (the browser build never registers it), and all state rides the
 * update bridge pushed by the main process.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AboutKey } from './locales.ts'
import css from './AboutSection.module.css'

/** Desktop update state mirrored from the main-process updater. */
export interface DesktopUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
}

/** One migration step outcome reported by the bridge. */
export interface MigrationStepView {
  kind: string
  action: string
}

/** Migration report mirrored from the main-process importer. */
export interface MigrationReportView {
  source: string
  target: string
  dryRun: boolean
  steps: MigrationStepView[]
  sessionsCopied: number
  sessionsSkipped: number
  storagesMerged: number
  errors: string[]
}

/** Minimal face of the desktop update bridge (preload exposes the rest). */
interface DesktopUpdateBridge {
  updateStatus(): Promise<DesktopUpdateState>
  updateCheck(): Promise<DesktopUpdateState>
  updateInstall(): void
  onUpdateState(callback: (state: DesktopUpdateState) => void): () => void
  migrateWebData(options?: {
    source?: string
    dryRun?: boolean
    includeSettings?: boolean
    includeCredentials?: boolean
    force?: boolean
  }): Promise<MigrationReportView>
}

declare global {
  interface Window {
    dshDesktop?: DesktopUpdateBridge
  }
}

/** Injected dependencies of the About section (slot `inject`). */
export interface AboutSectionInjected {
  /** Section copy. */
  t: (key: AboutKey, params?: Record<string, string>) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type AboutSectionProps = Partial<AboutSectionInjected>

/** Status text key per updater lifecycle position. */
const STATUS_KEY: Record<DesktopUpdateState['status'], AboutKey> = {
  idle: 'statusIdle',
  checking: 'statusChecking',
  // autoDownload is on: an available update transitions to downloading.
  available: 'statusDownloading',
  downloading: 'statusDownloading',
  downloaded: 'statusDownloaded',
  'not-available': 'statusUpToDate',
  error: 'statusError',
}

/**
 * Render the About & Updates column.
 * @param props - the inject face with the bound translator.
 * @returns the section element tree.
 */
export function AboutSection({ t = (key: AboutKey) => key }: AboutSectionProps) {
  const [state, setState] = useState<DesktopUpdateState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const desktop = typeof window === 'undefined' ? undefined : window.dshDesktop

  useEffect(() => {
    if (desktop === undefined) return
    let alive = true
    void desktop.updateStatus().then((snapshot) => {
      if (alive) setState(snapshot)
    }).catch(() => {})
    const unsubscribe = desktop.onUpdateState(setState)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [desktop])

  const [migration, setMigration] = useState<MigrationReportView | undefined>(undefined)
  const [migrating, setMigrating] = useState(false)
  const [includeSettings, setIncludeSettings] = useState(false)
  const [includeCredentials, setIncludeCredentials] = useState(false)

  const runMigration = useCallback(async (dryRun: boolean) => {
    if (desktop === undefined || migrating) return
    setMigrating(true)
    try {
      setMigration(await desktop.migrateWebData({ dryRun, includeSettings, includeCredentials }))
    } catch (error) {
      setMigration({
        source: '~/.dsh',
        target: '',
        dryRun,
        steps: [],
        sessionsCopied: 0,
        sessionsSkipped: 0,
        storagesMerged: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    } finally {
      setMigrating(false)
    }
  }, [desktop, migrating, includeSettings, includeCredentials])

  const check = useCallback(async () => {
    if (desktop === undefined || busy) return
    setBusy(true)
    try {
      setState(await desktop.updateCheck())
    } finally {
      setBusy(false)
    }
  }, [desktop, busy])

  const install = useCallback(() => { desktop?.updateInstall() }, [desktop])

  const downloaded = state?.status === 'downloaded'
  const checking = state?.status === 'checking' || busy
  const downloading = state?.status === 'downloading'
  const progress = state?.progress

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.row}>
        <span className={css.label}>{t('currentVersion')}</span>
        <span className={css.value}>{state?.currentVersion !== undefined ? `v${state.currentVersion}` : t('unknown')}</span>
      </div>
      {state !== undefined && (
        <div className={css.row}>
          <span className={css.label}>{t('status')}</span>
          <span className={css.status}>
            {t(STATUS_KEY[state.status])}
            {downloading && progress !== undefined ? ` ${progress}%` : ''}
            {state.status === 'error' && state.message !== undefined ? ` — ${state.message}` : ''}
          </span>
        </div>
      )}
      <div className={css.actions}>
        <button type="button" className={css.button} onClick={() => void check()} disabled={checking}>
          {checking ? t('checking') : t('checkForUpdates')}
        </button>
        {downloaded && (
          <button type="button" className={css.button} onClick={install}>
            {t('restartInstall')}
          </button>
        )}
      </div>

      <div className={css.divider} />
      <h2 className={css.heading}>{t('migrateTitle')}</h2>
      <p className={css.intro}>{t('migrateIntro')}</p>
      <div className={css.row}>
        <span className={css.label}>{t('migrateSource')}</span>
        <span className={css.value}>{migration?.source ?? '~/.dsh'}</span>
      </div>
      <div className={css.row}>
        <span className={css.label}>{t('migrateTarget')}</span>
        <span className={css.value}>{migration?.target !== undefined && migration.target !== '' ? migration.target : t('migrateTargetDefault')}</span>
      </div>
      <label className={css.check}>
        <input
          type="checkbox"
          checked={includeSettings}
          onChange={(event) =>{  setIncludeSettings(event.target.checked) }}
          disabled={migrating}
        />
        {t('migrateIncludeSettings')}
      </label>
      <label className={css.check}>
        <input
          type="checkbox"
          checked={includeCredentials}
          onChange={(event) =>{  setIncludeCredentials(event.target.checked) }}
          disabled={migrating}
        />
        {t('migrateIncludeCredentials')}
      </label>
      <div className={css.actions}>
        <button type="button" className={css.button} onClick={() => void runMigration(true)} disabled={migrating}>
          {migrating ? t('migrateRunning') : t('migratePreview')}
        </button>
        <button type="button" className={css.button} onClick={() => void runMigration(false)} disabled={migrating}>
          {migrating ? t('migrateRunning') : t('migrateStart')}
        </button>
      </div>
      {migration !== undefined && (
        <div className={css.migrateResult}>
          <div className={css.row}>
            <span className={css.label}>{t('migrateSessionsCopied')}</span>
            <span className={css.value}>{migration.sessionsCopied}</span>
          </div>
          <div className={css.row}>
            <span className={css.label}>{t('migrateSessionsSkipped')}</span>
            <span className={css.value}>{migration.sessionsSkipped}</span>
          </div>
          <div className={css.row}>
            <span className={css.label}>{t('migrateStoragesMerged')}</span>
            <span className={css.value}>{migration.storagesMerged}</span>
          </div>
          {migration.errors.length > 0 && (
            <p className={css.error} role="alert">{t('migrateErrors')}: {migration.errors.join('; ')}</p>
          )}
          {migration.dryRun && migration.errors.length === 0 && (
            <p className={css.hint}>{t('migrateDryRunHint')}</p>
          )}
        </div>
      )}
    </div>
  )
}
