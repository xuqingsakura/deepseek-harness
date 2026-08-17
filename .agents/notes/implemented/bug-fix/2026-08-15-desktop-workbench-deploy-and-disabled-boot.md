# Agent Note: Workbench bundles not deployed; `dsh.profile.disabled` not consumed at boot

Status: implemented

English | [中文](2026-08-15-desktop-workbench-deploy-and-disabled-boot.zh.md)

## Problem

Two bugs surfaced on the first workbench install (rc.15):

1. The workbench never appeared: no header toggle, no file tree. The new `@deepseek-ai/dsh-host-workbench` / `@deepseek-ai/dsh-client-ui-workbench` packages were absent from the client module table despite being in the installer.
2. whale-girl showed "disabled" in the desktop plugin manager but "enabled" (and actually running) in the Loader inventory list.

## Root causes

1. **Bundle patch not deployed.** The runtime mounts client plugins from the Loader entries, which come from the `dsh-web-app` bundle's `cordis.patch.yml`. That file (and the bundle's `package.json` dependency closure, which feeds `healProfilesModuleFallback`'s flat-module junctions) is package source, not `lib/`; the closure-sync script copies only `lib/`, so the deployed bundle still carried the pre-workbench patch. The new packages were also absent from the bundle's dependency graph, so no `profiles/node_modules` junction existed and the Loader (baseUrl = profile dir) could not resolve `@deepseek-ai/dsh-host-workbench` at all.
2. **`dsh.profile.disabled` was never consumed at boot.** `reconcilePlugins` (the `dsh plugin` command) only used `disabled` to avoid re-pushing a bundle into `dsh.profile.bundles`; `composeProfile` applied every bundle in `bundles` unconditionally. The desktop manager's `setPluginEnabled` keeps the layer stack constant (edits `disabled` only, so live re-enable works), which left `bundles` containing whale-girl alongside `disabled: [whale-girl]` — so every boot re-mounted whale-girl enabled, while the manifest view (desktop manager) said disabled. Two UI surfaces read two different truths.

## Decision

1. **Publish the bundle patch as part of the desktop runtime.** The build/deploy flow now treats `dsh-web-app`'s `cordis.patch.yml` and `package.json` as deployable: both are copied into the runtime closure, and the two new packages are declared in the bundle's dependencies so `healProfilesModuleFallback` junctions them into `profiles/node_modules`. The client module table then includes `@deepseek-ai/dsh-client-ui-workbench` and the gateway loads.
2. **Boot consumes `dsh.profile.disabled`.** `loadProfile` now projects the manifest `disabled` list onto `Profile.disabled`; `composeProfile` collects the entry ids each disabled bundle inserts (insert lists and direct rows) and appends `{ id, disabled: true }` overlay patches after every user/overlay layer, so a disabled bundle's rows mount row-disabled at boot. The layer stack stays constant (live toggle still works) and the Loader inventory now agrees with the manifest view on next boot.

## Alternatives considered

**Make `setPluginEnabled(false)` also evict the bundle from `dsh.profile.bundles`.** Rejected: it breaks the "layer stack constant" contract the live re-enable path relies on, and removes the entry from the running tree. Row-disabling at boot keeps the entry mounted but inert, matching the live-toggle model.

**Ship the patch inside `lib/`.** Rejected: bundle patches are read from the package root by `dsh.profile.bundles` resolution; duplicating them under `lib/` would fork the source of truth.

## Consequences

A fresh install now loads the workbench (toggle + overlay file tree), and a bundle disabled through the desktop manager stays disabled across restarts with both the manager and the Loader inventory in agreement. `pnpm run build:lib:host` + the closure sync + `deploy-runtime` is the full publish path; bundle patch/package.json changes must also be copied into the runtime closure (the sync script copies `lib/` only).