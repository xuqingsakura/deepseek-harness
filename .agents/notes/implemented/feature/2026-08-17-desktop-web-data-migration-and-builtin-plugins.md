# Agent Note: Web-data migration tool and one-click built-in plugin install

Status: implemented

English | [中文](2026-08-17-desktop-web-data-migration-and-builtin-plugins.zh.md)

## Problem

Moving from the Web version to the desktop shell meant hand-copying the Web harness home (~/.dsh) into the desktop home, with no guidance about what was safe to overwrite. Separately, the bundled workbench plugin shipped inside the app, but installing it from Settings → Plugins required typing its local path by hand.

## Decision

Add a dependency-free migration module and a one-click install surface for bundled plugins:

- **Migration module**: `apps/desktop/src/migrate-web-data.ts` copies conversation sessions and merges storage records from a Web harness home into a target home without ever overwriting data the target owns. Sessions are copied only when the target lacks that session directory (an existing id is skipped unless `--force`); `storages/*.json` merge key-by-key with the target's keys winning; `settings.yaml` / `.credentials.yaml` are never migrated unless explicitly opted in and only when the target file is absent; `.anonymous-user-id` copies only when the target has none. `--dry-run` reports the plan without touching anything and `--json` emits a machine-readable report.
- **CLI**: `apps/desktop/scripts/migrate-web-data.mjs` runs the same module from the command line (source default `~/.dsh`, target default the desktop home).
- **GUI**: Settings → About & Updates gains a "Import data from Web version" block (preview import, start import, settings/credentials toggles, result counts) that drives the module over IPC `dsh:migrate-web-data`.
- **Built-in plugins**: `plugin-manager.ts` gains `listBuiltinPlugins()` / `installBuiltinPlugin()`, scanning `resources/plugins` (dev: `apps/desktop/plugins`) for directories declaring `dsh.bundle.patch`. Settings → Plugins shows a "Built-in plugins" block that installs each with one click (`file:` spec, no path typing), reusing the official profile-plugin flow.

## Consequences

A Web-version user can move conversations, workspaces, and settings into the desktop in one guided step, and the bundled workbench/skin plugins install without manual path entry. The migration never destroys desktop-owned data by default, so running it against an already-populated desktop is safe.

## Alternatives considered

- Full home-copy (sessions + settings + credentials + profiles): overwrites the desktop's own data and drags in the Web profile's runtime node_modules. Rejected: the merge-without-overwrite semantics above are safer and faster.
- A separate migration binary instead of a desktop IPC + CLI pair: the module stays reusable from both entry points with one implementation, so a separate binary adds packaging weight for no benefit.
