# Agent Note：工作台底部终端面板、VSCode 风格 Git 与参数个数修复

Status: implemented

[English](2026-08-16-workbench-bottom-terminal-vscode-git.md) | 中文

## 问题

桌面端工作台出现两个回归和一个布局缺口：
- UI 终端报 `client api: workbench/terminalSpawn expected 2 argument(s), got 1` —— typert 客户端拒绝参数个数与描述符参数列表不一致的调用，因此可选参数必须显式传 `undefined`。
- Git 变更行只在侧边栏预览 diff，无法在中间查看器中打开变更文件。
- 终端在左侧标签条内，空间狭窄；布局缺少 VSCode 风格的底部面板。

## 决策

- **参数个数修复**：在四个 workbench 客户端调用点（`terminalSpawn`、`gitFetch`、`gitPush`、`writeText`）为每个省略的可选参数显式传 `undefined`。这是纯客户端改动，网关描述符不变。
- **底部终端面板**：布局插件的 `AppFrame` 增加第二行 grid。布局 store 记录 `bottom` 高度（0 = 关闭），通过 `ctx.layout` 暴露 `setBottom`/toggle/close 操作；垂直拖拽手柄调整条高。工作台插件注册 `workbench.bottom` 席位，其占用者（`WorkbenchBottomTerminal`）绑定文件树的会话并渲染共享终端面板。侧边栏标签条移除终端标签，改为打开底部面板的 `>_` 开关按钮。
- **VSCode 风格 Git**：`WorkbenchGitPanel` 接受接到 `workbench.open` 的 `onOpenFile` 回调；单击变更行（或其 ↗ 按钮）在中间查看器打开文件，同时保留 diff 预览选中。
- **终端打磨**：输出条通过新的纯函数 `parseAnsi`（带单元测试）渲染 ANSI SGR 颜色（前景、背景、粗体、反色）；新增复制按钮将当前输出写入剪贴板。

## 后果

桌面端工作台现在在框架底部有可调整高度的 VSCode 风格终端条，Git 行可在中间编辑器打开文件，终端输出带颜色。参数个数修复恢复了客户端的终端启动、拉取、推送与新建文件。底部面板与查看器一样是 root 作用域：打开即渲染，并通过工作台状态解析会话（固定会话，当前会话为回退）。

## 备选方案考量

- 用 xterm.js + node-pty 实现真 PTY 终端（DSH-better-sidebar 的做法）：Electron 下的原生模块 ABI 风险与额外安装体积；现有管道式 shell 已满足面板需求。若交互式 TUI 支持成为需求可再评估。
- 用固定定位覆盖式终端（像 DSH-better-sidebar 那样 CSS margin 挤压）：依赖框架的 DOM 顺序且与 grid 冲突；显式的第二行 grid 让布局保持声明式且可测试。
## 后续打磨（同一会话）

- **Shell 探测修复**：旧 pickShell 用异步 `spawn()` 探测候选，其 ENOENT 通过调用方永远看不到的 'error' 事件到达，因此即使 Electron PATH 中没有 `pwsh.exe` 也总是选中它，终端报 `spawn pwsh.exe ENOENT`。`probeShell` 现在用 `spawnSync()`（同步抛出 ENOENT）同步探测，回退到 `powershell.exe`；`pickShell` 增加测试注入的探测参数。
- **Git 面板**：溢出操作收进 ⋯ 菜单（全部暂存、全部放弃、拉取、同步、推送），窄侧边栏工具栏不再换行；移除侧边栏 diff 预览列。单击变更行现在在中间查看器打开该文件的 diff——新增 `DiffViewer` 席位（`workbench.openDiff` 状态：路径 + staged 标志），对齐 VSCode 源代码管理单击查看 diff 的行为。
- **终端条**：移除复制按钮；标签栏新增 ✕ 按钮关闭整个底部面板（用侧边栏的 `>_` 开关重新打开）；底部行只横跨中间与右侧列（`grid-column: 2 / -1`），文件树列保持完整高度。
- **Windows PowerShell 编码**：UTF-8 固定从 UI 侧 stdin 前导（PowerShell 5.1 会把它回显进输出并导致乱码）移到 host 启动参数——`powershell.exe` 现在用 `-NoExit -Command` 启动，在首个提示符前执行 `[Console]::OutputEncoding` / `$OutputEncoding`，初始化行不再回显且 shell 保持交互。
- **Git 溢出菜单**：⋯ 锚点按钮补上缺失的开关 onClick，菜单现在能打开。
- **Git 面板布局**："源代码管理"标题不再换行；分支选择移到标题下独占整行；提交区改为竖排（提交信息输入框在上、提交按钮在下）。更改列表内部滚动（`min-height: 0` + 面板 `overflow: hidden`），长变更列表不再把提交历史挤出可视区。
- **可折叠更改分组**：每个分组标题（已暂存 / 更改 / 未跟踪）现在是带 ▶/▼ 箭头的文件夹样式按钮，可折叠或展开整个文件列表。
- **提交历史置顶**：提交历史条移到更改列表上方并固定高度，长更改列表在其下方滚动（overflow-y auto），不再把历史挤出可视区。
- **侧边栏全高**：侧边栏列现在横跨两行 grid（grid-row: 1 / -1），打开底部终端不再在文件树下方留下空白矩形（底部行只横跨第 2-3 列）。
- **Git 提交历史相邻**：提交历史条移回更改列表下方、紧贴提交信息输入框上方，不再浮在顶部与输入框隔开（空状态间隙）。更改列表在其上方滚动。
- **列表滚动根因**：工作台侧边栏面板缺少 `min-height: 0`，导致嵌套的更改列表撑开面板而不是滚动。已补上；列表现在内部滚动（滚动条跟随指针显示，遵循侧边栏的 quiet-bars 行为）。
- **终端关闭**：关闭最后一个 shell 标签现在关闭整个底部面板（VSCode 式），不再留下空条；与关闭标签竞态的轮询会静默停止，不再报 `unknown terminal`。
- **提交历史相邻落地**：早前一次尝试只是文本上重排了 DOM 而没有真正移动块（提取的片段仍覆盖 body + history）；rc.47 只移动 history 块，提交输入区终于紧贴更改列表下方，提交历史位于两者之间。
