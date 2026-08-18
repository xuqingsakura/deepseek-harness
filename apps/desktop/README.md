# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The Windows desktop shell for the DeepSeek Harness Web GUI. By default the Electron main process boots the harness `web` profile in-process (A3) and renders the existing harness UI in a native window; `DSH_DESKTOP_HOST=child` restores the supervised `dsh web` host-child layout (A2).

## Architecture

Three layers replace the browser tab, never the harness itself:

- **In-process host (default, A3)** — the Electron main process dynamically imports the deployed host closure (`out/runtime/host-deploy`, packaged `resources/runtime/host-deploy`) and boots the `web` profile inside itself via the shared profile boot; the loopback URL comes from the in-process `webServer` service. The closure must be a flat `node_modules`: the vendored Loader's bare `@deepseek-ai/*` resolution needs either Node's internal ESM loader (`node-addon-require-builtin`, system-Node ABI, unavailable under Electron) or a flat layout above the loader's own file. `DSH_DESKTOP_HOST=child` keeps the A2 subprocess host (bundled `node.exe` + the same closure) as a fallback.
- **IPC carrier** — `packages/client/connection/src/client/electron-api-client.ts` extends `AbstractApiClient` and routes every `/api/*` request through `window.dshDesktop.apiFetch` (`ipcRenderer.invoke('dsh:api-fetch')`); the mux/WebSocket downlink is relayed by the main process as a frame stream (`dsh:api-stream-subscribe`). The browser carrier is untouched: `apply()` keeps the HTTP carrier whenever `window.dshDesktop` is absent.
- **Native shell** — custom title bar (favicon + centered "DeepSeek Harness" + minimize/maximize-close controls) with a themed background, system tray with close-to-tray, notifications when an approval/question request arrives while the window is hidden, and window-geometry persistence (`%APPDATA%\dsh-desktop\window-state.json`). The title-bar whale is painted with `currentColor` off `--dsw-alias-label-primary` (the same token as the sidebar FishLogo), so it is dark ink in light mode and near-white in dark mode. The webServer binds a preferred fixed loopback port (`17890`, with fallbacks) so the renderer origin — and with it the web UI's localStorage (current session, chat view, workspace view) — stays stable across launches.

## Usage

Build the repository artifacts first (the host child runs the built launcher):

```sh
pnpm run build
```

Then run the desktop shell:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

Self-check mode boots the host, waits for the React root to render, asserts the title bar and window controls, and prints `DESKTOP_SMOKE_OK` (exit 0) or `DESKTOP_SMOKE_FAIL` (exit 1):

```sh
pnpm --filter @deepseek-ai/dsh-desktop run smoke
```

`$DSH_HOME` overrides the harness home; otherwise the shell uses `apps/desktop/.dsh-home` in source/dev runs and `%APPDATA%\dsh-desktop\dsh-home` in the packaged app. All harness user data (conversation logs under `sessions/`, `settings.yaml`, `.credentials.yaml`, `storages/`) lives under that home.

To bring a web-version home (`~/.dsh`) over, Settings → About & Updates → **Import data from Web version** runs a safe merge (or run `node apps/desktop/scripts/migrate-web-data.mjs` from the repo after `pnpm --filter @deepseek-ai/dsh-desktop run build`). The migration copies only conversation sessions the target does not already own, merges `storages/*.json` key-by-key (target keys win), and leaves `settings.yaml` / `.credentials.yaml` untouched unless you opt in explicitly (and even then only when the target file is absent). An empty or missing `storages/workspace.json` makes the workspace registry re-bootstrap and adopt the copied sessions automatically. Use `--dry-run` to preview, `--force` to replace target-owned sessions, and `--json` for machine-readable output.

## Launch splash

While the harness host boots, the shell shows an animated launch page: the favicon whale swims in from the left, settles into a breathing loop with brand-blue ripple rings over a star field, and on host-ready the whale swims out right while the page fades to the dark base before the real UI loads. All motion is transform/opacity (GPU composited) and respects `prefers-reduced-motion`; the pre-animation splash remains available as a fallback via `DSH_DESKTOP_LEGACY_SPLASH=1`.

Any installed web-profile plugin may supply its own splash by declaring `dsh.desktop.splash` in its package.json pointing at a self-contained HTML file (relative to the package root). The shell scans installed plugins at boot and uses the first valid declaration; broken or path-escaping declarations fall back silently to the built-in page. Splash HTML should implement `window.__dshSplashExit()` returning a Promise that resolves when its exit animation finishes, so the shell can transition smoothly to the UI; pages without it get a fixed 450ms fade.

## Development

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev   # tsc build, then electron .
pnpm --filter @deepseek-ai/dsh-desktop exec electron . --gen-icon apps/desktop/assets   # regenerate icon assets from apps/web/public/favicon.svg
```

## LLM Providers

The packaged runtime ships three LLM provider families (the rest of pi-ai's catalog is pruned at deploy time):

- **DeepSeek** — the native `dsh-llm-deepseek` provider (active by default) plus pi-ai's `deepseek` catalog entry. Set `DEEPSEEK_API_KEY`.
- **Xiaomi MiMo** — pi-ai's `xiaomi` provider (OpenAI-compatible, `https://api.xiaomimimo.com/v1`), plus the `xiaomi-token-plan-*` variants with their own endpoints and `XIAOMI_TOKEN_PLAN_*_API_KEY` keys. Set `XIAOMI_API_KEY` for the regular API. The catalog keeps only the models the MiMo API actually accepts today: `mimo-v2.5` and `mimo-v2.5-pro`.
- **OpenCode Zen / Zen Go** — pi-ai's `opencode` and `opencode-go` catalog entries (Anthropic / Google / OpenAI-compatible endpoints); configure their API keys in the `llm-pi-ai` settings section.

Configure extra providers or credentials in the app's settings (`llm-pi-ai` section) or via the environment keys above.

## Packaging (Windows NSIS)

The installer bundles the host runtime (a deployed closure of the workspace packages) under `resources/runtime`; see `runtime/package.json` and `electron-builder.yml`. `package:desktop` materializes a missing closure on a clean tree (CI) with `pnpm deploy`, then refresh it with `node apps/desktop/scripts/deploy-runtime.mjs` (which also stages the `@deepseek-ai/dsh` bin package that pnpm deploy skips, and prunes the duplicated vendored pnpm the legacy deploy copies in), which syncs every freshly built workspace package's `lib/` into the closure, regenerates the stable `embed.js` re-export shim and prunes dead weight for a smaller, faster install: `.map`/`.d.ts`/`.pdb`/`.ts` artifacts, build-time tools (`typescript`, `vite`), the `node.exe` child fallback (the in-process host is the packaged default; `DSH_DESKTOP_HOST=child` is dev-only now), and all pi-ai providers except the DeepSeek, Xiaomi/MiMo, and OpenCode (Zen/Zen Go) families. This cut the installer from 263 MB to ~135 MB and a silent install from 16+ minutes to ~7 minutes.

```sh
# one-command package: builds client libs, refreshes the runtime closure
# (deploy-runtime.mjs), compiles the shell, runs electron-builder, and lands
# Setup.exe in apps/desktop/dist-installer/. Run `pnpm run build:lib:host`
# first if host packages changed (deploy-runtime copies apps/cli/lib).
pnpm run package:desktop
# mirrors for the first run / CI (set before package:desktop):
# $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
# $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

The installer lands in `apps/desktop/dist-installer/`. electron-builder output goes to `%LOCALAPPDATA%\Temp\dsh-pkg` (configured in `electron-builder.yml`) so the workspace watcher never locks `win-unpacked`.


## Updating

- **Overwrite-in-place upgrades.** Since rc.9 the NSIS installer skips the previous uninstaller (see `build/installer.nsh`) and overwrites the existing installation directly: run the new Setup.exe over the old one (same per-machine scope), no uninstall needed. Shortcuts, window state, and all harness data under `%APPDATA%\dsh-desktop` are preserved.
- **In-app auto-update.** Settings → About → 检查更新 checks the release channel baked into the packaged `app-update.yml`. Packaged builds use the GitHub provider (`owner`/`repo` from `electron-builder.yml`) and resolve the newest published release: a prerelease tag (`0.1.0-rc.*`) resolves the `rc` channel (`rc.yml`), a stable tag resolves `latest.yml`. `DSH_UPDATE_FEED_URL` or `%APPDATA%\dsh-desktop\update-config.json` (`{"url": "https://…/updates/"}`) still override the feed. `update-downloaded` notifies and clicking restarts into the install. `.github/workflows/desktop-release.yml` builds the installer on a manual dispatch (or a `v*` tag push) and publishes the Setup exe, its `.blockmap`, and the channel yml to this repo's GitHub Releases.
- **Plugins.** The desktop runs the official `dsh plugin --profile web` flow for Settings → Plugins: a vendored pnpm (`resources/pnpm`) installs into `%APPDATA%\dsh-desktop\dsh-home\profiles\web\node_modules` and the official reconcile registers `dsh.bundle` packages into `dsh.profile.bundles` — exactly what the CLI does. Add by npm `name@version` (needs registry access; set `DSH_PNPM_REGISTRY` for a mirror), an absolute path/`file:` spec to a local `.tgz`/directory, or a git spec such as `github:owner/repo#branch` (git must be on PATH). A git install fetches sources, so the plugin's `prepare` script builds it on first install; pnpm >=10 blocks that script until allowed, and the UI offers a one-click "authorize build script and retry" flow that writes the printed key into the profile's `pnpm-workspace.yaml` and re-runs the add. Installs inherit the proxy: the installer prefers `HTTPS_PROXY`/`HTTP_PROXY` environment variables, falls back to the global git proxy (`git config --global http.proxy`/`https.proxy`), writes it into the profile's `.npmrc`, and passes it to the spawned pnpm/git — so GitHub installs follow the same route as the browser's system proxy. The Settings → Plugins desktop block is the unified manager for external plugins: each row shows its source (npm / GitHub / local), version, bundle status, and runtime mount phase (with failure detail), and offers per-plugin or bulk update, enable/disable (a disabled bundle stays installed but leaves the layer stack via `dsh.profile.disabled`), batch remove, and an "update available" badge parsed from `pnpm outdated`. Enable/disable applies immediately in the running app (no restart): the installer writes the profile manifest and drives the live Loader row, the host broadcasts the recomposed `__DSH_BOOT__` graph, and the renderer's client-HMR reconciles membership, so the plugin's UI unmounts/mounts on the spot. (Full `cordis.patch.yml` hot-reload still requires the real-Node internal loader, which Electron cannot load.) Plugins must be authored to the official bundle shape (`dsh.bundle.patch` + optional `dsh.client` browser half built to the `window.__ModuleLoader__.load` protocol). A new or removed bundle layer activates on restart (the in-process host has no config HMR). The desktop ships the bundled plugins (`dsh-workbench`, and a skin) under `resources/plugins`; Settings → Plugins lists them in a **Built-in plugins** block with a one-click install (`file:` spec, no path typing). The workbench plugin provides the file tree, Markdown/code viewer with syntax highlighting, embedded browser, terminal, Git panel (VSCode-style commit graph), and background-task panel. The two LLM provider families are below.

## Known Limitations

- **Directory picker is the in-app browse flow, not the native OS dialog.** The web profile's `directory-picker-auto` row resolves to the native Win32 chooser on a loopback bind, and that chooser spawns its worker with `process.execPath` — the Electron binary under the in-process host — so the worker can never report. The desktop pins the renderer-side browse backend via `assets/desktop-browse-picker.yml` instead; it runs entirely in the renderer and needs no child process.
- In-process (default) runs one process; the `DSH_DESKTOP_HOST=child` fallback still spawns a `node` child. Window close disposes the tree (durable sessions persist through SQLite regardless).
- Config hot-reload (editing `cordis.patch.yml` while running) is unavailable in-process: the config-HMR watcher requires Node's internal loader, which Electron cannot load.
- Closing the window parks the app in the system tray (tray menu: show/hide, check updates, quit) instead of quitting; the tray "退出 DeepSeek Harness" item (or any `app.quit()` path) fully disposes the in-process host (`fiber.dispose()`), closes the loopback server, and exits — no background processes remain. Hidden windows keep Chromium's background throttling on, so tray-resident CPU drops to idle.
