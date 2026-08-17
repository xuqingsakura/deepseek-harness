# Agent Note: Desktop official plugin install — vendored pnpm, loader fallback, skin plugin proof

Status: implemented

English | [中文](2026-08-15-desktop-official-plugin-install.zh.md)

## Problem

The desktop shell could not install third-party plugins. The CLI's `dsh plugin --profile web add <package>` forwards to pnpm inside the profile directory and reconciles `dsh.bundle` packages into `dsh.profile.bundles`, but the packaged app had no pnpm, no `dsh` CLI, and no UI entry. Worse, even a manually installed profile plugin could not load: the desktop boots the web profile in-process without Node's internal loader (`node-addon-require-builtin` is system-Node ABI and unavailable under Electron), and the vendored Loader's bare `import(name)` resolved from the loader's own module graph — `profiles/web/node_modules` was unreachable.

## Decision

- **Reuse the official flow, not a parallel one.** The runtime closure already ships `apps/cli`'s `runPlugin` and the `dsh-app-boot` profile APIs. The desktop adds `apps/desktop/src/plugin-manager.ts`, which drives the same semantics: init the profile, run a **vendored pnpm** (`@pnpm/exe` Windows build at `resources/pnpm/pnpm.exe`, ~100 MB, stripped to `pnpm.exe` + `dist/`) with `update-notifier=false` (kills pnpm's startup registry check that stalls ~70 s behind a blocked registry), and reconcile `dsh.profile.bundles` against installed state. `DSH_PNPM_REGISTRY` overrides the registry for mirrors.
- **IPC + UI.** `dsh:plugin-add/remove/list` handlers call the manager; the preload bridge exposes `pluginAdd/pluginRemove/pluginList`; Settings → Plugins (the inventory tab) renders a desktop-only `DesktopPluginManager` block (gated on `window.dshDesktop`) with a spec input, the installed list, remove buttons, and a restart hint.
- **Loader fallback for hosts without the internal loader.** `vendor/loader/src/config/tree.ts` — when `ctx.loader.internal` is absent and the specifier is a bare package name — resolves through `createRequire(new URL('package.json', ctx.baseUrl))` instead of `import(name)` from the loader's own file. `baseUrl` is the profile directory, so profile-installed plugins resolve exactly as the internal loader resolves them. Logged in vendor/README.md local-modifications.
- **Proof: an official-format skin plugin.** `apps/desktop/plugins/dsh-skin-aurora` is an npm package with `dsh.bundle.patch` + `dsh.client`, whose browser half is the official client-bundle protocol (`window.__ModuleLoader__.load({ id, factory })`) and stacks `ctx.theme.overrideTokens('dsh-skin-aurora', { '--dsw-alias-*': { light, dark } })`. End-to-end verified: `installPlugin` → pnpm add → reconcile (bundle joined), restart → host loader resolves the profile bundle, client-modules discovers `dsh.client` into `__DSH_BOOT__`, the browser activates the factory, and the palette overrides land (`--dsw-alias-bg-base` becomes `#f7f4ff`; screenshot shows the purple skin).
- **Exit/performance.** Quit already disposes the in-process host (`fiber.dispose()`) and kills the child host; Electron terminates its own utility processes, so no background processes remain after exit. Hidden-to-tray windows now explicitly keep Chromium background throttling on.

## Alternatives considered

- **Bundle the `dsh` CLI** — the closure already carries `runPlugin`; a separate CLI would duplicate it.
- **Use Node's `module.register` hooks** in the main process for a resolve hook — heavier, Electron-version-sensitive, and the loader already has a documented no-internal path.
- **Self-authored installers (registry fetch, tarball unzip)** — diverge from the official pnpm/reconcile semantics the user asked to follow.

## Consequences

- Settings → Plugins installs official `dsh.bundle` plugins into the user profile (`%APPDATA%`, no admin needed); upgrades (overwrite-in-place, rc.9+) keep them.
- New bundle layers activate on restart only (no config HMR in-process).
- The installer grows by the vendored pnpm (~100 MB on disk, ~35 MB compressed).
- `vendor/loader` carries one documented local modification; future vendor syncs must re-apply it.
- Skin plugins (or any client plugin) must ship the `__ModuleLoader__.load` bundle format — the `tsdown` client-bundle preset is the canonical builder.