# Agent Note：会话流窗口化、渲染内存观测、常驻窗口 LRU

状态：已实现

[English](2026-08-19-chat-flow-windowing-and-render-memory.md) | 中文

## 问题

长对话一次渲染所有业务节点；即使有 `content-visibility: auto`，DOM 与协调成本仍随消息数线性增长，超长回复会保持整个流挂载。常驻 `Session` 实例永远持有事件窗口，打开很多会话会累积内存，只能靠重启回收；也没有应用内手段观察渲染器堆增长。窗口化本身在真实浏览器里还会崩溃：测量行导致 spacer 偏移，Chromium 的滚动锚定调整 scrollTop 保持视口稳定，窗口重算，两者互相振荡，直到 React 的更新深度守卫把对话视图拆掉（相邻行的 start/end 无限切换）。

## 决策

- **会话流窗口化**（`chat-window.ts` + `ChatView.tsx`）：纯几何核心（`prefixSums`/`computeWindow`/`tailWindow`）驱动 spacer 窗口——只挂载视口 ±12 行，顶部/底部 spacer 保持 scrollHeight。行在首帧绘制前获得 kind 级高度估算，ResizeObserver 测量已挂载行。只有 `ResizeObserver` 存在且流 ≥ `WINDOW_THRESHOLD`（200）节点时才启用窗口化，因此 jsdom 测试与小会话保持全量挂载路径。「加载更早」的 prepend 锚定在锚点行被卸载时回退到高度表；切换会话会清空高度缓存。
- **稳定测量**（崩溃修复）：测量回调只重算 spacer 高度（`applyMeasured`），绝不移窗口，因此测量一行不会级联成挂载新行；窗口化期间流禁用行的 `content-visibility` 并在滚动容器上设置 `overflow-anchor: none`，消除了经浏览器实测的滚动锚定反馈振荡（115 次滚轮再回到顶部，无崩溃）。
- **渲染内存观测**（`render-memory.ts`）：`ConversationRoot` 上的挂载计数 hook 每 10s 采样 `performance.memory`，空闲堆 5 分钟增长 ≥ 64 MB 时警告一次，并向 DevTools 暴露 `window.__dshRenderMemory`。
- **常驻窗口 LRU**（`Session`/`SessionManager`）：`Session` 在打开时记录 `lastActiveAt`，新增 `releaseWindow()`/`hasOpenWindow()`；管理器把并发打开窗口上限设为 `MAX_RESIDENT_WINDOWS = 20`，并在切换选择时释放最旧的非选中、非运行窗口（实例保持温热，下次打开重新拉取历史）。

## 影响

900+ 节点的会话只挂载约 20–60 行即可滚动，不再出现首个 rc.56 构建携带的滚动锚定崩溃；堆增长可观测，大会话集合不再累积陈旧窗口。jsdom 与小会话行为逐字节不变。

## 备选方案

- 绝对定位行（FileTree 式）：效率最高，但对动态流式高度不友好。spacer 窗口让已挂载行保持普通文档流，并复用既有锚定/台账机制。
- 每次测量后补偿 scrollTop 来自持滚动锚定：每一帧都在与浏览器自身的锚定对抗。窗口化时禁用 `overflow-anchor` 只有一行，且既有阅读者归属台账已接管位置。
- 直接丢弃窗口（drop 整个 `Session`）：会丢失队列/地址/blank 状态；`releaseWindow()` 保持实例温热，重开时重新拉取。
