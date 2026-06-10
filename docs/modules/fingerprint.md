# `src/workspace/fingerprint.ts` — workspace fingerprint

## Purpose

Compute a single hash for the workspace as a whole, folded into every
task's cache key. Lets a lockfile bump or workspace-shape change
invalidate every cached entry at once.

## Public surface

```ts
export function computeWorkspaceFingerprint(workspaceRoot: string): Promise<string>
```

Returns a hex sha256.

## Files folded in

Whichever of these exist at the workspace root, in this fixed order:

| File                  | Why                                      |
| --------------------- | ---------------------------------------- |
| `pnpm-lock.yaml`      | pnpm resolved deps                       |
| `package-lock.json`   | npm resolved deps                        |
| `npm-shrinkwrap.json` | npm published lock                       |
| `yarn.lock`           | yarn resolved deps                       |
| `bun.lock`            | Bun resolved deps (text format)          |
| `bun.lockb`           | Bun resolved deps (binary legacy format) |
| `pnpm-workspace.yaml` | workspace shape                          |

Missing files are skipped (not all workspaces use every manager). The
fixed declaration order gives a deterministic fingerprint regardless of
filesystem traversal order.

Per-project `package.json` is **NOT** folded in here — that's
[`execute-task.md`](./execute-task.md)'s
`hashProjectPackageJson` (a separate `projectPackageJsonHash` field
of `CacheKeyInput`).

## Algorithm

```ts
const h = new Bun.CryptoHasher('sha256')
for (const f of FILES) {
  if (file at <root>/<f> exists) {
    h.update(`${f}\0`)
    h.update(<bytes>)
    h.update('\n')
  }
}
return h.digest('hex')
```

The filename prefix prevents collisions between two files that happen
to have the same byte content but different roles.

## What this does NOT do

- **Doesn't read inside `node_modules/`.** The lockfile contains the
  resolved version set; that's the source of truth for "did the
  dep tree change?"
- **Doesn't hash arbitrary root-level files.** Workspace-level
  `globalInputs` is a deferred feature.

## Tests

`tests/orchestrator.test.ts` indirectly covers this — a lockfile edit
invalidates every cached entry in the e2e fixtures. The fingerprint
itself doesn't have a dedicated unit-test file.

## Adding a new fingerprint source

1. Add the filename to `WORKSPACE_FINGERPRINT_FILES`.
2. Bump `CACHE_VERSION` (presence of that file changes cache keys
   for affected workspaces).
3. Update `docs/caching.md` § History.
