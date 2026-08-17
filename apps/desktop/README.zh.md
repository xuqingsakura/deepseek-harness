# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness Web GUI 的 Windows 桌面壳。默认情况下，Electron 主进程以 in-process 方式启动 harness 的 `web` profile（A3），并在原生窗口中渲染现有 harness UI；`DSH_DESKTOP_HOST=child` 可恢复由父进程监督的 `dsh web` host-child 布局（A2）。

## 架构

三层替换浏览器标签页，而不是替换 harness 本身：

- **In-process host（默认，A3）** —— Electron 主进程动态导入已部署的 host 闭包（`out/runtime/host-deploy`，打包后为 `resources/runtime/host-deploy`），并通过共享的 profile boot 在自身进程内启动 `web` profile；loopback URL 来自进程内的 `webServer` 服务。该闭包必须是扁平的 `node_modules`：vendored Loader 对裸 `@deepseek-ai/*` 的解析要么需要 Node 内部 ESM loader（`node-addon-require-builtin`，系统 Node ABI，Electron 下不可用），要么需要位于 loader 自身文件之上的扁平布局。`DSH_DESKTOP_HOST=child` 保留 A2 子进程 host（随附 `node.exe` + 同一闭包）作为回退。
- **IPC carrier** —— `packages/client/connection/src/client/electron-api-client.ts` 扩展 `AbstractApiClient`，把每个 `/api/*` 请求路由到 `window.dshDesktop.apiFetch`（`ipcRenderer.invoke('dsh:api-fetch')`）；mux/WebSocket 下行链路由主进程以帧流方式转发（`dsh:api-stream-subscribe`）。浏览器 carrier 保持不变：`apply()` 在 `window.dshDesktop` 不存在时保留 HTTP carrier。
- **Native shell** —— 自定义标题栏（favicon + 居中的 "DeepSeek Harness" + 最小化/最大化/关闭控件），带主题背景；系统托盘支持关闭到托盘；窗口隐藏时收到审批/提问请求会弹出通知；并持久化窗口几何（`%APPDATA%\dsh-desktop\window-state.json`）。标题栏鲸鱼使用 `currentColor` 绘制，取色自 `--dsw-alias-label-primary`（与侧栏 FishLogo 相同的 token），因此浅色模式下为深色墨迹、深色模式下为近白色。webServer 绑定一个偏好的固定 loopback 端口（`17890`，带回退），使渲染进程 origin —— 以及 web UI 的 localStorage（当前会话、聊天视图、工作区视图）—— 在多次启动间保持稳定。

## 使用

先构建仓库产物（host 子进程运行的是构建后的启动器）：

```sh
pnpm run build
```

然后运行桌面壳：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

自检模式启动 host、等待 React 根渲染、断言标题栏与窗口控件，并打印 `DESKTOP_SMOKE_OK`（退出码 0）或 `DESKTOP_SMOKE_FAIL`（退出码 1）：

```sh
pnpm --filter @deepseek-ai/dsh-desktop run smoke
```

`$DSH_HOME` 可覆盖 harness home；否则源码/开发运行使用 `apps/desktop/.dsh-home`，打包应用使用 `%APPDATA%\dsh-desktop\dsh-home`。所有 harness 用户数据（`sessions/` 下的对话日志、`settings.yaml`、`.credentials.yaml`、`storages/`）都位于该 home 下。

要迁移 web 版 home（`~/.dsh`），可在「设置 → 关于与更新 → 从 Web 版导入数据」中一键执行安全合并（或先执行 `pnpm --filter @deepseek-ai/dsh-desktop run build`，再运行仓库中的 `node apps/desktop/scripts/migrate-web-data.mjs`）。迁移只会复制目标尚不拥有的会话目录，按 key 合并 `storages/*.json`（目标已有 key 优先），且默认不碰 `settings.yaml` / `.credentials.yaml`，除非你显式勾选导入（且目标文件不存在时才会写入）。空的或缺失的 `storages/workspace.json` 会让工作区注册表重新引导并自动接管复制的会话。可用 `--dry-run` 预览、`--force` 覆盖目标已有会话、`--json` 输出机器可读报告。

## 开发

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev   # tsc build, then electron .
pnpm --filter @deepseek-ai/dsh-desktop exec electron . --gen-icon apps/desktop/assets   # regenerate icon assets from apps/web/public/favicon.svg
```

## LLM 提供方

打包运行时只提供三类 LLM 提供方（pi-ai 其余目录在部署时裁剪）：

- **DeepSeek** —— 原生 `dsh-llm-deepseek` 提供方（默认启用）以及 pi-ai 的 `deepseek` 目录条目。设置 `DEEPSEEK_API_KEY`。
- **小米 MiMo** —— pi-ai 的 `xiaomi` 提供方（OpenAI 兼容，`https://api.xiaomimimo.com/v1`），以及 `xiaomi-token-plan-*` 变体，它们有自己的端点和 `XIAOMI_TOKEN_PLAN_*_API_KEY` 键。常规 API 设置 `XIAOMI_API_KEY`。目录只保留 MiMo API 当前实际接受的模型：`mimo-v2.5` 和 `mimo-v2.5-pro`。
- **OpenCode Zen / Zen Go** —— pi-ai 的 `opencode` 与 `opencode-go` 目录条目（Anthropic / Google / OpenAI 兼容端点）；在 `llm-pi-ai` 设置分区配置其 API 密钥。

可在应用设置（`llm-pi-ai` 分区）或通过上述环境键配置额外提供方或凭据。

## 打包（Windows NSIS）

安装包在 `resources/runtime` 下捆绑 host 运行时（工作区包的一份已部署闭包）；见 `runtime/package.json` 与 `electron-builder.yml`。执行 `pnpm run build:lib:host` 后，用 `node apps/desktop/scripts/deploy-runtime.mjs` 刷新闭包，该脚本会把工作区各包最新构建的 `lib/` 同步进闭包，并重新生成稳定的 `embed.js` 再导出 shim，并裁剪冗余以减小安装包体积、加快安装：`.map`/`.d.ts`/`.pdb`/`.ts` 工件、构建期工具（`typescript`、`vite`）、`node.exe` 子进程回退（in-process host 是打包默认；`DSH_DESKTOP_HOST=child` 现在仅用于开发），以及除 DeepSeek、Xiaomi/MiMo 与 OpenCode（Zen/Zen Go）家族之外的所有 pi-ai 提供方。这使安装包从 263 MB 减到约 135 MB，静默安装从 16 分多钟缩短到约 7 分钟。

```sh
# one-command package: builds client libs, refreshes the runtime closure
# (deploy-runtime.mjs), compiles the shell, runs electron-builder, and lands
# Setup.exe in apps/desktop/dist-installer/. Run `pnpm run build:lib:host`
# first if host packages changed (deploy-runtime copies apps/cli/lib).
pnpm run package:desktop
# mirrors for the first run / CI (set before package:desktop):
# $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
# $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

安装包落在 `apps/desktop/dist-installer/`。electron-builder 输出写入 `%LOCALAPPDATA%\Temp\dsh-pkg`（在 `electron-builder.yml` 中配置），这样工作区 watcher 永远不会锁住 `win-unpacked`。

## 更新

- **就地覆盖升级。** 自 rc.9 起，NSIS 安装器跳过之前的卸载程序（见 `build/installer.nsh`），直接覆盖现有安装：在新版 Setup.exe 上再运行一次（同一机器级作用域），无需卸载。快捷方式、窗口状态以及 `%APPDATA%\dsh-desktop` 下的所有 harness 数据都会保留。
- **应用内自动更新。** 设置 → 关于 → 检查更新 检查打包进 `app-update.yml` 的发布通道。打包版使用 GitHub provider（`electron-builder.yml` 中的 `owner`/`repo`）并解析最新已发布 release：预发布标签（`0.1.0-rc.*`）解析 `rc` 通道（`rc.yml`），稳定标签解析 `latest.yml`。`DSH_UPDATE_FEED_URL` 或 `%APPDATA%\dsh-desktop\update-config.json`（`{"url": "https://…/updates/"}`）仍可覆盖 feed。`update-downloaded` 会通知，点击后重启进入安装。`.github/workflows/desktop-release.yml` 会在手动触发（或推送 `v*` 标签）时构建，并把 Setup exe、`.blockmap` 和通道 yml 发布到本仓库的 GitHub Releases。
- **插件。** 桌面端运行官方 `dsh plugin --profile web` 流程以支持 设置 → 插件：vendored pnpm（`resources/pnpm`）安装到 `%APPDATA%\dsh-desktop\dsh-home\profiles\web\node_modules`，官方 reconcile 把声明 `dsh.bundle` 的包注册进 `dsh.profile.bundles` —— 与 CLI 完全一致。通过 npm `name@version`（需要 registry 访问；镜像可设置 `DSH_PNPM_REGISTRY`）、本地 `.tgz`/目录的绝对路径/`file:` 规格，或 git 规格（如 `github:owner/repo#分支`，需要 PATH 中有 git）添加。git 安装拉取的是源码，首次安装时由插件的 `prepare` 脚本构建；pnpm ≥10 默认拦截该脚本，界面提供一键「授权构建脚本并重试安装」，把打印的 key 写入 profile 的 `pnpm-workspace.yaml` 后重试。安装会继承代理：安装器优先读取 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量，其次读取全局 git 代理（`git config --global http.proxy`/`https.proxy`），写入 profile 的 `.npmrc` 并传给 pnpm/git 子进程——GitHub 安装与浏览器系统代理走同一条链路。设置 → 插件的桌面端区块是外部插件的统一管理器：每一行显示来源（npm / GitHub / 本地）、版本、bundle 状态与运行时挂载阶段（含失败详情），并提供单个或批量更新、启用/停用（停用的 bundle 保留安装但通过 `dsh.profile.disabled` 退出层栈）、批量移除，以及由 `pnpm outdated` 解析出的"可更新"徽标。启用/停用在运行中的应用里即时生效（无需重启）：安装器写入 profile 清单并驱动实时 Loader 行，host 广播重组后的 `__DSH_BOOT__` 图，渲染端的 client-HMR 按图 reconcile 成员，插件的 UI 会当场卸载/挂载。（完整的 `cordis.patch.yml` 热更新仍依赖真实 Node 的内部 loader，Electron 无法加载。）插件必须按官方 bundle 形态编写（`dsh.bundle.patch` + 可选的、构建到 `window.__ModuleLoader__.load` 协议的 `dsh.client` 浏览器半区）。新增或移除 bundle 层后需重启生效（in-process host 没有配置 HMR）。桌面端随附的内置插件（`dsh-workbench` 及一个皮肤）位于 `resources/plugins`，设置 → 插件页会以「内置插件」区块列出并支持一键安装（`file:` 形式，无需手动输入路径）。工作台插件提供文件树、Markdown/代码查看（含语法高亮）、内嵌浏览器、终端、Git 面板（VSCode 式提交分支图）与后台任务面板。下方是两个 LLM 提供方家族。

## 已知限制

- **目录选择是应用内浏览流程，不是原生 OS 对话框。** web profile 的 `directory-picker-auto` 行在 loopback 绑定上解析为原生 Win32 选择器，而该选择器会用 `process.execPath` —— in-process host 下的 Electron 二进制 —— 生成 worker，因此 worker 永远无法上报。桌面端改通过 `assets/desktop-browse-picker.yml` 固定渲染端的 browse 后端；它完全运行在渲染进程中，不需要子进程。
- In-process（默认）只运行一个进程；`DSH_DESKTOP_HOST=child` 回退仍会生成 `node` 子进程。关闭窗口会销毁整棵树（持久会话无论如何都会通过 SQLite 持久化）。
- 配置热重载（运行中编辑 `cordis.patch.yml`）在 in-process 下不可用：配置 HMR watcher 需要 Node 内部 loader，Electron 无法加载。
- 关闭窗口会把应用驻留在系统托盘中（托盘菜单：显示/隐藏、检查更新、退出）而不是退出；托盘"退出 DeepSeek Harness"项（或任何 `app.quit()` 路径）会完全销毁 in-process host（`fiber.dispose()`）、关闭 loopback 服务器并退出——不留任何后台进程。隐藏窗口会保持 Chromium 的后台节流，因此驻留托盘的 CPU 会回落到空闲。
