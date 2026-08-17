# Agent Note: Desktop runtime closure pruned of dead packages

Status: implemented

English | [中文](2026-08-16-desktop-runtime-closure-prune.zh.md)

## Problem

The packaged desktop shipped a 648MB unpacked app (host runtime 189MB, 19.7k
files) whose NSIS install took ~10 minutes and whose first launch was slowed by
Defender scanning tens of thousands of small files.

## Decision

Extend the deploy-time closure prune in
`apps/desktop/scripts/deploy-runtime.mjs` to remove packages with no runtime
importer in the web profile (verified by scanning every shipped JS module):
test toolchains (`vitest`, `@vitest`, `@testing-library`, `rollup`,
`@rollup`), the dev TS runner (`tsx`, `esbuild`, `@esbuild`),
dropped-provider deps (`@google`, `@agentclientprotocol`), and
test-support / non-web-profile packages (`dsh-acp*`, `dsh-headless`,
`dsh-e2b*`, `dsh-subagent-acp`/`-dsh-sdk`/`-codex`). The prune also
strips the remaining debug artifacts (`.d.ts`, `.map`, `.tsbuildinfo`).

## Consequences

The host closure dropped from 189MB/19,713 files to 126MB/15,030 files,
shrinking the installer and reducing install time and first-launch scan cost.
`@deepseek-ai/dsh-attachment-local` still ships `sharp` (image
attachments) and the client markdown stack still ships `katex`/`@shikijs`
— those are real runtime dependencies and stay.

## Alternatives considered

- **Ship the full closure unchanged** — zero risk of a missing runtime
  module, but the 648MB unpacked app and ~10-minute installs were the problem
  this note exists to solve. Rejected.
- **Prune more aggressively (drop katex/@shikijs/sharp)** — would shrink the
  closure further, but those are real runtime importers (markdown rendering,
  image attachments); dropping them breaks features. Rejected: the prune keeps
  anything with a verified importer.
