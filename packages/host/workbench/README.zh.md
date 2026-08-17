# @deepseek-ai/dsh-host-workbench

[English](README.md) | 中文

面向桌面端与 Web 端工作台 UI 的会话级 Remote 网关：会话的权威工作目录、懒加载目录列表、带窗口上限的文本读取、版本守卫的原子写入、持久终端会话，以及 Git 工作树操作——文件访问建立在已挂载的 `ctx.fs` 之上，进程访问通过直接子进程派生，仓库访问通过系统 `git` 可执行文件。

桌面端与 Web 端工作台 UI 调用此网关，而不是自行开放路由，因此文件访问继承了官方文件系统边界：realpath 派生的目标身份、原子变更、版本守卫以及已挂载的沙箱策略。每个操作都按会话隔离：请求携带 `sessionId`，由会话头部的 `cwd` 解析权威工作目录，相对路径基于它解析，与模型侧工具的 execution world 保持一致。

| Remote 方法 | 返回 | 说明 |
|---|---|---|
| `cwd(sessionId)` | `WorkbenchCwdResult` | 会话头部 cwd；会话仍在持久化恢复期间回退到进程 cwd |
| `listDir(sessionId, path)` | `WorkbenchDirEntry[]` | 仅一层——客户端在展开时懒加载子树 |
| `readText(sessionId, path)` | `WorkbenchReadResult` | NUL 探测识别二进制；超大文件返回头部窗口并标记 `truncated: true` |
| `writeText(sessionId, path, content, version?)` | `WorkbenchWriteResult` | 带版本时守卫写入；省略版本为无条件创建或覆盖 |
| `terminalSpawn(sessionId, cwd?)` | `WorkbenchTerminalSpawnResult` | 一个持久 shell（Windows 上为 PowerShell，其他平台为 bash），通过 stdio 管道交互；Windows 优先 `pwsh`，回退到 `powershell.exe` |
| `terminalWrite(sessionId, id, data)` | `void` | 向 shell 的 stdin 写入原始输入 |
| `terminalRead(sessionId, id)` | `WorkbenchTerminalReadResult` | 消费式读取增量输出（UI 轮询，无推送通道） |
| `terminalClose(sessionId, id)` | `void` | 终止进程树并删除记录 |
| `terminalCloseSession(sessionId)` | `void` | 终止某一会话作用域内的全部 shell |
| `gitStatus(sessionId)` | `WorkbenchGitStatusResult` | `isRepo` 标记、当前分支与 porcelain 投影的更改 |
| `gitDiff(sessionId, path?, staged?)` | `WorkbenchGitDiffResult` | 单路径或整个工作树相对索引/HEAD 的统一 diff |
| `gitLog(sessionId, limit?)` | `WorkbenchGitLogEntry[]` | 最近的提交，新到旧 |
| `gitBranches(sessionId)` | `WorkbenchGitBranch[]` | 本地分支，标记当前检出的分支 |
| `gitAdd(sessionId, paths?)` | `void` | 暂存路径；空数组暂存全部 |
| `gitRestore(sessionId, paths, staged?)` | `void` | 放弃工作树更改或取消暂存索引条目 |
| `gitCommit(sessionId, message)` | `void` | 提交已暂存的更改 |
| `gitCheckout(sessionId, branch)` | `void` | 检出某个本地分支 |

终端进程由网关持有：关闭网关会终止所有作用域内的活动 shell。Git 动词以 `git --no-color` 配合 `-c color.ui=false` 运行，保证捕获的输出可解析；变更操作失败时携带捕获的 stderr 明确报错。

## Model Experience

无：网关只为人类工作台 UI 投影宿主文件系统/进程/仓库状态，不触及任何模型请求。

#### KV Cache effect

无：网关从不组装或发送 provider 请求。

## Known Limitations and Deferred Work

- **无递归列举** —— 目录树由客户端基于单层 `listDir` 调用拼装；深树每展开一个目录多一次往返。
- **仅文本窗口** —— 二进制文件返回 `binary: true` 与空内容；图片/PDF 等媒体预览属于后续预览面板，通过同一网关读取。
- **暂无目录创建/重命名/删除** —— 文件树先交付读取/列举；文本写入之外的变更操作属于后续工作。
- **管道式终端而非 PTY** —— shell 通过 stdio 管道运行，没有终端设备，因此不支持全屏交互程序（vim、top 等）；面板面向命令驱动的工作流。
- **Git 依赖系统 `git` 可执行文件** —— 不内置 git；未安装 git 或 PATH 中缺失时，仓库被报告为不存在。