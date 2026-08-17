# Agent Note: Desktop unified external plugin manager

Status: implemented

English | [中文](2026-08-15-desktop-external-plugin-manager.zh.md)

## Problem

The desktop Settings -> Plugins surface had two halves with different depths: a read-only runtime inventory of every mounted Loader entry, and a minimal install list (add/remove only) that showed no source, no update path, no enable/disable, and no runtime state. Managing an external plugin meant knowing the pnpm spec, guessing the source, and restarting to find out whether it actually mounted — GitHub installs in particular had no visible update or failure path.

## Decision

`apps/desktop/src/plugin-manager.ts` thickens the installed-plugin projection and gains management verbs, all on the official `dsh plugin --profile web` flow:

- `listPlugins` returns `spec`, `source` (`npm`/`git`/`local`, derived from the pnpm dependency spec), and `enabled` alongside the existing name/version/isBundle/patch.
- `updatePlugin` / `updateAllPlugins` run `pnpm update <name>` / `pnpm update`; `removePlugins` batches several names into one `pnpm remove`. `checkOutdated` parses `pnpm outdated --format json` into a name -> latest map (git and local plugins are not reported and never appear).
- `setPluginEnabled` toggles a bundle plugin's layer membership by maintaining the profile manifest's `dsh.profile.disabled` list, without running pnpm; `reconcilePlugins` (desktop and CLI, `apps/cli/src/plugin.ts`) now respects that list, so a disabled bundle stays installed but leaves the layer stack and is not re-added on the next pnpm operation. `DshProfileManifest` in `packages/boot/app-boot/src/profile.ts` declares the field.
- New IPC handlers `dsh:plugin-update`, `dsh:plugin-update-all`, `dsh:plugin-remove-many`, `dsh:plugin-set-enabled`, `dsh:plugin-outdated` (preload bridge `pluginUpdate`/`pluginUpdateAll`/`pluginRemoveMany`/`pluginSetEnabled`/`pluginOutdated`).

The renderer block (`DesktopPluginManager.tsx`) is the unified manager: each external plugin row shows a source badge, version, bundle/state tags, and a runtime mount phase matched from the Loader inventory snapshot the tab passes down; failed rows surface the fiber's mount error (`packages/host/plugin-inventory` now projects the private `_error` of a FAILED fiber as `error`). Actions are update, enable/disable (bundle plugins only), remove, batch remove via checkboxes, and "update available" badges. `pnpm outdated` runs once on mount and after version-affecting operations, not after every toggle, to keep the block responsive.

Enable/disable applies live, not only at the next boot: `host-in-process.ts` exposes `InProcessHostControls.setPluginEnabled`, which the installer calls after the manifest write to toggle the running Loader row (`entry.update({ disabled })` — the same runtime mutation config HMR uses). The host's client-modules scan drops a disabled row from `__DSH_BOOT__` (a disabled entry has no fiber); `client-hmr` broadcasts the recomposed graph over `/plugins/events`, and its browser half reconciles membership (mount missing rows, tear down departed rows; kernel rows excluded), so the plugin's UI unmounts/mounts without a page reload. Rev changes stay on `rebuilt` frames.

## Alternatives considered

**Add a separate management section instead of upgrading the existing block.** Rejected: the two lists would duplicate the same installed packages with different truth, and the restart hint / allowBuilds gate already live in the existing block.

**Drive enable/disable by editing `dsh.profile.bundles` directly.** Rejected: `reconcilePlugins` auto-re-adds any dependency that declares `dsh.bundle`, so a bare removal from the list would not survive the next pnpm operation; the explicit `disabled` list is the persistent, reconcile-aware source.

**Read the WinINET/system proxy for installs.** Already decided against in the proxy-inheritance note; this feature reuses that resolution unchanged.

## Consequences

External plugins are now uniformly manageable in one place with visible source, version, update, enable/disable, runtime phase, and failure detail, all backed by the same reconcile the CLI uses so the two surfaces cannot drift. Enable/disable is a manifest write with no pnpm spawn, and batch verbs keep install-time work to one pnpm invocation. The profile manifest gains an optional `dsh.profile.disabled` array; older CLI builds that do not know it would re-add a disabled bundle on their next `dsh plugin` run, which is why the CLI reconcile was updated in the same change. Enable/disable needs no restart for either half: the Loader row toggles instantly and the renderer follows the recomposed graph, so a disabled plugin's UI disappears immediately and re-appears on enable. The restart hint remains for installs, removals, and host-half code updates, whose module code has no hot swap.