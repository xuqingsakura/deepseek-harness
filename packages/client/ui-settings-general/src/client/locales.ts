/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'migrate.title': '数据迁移',
  'migrate.desc': '从 Web 版（~/.dsh）导入对话记录到桌面端，安全合并、不覆盖桌面端已有数据。',
  'migrate.source': '源目录',
  'migrate.sourcePlaceholder': '留空自动检测 ~/.dsh',
  'migrate.includeSettings': '包含设置',
  'migrate.includeCredentials': '包含凭据',
  'migrate.dryRun': '试运行',
  'migrate.run': '执行迁移',
  'migrate.busy': '处理中…',
  'migrate.report.source': '源',
  'migrate.report.target': '目标',
  'migrate.report.copied': '已复制会话',
  'migrate.report.skipped': '已跳过',
  'migrate.report.storages': '合并存储',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'migrate.title': 'Data migration',
  'migrate.desc': 'Import conversation data from the Web harness (~/.dsh) into the desktop home with a safe merge that never overwrites desktop data.',
  'migrate.source': 'Source',
  'migrate.sourcePlaceholder': 'Leave empty to auto-detect ~/.dsh',
  'migrate.includeSettings': 'Include settings',
  'migrate.includeCredentials': 'Include credentials',
  'migrate.dryRun': 'Dry run',
  'migrate.run': 'Run migration',
  'migrate.busy': 'Working…',
  'migrate.report.source': 'Source',
  'migrate.report.target': 'Target',
  'migrate.report.copied': 'Sessions copied',
  'migrate.report.skipped': 'Skipped',
  'migrate.report.storages': 'Storages merged',
} satisfies Record<SettingsKey, string>
