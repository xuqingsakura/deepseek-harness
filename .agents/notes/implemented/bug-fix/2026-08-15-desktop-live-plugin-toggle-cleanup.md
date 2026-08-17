# Agent Note: Desktop live plugin enable/disable did not apply

Status: implemented

English | [中文](2026-08-15-desktop-live-plugin-toggle-cleanup.zh.md)

## Problem

Toggling a plugin's enable switch in the desktop Settings -> Plugins manager was not applying live: the change only took effect after restarting the app. Two independent root causes.

First, `setPluginEnabled` in `apps/desktop/src/plugin-manager.ts` evicted the plugin from `dsh.profile.bundles` when disabling (and appended it back when enabling). The running loader tree only contains rows that were in the bundle stack at boot; once a plugin was evicted, the in-process host could not toggle it live — re-enabling required a restart, and the manifest state could not even be recovered live.

Second, even when the entry was present, third-party client plugins such as whale-girl never cleaned up their DOM on disable. The vendored cordis `isConstructor` treated every callable with a prototype as a class and constructed it with `new`. A plain-function plugin apply that returns a disposer had that disposer silently replaced by the constructed instance, so cleanup was never collected into the fiber's `_disposables`; `fiber.dispose()` then ran nothing and the plugin's DOM stayed on the page. Official plugins use `ctx.effect` for cleanup (which lives in `_disposables`), so only disposer-returning plain functions were affected.

## Decision

`setPluginEnabled` now toggles only the `dsh.profile.disabled` list; the bundle stack stays constant, so the entry keeps mounting in the running loader tree and the in-process host can apply the change live. Enabling an installed bundle that a pre-fix state had evicted from the stack appends it back. `listPlugins` derives `enabled` from `!disabled.includes(name)`, the CLI/desktop `reconcilePlugins` no longer evicts disabled bundles, and the desktop UI updates the toggle from the manager's returned `enabled` instead of bundle membership.

Vendored cordis `isConstructor` (`vendor/cordis/src/utils.ts`) now constructs only class definitions (detected by `Function.prototype.toString` starting with `class`) and invokes every other callable-with-prototype shape directly, so a plain-function plugin's returned disposer reaches the fiber. This is recorded as vendor local modification 19.

Because the renderer's cordis kernel is bundled by `apps/web` (the `dsh-web-frontend` package), the web bundle must be rebuilt to carry the fix; `vite.config.ts` gains a `node:url` alias to the existing throwing stub pattern so the vendored loader's Node-only `pathToFileURL` import (unreachable in the browser) does not fail the build.

## Alternatives considered

**Refresh the renderer page on membership changes.** Rejected: it turns live enable/disable into a reload for every plugin, discarding the no-reload sync for well-behaved plugins, and the real defect was cordis's constructor misclassification.

**Patch whale-girl itself.** Rejected: third-party plugins must work unmodified; the cordis fix benefits every disposer-returning plain-function plugin.

**Only change the manifest semantics.** Rejected: without the cordis fix the UI state would flip but whale-girl's pet DOM would still linger until restart.

## Consequences

Enabling a plugin that is already in the running tree (installed and enabled after this fix) applies immediately: the whale-girl pet disappears on disable and returns on enable with zero errors and no restart or reload. A plugin that a pre-fix state evicted from the bundle stack needs one restart after its first enable (the entry is not in the running tree), after which toggling is live. The vendored cordis change also fixes DOM/cleanup lifecycle for any plain-function plugin that returns a disposer.
