# DeepSeek Harness 桌面端对比分析报告

> 对比对象：
> - **当前桌面端**：`D:\deepseek-harness\apps\desktop`（`@deepseek-ai/dsh-desktop`，主仓库内应用，v0.1.0-rc.56）
> - **对比桌面端**：`D:\deepseek-harness-key\deepseek-harness-desktop`（社区独立产品工作区，DSH Desktop v2.0.1，仓库 anywhere-labs/deepseek-harness-desktop）
>
> 分析日期：2026-08-20
>
> 本文档合并两轮分析：第一轮为总体对比，第二轮为代码级与工程级深入分析（含补丁逐项、上游版本漂移量化、打包/发布/测试管线对比）。

---

## 目录

1. [结论速览](#一结论速览)
2. [对比基线](#二对比基线)
3. [相同点（同源思路）](#三相同点同源思路)
4. [差异点](#四差异点)
5. [各自的优势](#五各自的优势)
6. [启动链路代码级对比](#六启动链路代码级对比)
7. [范式差异：外壳 vs 插件化](#七范式差异外壳-vs-插件化)
8. [补丁逐项分析](#八补丁逐项分析)
9. [上游版本漂移（真实 git 量化）](#九上游版本漂移真实-git-量化)
10. [打包/发布管线对比](#十打包发布管线对比)
11. [测试策略对比](#十一测试策略对比)
12. [依赖面对比](#十二依赖面对比)
13. [总结与移植可行性](#十三总结与移植可行性)

---

## 一、结论速览

两者是**同一设计思路、两种工程形态**的实现：都是「用 Electron 承载 DSH 本地 Web UI，主进程内启动 DSH Host，loopback 同源加载页面」。但定位完全不同——

- **当前桌面端**是上游主仓库内部的一个**极简外壳**：只替换"浏览器标签页"这一层，紧跟最新上游基线（rc.56），仅支持 Windows，源码 6 个文件约 2.8k 行。
- **对比桌面端**是一个**独立的社区完整产品**：把"桌面本身做成一个 Cordis 插件"（`dsh-plugin-desktop`），基于较旧的上游基线 rc.7 + 自研补丁，功能面大一个数量级（72 个源文件约 13.5k 行、68 个测试文件），支持 Windows + macOS，自带插件市场、终端、多配置档案、诊断、自更新、启动/安装恢复等能力。

**一句话：当前桌面端是"薄壳"，对比桌面端是"全家桶产品"。**

---

## 二、对比基线

| 维度 | 当前桌面端（apps/desktop） | 对比桌面端（deepseek-harness-desktop） |
|---|---|---|
| 位置 | 主仓库内 `apps/desktop`，pnpm workspace 一员 | 独立 git 仓库（origin: anywhere-labs），yarn@4 workspaces |
| 版本 | dsh-desktop `0.1.0-rc.56`（主仓库 HEAD 2026-08-20；最近 git 标签 `dsh-v0.1.0-rc.8`，后续版本未打标签） | 产品 `2.0.1`；上游基线 `0.1.0-rc.7`（commit `99f6f02`，子模块未检出） |
| 上游依赖 | 直接消费工作区源码（当前 master） | 消费 npm 已发布 `@deepseek-ai/dsh-*@0.1.0-rc.7` + 6 个 `patches/` 补丁 |
| 定位 | "Windows desktop shell for the Web GUI" | "DSH Desktop 产品工作区"，桌面本身即插件（`cordis.patch.yml`、`dsh` bundle manifest） |
| 平台 | 仅 Windows（NSIS） | Windows x64 + macOS Universal（DMG/notarize）+ Linux dir |
| 开放度 | `private: true`，不发布 | 公开 npm 发布（`bin: dsh-desktop`），社区项目（明示与深度求索无隶属关系） |
| 包管理器 | pnpm monorepo | yarn@4 workspaces（`deepseek-harness/` 子模块独立为 pnpm 上游工程） |

---

## 三、相同点（同源思路）

| 能力 | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 宿主方式 | Electron 主进程内动态导入 host 闭包，启动 DSH `web` profile | Electron 主进程内启动 Host Cordis root（desktop profile） |
| 页面载入 | loopback HTTP/WebSocket 同源页面，渲染进程沙箱化 | 同（127.0.0.1 临时端口，同源页面） |
| Web UI 不改写 | 复用上游 `web` UI 与浏览器 carrier | 复用上游 `dsh-base`/`dsh-web-app`，官方侧边栏/对话/详情保留 |
| 原生窗口 | 自定义标题栏、系统托盘、关窗到托盘、通知、窗口几何持久化 | 同（tray、notifications、window-options、close-versus-quit） |
| 更新 | electron-updater + GitHub Releases 自动更新 | update-checker/download/lifecycle 完整自更新管线 |
| 皮肤/工作台 | 内置插件 `dsh-skin-aurora` + `dsh-workbench` | 主题 presenter + 社区市场生态 |
| Electron 版本 | 43.4.0 | 43.4.0（peerDependencies） |

---

## 四、差异点

### 4.1 工程形态：外壳 vs 插件

- **当前桌面端**：`main.ts`/`preload.ts`/`host-in-process.ts`/`plugin-manager.ts`/`splash.ts`/`migrate-web-data.ts` 六个文件，通过 `window.dshDesktop.apiFetch` IPC 桥接（`dsh:api-fetch`/`dsh:api-stream-subscribe`），把 harness 的浏览器载体搬到原生窗口。它**不参与 Cordis 组合**，是"替换浏览器标签页"的外壳。
- **对比桌面端**：Electron 可执行文件只是极简引导；窗口、导航、设置、生命周期全部由 `desktop-shell` Host 插件通过 **Cordis effects** 拥有；tray/terminal/updates/profiles 通过 effect 作用域命令贡献。**渲染进程无 preload 桥、无裸 Electron API**，客户端 face 只校验模式/平台并注册 `layout` 服务与 root 槽位。桌面能力本身以 `dsh` bundle patch 形式注入。

### 4.2 功能范围（对比桌面端显著更全）

| 能力 | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 多配置档案（profile） | ❌ 单一 home | ✅ 多档案 + 托盘切换 + 重启换档 + last-known-good 回滚 |
| 内置终端 | ❌（仅 Web UI 内终端） | ✅ `desktop-terminal`，dsh CLI 默认指向当前档案 |
| 启动恢复 | 仅 splash 错误页 | ✅ startup-recovery-controller/window/state-commit，失败回滚重试 |
| 安装恢复 | ❌ | ✅ install-recovery（可恢复的安装兼容修复） |
| 诊断/日志 | ❌ | ✅ diagnostics、diagnostic-export、log-files、log-level、mask-secrets、crash-evidence |
| 插件市场 | ❌（仅两个内置插件） | ✅ `dsh-community-market`（AJV 校验目录 + pnpm 托管安装）+ `dsh-community-fabric` 互操作标准 |
| pnpm 托管 | ❌（仅随包 vendored pnpm） | ✅ `pnpm.ts` 完整托管包操作 |
| Windows 加固 | ❌ | ✅ windows-pwsh-sandbox、windows-acl-runner、windows-volume-diagnostics、windows-agent-presets |
| macOS 支持 | ❌ | ✅ 通用构建、公证、shell PATH 恢复、vibrancy/交通灯 |
| 原生材料 | 主题化标题栏（currentColor whale） | Windows Mica + macOS vibrancy + 主题 presenter 投射 |
| 目录选择/工作区 | ❌ | ✅ directory-picker、workspace-admission、workspace-folder-drop、file-path-bridge |
| 数据迁移 | ✅ 从 Web 版导入（migrate-web-data） | ✅（另有档案切换不迁移策略） |

### 4.3 量化对比

| 指标 | 当前桌面端 | 对比桌面端 |
|---|---|---|
| src 文件数 | 6 | 72（含 client/） |
| src 行数 | 2,791 | 13,463 |
| 测试文件 | 1（migrate-web-data.spec.ts） | 68（含 win/mac 打包、更新、恢复、闭包验证等） |
| 打包/校验脚本 | 3（package/deploy-runtime/migrate-web-data） | 20+（package-win/mac、verify-* 系列、runtime-closure、licenses） |
| workspace 成员 | 主仓库一员 | dsh-plugin-desktop + dsh-community-market + dsh-community-fabric + upstream 子模块 |

### 4.4 其他关键差异

- **上游基线**：当前桌面端跟随主仓库最新 master（rc.56）；对比桌面端固定在 rc.7（落后约 558 个提交），但用自研补丁补齐了 Windows/macOS 运行时缺口（如 schemastery 运行时门禁、sandbox ACL）。
- **发布渠道**：当前桌面端走 `xuqingsakura/deepseek-harness` GitHub Releases（CI：`.github/workflows/desktop-release.yml`）；对比桌面端走 `anywhere-labs/deepseek-harness-desktop` Releases + 官网 `dshdesktop.cn` 下载。
- **安装器**：当前桌面端 NSIS `perMachine: true`（统一安装范围）；对比桌面端 NSIS `perMachine: false` + Portable 双产物 + 安装器消息/校验测试。
- **本地状态**：当前仓库 `apps/desktop/src/host-in-process.ts`、`main.ts` 有未提交改动（进行中）；对比桌面端工作区干净、仓库 HEAD 在 2026-08-20 14:35。

---

## 五、各自的优势

**当前桌面端（apps/desktop）**

1. 紧跟最新上游（rc.56），与主仓库同源开发，无版本漂移。
2. 极简、职责单一：只做"浏览器→原生窗口"，改动面小、易审查。
3. 专门的启动 splash（动画 + 插件可扩展 `dsh.desktop.splash`）、Web 数据迁移、闭环 smoke 自检。

**对比桌面端（deepseek-harness-desktop）**

1. 完整产品级能力：档案、终端、市场、诊断、恢复、自更新一条龙。
2. 真正的插件化架构（desktop 本身是 Cordis 插件），第三方插件可注入桌面能力。
3. 跨平台（Win + mac），工程验证门禁极严（闭包/运行时/许可/打包后冒烟）。
4. 生态自洽：市场（dsh-community-market）+ 互操作标准（dsh-community-fabric）+ 社区文档站。

---

## 六、启动链路代码级对比

### 当前桌面端（`apps/desktop`）

`main.ts` 一个文件包办一切，宿主链路：

```
main.ts
 └─ startHostInProcess() [host-in-process.ts]
     ├─ pickLoopbackPort(): 17890 → 17891 → 17892 → 0(OS分配)
     ├─ 动态 import 部署闭包 out/runtime/host-deploy（flat node_modules）
     │   └─ @deepseek-ai/dsh-app-boot / dsh/lib/embed.js / dsh-cmdline / dsh-launch-environment
     ├─ embed.composeProfile('web', [desktop-browse-picker.yml overlay])
     ├─ appBoot.boot() —— Electron 主进程内起 host（A3），A2 child 仅 DSH_DESKTOP_HOST=child 时启用
     ├─ provideCmdline(['--port','--no-open'])
     ├─ ctx.get('webServer').port → loopback URL
     └─ 返回 loader controls（运行期插件 enable/disable，无配置 HMR）
```

其余（窗口/托盘/通知/更新/插件管理/数据迁移）全部在 `main.ts`（1232 行）里直接写死：窗口几何持久化、`--smoke` 自检、`--gen-icon`、`autoUpdater` + `DSH_UPDATE_FEED_URL`/`update-config.json` 覆盖、`plugin-manager.ts`（`spawnSync` 调 vendored pnpm + app-boot 档案 API）。

### 对比桌面端（`dsh-plugin-desktop`）

Electron 可执行文件是**最小引导**，`main.ts`（749 行）只做编排，原生能力全部交给 Cordis 插件：

```
bin.ts → main.ts
 ├─ crashReporter / failLoud 安装 / loadLayeredEnv / resolveDshHome
 ├─ 安装 desktop DSH runtime + pnpm runtime
 ├─ desktop-logger（stderr/uncaught/文件）、crash-evidence、lifecycle-events
 ├─ install-recovery store、profile startup（带 last-known-good 回滚）
 ├─ startup-generation / startup-state-commit / startup-recovery-controller/window
 ├─ shell-environment（mac/Linux 登录 shell PATH 恢复）、module-resolution（Node resolve hook）
 ├─ windows-volume-diagnostics、renderer 30s 启动监控、shutdown/exit coordinator
 └─ 失败路由：恢复窗口 → relaunch
```

窗口/托盘由 `desktop-shell` Host 插件（`src/index.ts`）用 **Cordis effects** 拥有：注册 `dsh-desktop` 设置命名空间（mode/port/logLevel）、webServer 路由（渲染进程启动报告 + win32 目录选择/校验）、设置变更触发重启、主题/语言同步、`runtime.schedule()` 以 `?dsh-desktop-mode=&dsh-desktop-platform=` 参数加载窗口。`cordis.patch.yml` 向标准 DSH bundle 插入 8 行：

```
- insert:
    - id: desktop-shell        name: dsh-plugin-desktop
    - id: community-market     name: dsh-community-market
    - id: desktop-terminal     name: dsh-plugin-desktop/terminal（Linux 禁用）
    - id: desktop-diagnostics  name: dsh-plugin-desktop/diagnostics
    - id: desktop-notifications name: dsh-plugin-desktop/notifications
    - id: desktop-pnpm         name: dsh-plugin-desktop/pnpm
    - id: desktop-profiles     name: dsh-plugin-desktop/profiles
    - id: desktop-updates      name: dsh-plugin-desktop/updates
# web-runtime: printUrl:false / surfaceContext:true / trustedHosts:[]
```

**同一点**：都是"Electron 主进程内起 host + loopback 同源页面"。
**关键差异**：当前桌面端是**一次性外壳**（桌面逻辑不在 Cordis 组合里）；对比桌面端是**插件化注入**（桌面能力是 8 个 Loader 行 + 若干服务，可被 profile 组合/禁用）。

---

## 七、范式差异：外壳 vs 插件化

### 7.1 同一个问题，两种解法：Win32 原生目录选择器

| | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 问题 | `-auto` 目录选择器的 Win32 worker 用 `process.execPath` 拉起的**是 Electron 二进制**，永远无法汇报 → 选择器必失败 | 同 |
| 解法 | `assets/desktop-browse-picker.yml` overlay：禁用 `directory-picker`，固定 `directory-picker-browse`（纯渲染进程，不起子进程） | 直接 patch 上游 `@deepseek-ai/dsh-client-ui-directory-picker-browse`：新增 `pickNativeDirectory`/`validateDirectory` 能力，走 webServer 原生路由 + `__DSH_DESKTOP_PICK_DIRECTORY__`，加"使用 Windows 选择文件夹"按钮 |
| 体验 | 纯 Web 浏览对话框 | 可调起 Windows 原生文件夹选择器 + 路径校验 |

两者都意识到了"Electron 内不能复用上游的 Win32 对话框子进程"，但一个选择**绕开**，一个选择**补丁增强**。这正是两边工程哲学的缩影：官方保守、社区激进。

### 7.2 更新通道实现对比

- 当前：直接在 `main.ts` 用 electron-updater（`NsisUpdater`），喂 URL 解析顺序 `DSH_UPDATE_FEED_URL` → `update-config.json` → 打包的 `app-update.yml`。
- 对比：拆成 `update-checker.ts` / `update-download.ts` / `update-lifecycle.ts` + `desktop-updates` 插件行，注册托盘命令、后台轮询策略（Config 可配）、安装包下载与清理、Windows 安装器 `--updated --force-run` 移交。

---

## 八、补丁逐项分析（`patches/` 6 个）

| 补丁 | 改动 | 效果/动机 |
|---|---|---|
| `dsh-app-boot@0.1.0-rc.7` | `parsePatchList`：patch 列表 YAML 解析为 `undefined/null` 时返回 `[]` 而非抛错 | 桌面档案无 patch list 时容错启动（可恢复性） |
| `dsh-llm-deepseek@0.1.0-rc.7` | 流式翻译里 `call.id !== void 0` → `call.id`（truthy）才写 `block.callId/name` | 修空字符串 tool-call id/name 被序列化的正确性缺陷 |
| `dsh-sandbox-windows-acl@0.1.0-rc.7` | `spawnSandboxed*`：`dwFlags 256→257` + `wShowWindow: 0` | 隐藏沙箱子进程的控制台窗口（Windows UX 修复） |
| `dsh-client-ui-workspace@0.1.0-rc.7` | 工作台浏览器根节点加 `data-dsh-workspace-drop-target` 属性 | 桌面端"拖放文件夹进工作台"的挂点 |
| `dsh-client-ui-directory-picker-browse@0.1.0-rc.7`（21KB，主补丁） | 目录浏览器/流程注入 `pickNativeDirectory`+`validateDirectory`；平台由 `?dsh-desktop-platform=win32` 判定；zh/en 文案；同步 `.d.ts` | 原生文件夹选择器 + 所有者校验 |
| `app-builder-lib@26.15.7` | macOS 签名：`importCerts` 透传 `keychainPassword`，`set-key-partition-list` 改用 keychain 密码 | 修 CI 加密 keychain 下公证/签名失败 |

结论：补丁全是**小而尖锐的运行时/打包修复**，没有大功能。社区产品靠"旧基线 + 精准补丁"维持可用性。

---

## 九、上游版本漂移（真实 git 量化）

```
rc.7 (99f6f02) → 当前 HEAD:   558 commits, 1864 files, +76,506 / -11,088 行
packages/client 范围:          539 files, +22,639 / -5,279（boot 重构等）
apps/desktop 在 rc.7 时:       不存在（git ls-tree 为空）
apps/desktop 首次提交:         05d3f4035 "feat(desktop): workbench panels, plugin split, and desktop hardening"
```

三点重要含义：

1. **当前桌面端是 rc.7 之后上游自己新造的**，它不在社区桌面仓库的视野内（社区固定 rc.7，只见过 npm 发布的 `@deepseek-ai/dsh-*`）。
2. 社区桌面仓库**落后上游 558 个提交**，这些提交里的修复/新能力（含上游自己新增的桌面端）它全都没有；它用补丁+自研代码补自己的缺口。
3. 版本号口径：主仓库 `dsh-desktop` 包已是 `0.1.0-rc.56`（最近 git 标签 `dsh-v0.1.0-rc.8`，后续版本未打标签）；社区产品版本 `2.0.1`。两者"版本"不可比，基线是 rc.7 vs rc.56。

---

## 十、打包/发布管线对比

| | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 打包配置 | `electron-builder.yml`：`com.deepseek-ai.dsh-desktop`、productName "DeepSeek Harness"、NSIS `perMachine: true`、extraResources 带 runtime 闭包+pnpm+workbench 插件 | `package.json#build`：`ai.deepseek.dsh.desktop`、productName "DSH Desktop"、NSIS `perMachine: false` + Portable 双产物、asar + fuses、`afterPack` 验证 |
| macOS | ❌ 无 | ✅ dir/universal、hardenedRuntime、notarize、x64ArchFiles 白名单 |
| 打包脚本 | `package.mjs`（build client → pnpm deploy 闭包 → electron-builder → dist-installer）+ `deploy-runtime.mjs` | `package-win.ts` / `package-win-portable.ts` / `package-mac.ts` / `release-mac.ts` / `verify-win-installer.ts` 等（可注入、可单测） |
| CI | `.github/workflows/desktop-release.yml`（Windows only，手动/`v*` tag，发布 GitHub Releases） | 仅 `ci.yml`；发布走脚本 + 官网 dshdesktop.cn（仓库内无 release workflow） |
| 更新通道 | electron-updater → GitHub Releases（`xuqingsakura/deepseek-harness`） | 自研 update-checker/download/lifecycle + 托盘命令 + 安装包清理 |

---

## 十一、测试策略对比

| | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 单测 | 1 个：`migrate-web-data.spec.ts` | 68 个 vitest spec，覆盖打包（win/mac/portable）、update checker/download、install-recovery、startup-recovery、profiles、pnpm、terminal、notifications、windows pwsh/ACL/volume/agent-presets、runtime-closure、renderer boot/health、license/notices 等 |
| 运行时验证 | `--smoke` 自检：React 根渲染、标题栏、窗口控制、暗色主题、tray、IPC、notify、截图 | `verify:closure/cli/loader/profile/licenses` + 打包后 `verify-packaged-runtime.ts`（afterPack 钩子） |
| 理念 | 冒烟级 | 把"打包产物"当作可测对象，门禁前置到 `check`/`prepack` |

---

## 十二、依赖面对比

- **当前**：运行时零额外依赖（宿主全部来自仓库内构建的闭包），仅 `electron-updater` 一个依赖；devDeps `electron` + `electron-builder`。
- **对比**：自包含可发布 npm 插件——50+ 个 `@deepseek-ai/dsh-*@0.1.0-rc.7` + `@deepseek-ai/cordis` + cordis-plugin-group/include/loader/timer + `koffi` + `pnpm` + `adm-zip` + `yaml` + `react@18` + `dsh-community-market`。

这是两者最根本的工程分叉：**一个消费仓库内源码，一个消费 npm 已发布包 + 补丁**。

---

## 十三、总结与移植可行性

**本质差异一句话**：官方 = "最小外壳 + 紧跟主干 558 个提交之后的最新代码"；社区 = "完整产品 + 固定 rc.7 旧基线 + 6 个精准补丁 + 8 个桌面插件行 + 市场生态"。

### 13.1 不是替代关系

- 如果目标是"给主仓库加一个够用的 Windows 壳"，当前 `apps/desktop` 已经完成核心闭环。
- 如果目标是"做成面向终端用户的产品"，对比桌面端的完整度明显更高，但它是独立社区维护、上游固定在 rc.7。

### 13.2 若要把社区桌面能力移植回当前仓库（按收益/成本排序）

| 功能 | 当前仓库移植建议 |
|---|---|
| 启动恢复/安装恢复（startup-recovery、install-recovery） | **最值得**：纯 launcher 层，与上游版本耦合低，可平移思路到 rc.56 |
| 诊断导出/日志脱敏/崩溃证据 | 可平移，改动集中在 `apps/desktop` |
| 多 profile 管理 | 中等：当前只有 `web` profile，需引入 profile 概念与重启换档状态机 |
| 原生目录选择器 | 当前已用 overlay 绕开；要原生体验需仿照补丁给 rc.56 的 `ui-directory-picker-browse` 加注入点（或新增 desktop 专属 client 入口） |
| Windows 沙箱/ACL/volume 加固 | 需对照 rc.56 对应包重做（rc.7 补丁不能直接搬） |
| 内置终端窗口 / 插件市场 | 独立大功能，属产品决策而非外壳职责 |

### 13.3 反向（社区想吸收上游）

成本更高：6 个补丁要全部 rebase 到 rc.56，且上游自己已造了桌面端，两边会进入"同源竞争"。

### 13.4 版本策略冲突提醒

对比桌面端基于 rc.7 + 补丁，主仓库已是 rc.56，两边能力不能直接平移；若想把对比桌面端的功能移植回主仓库，需按 rc.56 的扩展点重新实现，而不是复制代码。

---

## 附：主要证据文件

| 类别 | 当前桌面端 | 对比桌面端 |
|---|---|---|
| 启动主流程 | `D:\deepseek-harness\apps\desktop\src\main.ts`、`src\host-in-process.ts` | `...\dsh-plugin-desktop\src\main.ts`、`src\electron-runtime.ts`、`src\index.ts` |
| 插件层 | `apps\desktop\assets\desktop-browse-picker.yml`、`src\plugin-manager.ts` | `dsh-plugin-desktop\cordis.patch.yml`、`src\profiles.ts`、`src\updates.ts`、`src\desktop-plugins.ts` |
| 打包 | `apps\desktop\electron-builder.yml`、`scripts\package.mjs` | `dsh-plugin-desktop\package.json#build`、`scripts\package-win.ts` 等 |
| 补丁 | — | `patches\*.patch`（6 个） |
| 版本 | 主仓库 git `99f6f02..HEAD`（558 commits） | `upstream.json`（rc.7 / commit 99f6f02）、`package.json`（2.0.1） |
| CI | `.github\workflows\desktop-release.yml` | `.github\workflows\ci.yml` |