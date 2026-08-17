# Agent Note：在「插件列表」tab 启用/停用外部插件

Status: implemented

[English](2026-08-17-plugin-list-enable-disable.md) | 中文

## Problem

插件设置的「插件列表」tab（`PluginInventorySettingsTab`）是只读的 Loader 运行状态目录：每一行只显示「已启用/已停用」配置标签和 Cordis 状态。用户已停用的插件（例如 whale-girl）无法在这个列表里重新启用，唯一的管理入口（桌面端插件管理）在另一个 tab，导致已停用插件看起来无法操作。

## Decision

该目录现在检测桌面端 Electron bridge（`window.dshDesktop`），通过 `pluginList()` 加载已安装的外部插件列表，并以包名建立索引。对于 `moduleName` 匹配已安装外部插件的目录行，展开后的卡片详情里增加「启用/停用」按钮：点击调用 `pluginSetEnabled(name, !enabled)`、更新本地映射，并重新读取 Loader 目录让该行反映新状态。浏览器构建没有 bridge，保持只读，与现有 `DesktopPluginManager` 的模式一致。

## Consequences

用户可以直接在「插件列表」tab 切换外部插件的启用状态，无需切到桌面端插件管理。bridge 失败路径会让目录保持只读而不是破坏列表；切换进行中按钮进入 busy 禁用状态。

## Alternatives considered

- 所有启用/停用都路由到已有的桌面端插件管理 tab。否决：用户的期望是在看到状态的地方直接操作，且两个 tab 是相互独立的界面。
- 只在卡片标题行暴露切换按钮。否决：该行是一个展开按钮，再嵌套按钮违反 HTML 交互内容规则，所以操作放在展开后的详情区。
