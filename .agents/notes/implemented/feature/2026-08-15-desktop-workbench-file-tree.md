# Agent Note: Desktop workbench — session-scoped file gateway and file tree

Status: implemented

English | [中文](2026-08-15-desktop-workbench-file-tree.zh.md)

## Problem

The desktop app's official UI had no human-facing file surface: the workspace browser lists sessions, deliverables lists produced files, but nothing browses the session's working directory, opens a file, or saves edits. The first slice of the workbench (P0-1, plan confirmed with the user) is a session-scoped file tree plus a read-only text viewer, built to VSCode-like workbench ambitions (editor, terminal, Git, jobs panel later).

## Decision

Two new packages, wired through the official Remote seam instead of new HTTP routes:

- `@deepseek-ai/dsh-host-workbench` — a `TypertRemoteService` gateway (`ctx.remote.workbench`) exposing `cwd`, `listDir`, `readText`, `writeText`, all session-scoped (the session header's `cwd` resolves relative paths) and riding the mounted `ctx.fs` so file access inherits realpath identity, atomic mutation, version guards, and the sandbox policy. Text reads run through a 1 MiB window (oversize files return the leading window via `streamText`), binary files are NUL-probed and reported, and version-supplied writes are guarded.
- `@deepseek-ai/dsh-client-ui-workbench` — the browser half: a session-header toggle (`conversation.session.header.actions`) opens a right-hand panel in the shell overlay (`shell.overlay`) bound to that conversation. The file tree is lazy (root on mount, one level per expansion), and the viewer reports explicit binary/truncated/empty/failed states. One state handle is created in the plugin body and shared by both registrations through their slot inject closures — the slot store seat cannot share one handle across two scopes.

`@deepseek-ai/dsh-api-remotes` assembles the generated workbench Remote client (`import workbenchRemote from '@deepseek-ai/dsh-host-workbench/remote'`) and re-exports the wire types, so client plugins get `ctx.remote.workbench` with full types. The web-app patch layer mounts both rows (`workbench`, `ui-workbench`).

## Alternatives considered

**Open `/workbench` HTTP routes like dsh-better-sidebar does.** Rejected: the official Remote + Typert pipeline gives typed client calls, the trust fence, and the in-process desktop carrier for free, and keeps the workbench on the same seam as every other host capability.

**Reuse the slot store seat for the shared open/session/file state.** Rejected: `ui-slots` forbids one store handle under two scopes, and the toggle and panel live in different slots; an apply-created handle passed through inject closures is the documented pattern for that shape.

## Consequences

The desktop (and web) surface gains a right-hand file workbench: open the bound session's cwd, expand directories lazily, open a text file in a read-only viewer. The host gateway is the single file face later slices extend — the editor (P0-4) adds write-through and multi-tab on the same `writeText`/`readText` Remote, and previews (P1-2) reuse `readText`/media reads. No model-facing behavior changed: nothing here reaches a prompt, message, schema, stream, or tool result.