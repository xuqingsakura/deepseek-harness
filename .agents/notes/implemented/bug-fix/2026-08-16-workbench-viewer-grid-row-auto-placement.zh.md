# Agent Note：工作台查看器列高度塌缩为 0（CSS Grid 自动放置）

Status: implemented

[English](2026-08-16-workbench-viewer-grid-row-auto-placement.md) | 中文

## 问题

桌面端工作台三栏视图（文件树 | 文件查看器 | 对话）连续 12 个安装版本
（rc.20–rc.31）中间栏一直是空白：文件树和对话都能渲染，但中间查看器始终
不显示内容，尽管 DOM 里已经存在文件文本。

## 根因

`AppFrame` 是三栏 CSS Grid，`grid-template-rows: 100%`。工作台视图通过
`[data-workbench]` 规则交换列（`centerCol` 2→3，`detailsCol` 3→2），但 DOM
顺序不变（sidebar、center、details）。在默认 `grid-auto-flow: row` 下，自动
放置光标在把 `centerCol` 放到第 3 列之后，已经越过第 1 行的第 2 列，因此
DOM 顺序靠后的 `detailsCol`（第 2 列）被放进隐式第 2 行。该行 auto 高度塌缩
为 0：查看器使用 `flex: 1` 子项（flex-basis 0 不贡献固有高度），且各列用
`overflow: hidden` 裁剪——于是整个中间列消失到框架下方。之前 12 次修复
flex/高度链都不可能成功：缺陷在行的放置，不在尺寸。

## 决策

给 `.sidebarCol`、`.centerCol`、`.detailsCol` 显式加 `grid-row: 1`，把所有
列钉死在唯一一行（打包器会编译为 `grid-area: 1/1`、`1/2`、`1/3`）。工作台
的 `grid-column` 交换照常工作（只改列号），行号不变。

## 备选方案

- 框架加 `grid-auto-rows: 100%`。否决：元素仍落在隐式第 2 行、位于
  y = 框架高度处，整列渲染在可视框架下方被裁剪。
- `grid-auto-flow: column`。不作为首选：同样有效，但改变流向比钉死行号的
  改动面更大，且 `grid-row: 1` 直接写明了不变式。

## 影响

工作台中间列（文件查看器）现在在任意视口高度下都填满整行，查看器内容
（头部 + 可滚动正文）正常渲染。今后任何列数或放置改动都必须让所有列保持
在第 1 行；CSS 注释记录了该自动放置陷阱。
