# @deepseek-ai/dsh-client-ui-workbench

English | [中文](README.zh.md)

Workbench UI plugin, browser half: a session-header toggle switches the layout into the file-workbench view — a tabbed left sidebar (file tree / terminal / Git / background tasks), a CodeMirror editor in the center column, and the conversation moving to the right column — backed entirely by the session-scoped workbench Remote (`ctx.remote.workbench`), which in turn rides `ctx.fs`, child processes, and the system `git` binary on the host.

The header toggle registers into `conversation.session.header.actions` and binds the view to that conversation; the sidebar panel registers into `sidebar.workbench` and the center-column editor into `workbench.viewer`. One state handle (created in the plugin body, never module-level) is shared by the registrations through their slot inject closures, so the toggle, the sidebar, and the editor agree on open state, bound session, active file, and selected sidebar tab without the slot store seat (which forbids one handle across two scopes). The layout swaps the center and right column roles while the workbench view is active, so the conversation keeps its React identity across the swap.

The file tree is lazy: the root lists on mount or session/cwd change, each directory expands on click, caches its listing, and collapses on a second click. A right-click context menu creates files and folders, renames, and deletes through the gateway filesystem verbs, refreshing the affected listing afterwards. Code files open in the CodeMirror editor with syntax highlighting, line numbers, search, and a version-guarded save (Ctrl+S or the header button); Markdown files render through MarkdownText. The tab bar supports right-click batch close (this/others/all), and tab switches or closes warn before discarding unsaved edits. The terminal panel keeps persistent PowerShell (Windows) or bash shells per session as tabs — spawn new ones with "+", clear output, and recall per-terminal command history with Up/Down. The Git panel shows a VSCode-style staged/unstaged/untracked change list with a per-line highlighted unified diff, stage/unstage/discard per file, stage-all/discard-all, fetch/pull/push, a commit composer, branch switching, and a recent-commit history list. The tasks panel lists the session's background `ctx.jobs` records with live durations.

## Model Experience

None, as the workbench renders host filesystem/process/repository state for a human; nothing reaches a model request.

#### KV Cache effect

None; the package never assembles or sends a provider request.

## Known Limitations and Deferred Work

- **Pipe-backed terminal** — the shell runs without a PTY, so full-screen interactive programs are unsupported; command-driven workflows are the target.
- **Git panel is read-mostly** — no push/pull/fetch, merge conflict resolution, or commit history detail view yet; status, diff, commit, and branch switching are the first slice.
- **No workspace picker inside the panel** — the tree always browses the bound session's cwd; picking a different directory belongs with the workspace flow.
- **Both columns resize by drag while the workbench is open** — the tree column reuses the sidebar drag handle (264–720px) and the right conversation column reuses the details handle (300–520px).