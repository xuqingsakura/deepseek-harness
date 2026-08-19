# Agent Note：工作台文件树虚拟滚动、三栏等分、Git 历史整理

状态：已实现

[English](2026-08-19-workbench-file-tree-virtualization-and-equal-split.md) | 中文

## 问题

工作台文件树一次渲染目录下的每一行，大目录（数千文件）会物化数千个 DOM 行并拖慢滚动。三栏布局（侧边栏 | 中间 | 详情）以任意宽度打开，无法等分或拖拽调整。Git 面板把提交历史与更改列表堆叠在一起，没有稳定顺序，且「选择一个更改以查看差异」区域与中间列预览重复。文件树也缺少 VSCode 式交互：文件名搜索、路径引用/复制、可持久化的展开状态。

## 决策

- **文件树虚拟滚动**（`FileTree.tsx`）：`flattenVisibleRows()` 把展开的树扁平化为一行列表，按固定 24px 行高做窗口化（±12 行缓冲），大目录只渲染可见切片；`sortEntries` 目录优先 + 自然名称排序。
- **三栏等分**（`columns.ts` / `stores.ts` / `AppFrame.tsx`）：`computeEqualColumns()` 加 `workbenchEqual` 布局标记；打开工作台默认三栏 1:1:1，拖拽手柄或折叠一栏即退出等分状态。
- **host 工作台增强**（`packages/host/workbench` + `packages/fs`）：`listDir` 现在返回 listing，含 1000 条上限与 `truncated` 标记；新增 `searchFiles` 做带预算的递归文件名搜索（200 匹配 / 10 万次访问，跳过 `.git`，绝不深入符号链接目录）；`WorkbenchDirEntry` 携带 `hidden`/`isSymlink`/`broken`。
- **文件树客户端升级**：符号链接与失效链接图标、隐藏行置灰、悬停 @引用（向 composer 草稿追加 `@<相对路径>`）与复制路径按钮、截断提示行、按会话 localStorage 持久化展开状态；`WorkbenchTreePanel` 增加防抖搜索框、刷新/关闭操作与 cwd 面包屑。
- **Git 面板**（`WorkbenchGitPanel.tsx`）：提交历史移到更改列表上方（border-bottom，固定 128px），移除冗余的「选择一个更改以查看差异」区域（中间列已预览所选文件）。

## 影响

打开带大目录的工作台不再因 DOM 物化而卡顿；三栏等分打开并可拖拽调整；文件名搜索、路径引用/复制、展开记忆与项目参考的 VSCode 资源管理器模型（DSH-better-sidebar）一致；Git 历史在长更改列表上方保持可见。

## 备选方案

- 只懒加载展开层级而不做窗口化：大目录展开后仍会物化每一行。否决：固定行高窗口是让超大目录保持廉价渲染的唯一方式。
- 打开时通过改写拖拽宽度来等分：会污染已持久化的宽度。独立的 `workbenchEqual` 标记把等分作为临时布局模式，拖拽即退出。
- 保留 Git「选择一个更改」区域：与中间列预览重复。P3 里程碑移除。
