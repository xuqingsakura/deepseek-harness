# Agent Note：桌面端插件即时启停未生效

状态：已实现

[English](2026-08-15-desktop-live-plugin-toggle-cleanup.md) | 中文

## 问题

在桌面端「设置 → 插件」里切换插件的启用开关没有即时生效，只能重启应用后才生效。根因有两个，相互独立。

其一，`apps/desktop/src/plugin-manager.ts` 的 `setPluginEnabled` 在停用时会将该插件从 `dsh.profile.bundles` 层栈中移除（启用时再加回）。运行中的 loader 树只包含启动时层栈里存在的行；插件一旦被移出层栈，进程内 host 就无法对它做实时切换——重新启用必须重启，且清单状态也无法在运行中恢复。

其二，即使入口在树里，第三方客户端插件（如 whale-girl）在停用时也不会清理自己的 DOM。vended 的 cordis `isConstructor` 把所有带 prototype 的可调用对象都当作 class，用 `new` 构造。普通函数插件 apply 返回的 disposer 会被构造出的实例悄悄替换，cleanup 从未收集进 fiber 的 `_disposables`；`fiber.dispose()` 因此什么都不执行，插件的 DOM 残留在页面上。官方插件用 `ctx.effect` 注册清理（位于 `_disposables`），所以只有「返回 disposer 的普通函数插件」受影响。

## 决策

`setPluginEnabled` 现在只切换 `dsh.profile.disabled` 列表；层栈保持不变，入口持续存在于运行中的 loader 树，进程内 host 可以实时应用变化。启用一个被旧版本状态移出层栈的已安装 bundle 时会把它加回。`listPlugins` 用 `!disabled.includes(name)` 推导 `enabled`，CLI/桌面端 `reconcilePlugins` 不再驱逐 disabled 的 bundle，桌面端 UI 用管理器返回的 `enabled` 更新开关而不是 bundle 成员关系。

Vendored cordis `isConstructor`（`vendor/cordis/src/utils.ts`）现在只构造 class 定义（通过 `Function.prototype.toString` 以 `class` 开头检测），其它带 prototype 的可调用对象直接调用，普通函数插件的 disposer 得以进入 fiber。已记录为 vendor 本地修改第 19 条。

由于渲染端的 cordis 内核由 `apps/web`（`dsh-web-frontend` 包）打包，web bundle 必须重建才能携带该修复；`vite.config.ts` 新增 `node:url` 别名指向已有的抛错 stub 模式，使 vendored loader 的 Node 专用 `pathToFileURL` import（浏览器不可达）不再导致构建失败。

## 备选方案

**成员变化时刷新渲染端页面。** 否决：把即时启停变成对每个插件都刷新，丢弃了对行为正常插件的无刷新同步；真正的缺陷是 cordis 的构造函数误判。

**直接修补 whale-girl。** 否决：第三方插件必须不经修改即可运行；cordis 修复惠及所有返回 disposer 的普通函数插件。

**只改清单语义。** 否决：没有 cordis 修复的话 UI 状态会翻转，但 whale-girl 的宠物 DOM 仍会残留到重启。

## 影响

启用一个已在运行树中的插件（本修复后安装并启用的插件）立即生效：停用时 whale-girl 宠物消失、启用时回来，零错误、无需重启或刷新。被旧版本状态移出层栈的插件在首次启用后需要一次重启（入口不在运行树中），之后切换即为实时。vendored cordis 的改动同时修复了任何返回 disposer 的普通函数插件的 DOM/清理生命周期。
