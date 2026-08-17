# Agent Note: Desktop shell hardening — browse picker pin, stable origin, crash and link handling

Status: implemented

English | [中文](2026-08-14-desktop-shell-hardening.zh.md)

## Problem

Three desktop-shell defects surfaced after the in-process host (A3) landed:

- **The workspace directory picker is broken.** The web profile's `directory-picker-auto` row resolves to the native Win32 chooser on a loopback bind, and `win32-dialog-host.ts` spawns its worker with `process.execPath` — the Electron binary under the in-process host — so the worker can never report and the UI shows "win32 folder dialog worker exited before reporting a result".
- **The renderer origin changes every launch.** The in-process webServer binds `--port 0`, so the renderer URL is `http://127.0.0.1:<random>` each run. localStorage is origin-keyed (port included), so the web UI's persisted stores (`dsh.sessions.current`, `dsh.conversation.chat`, `dsh.workspace.view.v5`, `dsh.trajectory.duration`) reset on every launch and stale origin entries accumulate in `%APPDATA%\dsh-desktop\Local Storage`.
- **No renderer-crash or external-link handling.** A renderer crash leaves a white window with no recovery, and `target=_blank` links open second frameless windows inside the app.

## Decision

- **Pin the browse directory picker.** `apps/desktop/assets/desktop-browse-picker.yml` disables the `directory-picker` (auto) row and inserts the `directory-picker-browse` backend + `ui-directory-picker-browse` surface. `host-in-process.ts` passes the overlay to `composeProfile`, so it rides the standard `--patch` overlay path (same mechanism as `apps/web/tests/pin-browse-picker.overlay.yml`). The child-host fallback gets the same `--patch` argument. The in-process host now reports the resolved picker (`directoryPicker`) and the smoke asserts `picker=browse`.
- **Stable loopback port.** `host-in-process.ts` exports `pickLoopbackPort()`: try `17890`, then `17891`, `17892`, else an OS-assigned port. The chosen port goes into the web cmdline for both the in-process and child hosts, so the renderer origin — and localStorage — is stable across launches unless the port is taken.
- **Renderer-crash and navigation hardening.** `createMainWindow` auto-reloads once after `render-process-gone` (a second crash within 10 s notifies instead of reload-looping), `setWindowOpenHandler` denies new windows and opens http(s) links in the system browser, and `will-navigate` blocks leaving the host origin.

## Alternatives considered

- **Fix the native worker spawn** (resolve a real `node.exe` for `process.execPath` under Electron) — keeps the OS folder dialog, but the packaged installer pruned `node.exe` for size, and koffi's ABI story under Electron is fragile. The browse picker runs entirely in the renderer and is the web app's own supported non-loopback path.
- **Serve the renderer from a custom protocol** to fix the origin without a fixed port — larger change with no benefit over a preferred fixed port plus fallbacks.

## Consequences

- The desktop always uses the in-app browse directory picker; the native Win32 folder dialog (and its `koffi` dependency) is unused by the desktop but stays for `dsh web` under real Node.
- With a free `17890`, the renderer origin is stable and localStorage persists across launches; a taken port falls back (that launch's UI prefs are ephemeral again, data is unaffected).
- Web-version homes migrate by copying `sessions/`, `settings.yaml`, `.credentials.yaml`, and `storages/` into the packaged home; an empty/missing `storages/workspace.json` makes the workspace registry re-bootstrap and adopt copied sessions automatically (verified: `session-5b3a4247` → 修仙app workspace).
