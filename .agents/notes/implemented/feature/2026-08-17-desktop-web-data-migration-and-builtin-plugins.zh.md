# Agent Note：Web 数据迁移工具与内置插件一键安装

状态：已实现

[English](2026-08-17-desktop-web-data-migration-and-builtin-plugins.md) | 中文

## 问题

从 Web 版迁移到桌面端需要手动把 Web harness home（~/.dsh）拷贝到桌面 home，而且不清楚哪些可以安全覆盖。另外，随应用一起发布的工作台插件虽然内置，但从「设置 → 插件」安装时仍需手动输入本地路径。

## 决策

新增一个无依赖的迁移模块，并为内置插件提供一键安装入口：

- **迁移模块**：`apps/desktop/src/migrate-web-data.ts` 把 Web harness home 的对话会话与存储记录复制/合并到目标 home，绝不覆盖目标已有的数据。会话仅在目标缺少该会话目录时复制（已存在的会话 id 默认跳过，`--force` 才覆盖）；`storages/*.json` 按 key 合并，目标已有 key 优先；`settings.yaml` / `.credentials.yaml` 默认不迁移，仅在显式勾选且目标文件不存在时写入；`.anonymous-user-id` 仅在目标没有时才复制。`--dry-run` 只输出计划不改动任何文件，`--json` 输出机器可读报告。
- **CLI**：`apps/desktop/scripts/migrate-web-data.mjs` 在命令行运行同一模块（源默认 `~/.dsh`，目标默认桌面 home）。
- **GUI**：设置 → 关于与更新新增「从 Web 版导入数据」区块（预览导入、开始导入、设置/凭据勾选、结果统计），通过 IPC `dsh:migrate-web-data` 驱动该模块。
- **内置插件**：`plugin-manager.ts` 新增 `listBuiltinPlugins()` / `installBuiltinPlugin()`，扫描 `resources/plugins`（开发：`apps/desktop/plugins`）下声明 `dsh.bundle.patch` 的目录。设置 → 插件新增「内置插件」区块，每个插件一键安装（`file:` 形式，无需输入路径），复用官方 profile 插件流程。

## 影响

Web 版用户可以在一键引导下把对话、工作区与设置迁入桌面端；内置工作台/皮肤插件无需手动输入路径即可安装。迁移默认不破坏桌面端已有数据，因此对已填充的桌面重复运行是安全的。

## 备选方案

- 整目录拷贝（sessions + settings + credentials + profiles）：会覆盖桌面端自身数据，还会带入 Web profile 的运行时 node_modules。否决：采用上述"不覆盖合并"语义更安全、更快。
- 单独做迁移二进制而不是桌面 IPC + CLI 组合：模块可以从两个入口复用同一实现，单独的二进制只会增加打包体积而没有收益。
