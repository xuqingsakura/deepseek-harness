# Agent Note：工作台内嵌浏览器与 VSCode 式 Git 提交分支图

状态：已实现

[English](2026-08-17-workbench-browser-and-git-graph.md) | 中文

## 问题

工作台 Git 面板把最近提交显示为扁平的文本历史，没有拓扑结构；工作台也无法在文件树与对话旁边打开网页。

## 决策

- **Git 提交分支图**：host 端 `gitLog` 命令现在请求父提交哈希（`--pretty=format:` 增加 `%P`），`WorkbenchGitLogEntry` 增加 `parents` 字段。新增无依赖的布局纯函数 `git-graph.ts`（`buildGitGraph`），以新到旧的提交列表为输入计算基于 lane 的图（节点列、延续边线、合并检测）；Git 面板把历史渲染为 VSCode 式分支图：lane 圆点与边线、短哈希、消息、合并标记与作者。
- **内嵌浏览器**：工作台侧栏新增「浏览器」标签，其中间列视图为 `WorkbenchBrowserPanel` —— 地址栏（后退/前进/刷新/主页）、URL 归一化（`normalizeBrowserUrl`：裸域名与 localhost 补 https://，显式 scheme 原样通过，端口不会被误判为 scheme）、内嵌 iframe。URL 保存在共享的工作台状态句柄中，切换标签后仍然保留。

## 影响

Git 历史现在一眼可见分支/合并拓扑；开发者无需离开工作台即可浏览文档或本地开发服务器。浏览器为 iframe 实现，禁止被嵌入的站点会显示空白页框，但地址栏仍可用。

## 备选方案

- 完整的 Electron `<webview>`/BrowserView 面板：需要启用 `webviewTag`（安全面改动），且无法在 web client bundle 测试中运行。P2 里程碑否决：iframe 已覆盖文档与本地服务浏览，地址栏与框架内容无关。
- 仅凭提交元数据在 CSS 里画图：没有 parents 就没有拓扑；host 端 `%P` 改动是让分支图成为可能的最小数据补充。
