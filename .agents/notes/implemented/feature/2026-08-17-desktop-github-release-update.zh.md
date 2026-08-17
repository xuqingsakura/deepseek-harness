# Agent Note：桌面端从 fork 的 GitHub Releases 更新

Status: implemented

[English](2026-08-17-desktop-github-release-update.md) | 中文

## Problem

桌面端更新检查需要手动配置 feed。`configureUpdater()` 只有在 `DSH_UPDATE_FEED_URL` 或 `%APPDATA%\dsh-desktop\update-config.json` 指向通用 feed 时才启用 updater；打包内建的 `app-update.yml`（占位 generic URL）从未被使用，因此已安装版本无法从本 fork 的 GitHub Releases 发现新安装包、下载并安装。

## Decision

- `electron-builder.yml` 现在声明 GitHub publish provider（`owner: xuqingsakura`、`repo: deepseek-harness`），打包内建的 `app-update.yml` 指向 fork 的 Releases，electron-updater 从 Atom feed 解析最新已发布 release。`DSH_UPDATE_FEED_URL` / `update-config.json` 仍可在运行时覆盖 feed。
- `configureUpdater()` 回退到打包内建通道：显式覆盖优先，否则打包版从 `app-update.yml` 启用 updater（`updaterConfigured = app.isPackaged`）。开发模式保持静默。
- `apps/desktop/scripts/package.mjs` 支持 `DSH_PKG_OUTPUT_DIR`，在 CI 上覆盖 electron-builder.yml 中机器相关的输出目录。
- 新增 `.github/workflows/desktop-release.yml`：在手动触发（可选版本号输入）或推送 `v*` 标签时于 `windows-latest` 构建（pnpm install → `build:lib:host` → `package:desktop`），然后发布 tag 为 `v<version>` 的 GitHub Release。预发布版本（`0.1.0-rc.*`）标记为 prerelease 并发布 `rc` 通道文件（`rc.yml`，另附一份 `latest.yml`）；稳定版本发布 `latest.yml`。资产名改为连字符（`DeepSeek-Harness-Setup-<version>.exe` + `.blockmap`），因为 GitHub provider 会把下载路径中的空格改写成连字符。

## Consequences

打包版在 设置 → 关于 → 检查更新 开箱即用：解析最新 rc release、下载安装包并重启进入静默 NSIS 安装。仓库必须保持公开（GitHub provider 匿名读取 `releases.atom`）；私有仓库需要基于 token 的 provider。安装包未配置 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets 时不签名，Windows SmartScreen 可能首次弹出警告。

## Alternatives considered

- 保留 generic provider，并把 `update-config.json` 指向 `releases/download/latest`。否决：需要维护移动的 `latest` 标签、每次发布手工处理，还要每台机器手动配置。
- 使用第三方发布 action（softprops/action-gh-release）。否决：托管 runner 自带 `gh` 且自动注入 `GITHUB_TOKEN`，工作流保持零第三方依赖。
