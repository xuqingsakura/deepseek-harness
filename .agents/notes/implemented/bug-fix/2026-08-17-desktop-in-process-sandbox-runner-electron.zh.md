# Agent Note：桌面端 in-process host 下 pwsh 工具返回空输出

Status: implemented

[English](2026-08-17-desktop-in-process-sandbox-runner-electron.md) | 中文

## Problem

打包后的 Windows 桌面端应用里，pwsh 工具对每条命令都返回空结果：没有 stdout、没有 stderr、也没有退出码标记（以 exit 0 且「无输出」结束）。最小命令如 `Write-Output "HELLO_MARKER_12345"` 也毫无输出，而 read/glob/grep/write/edit 等文件工具都正常。命令行直接测试 powershell.exe、pwsh.exe 和 windows-acl runner 全部成功，说明问题只出现在打包后的 Electron host 里。

## Root cause

桌面端默认以 in-process 方式启动 harness（A3，`startHostInProcess`），host 运行在 Electron 主进程内，`process.execPath` 是 `DeepSeek Harness.exe` 而不是 `node.exe`。windows-acl 沙箱 runner 的调用形式是 `[process.execPath, runner.js, ...]`（`dsh-sandbox-local` 的 `windowsAclRunnerInvocation`）。在没有 `ELECTRON_RUN_AS_NODE=1` 的情况下 spawn Electron 可执行文件，会把它当作 GUI 应用启动；应用的单实例锁（`requestSingleInstanceLock`）让第二个实例立即以状态 0 退出且无输出，于是 runner 从未执行、被限制的 pwsh 也从未运行。桌面端所有走沙箱的命令都命中这条路径，所以 pwsh（以及未来任何 windows-acl 限制的命令）看起来能调用却毫无输出。

## Decision

在 `packages/subprocess/subprocess-local/src/spawn.ts` 中，`spawnSubprocess` 现在检测被 spawn 的程序是否是当前进程自身的可执行文件且处于 Electron 环境（`process.versions.electron` 加 `process.execPath`），并在子进程环境里加入 `ELECTRON_RUN_AS_NODE=1`。这样 Electron 会把 `runner.js` 当作普通 Node 脚本执行（已在用户机器上验证：runner 运行、koffi 加载、受限的 powershell.exe 正确打印标记）。 同一处 spawn 还在 Windows 上应用 `windowsHide`。但仅此还不够：runner 的受限子进程因为 runner 没有控制台可继承，仍会创建自己的控制台窗口。`dsh-sandbox-windows-acl` 的 `spawnSandboxedInherited`/`spawnSandboxed` 现在给 `CreateProcessAsUserW` 的创建标志加上 `CREATE_NO_WINDOW`，让受限的 PowerShell 也无窗口运行。POC 时代的 `STATUS_DLL_INIT_FAILED`（0xC0000142）警告只在 restricting 列表含 S-1-2-1 控制台登录 SID 时出现；当前发布的列表不含它，该标志经验证可用（输出、stderr、工作区写入都正常，包括 workspace-write 下的中文 UTF-8）。`SpawnInternals` 增加 `electronSelfExec` 测试注入点，让普通 node 测试主机也能覆盖该标志；`spawn.spec.ts` 新增两条测试固化行为。

## Alternatives considered

- 在安装包里内置真正的 `node.exe` 并让 runner 指向它。否决：会增大安装包，且构建本就为体积省略了 node.exe（child-host 模式也明确说明了这一点）。
- 从 PATH 解析系统 node。否决：桌面端不能依赖用户自行安装的 Node；`ELECTRON_RUN_AS_NODE` 复用了应用自带运行时。
- 对所有子进程设置 `ELECTRON_RUN_AS_NODE`。否决：只有当程序是充当 Node 运行时的 Electron 可执行文件时才正确。

## Consequences

桌面端打包后的受限命令（pwsh 工具）恢复正常，且每条命令不再闪现控制台窗口。该标志对非 Electron 二进制无害，且限制只作用于 spawn 应用自身可执行文件的场景，其它子进程不受影响。subprocess 服务现在有一个值得记住的 Windows/Electron 行为，未来任何自执行 spawn 都要留意。
