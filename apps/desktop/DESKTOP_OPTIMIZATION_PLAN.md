# 桌面端完善 + 皮肤插件 统一计划（审查版）

> 本计划把「桌面端整体完善」与「皮肤插件（图片背景 + 自定义主题）」整合为一份可执行的路线图，并做多方位审查：
> 架构 / 性能(CPU·内存·渲染) / 代码规范与可维护性 / 中文注释 / 安全 / 测试 / 文档。
> 状态：**2026-08-23 已完成两轮桌面端优化（第一轮 P0→P2 地基，第二轮 P0-A/B、P2-B、P1-C、P2-A、P1-B），全部见文末「9. 本轮执行记录」**。皮肤插件（Phase 1）按用户决定暂缓，恢复时间待定。

---

## 0. 目标与总体策略

- **目标**：让桌面端**稳定、省资源、易维护、可扩展**，并落地一个清晰的「皮肤插件」（图片主题背景 + 自定义主题）。
- **策略**：先做地基（架构拆分、主题/窗口一致性、稳定性），再做皮肤插件与功能增强，最后性能监控与清理。
- **原则**：
  1. 模块化：拒绝"上帝文件"，按域拆分，单一职责。
  2. 性能优先：把重活移到合适线程/进程，控制渲染 DOM 与后台资源。
  3. 可读可维护：统一命名/错误处理/日志，**关键逻辑补中文注释**。
  4. 可测试：每个核心模块配单测。

---

## 1. 现有问题清单（审查发现）

| # | 类别 | 问题 | 证据/影响 |
|---|------|------|-----------|
| 1 | 架构 | `main.ts` 1347 行"上帝文件"，窗口/托盘/更新/图标/API mux/宿主启动/全部 IPC 内联 | 难读、难测、难改；改动易牵连 |
| 2 | 架构 | `preload.ts` 标题栏用 JS 字符串拼 HTML + 内联样式 + 数千字符内嵌 SVG | 脆弱、难维护 |
| 3 | 主题 | 工作台窗口硬编码 `backgroundColor: '#0d1117'`（深色） | 与主题不一致；皮肤插件无法全局生效 |
| 4 | 主题 | 工作台窗口未做窗口状态持久化（主窗口已做） | 重启后布局丢失 |
| 5 | 性能/CPU | 宿主以**进程内**方式运行整个 harness（web profile）于 Electron **主进程** | 主进程 CPU 与 UI 争抢；会话/LLM 等重活占主进程 |
| 6 | 性能/内存 | 主窗口 + 工作台各加载完整 React web app | 双份渲染内存 |
| 7 | 性能/内存 | 窗口状态保存的 `saveTimer` 在窗口关闭时未清除；`window.getBounds()` 可能对已销毁窗口调用 | 潜在极小泄漏/异常 |
| 8 | 性能/渲染 | 长会话 DOM 无虚拟化；流式 Markdown 全量渲染 | 长会话卡顿/高内存 |
| 9 | 性能 | 皮肤背景图若不做限制，模糊/大图会带来 GPU/渲染内存压力 | 启动/滚动卡顿 |
| 10 | 安全 | `apiFetch` 桥接受渲染层任意 URL，未限制为宿主 origin | XSS 时可 SSRF/外发 |
| 11 | 安全 | `webPreferences.sandbox: false` | 渲染层沙箱关闭（需评估） |
| 12 | 可维护 | 注释以英文为主；`host-in-process.ts` / `migrate-web-data.ts` 无中文注释 | 不符"中文注释"诉求 |
| 13 | 测试 | 仅有 `tests/migrate-web-data.spec.ts`；plugin-manager / main 核心逻辑无单测 | 回归风险高 |
| 14 | 清理 | `plugins/dsh-workbench` 已被 `dsh-workspace` 替代仍打包 | 遗留 |
| 15 | 稳定性 | API WebSocket 无断线重连/心跳 | 长会话流式断连易卡死 |

---

## 2. 阶段划分（P0 → P2）

### Phase 0 · 地基（架构 / 主题一致 / 稳定性）

#### 0.1 `main.ts` 结构拆分
- **动作**：拆成 `src/main/{windows,tray,updater,ipc,host,icon,api-mux}.ts`，`main.ts` 仅做装配；抽硬编码常量到 `config.ts`。
- **验收**：`main.ts` 缩减到 <200 行；每个模块职责单一、可单测；IPC 按域归到 `ipc.ts`。
- **关联**：为皮肤/工作台/更新提供可维护窗口模块。

#### 0.2 主题 / 窗口一致性
- 工作台窗口取消硬编码深色，改为消费主题 token（皮肤插件全局生效的前提）。
- 主/工作台窗口统一窗口状态持久化 + 最大化同步。
- X→托盘 / 回到原桌面 / 恢复主窗口抽成状态机，去掉重复"找主窗口"。

#### 0.3 性能与稳定性
- 宿主子进程与 shell(pwsh/cmd) 统一 `windowsHide` / `CREATE_NO_WINDOW`，解决命令窗口闪现。
- 退出时**一次性**清理：杀宿主、关 WebSocket、清 `apiFrameBatches`/`apiSockets` 定时器、清窗口状态 saveTimer。
- API mux：WebSocket **断线重连 + 心跳**；窗口销毁时全量释放。

### Phase 1 · 皮肤插件（图片背景 + 自定义主题）

#### 1.1 M1 宿主侧
- 新增 `ui-skin` settings 命名空间：`backgroundImage`、`backgroundOpacity`、`backgroundBlur`、`backgroundTint`、`backgroundFit`、`customTokens`(`--dsw-alias-*` light+dark)。
- 本地图片服务：文件路径→渲染层可访问 loopback URL；校验存在/类型/大小；**压缩/降分辨率**以控内存。

#### 1.2 M2 客户端插件
- `ctx.theme.overrideTokens` 应用自定义颜色；注入 `<style>` 背景图层（`background-image`+遮罩）。
- 监听 `theme/change` 按 light/dark 切换遮罩；`prefers-reduced-motion` 关模糊/过渡。
- **性能**：背景图 `background-size: cover`、控制 `filter: blur` 半径、`content-visibility`/`contain`，避免大图滚动卡顿。

#### 1.3 M3 设置 UI
- 皮肤分区：图片选择、滑杆实时预览、颜色自定义(light/dark)、预设；预览不写盘、确认后持久化、一键还原。

#### 1.4 M4 封装与文档
- 内置/可安装插件；补中文注释、README(中英)、截图。

### Phase 1 · 功能增强

- 插件管理 UI 增强：GitHub 安装版本选择、依赖安全审查、安装前 diff；外部插件统一管理面板。
- 自动更新可视化：下载进度、`blockmap` 校验、更新日志/发布说明。
- 数据迁移工具化：`migrate-web-data` 做成独立可复用小工具 + 界面导入，不破坏既有数据。

### Phase 1 · 测试（覆盖 0.x + 1.x）

- `plugin-manager`：install/remove/update/setEnabled/outdated/allowBuilds。
- `main.ts`：窗口状态、托盘、更新状态机、API mux(批量/销毁/重连)。
- 皮肤插件：overrideTokens 生效、背景 light/dark 切换、设置持久化/回滚。

### Phase 2 · 性能监控 + 清理

- **会话节点窗口化(P0-1，收益最大)**：ChatView 按索引窗口化 + 高度缓存 + 占位块 + 滚动锚定。
- 流式 Markdown 渲染上限（流式只渲染前 N 字符，完成全量）。
- 渲染内存观测：`performance.memory` 采样 + 非当前会话节点 LRU 上限。
- 工作台增强：会话切换器、多工作台标签、布局/宽度持久化；阅读区语法高亮/Markdown/差异视图。
- 清理：删除 `plugins/dsh-workbench`；清理未用常量/死代码。

---

## 3. 性能专项（CPU / 内存 / 渲染）——贯穿始终

### 3.1 CPU
- **主进程重活下移**：评估把 in-process 宿主的关键重活（会话持久化、LLM 请求、agent loop）在必要时迁移到独立 worker/子进程，降低与 Electron UI 的争抢。若不可行，至少保证宿主任务**可中断/可超时**，避免长任务阻塞窗口事件。
- 避免主进程频繁 `setTimeout`/轮询；窗口状态保存用**防抖**（已有 500ms）。
- API mux 已用**批量 flush + 定时器**，保持并补断线重连；避免为每个事件开 timer。

### 3.2 内存
- **多窗口**：主/工作台共享同一 host 数据；关闭工作台/主窗口时全量释放 webContents、IPC socket、批次、监听器。
- **窗口状态 saveTimer**：窗口 close 时 clearTimeout，避免残留定时器与对已销毁窗口 `getBounds()`。
- **背景图**：限制分辨率/压缩、用 `background-size: cover`，避免全尺寸位图进渲染内存。
- **渲染内存 LRU**：非当前会话节点缓存设上限，可重建。
- 主进程模块加载：in-process 宿主把整套 runtime 载入主进程；评估**按需加载**而非一次全量。

### 3.3 渲染
- 会话节点窗口化（见 Phase 2）。
- 皮肤插件背景图层用 `content-visibility`/`contain`，避免大区域持续重绘。
- 流式 Markdown 增量渲染 + 超长折叠。

---

## 4. 代码规范与可维护性专项

### 4.1 模块化与命名
- 按域拆分，`src/main/*`；组件与逻辑分离；导入路径统一；类型显式（`strict: true` 已启用）。
- IPC 统一：参数 `unknown` 入参 + 运行时校验（保留现有防御式），集中到 `ipc.ts`。

### 4.2 错误处理与日志
- 统一错误封装 + `debugLog`/`traceLog` 分级；`apiSockets`/宿主启动失败有明确诊断。
- 一个模块一个日志通道，避免 `console.log`/`console.error` 散落。

### 4.3 中文注释
- **原则**：桌面端**特有逻辑**（窗口/托盘/更新/插件管理/工作台/皮肤/API mux/宿主启动）补充**中文注释**；通用/上游沿用代码加**中文 JSDoc**（函数头 `@param`/`@returns`、复杂分支解释）。注释说明"为什么"，不复述"做了什么"。
- 优先给 `main.ts` 拆分后的模块、`plugin-manager.ts`、`host-in-process.ts`、`preload.ts`、皮肤插件补中文注释。
- 注意：源码注释不参与仓库翻译配对门禁，不会破坏 CI；但与 `AGENTS.md` 的英文优先约定有出入，至少在**桌面端自定义文件头**标注用途与边界。

### 4.4 可测试
- 拆分后每个模块可独立单测；行为性改动补对应测试并说明动机。

---

## 5. 安全专项

- `apiFetch` 桥**限制为宿主 origin**，拒绝跨源 URL（防 SSRF/外发）。
- 评估 `webPreferences.sandbox: true` 的可行性（恢复渲染层沙箱，减少攻击面）。
- `shell.openExternal` 仅允许 `http/https`（已有）。
- 插件安装：允许构建脚本需 `allowBuilds` 白名单（已有）；补充**依赖安全审查**与安装前 diff。
- 本地图片服务：校验路径在允许目录内，防目录穿越；图片类型白名单。

---

## 6. 依赖与优先级图

```
Phase 0(架构拆分/主题一致/稳定性)
   ├─促进─> 皮肤插件(M1-M4)        # 主题一致是背景/颜色全局生效前提
   ├─促进─> 功能增强(插件/更新/迁移)
   └─促进─> 工作台增强(窗口/布局)
Phase 1(测试) — 与 0/1 并行
Phase 2(性能监控/清理/中文注释) — 收尾
```

**建议执行顺序**：
1. Phase 0.1（`main.ts` 拆分，先出模块草案）。
2. Phase 0.2（主题一致）+ 皮肤插件 M1/M2（最快看到主题/背景统一效果）。
3. Phase 1（功能增强、补测试）。
4. Phase 2（性能监控、清理、中文注释收尾）。

---

## 7. 风险与待定决策

- **in-process 宿主下移**：是否需要拆分负担，需先做 profile 后确定；若收益小则保持现状，仅保证可中断/超时与退出清理。
- **背景图实现**：选"本地路径→loopback URL"（推荐，省内存）还是"base64 入库"（简单但大图膨胀 settings.yaml）；M1 时定。
- 皮肤插件**内置 vs 独立可安装**：先作为内置插件迭代，稳定后可拆独立仓库发布。
- **文档落盘**：本计划以 `apps/desktop/DESKTOP_OPTIMIZATION_PLAN.md` 保存，不随仓库提交（如需提交请告知，我会先评估与文档门禁的冲突）。

---

## 8. 执行清单（勾选式，已按最新状态更新）

- [x] Phase 0.1 main.ts 拆分 + 常量提取（已拆为 src/main/{config,host,ipc,log,state,tray,updater,windows,window-state,icon}.ts）
- [x] Phase 0.2 主题/窗口一致 + 状态机（工作台窗口状态持久化；主窗口引用统一 findMainWindow/restoreMainWindow）
- [x] Phase 0.3 稳定性(子进程 windowsHide / 退出清理 flushLog / API 断线重连)
- [ ] Phase 1 皮肤插件 M1-M4（**暂缓**：用户决定不做独立皮肤插件）
- [ ] Phase 1 功能增强(插件管理/更新/迁移)（部分完成：安装即启用；更新/迁移已有）
- [ ] Phase 1 测试(plugin-manager / main / 皮肤)（**暂缓**：需 electron-mock 测试基建）
- [x] Phase 2 性能监控(会话窗口化/流式上限/内存LRU)（ChatView 已窗口化、超长回复折叠、height 缓存裁剪；节点 LRU 未侵入式改动）
- [x] Phase 2 工作台增强 + 清理(dsh-workbench) + 中文注释收尾（dsh-workbench 已移除；工作台增强；中文注释覆盖新增模块）

---

## 9. 本轮 P0→P2 执行记录（2026-08-23）

按审计报告优先级推进，全部通过 `pnpm run build`（tsc -b）。改动集中在 `apps/desktop`。

### P0-1 宿主运行模式可配置化
- 新增 `src/main/host-mode.ts`；模式来源：`DSH_DESKTOP_HOST` > `userData/host-mode.json` > 默认 in-process。
- child 模式若打包缺 `node.exe` 优雅回退到 in-process；新增 IPC `dsh:get-host-mode`，preload 暴露 `getHostMode()`。

### P0-2 工作台模式释放主窗口渲染器（默认关闭）
- `state.mainWindow` / `state.mainWindowUrl`；`findMainWindow()` / `restoreMainWindow()`（P2-11 一并落地，去掉正则猜主窗口）。
- 进入工作台隐藏主窗口；可选卸载为 `about:blank`，离开幂等重载。开启：`desktop-settings.json` 写 `{"releaseMainRenderer": true}`。

### P0-3 主进程同步 I/O 异步化
- `log.ts`：打包改用 `createWriteStream` 异步追加 + `before-quit` 的 `flushLog()`。
- `plugin-manager.ts`：`runPnpm` 由 `spawnSync` 改异步 `spawn`，6 处调用点 `await`。

### P1-5 窗口状态定时器
- 主/工作台账 `saveTimer`/`wsSaveTimer` 在 `closed` 时清空。

### P1-6 smoke 自检抽取
- `--smoke` 逻辑抽到 `src/main/smoke.ts`（`runSmoke`），`main.ts` 只装配与退出结算。

### P1-7 插件安装即启用
- `installPlugin` 在官方 reconcile 后 `enableNewBundles`：新增 bundle 自动移出 `disabled` 并加入 `bundles`。

### P2-8 清理 dsh-workbench
- 删除 `apps/desktop/plugins/dsh-workbench/`，并从 `electron-builder.yml` 移除打包引用。

### P0-A 宿主默认子进程 + 设置项 + 打包内置 node.exe（第二轮）
- host-mode 默认改为 `child`（进程内仍可切回）；新增 `dsh:set-host-mode` IPC + preload `setHostMode`。
- 设置→关于 新增「代理后端」项（进程内/子进程），切换写 `host-mode.json`，重启生效。
- `package.mjs` 打包前把当前 Node ABI 的 `node.exe` 拷到 `runtime/node.exe`，electron-builder 内置 `resources/runtime/node.exe`，使打包版 child 宿主可用。

### P0-B 启动链路打点
- `main.ts` 增加 `boot:app-ready / port-picked / host-started / host-ready / splash-exit` 各阶段 +耗时（debugLog），用于定位启动耗时。

### P2-B 诊断/日志入口
- 新增 `dsh:get-diagnostics` / `dsh:open-log-file` IPC + preload `getDiagnostics`/`openLogFile`；设置→关于 增加「诊断」区（版本/代理后端/插件数/日志路径 + 打开日志文件）。

### P1-C 渲染层沙箱加固
- preload 用 esbuild 打成单文件 CJS（`scripts/bundle-preload.mjs` → `lib/preload.cjs`，electron external、图标内联）；`windows.ts` 两窗口恢复 `sandbox: true`；`build` 脚本串联 bundle 步骤。

### P2-A 启动/崩溃安全恢复
- 新增 `src/main/recovery.ts`：启动成功清零/失败累加；上次失败下次自动进安全模式（禁非基础插件，保留 base/web-app）；诊断区「安全模式重启」。
- `plugin-manager.disableNonBasePlugins(home)`；IPC `dsh:relaunch-safe` + preload `relaunchSafe`。

### P1-B 插件操作取消
- `plugin-manager` 追踪 pnpm 子进程，暴露 `cancelPluginOp()`；IPC `dsh:plugin-cancel` + preload `pluginCancel`；诊断区「取消插件操作」（有无运行的反馈文案）。

### P0-C 启动→主界面数据就绪过渡
- preload 在 web app 页注入全屏启动加载层（跳过 splash/工作台）；web app 会话不再 `loading` 时调 `reportAppReady()` 上报，加载层淡出（超时 8s 兜底）。
- `ConversationRoot` 新增就绪上报；main 增加 `dsh:app-ready` 记录 `boot:data-ready`。

### 测试与文档
- 新增 `host-mode.spec.ts` / `window-state.spec.ts` / `recovery.spec.ts`；桌面单测 **4 文件 / 22 用例全通过**。
- `DESKTOP_GUI_TEST.md`：A 组注明沙箱回归；C 组默认改 child；新增 G1–G10 用例。

### 暂缓 / 待后续
- 皮肤插件 M1–M4（用户决定暂缓，恢复时间待定）。
- P2-9 已完成（preload 图标抽取 `preload-icons.ts`）；P2-10 已完成（单测落地）。
- P1-A 渲染节点 LRU：经排查会话节点均为 per-session 作用域 + dispose 清理，窗口化 + height 裁剪 + 渲染采样已覆盖，无跨会话无界缓存，故未做侵入式改动。
- P1-B 插件「进度条」：当前为取消能力 + 诊断区入口；精确 pnpm 进度需专门解析器，待后续。

### 暂缓：启动动画 / 主界面数据就绪过渡（2026-08-23 记录）
- **应用行为**：启动动画结束后进入主界面，展示的是「选择一个工作区开始」的**工作区选择态**，没有自动打开某条会话的聊天记录；因此「聊天记录加载」更多取决于**是否自动打开上次会话**，而非启动动画/加载层本身。
- **已实现**：去白标题栏（纯动画）、P0-C 数据就绪过渡/加载层 已在 rc.64。
- **待后续（用户暂缓）**：① 自动打开上次会话（优化「进入即看到聊天记录」）；② 深色→浅色的主题过渡闪变；③ splash 与加载层合并为一个流程。恢复时间待用户说明。

### 安全备注 / 后续候选
- **loopback Web UI 可被本机访问**：宿主绑定 `127.0.0.1:17890`（loopback，局域网/外网不可达），但同机浏览器可打开 `http://127.0.0.1:17890/`。属架构使然；如需本机浏览器也访问不了，候选方案：B（loopback token 鉴权）、A（每次随机端口，牺牲 localStorage 跨启动）、C（/api 仅走 IPC）。用户表示仅好奇，暂不实施。

### 需要用户 GUI 实测（两轮合并）
- 标题栏 A1–A9（沙箱下重点：三按钮 / 双击最大化 / 深色鲸鱼）。
- 工作台 B4–B7；宿主模式 C1–C3（默认 child）；插件 D1–D5。
- 设置→关于 G1–G5（代理后端 / 诊断 / 启动打点）；G6（沙箱整体）；G7–G8（安全模式）；G9–G10（插件取消）。

### 需要用户 GUI 实测
- 标题栏三按钮 / 双击最大化 / 深色主题鲸鱼颜色。
- 工作台进入 / 离开（回到原桌面） / 恢复主窗口。
- GitHub 插件安装即启用；启用/停用后重启是否保持。
