# `src/workspace/lockfile.ts` — vx-lock.json

## Purpose

`vx lock` freshly evaluates every project config and freezes
`{ configPath, configHash, config }` per project into `vx-lock.json`.
`vx run --frozen` loads configs FROM the lock (zero eval, no staleness
check of its own); `vx lock --check` reports changed files from the
stored hashes and re-evaluates to catch env-drift the hashes can't
see.

## Public surface

```ts
export const LOCKFILE_NAME = 'vx-lock.json'
export const LOCKFILE_VERSION = 1

export interface LockfileEntry {
  configPath: string // root-relative, posix
  configHash: string // for `--check`'s file-changed report
  config: ProjectConfig // the validated object, as evaluated by `vx lock`
}
export interface Lockfile {
  version: number
  projects: Record<string, LockfileEntry> // by project name
}

export function lockfilePath(root: string): string
export const FROZEN_WITHOUT_LOCK: string // the `--frozen` refusal when no lock exists
export async function readLockfile(root: string): Promise<Lockfile | null>
export async function writeLockfile(root: string, lock: Lockfile): Promise<void>
export async function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; configPath: string }>,
  root: string,
  store?: ConfigEvalStore, // remembers validated entries across runs
): Promise<ProjectConfig[]>
```

`frozenProjectConfigs` is what a `--frozen` load serves instead of an
evaluation: an entry missing for the project, or one whose stored path
is not the project's, is a `UserError` naming the project and the
remedy. Each entry is validated as a loaded config is; with a `store`
the verdict is kept beside the config evaluations, keyed by the lock's
bytes, the project, and vx's and Bun's versions, so a warm run on an
unchanged lock does not validate again (1,000 projects: ~30 ms). A
refusal is never kept, and a lock not read by `readLockfile` has no
bytes to key by. The CLI's own selection load (`loadCliProjects`, what a filter
that walks the graph stages) reads the lock the same way under
`--frozen`, so the selection and the run see one graph.

## Invariants

- Deliberate asymmetry: `--frozen` runs TRUST the lock outright — a
  config edited since `vx lock` runs as locked (owner, 2026-06-13: a
  byte-hash re-check cannot see import closures or env, so it would be
  a weaker guarantee pretending to add safety); only `--check` pays the
  full re-evaluation, and the CI recipe is `vx lock --check && vx run
--frozen`. `configHash` exists for `--check`'s file-changed report.
- A missing entry (or a missing lock) under `--frozen` is a hard
  `UserError` — never a silent fallback to evaluation. An entry under
  another path (a config renamed or moved) names both paths (D-88).
- `writeLockfile` writes a temp file beside the lock and renames it over
  the lock, so a reader sees the old lock or the new one, never a
  truncated one. A write in place truncated first, and a `--frozen` run
  or `vx watch --frozen` woken by the write could read the lock empty
  (item 972).
- `--check` refuses at least what `--frozen` refuses: a project with no
  entry, or an entry whose stored path is not the project's (a config
  renamed with its bytes unchanged), and it also names a locked project
  that no longer has a config. It compares a fresh evaluation in the
  lock's JSON form, so a field a config leaves `undefined` is not drift.
  An unknown argument exits 1 before anything is read or written.
- `vx-lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).
