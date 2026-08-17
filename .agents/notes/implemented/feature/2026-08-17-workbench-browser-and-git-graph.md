# Agent Note: Workbench embedded browser and VSCode-style Git commit graph

Status: implemented

English | [中文](2026-08-17-workbench-browser-and-git-graph.zh.md)

## Problem

The workbench Git panel listed recent commits as a flat text history with no topology, and the workbench had no way to open a web page alongside the file tree and conversation.

## Decision

- **Git commit graph**: the host `gitLog` command now requests parent hashes (`--pretty=format:` gains `%P`) and `WorkbenchGitLogEntry` carries `parents`. A new dependency-free layout function `git-graph.ts` (`buildGitGraph`) computes a lane-based graph (node columns, continuing edges, merge detection) as a pure function of the newest-first commit list, and the Git panel renders the history as a VSCode-style graph: lane dots and edges, abbreviated hash, message, merge tag, and author.
- **Embedded browser**: the workbench sidebar gains a "Browser" tab whose center-column view is `WorkbenchBrowserPanel` — an address bar (back/forward/reload/home), URL normalization (`normalizeBrowserUrl`: bare domains and localhost get https://, explicit schemes pass through, ports are not mistaken for schemes), and an embedded iframe. The URL lives in the shared workbench state handle so the panel survives tab switches.

## Consequences

The Git history now shows branch/merge topology at a glance, and a developer can browse docs or a local dev server without leaving the workbench. The browser is an iframe, so sites that forbid framing render a blank frame with the address bar still usable.

## Alternatives considered

- A full Electron `<webview>`/BrowserView panel: would require enabling `webviewTag` (a security-surface change) and does not work in the web client bundle tests. Rejected for the P2 milestone: the iframe covers documentation and local-server browsing, and the address bar is independent of frame content.
- Rendering the graph purely in CSS from commit metadata: no parents meant no topology; the host-side `%P` change is the minimal data addition that makes a graph possible.
