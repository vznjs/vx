# `src/workspace/fingerprint.ts` — workspace fingerprint

## Purpose

Compute a single hash for the workspace as a whole, folded into every
task's cache key. Lets a lockfile bump or workspace-shape change
invalidate every cached entry at once.

## Public surface

```ts
export const WORKSPACE_FINGERPRINT_FILES: readonly string[] // the table below, in order

export interface WorkspaceFingerprints {
  readonly all: string // over every file present
  readonly unclaimed: string // over the files no plugin claims
  readonly files: ReadonlyMap<string, Uint8Array> // the bytes folded, by file name
}

export function computeWorkspaceFingerprint(
  workspaceRoot: string,
  reads?: LoadReads,
): Promise<string>
export function computeWorkspaceFingerprints(
  workspaceRoot: string,
  claimed: ReadonlySet<string>,
  reads?: LoadReads,
): Promise<WorkspaceFingerprints>
```

Every file goes through the load's `reads` (workspace.md), so the
`pnpm-workspace.yaml` discovery already read is folded from those bytes
rather than probed and read a third time.

Both return 16 hex characters of seed-chained xxh3. The second also hands
back the bytes it folded (`files`), already in memory for the fold: the
run keeps them so a mid-run check can say which file a task rewrote
(`orchestrator/fingerprint-watch.ts`,
[`fingerprint-watch.md`](./fingerprint-watch.md)). The second reads each
file once and folds two digests: `all` over every file present, and
`unclaimed` over the files no plugin claims. `prepareRun` keys the
config-evaluation cache on `all` (a config may import a dependency the
lockfile resolved) and every task key on `unclaimed`. A claimed file
leaves the key digest entirely, name included — a fold of "present"
would still re-key the workspace the first time the file appeared.

## Claiming a file (`VxPlugin.fingerprint`)

A plugin that reads a lockfile and keys each project on its own
dependency closure declares `fingerprint: { files: ['pnpm-lock.yaml'],
affected(change, ctx) }`. The schema refuses a name this module does
not fold (nothing to take out) and a second claimant for one file.
`fingerprintClaims(plugins)` in `plugin-host.ts` indexes the claims;
`--affected` (`workspace/affected.ts`) asks the claimant's `affected`
with the file's bytes at the base ref and in the working tree, and
selects the projects it names instead of every project — `undefined`
("cannot tell") widens exactly as an unclaimed file does. `vx watch`
needs nothing: it still re-runs on the file, and the keys decide.
`@vzn/vx-lockfile` (`pnpm()`, `bun()`, `npm()`, `yarn()`) are the claimants, both over the shell in
[`lockfile-claim.md`](./lockfile-claim.md).

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
| `pnpm-workspace.yaml` | workspace shape, pnpm catalogs           |
| `.yarnrc.yml`         | Yarn 4 catalogs, install settings        |

`.yarnrc.yml` is here because `yarn.lock` does not say what a catalog
names: a workspace's `catalog:` dependency is recorded as that literal,
and a real Yarn 4.18.1 install that flipped the catalog `^6 → ^7`, both
ranges already resolved, rewrote not one byte of `yarn.lock` while the
workspace's `node_modules` moved to 7 (turborepo#12635). No plugin
claims it: `yarn()` keys each workspace on every entry of a catalog's
package, and which one the catalog names is this file's to say.

Missing files are skipped (not all workspaces use every manager). The
fixed declaration order gives a deterministic fingerprint regardless of
filesystem traversal order.

Per-project `package.json` is **NOT** folded in here — that is the
project's own digest in [`task-hash.md`](./task-hash.md) (a separate
`projectPackageJsonHash` field of `CacheKeyInput`). Deliberately absent
too: `vx.workspace.{ts,mts,js,mjs}`. Everything it can declare —
`concurrency`, `cacheDir`, `timeout`, the plugin list — is placement,
storage or observability, never what a command produces; folding it
would split the cache between a laptop declaring the local plugins and
a CI runner declaring `reapi()`, the `NODE_OPTIONS` non-goal from the
other side. A per-task input that genuinely varies belongs in
`cache.inputs`.

## Algorithm

```ts
let h = 0n
for (const f of FILES) {
  if (read <root>/<f> succeeds) {
    h = xxh3(`${f}\0`, h)
    h = xxh3(<bytes>, h)
  }
}
return h.toString(16).padStart(16, '0')
```

The filename prefix prevents collisions between two files that happen
to have the same byte content but different roles. Each candidate costs
one `open`: the read's ENOENT (or EISDIR, for a directory by the name)
is the absence, where an `exists()` stat before the read doubled the
calls for every file present
(`tests/syscall-repeats.unsafe.test.ts`).

## What this does NOT do

- **Doesn't read inside `node_modules/`.** The lockfile contains the
  resolved version set; that's the source of truth for "did the
  dep tree change?"
- **Doesn't hash arbitrary root-level files.** Root-anchored inputs are
  declared per task via `cache.inputs.workspaceFiles` /
  `cache.inputs.workspaceRuntime`; a workspace-level `globalInputs` field is
  an owner-rejected non-goal (shared TypeScript presets compose instead).

## Tests

`tests/fingerprint.test.ts` pins stability, sensitivity per file, and
the claim (a claimed edit moves `all` and not `unclaimed`; nothing
claimed folds both the same). `tests/affected.test.ts` pins the
`--affected` half of a claim, `tests/plugin-pipeline.test.ts` the key
half through `planRun` and the CLI.

## Adding a new fingerprint source

1. Add the filename to `WORKSPACE_FINGERPRINT_FILES`.
2. Bump `CACHE_VERSION` (presence of that file changes cache keys
   for affected workspaces).
3. Update `docs/caching.md` § History.
