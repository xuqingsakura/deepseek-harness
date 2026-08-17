# Agent Note：桌面端 —— 覆盖式升级、自动更新与标题栏主题

Status: implemented

[English](2026-08-15-desktop-overwrite-upgrade-and-titlebar-theme.md) | 中文

## 问题

两个桌面端缺陷阻碍了更新流程：

- **每次 NSIS 重装都报 "Failed to uninstall old application files...:2"。** electron-builder >= 26.7（回归：electron-userland/electron-builder#9593）在重装前会用 `--updated` 运行旧卸载器；该路径会把 `$INSTDIR` 原子改名移走，任何文件被占用就以退出码 2 中止。因此更新必须先卸载再安装，丢失快捷方式并可能造成用户数据目录混乱。
- **深色模式下标题栏鲸鱼仍是黑色。** 注入的 favicon SVG 通过 `@media (prefers-color-scheme: dark)` 变色，它跟随操作系统/浏览器配色 —— 而应用自身的浅/深色是由 `--dsw-*` token 驱动的（主题 presenter 会写根 `color-scheme` 与 body token）。二者并不总是同步，因此鲸鱼没有像其下方侧边栏的 FishLogo 一样变白。

## 决策

- **覆盖式升级。** `apps/desktop/build/installer.nsh`（electron-builder 自定义 NSIS include，从 `buildResources` 自动引入）在 `customInit`（`.onInit`）中删除卸载注册表键的 `UninstallString`/`QuietUninstallString`，覆盖 HKCU/HKLM 与 32/64 位视图。`uninstallOldVersion` 因此找不到旧安装，跳过旧卸载器，新安装包直接覆盖旧文件；随后 `registryAddInstallInfo` 会重新创建卸载条目。`nsis.perMachine: true` 让所有安装共用一个作用域（`C:\Program Files\DeepSeek Harness`），后续 Setup.exe 直接覆盖前一次安装，不再叠加作用域。
- **自动更新。** 主进程接入 `electron-updater`：更新源依次取 `DSH_UPDATE_FEED_URL`、`%APPDATA%\dsh-desktop\update-config.json`（`{"url": "..."}`）、打包内的 `app-update.yml` 占位地址。托盘新增"检查更新"项用于手动检查；启动 12 秒后仅在配置了更新源时静默检查（绝不弹"已是最新"噪音）；`update-downloaded` 发通知，点击调用 `quitAndInstall()`。
- **标题栏鲸鱼跟随应用主题。** preload 用 `#dsh-titlebar-icon path { fill: currentColor }` 绘制 favicon，继承标题栏的 `color: var(--dsw-alias-label-primary, #111418)` —— 与侧边栏 FishLogo 使用同一 token：浅色模式为深墨蓝，深色模式接近白色，无需 IPC、不依赖系统配色。

## 备选方案

- **修补旧卸载器的 `--updated` 原子改名** —— 不可行：卸载器由 electron-builder 生成；自定义 include 删除注册表是 #9593 的社区通用 workaround。
- **在主进程设置 `nativeTheme.themeSource`** —— 需要渲染进程每次切换主题都走 IPC，且仍与 token 调色板语义（自定义主题/覆盖层）不一致。
- **保留 SVG 中的 `prefers-color-scheme`** —— 应用调色板是 token 驱动，系统配色与应用内主题切换正交，不可靠。

## 影响

- 重装与版本升级不再需要先卸载：已用静默 rc.8 覆盖 rc.8 验证（退出码 0、无弹窗）；跨版本 rc.9 覆盖 rc.8 走同一代码路径。
- 卸载注册表条目在 `customInit` 与 `registryAddInstallInfo` 之间会短暂缺失；若安装被取消可能遗留旧文件（罕见 —— 下次安装会覆盖，完成后 Windows"应用"列表会恢复条目）。
- 自动更新需要真实的更新源（环境变量或 `update-config.json`）；打包的占位地址在发布通道建立前保持惰性。
- smoke 通过模拟 presenter 应用深色断言鲸鱼填充色（`DESKTOP_TITLEBAR_DARK`），未来回归会在桌面端自检中直接失败。