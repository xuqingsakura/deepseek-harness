# Agent Note: Workbench split into an installable plugin

Status: implemented

English | [中文](2026-08-17-desktop-workbench-plugin-split.zh.md)

## Problem

The desktop shipped the workbench (file tree, editor, Git, terminal, tasks) hard-wired into the web-app bundle: both the host gateway (`dsh-host-workbench`) and the UI (`dsh-client-ui-workbench`) were inserted by web-app's patch layer, so every desktop install carried the workbench regardless of use, and the sidebar's activity bar always showed a workbench view-switch icon.

## Decision

Turn the workbench into an installable plugin and restore the desktop to its pre-workbench state by default:

- **Plugin**: a new patch-only bundle `apps/desktop/plugins/dsh-workbench` (package.json declaring `dsh.bundle.patch` + cordis.patch.yml) mounts the two existing workbench packages as entries. The packages still ship in the runtime closure (web-app keeps them as dependencies), so the profile's flat fallback node_modules keeps them resolvable; the plugin itself has no code.
- **Desktop default**: web-app's patch layer no longer inserts `workbench`/`ui-workbench`, so a fresh desktop has no workbench toggle, no workbench sidebar region, and the layout stays in the conversation view.
- **Sidebar**: the activity-bar workbench icon was removed; the workbench opens from the session-header "Workbench" button the plugin registers.
- **Distribution**: electron-builder ships the plugin at `resources/plugins/dsh-workbench`; the plugin manager installs it from that local path.

The workbench layout seats (sidebar.workbench / workbench.viewer / workbench.bottom in ui-sidebar / ui-layout) stay in the core shell — they are inert without a registered occupant and are what the plugin registers into.

## Consequences

A default desktop no longer shows or loads the workbench. Installing dsh-workbench (Settings → Plugins, local path) reactivates it with the latest bundled code. The split is fork-local: the layout seats this plugin depends on are not part of upstream, so the plugin does not function on an unmodified official desktop.

## Alternatives considered

- Self-contained plugin bundling the workbench code: heavier, and still cannot supply the missing layout seats on an official desktop, so it buys nothing for third-party installs.
- Keeping the workbench default-on and only adding the plugin as an alternative: does not satisfy "desktop restores its pre-workbench state".
- **Activity-bar icon restored (conditional)**: the sidebar now shows the workbench view icon only while the workbench seat has a registered occupant. ui-sidebar queries `ctx.slots.entries('sidebar.workbench')` and subscribes to its slot mutations, so installing the plugin brings the icon back (and uninstalling removes it) without a restart of the shell — a fresh session can open the workbench from the activity bar immediately, without chatting first.
