# 桌面端融合 upstream alpha.5 计划与决策

> fork 专属文档：记录将 fork（`xuqingsakura/deepseek-harness`）贴合 upstream `alpha.5` 的迁移计划、已确认决策与进展。
> 中文为主，便于长期维护与后续 agent 参考。

## 背景

- 本地基点为 upstream `alpha.1`（`cd5ef81481`），其上叠加 49 个 fork 专属提交（桌面工作台/工作区插件/终端/Git/文件树）。
- upstream `master` 已到 **`alpha.5`**（`49a606bc5b`），`alpha.1 → alpha.5` 共 692 个 upstream 提交、3732 文件、+67313/-44202 行，含大量重构（会话/存储层、steer-service、chat-context-memory、code-runtime-python、perf、若干 revert）。

## 已确认决策

1. **贴合 upstream（方案 A）**：整体采用 `alpha.5`，再把 fork 桌面按新 API 重新适配。
2. **迁移/备份优先**：在合并前先备份并处理本地会话数据迁移（当前 `session-persistence-sqlite` schema=19，`alpha.5` 已移除，改为 JSONL-only，现有会话历史可能不可直接读取）。
3. **工作区选择 bug 先独立修复**：当前桌面版本（rc.65 / alpha.1+fork）稳定复现「新建会话显示选择工作区，默认不绑定到对应工作区、且选不了工作区」，先定位并独立修复。
4. **交付物**：合并并重适配后打新 rc（**rc.66**），推到 fork `origin`（**不建 PR**）。

## 重要：暂时放弃 `dsh-workspace`

- **`dsh-workspace`（fork 工作台窗口/终端/Git/文件树插件）暂时放弃**，本次迁移/重适配**不实现、不迁移**。
- 工作台相关能力改由 upstream / 核心 shell 提供的会话视图驱动；`dsh-workbench`（installable plugin）是否保留另行确认。
- 该决定在后续 code 变更与打包中一律生效，避免再次引入 fork 专属工作台窗口。

## 已识别的破坏性变更（合并前必须处理）

- `session-persistence-sqlite` 在 `alpha.5` 中不存在 → JSONL-only（`session-format-01-jsonl-only`、`session-format-02-seq-brands`、`session-log-read-api`）。
- 上游大量重构会与 fork 桌面包冲突。

## 进展

- [ ] 独立修复工作区选择 bug（当前桌面版本）
- [ ] 建备份分支 + 会话数据迁移/备份
- [ ] 合并 upstream alpha.2 → alpha.5，处理冲突
- [ ] 按新 API 重适配桌面
- [ ] 打包 rc.66 并推到 fork origin

## 已确认：新建会话绑定问题处理方式（2026-09-03）

- 现象：在已有工作区（如“测试”）下点“+”新增会话 → 要么落到未绑定的「选择工作区」空状态，要么点击无反应。
- 根因：fork `dsh-workspace` 工作台渲染的工作区列表与标准 `@deepseek-ai/dsh-workspace`（workspace-controller registry）脱节；`connectWorkspace(workspaceId)` 在标准 registry 里找不到该工作区即抛错/不绑定。
- 决定：**不在当前版本单独打补丁**。随 `dsh-workspace` 一并放弃，在 alpha.5 合并 + 桌面重适配（采用标准工作区/会话流程）后于 **rc.66** 统一验证并修复。

## 进展更新（2026-09-03）

- ✅ 合并 upstream alpha.5（`2c7a3e8ae1`），12 处冲突全部按「A 贴合 upstream」解决；新增 fork 本地提交 `1d31186808`（重适配/编译修复）。
- ✅ 备份分支 `backup/pre-upstream-alpha5-merge-2026-09-03`；会话/工作区/设置已备份到 `%APPDATA%\dsh-desktop\userdata-backup-20260903-pre-alpha5`。
- ✅ 会话数据兼容：当前与 alpha.5 的 `SESSION_FORMAT_VERSION` 均为 0，旧 `session.jsonl.zstd` 可被读取，无需自研转换器。
- ✅ 修复构建环境：同步 `pnpm install --ignore-scripts`、补回 `@standard-schema/spec` 的 `.d.ts`（registry 拉取）；host 与 client **均通过 `tsc -b`**。
- ✅ 移除 fork 工作台实现包 `packages/host/workbench`、`packages/client/ui-workbench` 及其依赖/引用/tsconfig 引用（随 `dsh-workspace` 放弃，贴合 upstream）。

## 待办（后续）

- [ ] `pnpm run build`（tsdown 打包）验证完整构建。
- [ ] 桌面端重适配：`apps/desktop` 在 alpha.5 上编译、移除 `dsh-workbench` 插件、更新 web profile。
- [ ] 打包 rc.66。
- [ ] 推到 fork origin（不建 PR）。
- [ ] rc.66 中验证「已有工作区下新增会话绑定」。
