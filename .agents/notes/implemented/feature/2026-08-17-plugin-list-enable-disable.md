# Agent Note: Enable/disable external plugins from the Plugin list tab

Status: implemented

English | [中文](2026-08-17-plugin-list-enable-disable.zh.md)

## Problem

The Plugins settings "Plugin list" tab (`PluginInventorySettingsTab`) is a read-only catalog of the Loader inventory: every row only shows an Enabled/Disabled configuration tag and a Cordis phase. A plugin the user had disabled (e.g. whale-girl) could not be re-enabled from this list, and the only management surface (Desktop plugin management) lives on a separate tab, so disabled plugins appeared unreachable.

## Decision

The catalog now detects the desktop Electron bridge (`window.dshDesktop`), loads the installed external plugin list via `pluginList()`, and keys it by package name. For each inventory row whose `moduleName` matches an installed external plugin, the expanded card details gain an Enable/Disable button that calls `pluginSetEnabled(name, !enabled)`, updates the local map, and re-reads the Loader inventory so the row reflects the new state. Browser builds have no bridge and stay read-only, matching the existing `DesktopPluginManager` pattern.

## Consequences

Users can toggle external plugins directly from the Plugin list tab without switching to the desktop plugin manager. The bridge failure path keeps the catalog read-only rather than breaking the list, and the busy state disables the button while the toggle is in flight.

## Alternatives considered

- Route every enable/disable through the existing desktop manager tab. Rejected: the user expectation is to act where the state is shown, and the two tabs render independent surfaces.
- Surface the toggle only in the card trailing row. Rejected: the row is a single disclosure button; nesting another button inside it would violate HTML interactive-content rules, so the action lives in the expanded details.
