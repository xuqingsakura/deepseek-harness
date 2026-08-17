# Agent Note: Desktop plugin install inherits the user proxy

Status: implemented

English | [中文](2026-08-15-desktop-plugin-proxy-inheritance.zh.md)

## Problem

GitHub-hosted plugin installs from the desktop Settings -> Plugins manager intermittently failed with `ECONNRESET`/`ETIMEDOUT` reaching github.com even though the browser could open GitHub. The browser follows the system (WinINET) proxy; the desktop spawns pnpm, whose own HTTP client ignores both the system proxy and git's `http.proxy` config, so the fetch went direct and the connection reset killed it. git itself worked because it reads the global `http.proxy`, which made the failure look like a repository problem.

## Decision

`apps/desktop/src/plugin-manager.ts` resolves the proxy once per plugin operation. Explicit `HTTPS_PROXY`/`HTTP_PROXY` environment variables win; otherwise the installer reads the user's global git proxy (`git config --global https.proxy` / `http.proxy`) — the one place a desktop user has already configured the route. The resolved proxy is written into the profile `.npmrc` as `http-proxy`/`https-proxy`/`no-proxy` (pnpm's own HTTP client reads these) and passed to the spawned pnpm/git subprocess as `HTTP(S)_PROXY`/`ALL_PROXY` env variables (git reads these). When the proxy came from git config, `no-proxy` keeps `127.0.0.1,localhost` so a local registry mirror is never proxied. With no proxy configured anywhere, behavior is unchanged (direct).

## Alternatives considered

**Write only npmrc proxy lines.** Rejected because pnpm's git fetcher spawns the system `git`, which reads env variables and its own config rather than the profile `.npmrc`; the env pass-through covers that layer.

**Read the system (WinINET) proxy directly.** Rejected because it adds registry plumbing, and the user's git config is the existing, explicit signal of where desktop CLI-style traffic should go.

## Consequences

GitHub plugin installs now follow the same route as the browser when the user has a proxy in env or git config, removing flaky direct-connection failures. The profile `.npmrc` is rewritten on each operation, keeping only the installer-managed lines (update-notifier, registry, proxy), so a proxy that disappears is removed on the next install. A dead proxy still surfaces as a pnpm error in the UI.