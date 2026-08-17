# Agent Note: Desktop pwsh tool returns empty output under the in-process host

Status: implemented

English | [中文](2026-08-17-desktop-in-process-sandbox-runner-electron.zh.md)

## Problem

On the packaged Windows desktop app, the pwsh tool returned an empty result for every command: no stdout, no stderr, and no exit marker (the run settled as exit 0 with `(no output)`). Minimal commands such as `Write-Output "HELLO_MARKER_12345"` produced nothing, while read/glob/grep/write/edit file tools worked normally. Direct command-line testing of powershell.exe, pwsh.exe, and the windows-acl runner all succeeded, so the failure was specific to the packaged Electron host.

## Root cause

The desktop boots the harness in-process by default (A3, `startHostInProcess`), so the host runs inside the Electron main process where `process.execPath` is `DeepSeek Harness.exe`, not `node.exe`. The windows-acl sandbox runner invocation is `[process.execPath, runner.js, ...]` (`windowsAclRunnerInvocation` in `dsh-sandbox-local`). Spawning the Electron executable without `ELECTRON_RUN_AS_NODE=1` starts it as a GUI application; the app's single-instance lock (`requestSingleInstanceLock`) makes the second instance exit immediately with status 0 and no output, so the runner never executed and the confined pwsh never ran. Every sandboxed command on the desktop hit this path, which is why pwsh (and any future windows-acl-confined tool) looked alive but produced nothing.

## Decision

In `packages/subprocess/subprocess-local/src/spawn.ts`, `spawnSubprocess` now detects when the spawned program is the current process's own executable under Electron (`process.versions.electron` plus `process.execPath`) and adds `ELECTRON_RUN_AS_NODE=1` to the child environment. Electron then executes `runner.js` as a plain Node script (verified on the user's machine: the runner ran, koffi loaded, and the confined powershell.exe printed the expected marker). The same spawn also applies `windowsHide` on Windows. That alone was not enough: the runner's confined child would still create its own console window because the runner has no console to inherit. `spawnSandboxedInherited`/`spawnSandboxed` in `dsh-sandbox-windows-acl` now add `CREATE_NO_WINDOW` to the `CreateProcessAsUserW` creation flags, so the confined PowerShell runs windowless too. The POC-era `STATUS_DLL_INIT_FAILED` (0xC0000142) warning applied only when the S-1-2-1 console logon SID sat in the restricting list; the shipped lists omit it and the flag is verified usable (output, stderr, and workspace writes all work, including UTF-8 Chinese under workspace-write). `SpawnInternals` gains an `electronSelfExec` test seam so plain-node test hosts can exercise the flag; two tests in `spawn.spec.ts` pin the behavior.

## Alternatives considered

- Bundle a real `node.exe` in the installer and point the runner at it. Rejected: it grows the installer and the build already omits node.exe for size (the child-host mode explicitly documents this).
- Resolve a system node from PATH. Rejected: the desktop must not depend on a user-installed Node; `ELECTRON_RUN_AS_NODE` reuses the runtime the app already ships.
- Set `ELECTRON_RUN_AS_NODE` for every child process. Rejected: it is only correct when the program is the Electron executable acting as a Node runtime.

## Consequences

Sandboxed commands (the pwsh tool) work again on the packaged desktop, and each command no longer flashes a console window. The flag is harmless for non-Electron binaries, and the guard is limited to spawning the app's own executable, so unrelated child processes are unaffected. The subprocess service now has a documented Windows/Electron behavior worth keeping in mind for any future self-exec spawn.
