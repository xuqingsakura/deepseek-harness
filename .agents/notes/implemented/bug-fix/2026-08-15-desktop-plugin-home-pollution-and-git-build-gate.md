# Agent Note: Desktop plugin home pollution and git build gate

Status: implemented

English | [中文](2026-08-15-desktop-plugin-home-pollution-and-git-build-gate.zh.md)

## Problem

Installing a plugin from the desktop Settings -> Plugins manager failed with `dsh-plugin: harness home 必须是绝对路径，实际为 "undefined"`. The in-process host sets `process.env.DSH_HOME` for the booted web profile and restores it afterwards. On a normal app launch the variable is unset, so the restore assigned `undefined` to it; Node stringifies environment variable writes, turning the value into the literal string `"undefined"`. A later `harnessHome()` read then treated that non-empty value as a configured home, and `assertSafePluginHome` rejected the relative path. The same pollution previously surfaced as an EPERM writing under the install directory before the home assertion existed.

Separately, git-source plugin installs (per the publish tutorial) require pnpm >= 10 `allowBuilds` authorization before their `prepare` script runs; without it pnpm aborts with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. The desktop UI only echoed the pnpm output, leaving the user to hand-edit `pnpm-workspace.yaml`.

## Decision

`host-in-process.ts` restores the environment variable by deleting it when it was unset before boot, assigning only when a real previous value existed. `harnessHome()` additionally treats the literal `"undefined"`/`"null"`/`"NaN"` strings as unset and falls back to the app data `dsh-home`, so a polluted variable can never hijack plugin management.

For the build gate, `plugin-manager.ts` gains `parseAllowBuildHints()`, which reads the exact depPath keys pnpm prints under `allowBuilds:` in its hint block, and `writeAllowBuilds()`, which merges those keys into the profile's `pnpm-workspace.yaml` (single-quoted, preserving existing keys) without executing package code. `authorizeBuilds()` exposes the flow, and `PluginManagerResult` carries the parsed keys back to the UI. A new `dsh:plugin-allow-builds` IPC (exposed as `pluginAuthorizeBuilds` on the preload bridge) performs the write. On a failed install with pending keys, the manager shows a warning, the exact keys, and an "authorize build script and retry install" button that authorizes then re-runs the add.

## Alternatives considered

**Fix only `harnessHome()`.** Rejected because the environment variable stays polluted for every later reader, not just plugin management; fixing the restore is the root cause and the home guard is defense in depth.

**Parse the `Ignored build scripts:` warning instead of the hint block.** Rejected because that warning accompanies a non-fatal path where the install may "succeed" without running scripts. The fatal `GIT_DEP_PREPARE_NOT_ALLOWED` error carries the authoritative depPath key in its hint, which is what pnpm accepts verbatim.

**Drive `pnpm approve-builds` interactively.** Rejected because the desktop runs pnpm via `spawnSync` without a TTY and the command is interactive; writing `pnpm-workspace.yaml` is the same file-level change pnpm makes and stays scriptable.

## Consequences

Plugin management no longer depends on the host's environment-variable restore: a fresh install or overwrite launch adds plugins immediately. Git-hosted plugin installs now guide the user through authorization and retry in the UI instead of dead-ending on a raw pnpm error, with a visible warning that authorizing executes the package build code on their machine. The authorization only touches the profile's `pnpm-workspace.yaml`; no other configuration changes.