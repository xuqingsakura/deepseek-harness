# Agent Note：桌面端 client-hmr 图形协调与 shell 入口创建之间的启动竞态

状态：已实现

[English](2026-08-15-desktop-client-hmr-boot-race.md) | 中文

## 问题

rc.11 覆盖安装后，桌面端 shell 启动进入失败界面（`Failed to load plugins`），渲染端报 `cannot resolve entry 87044ea8`。即时启停功能在 `/plugins/events` SSE 通道上新增了 `graph` 帧，并在浏览器端实现 `reconcile()` 将渲染端 loader 树与 host 图形同步。竞态成因：shell 内核并发创建每个图形入口（`packages/client/web/src/boot.tsx` 中的 `Promise.all`），而 host 会在连接建立时立即回一个 graph 帧。`client-hmr` 入口一激活就打开该通道——此时兄弟入口仍在导入中（`_initTask` 进行中、`fiber` 尚未赋值）。reconcile 把这些入口视为无 fiber，将其移除并重建；内核自己的创建循环随后对已移除的入口调用 `loader.resolve(id)`，抛出 `cannot resolve entry <随机id>`，导致整个启动失败。

## 决策

`packages/client/hmr/src/client/index.ts` 延迟打开 SSE 通道，直到 shell 自身的入口创建结束：app-shell 组装行已存在（内核最后创建它）且 `loader.getTasks()` 为空，即没有入口仍在导入或排空生命周期任务。reconcile 还额外跳过 `_initTask` 仍在设置的行的移除，覆盖边界处的帧竞态。host 端不变：连接时立即回 graph 帧正是树稳定后驱动即时启停的机制。

## 备选方案

**仅让 reconcile 幂等且竞态安全。** 否决：跳过导入中的移除可修复 resolve-after-remove 崩溃，但 graph 帧仍可能挂载内核即将创建的某行，造成插件重复挂载。启动窗口守卫对成员变更（而不只是拆除）是必需的。

**等待内核设置 `window.__DSH_BOOT_READY__` 标志。** 否决为耦合过重：loader 树状态（app-shell 行存在、无待处理任务）正是内核自己的 `loader.await()` 收敛条件，插件可从其已注入的树中推导同一信号。

## 影响

桌面端全新启动不再与入口创建竞态：首个 graph 帧只在树收敛后到达，即时启停保持可用（host 仍会在连接时回复权威图形）。入口激活失败的启动永远不会打开通道，这是正确的——失败界面不需要 HMR。
