# Agent Note: Desktop Settings About & Updates section

Status: implemented

English | [中文](2026-08-15-desktop-settings-about-updates.zh.md)

## Problem

The desktop app's only update entry points were the tray context menu ("检查更新...") and native notifications. There was no in-app surface to show the installed version, trigger a check, or install a downloaded update, and the tray item was easy to miss. The request: add a version-update feature inside Settings and remove the tray "check for updates" item.

## Decision

A new client package `@deepseek-ai/dsh-client-ui-settings-about` registers a `settings.section` nav entry (`id: about`, order 90) rendered only when the Electron bridge (`window.dshDesktop`) is present, so the browser build never mounts it. The section shows the current version, an update status line (not checked / checking / downloading with percent / downloaded / up to date / error with message), a "check for updates" button, and a "restart & install" button once a download finished.

The main process owns a `DesktopUpdateState` machine (idle/checking/available/downloading/downloaded/not-available/error) and broadcasts every change to all shell windows over `dsh:update-state`. Three new IPC handlers back the UI: `dsh:update-status` (current state without a check), `dsh:update-check` (run a user-triggered check and return state), and `dsh:update-install` (quit-and-install when a download is ready). The preload bridge exposes `updateStatus`, `updateCheck`, `updateInstall`, and `onUpdateState`. Startup still performs the silent check; native notifications for available/downloaded updates are unchanged. The tray menu drops the "检查更新..." item — the Settings section is now the manual entry point.

The new package joins the web surface through `dsh-web-app`'s patch layer (one `ui-settings-about` row and a `workspace:*` dependency), so the desktop host composes it like every other client plugin; the web bundle itself does not change because the section is a plugin bundle served through the client module system.

## Alternatives considered

**Put the update card inside ui-settings-general as a general item.** Rejected: the update flow needs buttons and a status line, not a nav-row item, and a dedicated "About & Updates" page is the conventional place; keeping it a separate section package follows the repo's one-feature-per-package layout.

**Register the section unconditionally with a browser placeholder.** Rejected: the browser build should stay untouched — the bridge check is one line and keeps the web surface clean.

## Consequences

Settings now carries an always-visible "关于与更新" page: version, check, download progress, and restart-to-install, all driven by main-process state pushes so the page stays live without polling. The tray menu is one item shorter. Behavior is unchanged when no update feed is configured — the check surfaces the existing "未配置更新源" guidance through the section's status line instead of a notification only.
