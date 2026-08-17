# Agent Note: Heal of the profile module fallback is stamped and skipped warm

Status: implemented

English | [中文](2026-08-16-desktop-heal-stamp-cache.zh.md)

## Problem

Every launch ran `healProfilesModuleFallback`: a BFS over the installation's
entire dependency closure (reading each package.json) plus a symlink check for
every linked package. On the desktop that is thousands of filesystem calls per
startup in the main process before the window shows.

## Decision

Record a stamp file (`profiles/node_modules/.dsh-heal-stamp`) after a
successful heal. The stamp holds a SHA-256 of the install anchor path plus the
direct dependency/peer set of the installation manifest. A warm boot with a
matching stamp returns immediately (measured ~40x faster: 638ms → 15ms for
profile composition); a changed path (reinstall/move) or changed direct
dependencies invalidates it and re-heals. Transitive-only changes are not
tracked — the desktop's packaged closure is immutable between installs, so
links cannot drift.

## Consequences

Cold boots still heal and stamp; warm boots skip the closure walk. The
tradeoff is documented in the signature helper: a deleted link after a heal is
not repaired until the signature changes (acceptable for the immutable
desktop closure; CLI users can delete the stamp to force a re-heal).

## Alternatives considered

- **Re-heal on every launch** — the pre-stamp behavior; correct by construction
  but costs the full closure BFS and per-link junction checks each startup
  (measured 638ms just for profile composition). Rejected because the desktop
  closure is immutable between installs, so a warm skip cannot drift.
- **Stamp the install path only** — cheaper but cannot invalidate when the
  manifest's direct dependency set changes after an in-place upgrade.
  Rejected: a path-only stamp could skip a heal that a changed install needs.
