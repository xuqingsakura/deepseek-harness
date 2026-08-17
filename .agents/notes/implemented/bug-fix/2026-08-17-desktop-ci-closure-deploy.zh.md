# Agent Note：桌面端 CI 用 pnpm deploy 物化 host 闭包

Status: implemented

[English](2026-08-17-desktop-ci-closure-deploy.md) | 中文

## Problem

`package.mjs` 假设已部署的 host 闭包（`apps/desktop/out/runtime/host-deploy`）已经存在，所以干净的 CI 树在「deploy runtime closure」一步失败（`runtime closure not found`）。该闭包之前只能靠本地临时 `pnpm deploy` 生成，导致 release workflow 无法构建安装包。

## Decision

- `package.mjs` 在刷新前物化缺失的闭包：`pnpm --filter @deepseek-ai/dsh-desktop-host-pkg deploy --legacy --prod`，带 hoisted 链接器、`link-workspace-packages`、`confirm-modules-purge=false` 和 `CI=true`（CI 下 pnpm 跳过非 TTY 的清除确认）。目标目录先删除，因为 pnpm deploy 拒绝非空目录。
- `deploy-runtime.mjs` 在全新 deploy 跳过 `@deepseek-ai/dsh` bin 包时，从 `apps/cli` 补齐该包（pnpm legacy deploy 会跳过只有 bin 的 workspace 包），并裁剪 legacy deploy 从源包目录复制进闭包的 vendored pnpm——它通过 electron-builder `extraResources` 单独分发，闭包里的副本约 110 MB，纯属重复。

## Consequences

干净树构建（CI）现在可以端到端打包：`pnpm install` → `build:lib:host` → `package:desktop`。闭包不再携带重复的 vendored pnpm，安装包体积接近此前水平。本地已有闭包的重建会跳过 deploy 步骤。

## Alternatives considered

- 在 CI 里用缓存预置闭包。否决：闭包是大体积构建产物；每次从 pnpm store 生成更简单，缓存恢复也有自身成本。
- 让 `deploy-runtime.mjs` 自己执行 deploy。否决：deploy 属于打包编排的职责，而补齐 dsh bin 包仍是 deploy-runtime 的职责（它拥有闭包布局）。
