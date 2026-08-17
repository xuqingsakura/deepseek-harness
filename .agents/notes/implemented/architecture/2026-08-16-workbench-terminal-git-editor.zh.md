# Agent Note：工作台 P0–P2 —— CodeMirror 编辑器、终端、Git 与任务面板

Status: implemented

[English](2026-08-16-workbench-terminal-git-editor.md) | 中文

## 问题

工作台视图最初是只读的：一个懒加载文件树加 CodeBlock 查看器。编辑、执行命令、源代码管理与查看后台任务都需要离开面板。

## 决策

在单个 `dsh-host-workbench` Remote 网关上扩展终端与 Git 动词（而非新建包：两者都是对宿主进程的 UI 支撑投影，复用网关的会话 cwd 绑定与清理），并将浏览器半的 `sidebar.workbench` 席位扩展为带标签页的面板。

- **编辑器（P0-4）**：非 Markdown 文件用 CodeMirror 取代只读查看器。语言支持把共享的 `file-lang` 提示映射到 `@codemirror/*` 各包；Markdown 保持 MarkdownText 渲染。保存走既有的版本守卫 `writeText`（Ctrl+S 或头部按钮），带脏标记与保存/错误提示。CodeMirror 内联进 client bundle（tsdown `noExternal`），因此运行时闭包无需新增包。主题通过 MutationObserver 重配置实时跟随 `body[data-ds-dark-theme]`。
- **终端（P0-2）**：`terminalSpawn/Write/Read/Close/CloseSession` 在每个会话作用域内通过 stdio 管道运行一个持久 shell——Windows 上为 PowerShell（优先 `pwsh`，回退 `powershell.exe` 并加 UTF-8 输出前导），POSIX 为 bash/sh。无 PTY：按设计不支持全屏交互程序；UI 轮询 `terminalRead` 获取增量输出。
- **Git（P1-1）**：`gitStatus/Diff/Log/Branches/Add/Restore/Commit/Checkout` 驱动系统 `git` 二进制，以 `-c color.ui=false` 保证输出可解析。面板展示 VSCode 风格的已暂存/未暂存/未跟踪分组、统一 diff 预览、单文件与全量暂存/放弃、提交信息输入与分支切换。`isRepo` 区分非仓库目录与干净仓库。
- **任务**：侧边栏任务标签复用会话头弹窗使用的 `jobsBySession` 镜像——只读列表，带实时时长。

Windows 端终端清理使用 `taskkill /T /F`，回退到 `child.kill()`（沙箱环境拒绝 taskkill），并等待进程 `exit` 事件，确保调用方删除 cwd 目录前目录锁已释放（EBUSY）。

## 后果

工作台侧边栏现在是覆盖四个会话级视图的标签条；中间列可编辑并真实保存文件；Git 变更操作携带捕获的 stderr 明确失败。终端刻意采用管道式而非 PTY，Git 依赖系统 `git` 二进制——两者都在包 README 中记录。

## 备选方案考量

- 用 node-pty/ConPTY 实现真终端：Electron 下的原生模块 ABI 风险与额外安装体积；subprocess seam 已为模型侧终端工具持有 node-pty，但 UI 面板不需要全屏程序。若交互式 TUI 支持成为需求可再评估。
- 单独建 `dsh-host-terminal-ui` / `dsh-host-git` 包：两个 UI 支撑投影已共享 workbench 网关的会话作用域与清理，额外样板不划算；网关的 `remoteMethods()` 测试无论如何都会钉死方法清单。

## 后续打磨（同一会话）

- **文件系统动词** —— 网关新增 `fsMkdir`/`fsRename`/`fsRemove`（node:fs/promises，路径在会话 cwd 内规范化，拒绝越界）；文件树新增右键上下文菜单（新建文件/文件夹、重命名、删除），每次变更后刷新受影响的目录。刻意不改 `dsh-fs`：这些是 UI 变更操作，不是新的能力 seam。
- **Git 网络动词** —— `gitFetch`/`gitPull`/`gitPush` 加入网关；面板新增拉取/同步/推送按钮、逐行高亮的 diff 视图与最近提交历史条。
- **编辑器标签** —— 右键批量关闭（本页/其他/全部），并通过查看器的脏路径集合接入未保存更改确认守卫。
- **终端** —— 多 shell 标签（用 + 新建）、每个终端的清屏与上下键命令历史；会话切换仍会拆除全部 shell。
