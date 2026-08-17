# Agent Note：桌面端官方插件安装 —— vendored pnpm、loader 兜底解析、皮肤插件验证

Status: implemented

[English](2026-08-15-desktop-official-plugin-install.md) | 中文

## 问题

桌面端无法安装第三方插件。CLI 的 `dsh plugin --profile web add <package>` 会在 profile 目录内转发给 pnpm，并把声明 `dsh.bundle` 的包 reconcile 进 `dsh.profile.bundles`；但打包版没有 pnpm、没有 `dsh` CLI、也没有 UI 入口。更糟的是，即使手动装好 profile 插件也无法加载：桌面端在内进程启动 web profile，没有 Node 的内部 loader（`node-addon-require-builtin` 是系统 Node ABI，Electron 用不了），vendored Loader 的裸 `import(name)` 从 loader 自身模块图解析 —— `profiles/web/node_modules` 根本够不着。

## 决策

- **复用官方流程，不自建平行机制。** 运行时闭包已带 `apps/cli` 的 `runPlugin` 与 `dsh-app-boot` 的 profile API。桌面端新增 `apps/desktop/src/plugin-manager.ts`，走同一语义：初始化 profile → 用 **vendored pnpm**（`@pnpm/exe` Windows 构建，`resources/pnpm/pnpm.exe`，约 100 MB，精简为 `pnpm.exe` + `dist/`）执行，带 `update-notifier=false`（关闭 pnpm 启动时的 registry 版本检查，否则在国内被墙的 registry 下会卡约 70 秒）→ 按已安装状态 reconcile `dsh.profile.bundles`。`DSH_PNPM_REGISTRY` 可覆盖 registry（镜像）。
- **IPC + UI。** `dsh:plugin-add/remove/list` handler 调用管理器；preload 桥接暴露 `pluginAdd/pluginRemove/pluginList`；设置 → 插件（清单 tab）渲染桌面端专属的 `DesktopPluginManager` 区块（以 `window.dshDesktop` 为门槛）：spec 输入框、已装列表、移除按钮、重启提示。
- **无内部 loader 时的加载兜底。** `vendor/loader/src/config/tree.ts` —— 当 `ctx.loader.internal` 缺失且是裸包名时，改用 `createRequire(new URL('package.json', ctx.baseUrl))` 解析，而不是从 loader 自身文件 `import(name)`。`baseUrl` 即 profile 目录，因此 profile 安装的插件与内部 loader 从 `baseUrl` 解析的行为一致。已记入 vendor/README.md 本地修改日志。
- **验证：官方格式皮肤插件。** `apps/desktop/plugins/dsh-skin-aurora` 是带 `dsh.bundle.patch` + `dsh.client` 的 npm 包，浏览器半部是官方 client-bundle 协议（`window.__ModuleLoader__.load({ id, factory })`），通过 `ctx.theme.overrideTokens('dsh-skin-aurora', { '--dsw-alias-*': { light, dark } })` 叠加调色板。端到端验证：`installPlugin` → pnpm add → reconcile（bundle 入列），重启 → host loader 解析 profile bundle，client-modules 把 `dsh.client` 扫进 `__DSH_BOOT__`，浏览器激活 factory，调色板覆盖落地（`--dsw-alias-bg-base` 变为 `#f7f4ff`；截图呈紫色皮肤）。
- **退出/性能。** 退出本就会 dispose 内进程 host（`fiber.dispose()`）并 kill child host；Electron 自身 utility 进程随主进程结束，退出后无后台进程残留。隐藏到托盘的窗口现在显式保持 Chromium 后台节流。

## 备选方案

- **打包 `dsh` CLI** —— 闭包已带 `runPlugin`；额外 CLI 是重复。
- **主进程用 `module.register` hooks 提供解析钩子** —— 更重、依赖 Electron 版本，且 loader 本就有文档化的无 internal 路径。
- **自研安装器（registry 抓取、tarball 解压）** —— 偏离用户要求的官方 pnpm/reconcile 语义。

## 影响

- 设置 → 插件 可安装官方 `dsh.bundle` 插件到用户 profile（`%APPDATA%`，无需管理员）；覆盖式升级（rc.9+）会保留它们。
- 新 bundle 层仅在重启后激活（内进程无配置 HMR）。
- 安装包因 vendored pnpm 增大（磁盘约 100 MB，压缩后约 35 MB）。
- `vendor/loader` 多一处文档化本地修改；以后 vendor 同步需重新应用。
- 皮肤插件（或任何 client 插件）必须以 `__ModuleLoader__.load` bundle 格式发布 —— `tsdown` client-bundle preset 是规范构建器。