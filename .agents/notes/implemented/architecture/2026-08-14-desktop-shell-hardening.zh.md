# Agent Note：桌面端加固 —— 固定 browse 目录选择器、稳定渲染源、崩溃与外链处理

Status: implemented

[English](2026-08-14-desktop-shell-hardening.md) | 中文

## 问题

内进程宿主（A3）落地后暴露出三个桌面端缺陷：

- **工作区目录选择器不可用。** web profile 的 `directory-picker-auto` 行在回环绑定下解析到原生 Win32 选择器，而 `win32-dialog-host.ts` 用 `process.execPath` 派生 worker —— 在内进程宿主下这就是 Electron 二进制 —— worker 永远无法上报结果，界面报 "win32 folder dialog worker exited before reporting a result"。
- **渲染源每次启动都变化。** 内进程 webServer 绑定 `--port 0`，每次运行渲染地址都是 `http://127.0.0.1:<随机端口>`。localStorage 按源（含端口）隔离，因此 web UI 的持久化 store（`dsh.sessions.current`、`dsh.conversation.chat`、`dsh.workspace.view.v5`、`dsh.trajectory.duration`）每次启动都会重置，`%APPDATA%\dsh-desktop\Local Storage` 还会积累过期端口的条目。
- **没有渲染崩溃与外链处理。** 渲染进程崩溃后只剩白屏无法恢复；`target=_blank` 链接会在应用内再开一个无边框窗口。

## 决策

- **固定 browse 目录选择器。** `apps/desktop/assets/desktop-browse-picker.yml` 禁用 `directory-picker`（auto）行，插入 `directory-picker-browse` 后端 + `ui-directory-picker-browse` 表面。`host-in-process.ts` 把该 overlay 传给 `composeProfile`，走标准 `--patch` overlay 路径（与 `apps/web/tests/pin-browse-picker.overlay.yml` 同一机制）；child-host 回退路径也带同样的 `--patch`。内进程宿主现在上报解析结果（`directoryPicker`），smoke 断言 `picker=browse`。
- **稳定回环端口。** `host-in-process.ts` 导出 `pickLoopbackPort()`：依次尝试 `17890`、`17891`、`17892`，都不空闲则回退到系统分配端口。内进程与 child 宿主共用该端口，因此只要端口未被占用，渲染源（以及 localStorage）跨启动保持稳定。
- **渲染崩溃与导航加固。** `createMainWindow` 在 `render-process-gone` 后自动重载一次（10 秒内第二次崩溃改为通知，避免无限重载）；`setWindowOpenHandler` 拒绝新窗口并把 http(s) 链接交给系统浏览器；`will-navigate` 阻止离开宿主源。

## 备选方案

- **修复原生 worker 派生**（在 Electron 下为 `process.execPath` 解析真实 `node.exe`）—— 保留系统文件夹对话框，但安装包已为体积裁剪掉 `node.exe`，且 koffi 在 Electron ABI 下的兼容性脆弱。browse 选择器完全跑在渲染进程内，是 web 应用自身支持的非回环路径。
- **用自定义协议承载渲染**来固定源 —— 改动更大，且相比"首选固定端口 + 回退"没有额外收益。

## 影响

- 桌面端始终使用应用内 browse 目录选择器；原生 Win32 文件夹对话框（及其 `koffi` 依赖）在桌面端不再使用，但保留给真实 Node 下的 `dsh web`。
- `17890` 空闲时渲染源稳定，localStorage 跨启动持久；端口被占用则回退（该次启动的界面偏好会再次临时失效，数据不受影响）。
- web 端 home 迁移方式：把 `sessions/`、`settings.yaml`、`.credentials.yaml`、`storages/` 复制到安装版 home；`storages/workspace.json` 为空或缺失时，工作区注册表会重新初始化并自动收养复制的会话（已验证：`session-5b3a4247` → 修仙app 工作区）。
