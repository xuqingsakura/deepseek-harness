# Agent Note: 桌面端插件安装继承用户代理

Status: implemented

[English](2026-08-15-desktop-plugin-proxy-inheritance.md) | 中文

## Problem

桌面端 设置 → 插件 安装 GitHub 托管的插件时，即使浏览器能打开 GitHub，也间歇性地以 `ECONNRESET`/`ETIMEDOUT` 访问 github.com 失败。浏览器走系统（WinINET）代理；桌面端 spawn 的 pnpm 自己的 HTTP 客户端既不认系统代理，也不认 git 的 `http.proxy` 配置，于是直连被重置。git 本身因为读取全局 `http.proxy` 而正常，这让故障看起来像仓库问题。

## Decision

`apps/desktop/src/plugin-manager.ts` 在每次插件操作时解析一次代理。显式 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量优先；否则读取用户全局 git 代理（`git config --global https.proxy`/`http.proxy`）——桌面用户配置路由的既有位置。解析到的代理写入 profile 的 `.npmrc`（`http-proxy`/`https-proxy`/`no-proxy`，pnpm 自己的 HTTP 客户端读取这些），并以 `HTTP(S)_PROXY`/`ALL_PROXY` 环境变量传给 pnpm/git 子进程（git 读取这些）。代理来自 git 配置时，`no-proxy` 保留 `127.0.0.1,localhost`，本地 registry 镜像永不被代理。任何地方都没配置代理时行为不变（直连）。

## Alternatives considered

**只写 npmrc 代理行。** 拒绝，因为 pnpm 的 git fetcher 会 spawn 系统 `git`，它读取环境变量和自身配置而非 profile 的 `.npmrc`；环境变量透传覆盖了那一层。

**直接读取系统（WinINET）代理。** 拒绝，因为它需要额外的注册表管道，而用户的 git 配置是桌面端 CLI 风格流量应走哪里的既有显式信号。

## Consequences

当用户在环境变量或 git 配置中有代理时，GitHub 插件安装现在与浏览器走同一条链路，消除了时好时坏的直连失败。profile 的 `.npmrc` 每次操作都会被重写，只保留安装器管理的行（update-notifier、registry、代理），代理消失时下次安装会移除它。代理失效仍会以 pnpm 报错形式显示在 UI 中。