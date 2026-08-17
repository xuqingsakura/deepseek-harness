# Agent Note: Desktop updates from fork GitHub Releases

Status: implemented

English | [中文](2026-08-17-desktop-github-release-update.zh.md)

## Problem

The desktop update check required a manually configured feed. `configureUpdater()` only armed the updater when `DSH_UPDATE_FEED_URL` or `%APPDATA%\dsh-desktop\update-config.json` pointed at a generic feed; the packaged `app-update.yml` (a placeholder generic URL) was never used, so an installed build could not discover a new installer, download it, and install it from this fork's GitHub Releases.

## Decision

- `electron-builder.yml` now declares a GitHub publish provider (`owner: xuqingsakura`, `repo: deepseek-harness`), so the baked `app-update.yml` points at the fork's Releases and electron-updater resolves the newest published release from the Atom feed. `DSH_UPDATE_FEED_URL` / `update-config.json` still override the feed at runtime.
- `configureUpdater()` falls back to the packaged channel: explicit overrides win, otherwise packaged builds arm the updater from `app-update.yml` (`updaterConfigured = app.isPackaged`). Dev runs stay silent.
- `apps/desktop/scripts/package.mjs` honors `DSH_PKG_OUTPUT_DIR` to override electron-builder.yml's machine-specific output directory on CI.
- New `.github/workflows/desktop-release.yml` builds on `windows-latest` (pnpm install → `build:lib:host` → `package:desktop`) on a manual dispatch (optional version input) or a `v*` tag push, then publishes a GitHub Release tagged `v<version>`. Prerelease versions (`0.1.0-rc.*`) are marked prerelease and publish the `rc` channel file (`rc.yml`, plus a `latest.yml` copy); stable versions publish `latest.yml`. Assets are renamed with hyphens (`DeepSeek-Harness-Setup-<version>.exe` + `.blockmap`) because the GitHub provider rewrites spaces to hyphens in download paths.

## Consequences

Settings → About → 检查更新 now works out of the box on packaged builds: it resolves the newest rc release, downloads the installer, and restarts into a silent NSIS install. The repository must stay public (the GitHub provider reads `releases.atom` anonymously); a private repo needs a token-based provider. The installer is unsigned unless `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets are configured, so Windows SmartScreen may warn once.

## Alternatives considered

- Keep the generic provider and point `update-config.json` at `releases/download/latest`. Rejected: it needs a moving `latest` tag, per-release maintenance, and manual per-machine configuration.
- Use a third-party release action (softprops/action-gh-release). Rejected: `gh` ships on hosted runners and `GITHUB_TOKEN` is injected automatically, so the workflow stays dependency-free.
