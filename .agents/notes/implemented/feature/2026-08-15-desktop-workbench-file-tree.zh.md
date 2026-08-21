# Agent Note：桌面端工作台——会话级文件网关与文件树

Status: implemented

[English](2026-08-15-desktop-workbench-file-tree.md) | 中文

## Problem

桌面端官方 UI 一直没有面向人类的文件面板：工作区浏览器只列会话、交付物只列产物，没有任何界面浏览会话工作目录、打开文件或保存编辑。工作台的第一块（P0-1，已与用户确认方案）是会话级文件树加只读文本查看器，为后续类 VSCode 工作台目标（编辑器、终端、Git、任务面板）打底。

## Decision

新增两个包，走官方 Remote 通道而非自建 HTTP 路由：

- `@deepseek-ai/dsh-host-workbench` —— 一个 `TypertRemoteService` 网关（`ctx.remote.workbench`），暴露 `cwd`/`listDir`/`readText`/`writeText`，全部会话级（会话头部的 `cwd` 解析相对路径），并建立在已挂载的 `ctx.fs` 之上，使文件访问继承 realpath 身份、原子变更、版本守卫与沙箱策略。文本读取走 1 MiB 窗口（超大文件经 `streamText` 返回头部窗口），二进制文件经 NUL 探测并标记，带版本写入受守卫。
- `@deepseek-ai/dsh-client-ui-workbench` —— 浏览器半：会话头部切换按钮（`conversation.session.header.actions`）在 shell overlay（`shell.overlay`）中打开绑定到该会话的右侧面板。文件树懒加载（挂载时加载根，每层展开一次），查看器对二进制/截断/空文件/读取失败给出显式状态。一个状态句柄在插件 apply 体内创建，并通过两个注册的 slot inject 闭包共享——slot store seat 禁止同一句柄跨两个 scope。

`@deepseek-ai/dsh-api-remotes` 装配生成的 workbench Remote 客户端（`import workbenchRemote from '@deepseek-ai/dsh-host-workbench/remote'`）并 re-export 线类型，使 client 插件获得带完整类型的 `ctx.remote.workbench`。web-app 的 patch 层挂载两行（`workbench`、`ui-workbench`）。

## Alternatives considered

**像 dsh-better-sidebar 一样开放 `/workbench` HTTP 路由。** 拒绝：官方 Remote + Typert 管线免费提供类型化客户端调用、信任围栏与桌面端 in-process carrier，并让工作台与其它宿主能力走同一条边界。

**用 slot store seat 共享打开/会话/文件状态。** 拒绝：`ui-slots` 禁止同一 store 句柄跨两个 scope，而切换按钮与面板位于不同 slot；在 apply 内创建句柄并经 inject 闭包传递是官方文档对这种形态的写法。

## Consequences

桌面端（与 Web 端）获得右侧文件工作台：打开绑定会话的 cwd、懒加载展开目录、在只读查看器中打开文本文件。宿主网关是后续切片扩展的单一文件面——编辑器（P0-4）在同一个 `writeText`/`readText` Remote 上加写入与多 tab，预览（P1-2）复用 `readText`/媒体读取。无任何模型侧行为变化：此处不触及 prompt、消息、schema、流或工具结果。