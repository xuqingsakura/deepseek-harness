# Agent Note：桌面端设置页「关于与更新」区块

状态：已实现

[English](2026-08-15-desktop-settings-about-updates.md) | 中文

## 问题

桌面端的更新入口只有系统托盘的右键菜单（「检查更新...」）和原生通知，没有应用内界面可以查看当前版本、触发检查或安装已下载的更新，且托盘入口容易被忽略。需求：在设置里增加版本更新功能，并移除托盘「检查更新」项。

## 决策

新建客户端包 `@deepseek-ai/dsh-client-ui-settings-about`，注册 `settings.section` 导航项（`id: about`，order 90），仅在 Electron 桥（`window.dshDesktop`）存在时渲染，浏览器构建永远不会挂载它。该区块显示当前版本、更新状态行（未检查 / 检查中 / 下载中带百分比 / 已下载 / 已是最新 / 错误带信息）、「检查更新」按钮，以及下载完成后的「重启并安装」按钮。

主进程维护 `DesktopUpdateState` 状态机（idle/checking/available/downloading/downloaded/not-available/error），每次变化都通过 `dsh:update-state` 广播到所有 shell 窗口。三个新 IPC handler 支撑 UI：`dsh:update-status`（返回当前状态、不触发检查）、`dsh:update-check`（执行用户触发的检查并返回状态）、`dsh:update-install`（下载就绪时退出并安装）。preload 桥暴露 `updateStatus`、`updateCheck`、`updateInstall`、`onUpdateState`。启动时的静默检查保持不变；发现/下载完成的原生通知不变。托盘菜单移除「检查更新...」项——设置页区块成为手动入口。

新包通过 `dsh-web-app` 的补丁层加入 web 表面（一行 `ui-settings-about` 加一个 `workspace:*` 依赖），桌面端 host 像组合其它客户端插件一样组合它；web bundle 本身不变，因为该区块是经由客户端模块系统提供的插件 bundle。

## 备选方案

**把更新卡片放进 ui-settings-general 作为通用项。** 否决：更新流程需要按钮和状态行，不是导航行条目；独立的「关于与更新」页是惯例位置；保持独立 section 包符合仓库「一个功能一个包」的布局。

**无条件注册该区块并给浏览器占位。** 否决：浏览器构建应保持不变——桥检测只有一行，能让 web 表面保持干净。

## 影响

设置现在有常驻可见的「关于与更新」页：版本、检查、下载进度、重启安装，全部由主进程状态推送驱动，页面无需轮询保持实时。托盘菜单少了一项。未配置更新源时行为不变——检查会通过该区块的状态行显示既有的「未配置更新源」指引，而不只是通知。
