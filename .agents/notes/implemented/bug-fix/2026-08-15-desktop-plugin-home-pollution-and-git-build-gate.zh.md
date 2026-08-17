# Agent Note: 桌面端插件 home 污染与 git 构建授权

Status: implemented

[English](2026-08-15-desktop-plugin-home-pollution-and-git-build-gate.md) | 中文

## Problem

在桌面端 设置 -> 插件 中安装插件会失败并提示 `dsh-plugin: harness home 必须是绝对路径，实际为 "undefined"`。in-process host 在启动 web profile 前设置 `process.env.DSH_HOME`，结束后再恢复。普通启动时该环境变量未被设置，恢复阶段把 `undefined` 赋给它；Node 会强制把环境变量写入字符串化，得到字面量 `"undefined"`。之后的 `harnessHome()` 把这个非空值当作已配置 home，`assertSafePluginHome` 随即拒绝该相对路径。同样的污染在 home 断言出现之前，曾以“向安装目录写入导致 EPERM”的形式暴露。

另外，按发布教程安装 git 源码插件时，pnpm >= 10 在运行 `prepare` 脚本前要求 `allowBuilds` 授权；未授权时 pnpm 以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 中止。桌面端 UI 此前只回显 pnpm 输出，用户需要手动编辑 `pnpm-workspace.yaml`。

## Decision

`host-in-process.ts` 恢复环境变量时，若启动前未设置则删除该变量，只有存在真实旧值时才赋值。`harnessHome()` 同时把字面量 `"undefined"`/`"null"`/`"NaN"` 视为未配置，回退到应用数据目录下的 `dsh-home`，使被污染的环境变量永远无法劫持插件管理。

对于构建授权，`plugin-manager.ts` 新增 `parseAllowBuildHints()`，从 pnpm 输出中 `allowBuilds:` hint 块里读取精确的 depPath key；`writeAllowBuilds()` 把这些 key 合并进 profile 的 `pnpm-workspace.yaml`（单引号引用、保留已有 key），不执行任何包代码。`authorizeBuilds()` 暴露该流程，`PluginManagerResult` 把解析出的 key 带回 UI。新增 `dsh:plugin-allow-builds` IPC（preload 桥暴露为 `pluginAuthorizeBuilds`）执行写入。安装失败且存在待授权 key 时，管理器展示警告、精确 key 和“授权构建脚本并重试安装”按钮，点击后先授权再重新执行 add。

## Alternatives considered

**只修 `harnessHome()`。** 拒绝，因为环境变量仍会被污染并影响后续所有读取方，而不只是插件管理；修复恢复逻辑才是根因，home 守卫是纵深防御。

**解析 `Ignored build scripts:` 警告而非 hint 块。** 拒绝，因为该警告伴随非致命路径，安装可能“成功”但脚本没有运行。致命的 `GIT_DEP_PREPARE_NOT_ALLOWED` 错误在其 hint 中携带权威的 depPath key，这正是 pnpm 接受的原样 key。

**交互式运行 `pnpm approve-builds`。** 拒绝，因为桌面端通过 `spawnSync` 运行 pnpm 且没有 TTY，该命令需要交互；写入 `pnpm-workspace.yaml` 与 pnpm 所做的文件级修改一致且可脚本化。

## Consequences

插件管理不再依赖 host 的环境变量恢复行为：全新安装或覆盖安装后的首次启动即可直接添加插件。git 托管插件安装现在会在 UI 内引导用户授权并重试，而不是在原始 pnpm 报错处中断，并带有一条明确警告：授权意味着该包的构建代码会在用户机器上执行。授权只修改 profile 的 `pnpm-workspace.yaml`，不改动其他配置。