# `src/workspace/lockfile.ts` — vx-lock.json

## Purpose

`vx lock` freshly evaluates every project config and freezes
`{ configPath, configHash, config }` per project into `vx-lock.json`.
`vx run --frozen` loads configs FROM the lock (hash tripwire, zero
eval); `vx lock --check` re-evaluates and deep-compares to catch
env-drift the hashes can't see.

## Invariants

- Deliberate asymmetry: runs TRUST the lock (hash-only check); only
  `--check` pays full re-evaluation.
- Stale file / missing entry under `--frozen` is a hard `UserError` —
  never a silent fallback to evaluation.
- `vx-lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).
