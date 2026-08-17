# Agent Note: Desktop shell boots the harness in-process

Status: implemented

English | [中文](2026-08-14-desktop-in-process-host.zh.md)

## Problem

The Windows desktop shell (`apps/desktop`) originally supervised a `dsh web` host child under a bundled real Node (`DSH_DESKTOP_HOST=child`, the A2 layout): the renderer reaches the harness over loopback HTTP/WebSocket relayed through the Electron IPC bridge. That works but bundles a 50 MB `node.exe`, spawns a second process, and keeps two runtimes (system Node for the host, Electron for the shell) in one package. A3 was scoped to boot the harness inside the Electron main process instead.

## Decision

The shell boots the `web` profile **in-process by default** (A3). `apps/desktop/src/host-in-process.ts` dynamically imports the deployed host closure (`out/runtime/host-deploy`, packaged `resources/runtime/host-deploy`) and drives the shared profile boot (`prepareProfile` + `composeProfile` + `allPatches` + `boot` from `@deepseek-ai/dsh/lib/profile-boot`), then reads the loopback URL from the in-process `webServer` service. The renderer and IPC bridge are unchanged. `DSH_DESKTOP_HOST=child` keeps the A2 subprocess path as a fallback.

Three facts made this cheap:

- **Bare-name resolution needs a flat `node_modules`.** The vendored Loader resolves bare `@deepseek-ai/*` names either through Node's internal ESM loader (`node-addon-require-builtin`, compiled for the system Node ABI and unavailable under Electron) or, with `internal` absent, from the loader's own location upward. The repo's pnpm workspace is not a flat layout (`ERR_MODULE_NOT_FOUND`); the deployed host closure is, so in-process boot imports the closure rather than repo source.
- **`node-pty` is N-API.** The prebuilt win32 addon loads and spawns terminals under Electron's Node ABI; no rebuild or lazy-loading was needed, contrary to the earlier M1 assumption.
- **Config HMR needs the internal loader.** `runProfile`'s post-boot HMR watcher throws `--expose-internals is required` when `internal` is absent, so the in-process boot skips that post-boot glue (and the process-level signal/fail-loud wiring, which belongs to a standalone process, not an Electron app). Config hot-reload is unavailable in-process.

`apps/cli/src/profile-boot.ts` now exports `composeProfile` and `allPatches` so the desktop reuses the exact patch stacking (bundle layers, home layer, overlays, agent-presets root, telemetry switch) instead of duplicating it. The tsdown bundle names are content-hashed, so `apps/desktop/scripts/deploy-runtime.mjs` regenerates a stable `lib/embed.js` re-export shim from the bundle's export line after each `pnpm run build:lib:host`.

## Alternatives considered

- **Keep A2 as the only layout** — simplest, but keeps the second runtime and bundled `node.exe`.
- **Make the internal loader work under Electron** (rebuild `node-addon-require-builtin` for the Electron ABI) — would unlock config HMR, but Electron's Node internals are not guaranteed to match stock Node, and the runtime would need a second ABI-specific copy.
- **Lazy-load `node-pty`** — unnecessary once probing showed the N-API prebuild loads under Electron.

## Consequences

- The default desktop run has one process and one runtime; the bundled `node.exe` remains only for the `DSH_DESKTOP_HOST=child` fallback.
- Config hot-reload (edit `cordis.patch.yml` while running) is unavailable in the in-process shell; the web bundle's module-reload HMR was already disabled.
- The runtime closure must stay refreshed (`pnpm run build:lib:host` then `apps/desktop/scripts/deploy-runtime.mjs`) or the stable `embed.js` shim goes stale.
- A future size optimization can drop `node.exe` from `extraResources` once the child fallback is retired.
