# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

[English](README.md) | 中文

Web 设置中的只读**插件列表**标签页。浏览器插件注册一个 id 为 `all` 的本地化 `settings.plugins.tab` 贡献；“插件”分区拥有导航入口与标签栏。插件激活期间不会读取 Remote；首次选择该标签页时才挂载组件，并通过 [`api-remotes`](../../api/remotes/README.md) 懒调用 `ctx.remote.pluginInventory.list()`。

该标签页以可搜索的双列紧凑折叠卡片展示清单。每张收起的卡片使用模块短名称作为标题，以小标签表示有效启停状态；已启用的条目还会以彩色圆点表示根 fiber 状态。展开卡片后会直接展示 Loader 树条目 id，不附加重复的字段标题，并列出有效配置状态；已启用的条目还会列出 Cordis 状态，已停用的条目则省略重复的“未挂载”运行状态。条目 id 仍作为 React key、展开标识、详情值与额外的搜索目标；代码不按字符串形状对它分类。加载、空结果、无匹配结果与通用失败状态只属于已挂载组件；读取失败后可以重试，且不会暴露传输细节。在打包后的桌面端应用中，Electron bridge（`window.dshDesktop`）让该清单可操作：模块名匹配已安装外部插件（npm / GitHub / 本地）的目录行，会在展开后的详情里出现「启用/停用」按钮，通过 `pluginSetEnabled` 接入官方 `dsh plugin --profile web` 流程，每次切换后重新读取清单。浏览器构建没有 bridge，保持只读。

注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

## 模型体验

无，因为本包只在浏览器设置中展示 Host 拥有的部署快照，不注册任何模型接口。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **每次 Settings 挂载或重试只读取一份快照** —— 标签页不订阅 Loader 变化，也不会在重连后自动重新读取；切换标签页会保留当前快照，重新打开 Settings 则会取得新快照。
- **部分修改能力** —— 桌面端构建支持直接从列表切换外部插件（启用/停用）；安装/更新/移除仍在「桌面端插件管理」标签页，浏览器构建保持只读。
