# Agent Note：工作台拆分为可安装插件

Status: implemented

[English](2026-08-17-desktop-workbench-plugin-split.md) | 中文

## 问题

桌面端把工作台（文件树、编辑器、Git、终端、任务）硬编码进 web-app bundle：host 网关（`dsh-host-workbench`）与 UI（`dsh-client-ui-workbench`）都由 web-app 的 patch 层插入，因此每次安装都自带工作台，无论是否使用；侧边栏 activity 栏也始终显示工作台视图切换图标。

## 决策

把工作台变成可安装插件，并让桌面端默认恢复无工作台状态：

- **插件**：新的纯 patch bundle `apps/desktop/plugins/dsh-workbench`（package.json 声明 `dsh.bundle.patch` + cordis.patch.yml）把两个既有 workbench 包挂载为 entry。两个包仍随运行时闭包分发（web-app 保留为依赖），profile 的扁平回退 node_modules 保持可解析；插件本身无代码。
- **桌面端默认**：web-app 的 patch 层不再插入 `workbench`/`ui-workbench`，全新桌面端没有工作台开关、没有工作台侧边栏区域，布局保持对话视图。
- **侧边栏**：移除 activity 栏的工作台图标；工作台从插件注册的会话头部「工作台」按钮打开。
- **分发**：electron-builder 把插件随安装包分发到 `resources/plugins/dsh-workbench`；插件管理从该本地路径安装。

工作台布局席位（ui-sidebar / ui-layout 中的 sidebar.workbench / workbench.viewer / workbench.bottom）保留在核心 shell——没有注册占用者时它们是惰性的，正是插件注册的锚点。

## 后果

默认桌面端不再显示或加载工作台。安装 dsh-workbench（设置 → 插件，本地路径）后以最新随包代码重新激活。该拆分仅限 fork：插件依赖的布局席位不在上游，因此插件在未修改的官方桌面端上不可用。

## 备选方案考量

- 自包含插件打包工作台代码：更重，且仍然无法在官方桌面端提供缺失的布局席位，对第三方安装没有收益。
- 保持工作台默认开启、只把插件作为替代：不满足「桌面端恢复无工作台状态」。
- **activity 栏图标恢复（条件显示）**：侧边栏现在只在工作台席位有注册占用者时显示工作台视图图标。ui-sidebar 查询 `ctx.slots.entries('sidebar.workbench')` 并订阅其 slot 变更，因此安装插件即恢复图标（卸载即移除），无需重启 shell——新会话可以立刻从 activity 栏进入工作台，无需先聊天。
