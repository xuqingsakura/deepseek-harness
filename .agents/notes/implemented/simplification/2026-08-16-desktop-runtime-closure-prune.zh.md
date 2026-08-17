# Agent Note：桌面端运行时闭包裁剪死重包

Status: implemented

[English](2026-08-16-desktop-runtime-closure-prune.md) | 中文

## 问题

打包后的桌面端应用未解压体积 648MB（宿主运行时 189MB、1.97 万文件），NSIS
安装耗时约 10 分钟，首次启动还会因 Defender 扫描数万个小文件而变慢。

## 决策

扩展 `apps/desktop/scripts/deploy-runtime.mjs` 的部署期裁剪，删除 web 画像
中没有任何运行时引用的包（已通过扫描全部随包 JS 模块核实）：测试工具链
（`vitest`、`@vitest`、`@testing-library`、`rollup`、`@rollup`）、
开发期 TS 运行器（`tsx`、`esbuild`、`@esbuild`）、已裁剪提供商的依赖
（`@google`、`@agentclientprotocol`），以及测试支持/非 web 画像包
（`dsh-acp*`、`dsh-headless`、`dsh-e2b*`、`dsh-subagent-acp`/`-dsh-sdk`/`-codex`）。
同时清掉残留调试产物（`.d.ts`、`.map`、`.tsbuildinfo`）。

## 影响

宿主闭包从 189MB/19,713 文件降到 126MB/15,030 文件，安装包更小、安装更快、
首次启动扫描成本更低。`@deepseek-ai/dsh-attachment-local` 仍随包
`sharp`（图片附件），客户端 markdown 栈仍随包 `katex`/`@shikijs`
——这些都是真实运行时依赖，予以保留。

## 备选方案考量

- **原样携带完整闭包** —— 不会出现缺失运行时模块的风险，但 648MB 的解包应用与约 10 分钟的安装正是本 Note 要解决的问题。被否决。
- **更激进地裁剪（去掉 katex/@shikijs/sharp）** —— 闭包会更小，但它们是真实的运行时依赖（Markdown 渲染、图片附件）；去掉会破坏功能。被否决：裁剪只移除有可验证 importer 之外的内容。
