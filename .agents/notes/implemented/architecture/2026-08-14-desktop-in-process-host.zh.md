# Agent Note: 桌面壳在进程内启动 harness

Status: implemented

[English](2026-08-14-desktop-in-process-host.md) | 中文

## 问题

Windows 桌面壳（`apps/desktop`）原本监督一个打包的真实 Node 下的 `dsh web` 子进程宿主（`DSH_DESKTOP_HOST=child`，即 A2 布局）：渲染端经 Electron IPC 桥中继的回环 HTTP/WebSocket 访问 harness。它能工作，但打包了 50 MB 的 `node.exe`、多起一个进程，且一个包里有两个运行时（宿主用系统 Node，壳用 Electron）。A3 的目标是改为在 Electron 主进程内启动 harness。

## 决策

壳**默认在进程内启动 `web` profile**（A3）。`apps/desktop/src/host-in-process.ts` 动态 import 已部署的宿主闭包（`out/runtime/host-deploy`，打包后为 `resources/runtime/host-deploy`），驱动共享的 profile 启动流程（来自 `@deepseek-ai/dsh/lib/profile-boot` 的 `prepareProfile` + `composeProfile` + `allPatches` + `boot`），然后从进程内的 `webServer` 服务读取回环 URL。渲染端与 IPC 桥不变。`DSH_DESKTOP_HOST=child` 保留 A2 子进程路径作为回退。

三个事实让这条路很便宜：

- **裸包名解析需要扁平的 `node_modules`。** vendored Loader 解析裸的 `@deepseek-ai/*` 名字，要么走 Node 内部 ESM loader（`node-addon-require-builtin`，按系统 Node ABI 编译，Electron 下不可用），要么在 `internal` 缺失时从 loader 自身位置向上解析。仓库的 pnpm workspace 不是扁平布局（报 `ERR_MODULE_NOT_FOUND`）；部署的宿主闭包是，所以进程内启动 import 闭包而非仓库源码。
- **`node-pty` 是 N-API。** win32 预编译插件在 Electron 的 Node ABI 下可加载并可 spawn 终端；不需要重建或懒加载，与早期 M1 的假设相反。
- **配置 HMR 需要 internal loader。** `runProfile` 启动后挂的 HMR 监视器在 `internal` 缺失时会抛 `--expose-internals is required`，所以进程内启动跳过这段启动后胶水（以及进程级信号/fail-loud 接线——那属于独立进程，不属于 Electron 应用）。进程内不支持配置热更新。

`apps/cli/src/profile-boot.ts` 现在导出 `composeProfile` 与 `allPatches`，桌面端复用完全相同的补丁叠加逻辑（bundle 层、home 层、overlay、agent-presets 根、遥测开关）而不是复制。tsdown 的 bundle 文件名按内容哈希，因此 `apps/desktop/scripts/deploy-runtime.mjs` 在每次 `pnpm run build:lib:host` 后从 bundle 的 export 行重新生成稳定的 `lib/embed.js` 再导出 shim。

## 备选方案

- **只保留 A2 一种布局** —— 最简单，但保留第二个运行时和打包的 `node.exe`。
- **让 internal loader 在 Electron 下可用**（为 Electron ABI 重建 `node-addon-require-builtin`）—— 能解锁配置 HMR，但 Electron 的 Node 内部结构不保证与原生 Node 一致，且运行时需要第二份按 ABI 区分的副本。
- **懒加载 `node-pty`** —— 探测显示 N-API 预编译在 Electron 下可加载后，已无必要。

## 后果

- 默认桌面运行是一个进程、一个运行时；打包的 `node.exe` 仅服务于 `DSH_DESKTOP_HOST=child` 回退。
- 进程内壳不支持配置热更新（运行时编辑 `cordis.patch.yml`）；web bundle 的模块重载 HMR 原本就已禁用。
- 运行时闭包必须保持刷新（`pnpm run build:lib:host` 后跑 `apps/desktop/scripts/deploy-runtime.mjs`），否则稳定的 `embed.js` shim 会过期。
- 将来若停用子进程回退，可从 `extraResources` 去掉 `node.exe` 做体积优化。
