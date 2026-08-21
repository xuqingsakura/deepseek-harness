# Agent Note：工作台包未部署；`dsh.profile.disabled` 启动时未被消费

Status: implemented

[English](2026-08-15-desktop-workbench-deploy-and-disabled-boot.md) | 中文

## Problem

首个工作台安装（rc.15）暴露两个 bug：

1. 工作台完全没有出现：没有头部切换按钮，也没有文件树。新的 `@deepseek-ai/dsh-host-workbench` / `@deepseek-ai/dsh-client-ui-workbench` 包虽然进了安装包，却不在 client 模块表里。
2. whale-girl 在桌面端插件管理里显示"停用"，但 Loader 清单里显示"启用"且实际在运行。

## Root causes

1. **Bundle patch 未部署。** 运行时的 client 插件来自 Loader entries，而 Loader entries 来自 `dsh-web-app` bundle 的 `cordis.patch.yml`。该文件（以及 bundle 的 `package.json` 依赖闭包——它喂给 `healProfilesModuleFallback` 的 flat-module junction）是包源文件而非 `lib/`；闭包同步脚本只复制 `lib/`，所以部署的 bundle 仍是工作台之前的 patch。新包也不在 bundle 的依赖图里，因此没有 `profiles/node_modules` junction，Loader（baseUrl = profile 目录）完全无法解析 `@deepseek-ai/dsh-host-workbench`。
2. **`dsh.profile.disabled` 启动时从未被消费。** `reconcilePlugins`（`dsh plugin` 命令）只用 `disabled` 避免把 bundle 重新 push 进 `dsh.profile.bundles`；`composeProfile` 无条件应用 `bundles` 里的每个 bundle。桌面端管理器的 `setPluginEnabled` 保持 layer stack 恒定（只改 `disabled`，以支持实时启用），于是 `bundles` 里既有 whale-girl，`disabled` 里也有 whale-girl——每次启动 whale-girl 都被重新挂载为启用，而 manifest 视图（桌面端管理器）说停用。两个 UI 读到了两个不同的事实。

## Decision

1. **把 bundle patch 作为桌面端运行时的一部分发布。** 构建/部署流程现在把 `dsh-web-app` 的 `cordis.patch.yml` 和 `package.json` 视为可部署对象：两者都复制进运行时闭包，两个新包声明进 bundle 的依赖，使 `healProfilesModuleFallback` 把它们 junction 到 `profiles/node_modules`。于是 client 模块表包含 `@deepseek-ai/dsh-client-ui-workbench`，网关也能加载。
2. **Boot 消费 `dsh.profile.disabled`。** `loadProfile` 现在把 manifest 的 `disabled` 列表投影到 `Profile.disabled`；`composeProfile` 收集每个 disabled bundle 插入的 entry id（insert 列表与直接行），并在所有用户/overlay 层之后追加 `{ id, disabled: true }` overlay patch，使 disabled bundle 的行在启动时以 row-disabled 挂载。layer stack 保持恒定（实时切换仍可用），Loader 清单在下一次启动时与 manifest 视图一致。

## Alternatives considered

**让 `setPluginEnabled(false)` 同时把 bundle 从 `dsh.profile.bundles` 驱逐。** 拒绝：这破坏了实时启用路径依赖的"layer stack 恒定"约定，并且把 entry 从运行树中移除。启动时 row-disable 让 entry 保持挂载但惰性，与实时切换模型一致。

**把 patch 放进 `lib/`。** 拒绝：bundle patch 由 `dsh.profile.bundles` 解析时从包根读取；复制到 `lib/` 会分裂事实源。

## Consequences

新安装现在会加载工作台（切换按钮 + overlay 文件树）；通过桌面端管理器停用的 bundle 在重启后保持停用，且管理器与 Loader 清单一致。`pnpm run build:lib:host` + 闭包同步 + `deploy-runtime` 是完整发布路径；bundle patch/package.json 变更也必须复制进运行时闭包（同步脚本只复制 `lib/`）。