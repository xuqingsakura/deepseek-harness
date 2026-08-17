# Agent Note: Desktop CI materializes the host closure with pnpm deploy

Status: implemented

English | [中文](2026-08-17-desktop-ci-closure-deploy.zh.md)

## Problem

`package.mjs` assumed the deployed host closure (`apps/desktop/out/runtime/host-deploy`) already existed, so a clean CI tree failed at "deploy runtime closure" (`runtime closure not found`). The closure had only ever been produced by an ad-hoc local `pnpm deploy`, leaving the release workflow unable to build the installer.

## Decision

- `package.mjs` materializes a missing closure before refreshing it: `pnpm --filter @deepseek-ai/dsh-desktop-host-pkg deploy --legacy --prod` with the hoisted linker, `link-workspace-packages`, `confirm-modules-purge=false`, and `CI=true` (pnpm skips non-TTY purge prompts under CI). The target is removed first because pnpm deploy refuses a non-empty directory.
- `deploy-runtime.mjs` stages the `@deepseek-ai/dsh` bin package from `apps/cli` when a fresh deploy skipped it (pnpm skips bin-only workspace packages in legacy deploy), and prunes the vendored `pnpm` the legacy deploy copies into the closure from the source package dir — it ships separately via electron-builder `extraResources`, so the copy is ~110 MB of pure duplication.

## Consequences

A clean-tree build (CI) now packages end-to-end: `pnpm install` → `build:lib:host` → `package:desktop`. The closure no longer carries a duplicated vendored pnpm, keeping the installer close to its previous size. Local rebuilds that already have a closure skip the deploy step.

## Alternatives considered

- Pre-seed the closure in CI via a cache. Rejected: the closure is a large build artifact; generating it from the pnpm store on each run is simpler and cache-restores add their own cost.
- Teach `deploy-runtime.mjs` to run the deploy itself. Rejected: the deploy belongs with the package orchestration, and staging the dsh bin package stays a deploy-runtime concern (it owns the closure layout).
