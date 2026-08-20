/** Desktop-only data-migration row in the settings General section: imports
 * Web-harness data (~/.dsh) into the desktop home with a safe merge that
 * never overwrites target-owned sessions or storage keys. The row hides
 * entirely outside the desktop shell (no window.dshDesktop bridge). */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './MigrateDataRow.module.css'

/** Options accepted by the desktop migration bridge (subset of the host's). */
interface MigrateOptions {
  source?: string
  target?: string
  dryRun?: boolean
  includeSettings?: boolean
  includeCredentials?: boolean
  force?: boolean
}

/** One host migration step (workspace/settings/credentials scope). */
interface MigrationStep {
  kind: string
  detail: string
}

/** Full migration report mirroring the host shape. */
interface MigrationReport {
  source: string
  target: string
  dryRun: boolean
  steps: MigrationStep[]
  sessionsCopied: number
  sessionsSkipped: number
  storagesMerged: number
  errors: string[]
}

/** The desktop bridge exposed by the shell preload; absent in plain browsers. */
interface DesktopBridgeLike {
  migrateWebData?: (options?: MigrateOptions) => Promise<MigrationReport>
}

/** Read the shell bridge without crashing outside the desktop. */
function desktopBridge(): DesktopBridgeLike | undefined {
  // The shell bridge exists only in the desktop renderer; plain browsers and
  // node-environment tests must not touch an undefined global.
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { dshDesktop?: DesktopBridgeLike }).dshDesktop
}

/** Full component props: the standard settings-row locale seat plus our keys. */
export type MigrateDataRowProps = PropsLocale<'settings'>

/**
 * Render the data-migration row: source/options controls, a dry-run and an
 * execute action, and a compact report after a run.
 * @param props - the settings locale seat.
 * @returns the row, or null outside the desktop shell.
 */
export function MigrateDataRow({ t }: MigrateDataRowProps) {
  const bridge = desktopBridge()
  const [source, setSource] = useState('')
  const [includeSettings, setIncludeSettings] = useState(false)
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (bridge?.migrateWebData === undefined) return null

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const result = await bridge.migrateWebData?.({
        ...(source.trim() === '' ? {} : { source: source.trim() }),
        dryRun,
        includeSettings,
        includeCredentials,
      })
      setReport(result ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const summary = report === null ? null : (
    <div className={css.report} data-testid="migrate-report">
      <div>{t('migrate.report.source')}: {report.source}</div>
      <div>{t('migrate.report.target')}: {report.target}</div>
      <div>
        {t('migrate.report.copied')}: {report.sessionsCopied} · {t('migrate.report.skipped')}: {report.sessionsSkipped}
        {' · '}{t('migrate.report.storages')}: {report.storagesMerged}
      </div>
      {report.errors.length > 0 && (
        <div className={css.errors}>
          {report.errors.map((message, index) => <div key={index}>{message}</div>)}
        </div>
      )}
    </div>
  )

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('migrate.title')}</div>
        <div className={css.desc}>{t('migrate.desc')}</div>
      </div>
      <div className={css.controls}>
        <label className={css.field}>
          <span>{t('migrate.source')}</span>
          <input
            type="text"
            value={source}
            onChange={(event) => { setSource(event.target.value) }}
            placeholder={t('migrate.sourcePlaceholder')}
            disabled={busy}
          />
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={includeSettings}
            onChange={(event) => { setIncludeSettings(event.target.checked) }}
            disabled={busy}
          />
          {t('migrate.includeSettings')}
        </label>
        <label className={css.check}>
          <input
            type="checkbox"
            checked={includeCredentials}
            onChange={(event) => { setIncludeCredentials(event.target.checked) }}
            disabled={busy}
          />
          {t('migrate.includeCredentials')}
        </label>
        <div className={css.actions}>
          <button type="button" className={css.button} disabled={busy} onClick={() => { void run(true) }}>
            {busy ? t('migrate.busy') : t('migrate.dryRun')}
          </button>
          <button type="button" className={css.primary} disabled={busy} onClick={() => { void run(false) }}>
            {busy ? t('migrate.busy') : t('migrate.run')}
          </button>
        </div>
        {error !== null && <div className={css.errors}>{error}</div>}
        {summary}
      </div>
    </div>
  )
}
