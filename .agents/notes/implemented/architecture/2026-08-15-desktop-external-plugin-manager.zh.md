# Agent Note: 桌面端统一外部插件管理器

Status: implemented

[English](2026-08-15-desktop-external-plugin-manager.md) | 中文

## Problem

桌面端 设置 → 插件 此前有两块深度不同的界面：一块是只读的运行时 Loader 清单（每个已挂载条目），另一块是最简安装列表（只有添加/移除），既不显示来源、也没有更新路径、没有启用/停用、没有运行状态。管理一个外部插件意味着要知道 pnpm 规格、猜测来源，还要重启后才能发现它是否真的挂载——尤其 GitHub 安装没有可见的更新或失败路径。

## Decision

`apps/desktop/src/plugin-manager.ts` 加厚已安装插件投影并新增管理动词，全部基于官方 `dsh plugin --profile web` 流程：

- `listPlugins` 在原有 name/version/isBundle/patch 之外返回 `spec`、`source`（`npm`/`git`/`local`，从 pnpm 依赖规格推导）与 `enabled`。
- `updatePlugin` / `updateAllPlugins` 运行 `pnpm update <name>` / `pnpm update`；`removePlugins` 把多个名字合并为一次 `pnpm remove`。`checkOutdated` 解析 `pnpm outdated --format json` 为 name -> latest 映射（git 与本地插件不被 pnpm 报告，永不出现）。
- `setPluginEnabled` 通过维护 profile 清单的 `dsh.profile.disabled` 列表来切换 bundle 插件的层成员资格，不运行 pnpm；`reconcilePlugins`（桌面端与 CLI 的 `apps/cli/src/plugin.ts`）现在尊重该列表，因此停用的 bundle 保留安装但退出层栈，且在下一次 pnpm 操作中不会被重新加入。`packages/boot/app-boot/src/profile.ts` 的 `DshProfileManifest` 声明了该字段。
- 新增 IPC `dsh:plugin-update`、`dsh:plugin-update-all`、`dsh:plugin-remove-many`、`dsh:plugin-set-enabled`、`dsh:plugin-outdated`（preload 桥 `pluginUpdate`/`pluginUpdateAll`/`pluginRemoveMany`/`pluginSetEnabled`/`pluginOutdated`）。

渲染端区块（`DesktopPluginManager.tsx`）是统一管理器：每个外部插件行显示来源徽标、版本、bundle/状态标签，以及从标签页传入的 Loader 清单快照匹配到的运行时挂载阶段；失败行展示 fiber 的挂载错误（`packages/host/plugin-inventory` 现在把 FAILED fiber 的私有 `_error` 投影为 `error`）。操作为更新、启用/停用（仅 bundle 插件）、移除、复选框批量移除，以及"可更新"徽标。`pnpm outdated` 在挂载时与版本相关操作后各运行一次，而不是每次切换后都运行，以保持区块响应。

启用/停用即时生效，而不仅限于下次启动：`host-in-process.ts` 暴露 `InProcessHostControls.setPluginEnabled`，安装器在写入清单后调用它切换运行中的 Loader 行（`entry.update({ disabled })`——与配置 HMR 使用的运行时变更相同）。host 的 client-modules 扫描会把被停用的行从 `__DSH_BOOT__` 剔除（被停用的条目没有 fiber）；`client-hmr` 通过 `/plugins/events` 广播重组后的图，其浏览器半区按图 reconcile 成员（挂载缺失行、卸载离开行；内核行除外），因此插件的 UI 无需页面重载即可卸载/挂载。rev 变更仍由 `rebuilt` 帧处理。

## Alternatives considered

**新增独立管理区块而不是升级现有区块。** 拒绝：两个列表会以不同事实重复列出同一批已安装包，而重启提示与 allowBuilds 授权门已经位于现有区块。

**直接编辑 `dsh.profile.bundles` 实现启用/停用。** 拒绝：`reconcilePlugins` 会自动把任何声明 `dsh.bundle` 的依赖重新加入列表，因此裸移除无法在下一次 pnpm 操作后幸存；显式 `disabled` 列表才是持久、reconcile 感知的来源。

**安装时读取系统（WinINET）代理。** 已在代理继承 note 中否决；本特性原样复用该解析。

## Consequences

外部插件现在可以在一个地方统一管理，来源、版本、更新、启用/停用、运行时阶段与失败详情都可见，且全部由 CLI 使用的同一套 reconcile 支撑，两个界面不会漂移。启用/停用是一次清单写入、无 pnpm spawn，批量动词把安装期工作压缩为一次 pnpm 调用。profile 清单新增可选 `dsh.profile.disabled` 数组；不认识它的旧 CLI 构建会在下次 `dsh plugin` 运行时重新加入被停用的 bundle，因此 CLI reconcile 在本次改动中同步更新。启用/停用对两端都不再需要重启：Loader 行即时切换，渲染端跟随重组后的图，被停用插件的 UI 会立即消失、启用时立即重现。重启提示仍适用于安装、移除与 host 半区代码更新——后者的模块代码没有热替换。