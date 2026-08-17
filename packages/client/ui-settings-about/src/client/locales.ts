/** Copy dictionaries for the About & Updates settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'About & Updates',
  title: 'About & Updates',
  intro: 'Check the installed version and install updates released for this app.',
  currentVersion: 'Current version',
  status: 'Update status',
  checkForUpdates: 'Check for updates',
  checking: 'Checking…',
  restartInstall: 'Restart & install',
  statusIdle: 'Not checked yet',
  statusChecking: 'Checking for updates…',
  statusDownloading: 'New version downloading',
  statusDownloaded: 'New version downloaded, ready to install',
  statusUpToDate: 'You are on the latest version',
  statusError: 'Update check failed',
  unknown: 'Unknown',
}

/** Simplified Chinese strings. */
export const zh = {
  nav: '关于与更新',
  title: '关于与更新',
  intro: '查看当前安装版本，并安装本应用发布的新版本。',
  currentVersion: '当前版本',
  status: '更新状态',
  checkForUpdates: '检查更新',
  checking: '检查中…',
  restartInstall: '重启并安装',
  statusIdle: '尚未检查',
  statusChecking: '正在检查更新…',
  statusDownloading: '新版本下载中',
  statusDownloaded: '新版本已下载，可重启安装',
  statusUpToDate: '已是最新版本',
  statusError: '检查更新失败',
  unknown: '未知',
}

export type AboutKey = keyof typeof en
