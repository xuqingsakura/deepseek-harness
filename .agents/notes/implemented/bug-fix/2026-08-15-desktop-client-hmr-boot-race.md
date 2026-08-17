# Agent Note: Desktop boot race between client-hmr graph reconcile and shell entry creation

Status: implemented

English | [中文](2026-08-15-desktop-client-hmr-boot-race.zh.md)

## Problem

After the rc.11 overwrite install, the desktop shell booted to the failure screen (`Failed to load plugins`) with `cannot resolve entry 87044ea8` in the renderer. The live plugin enable/disable work added a `graph` frame on the `/plugins/events` SSE channel and a browser-side `reconcile()` that syncs the renderer's loader tree against the host graph. The race: the shell kernel creates every graph entry concurrently (`Promise.all` in `packages/client/web/src/boot.tsx`), and the host answers a connect with an immediate graph frame. The `client-hmr` entry opens that channel as soon as its own activation runs — while sibling entries are still importing (`_initTask` in flight, `fiber` not yet assigned). Reconcile saw such an entry as fiberless, removed it, and re-created it; the kernel's own create loop then called `loader.resolve(id)` on the now-removed entry and threw `cannot resolve entry <random-id>`, failing the whole boot.

## Decision

`packages/client/hmr/src/client/index.ts` defers opening the SSE channel until the shell's own entry creation has settled: the app-shell assembly row exists (the kernel creates it last) and `loader.getTasks()` is empty, so no entry is still importing or draining a lifecycle task. Reconcile additionally skips removal of rows whose `_initTask` is still set, covering frame races at the settle boundary. The host half is unchanged: the immediate graph frame on connect is exactly what drives live enable/disable once the tree is stable.

## Alternatives considered

**Make reconcile idempotent and race-safe only.** Rejected: skipping mid-import removals fixes the resolve-after-remove crash, but a graph frame that mounts a row the kernel is about to create still double-mounts that plugin. The boot-window guard is required for membership changes, not just teardown.

**Wait for a `window.__DSH_BOOT_READY__` flag set by the kernel.** Rejected as more coupling: the loader-tree state (app-shell row present, zero pending tasks) is exactly the kernel's own `loader.await()` settlement condition, so the plugin can derive the same signal from the tree it already injects.

## Consequences

A fresh desktop launch no longer races entry creation: the first graph frame arrives only after the tree settled, and live plugin enable/disable keeps working (the host still answers connect with the authoritative graph). A boot that failed entry activation never opens the channel, which is correct — the failure screen needs no HMR.
