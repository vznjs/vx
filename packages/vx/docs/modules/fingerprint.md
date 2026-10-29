# `src/workspace/fingerprint.ts` — claimed root files

## Purpose

Read the root files a plugin claims, once per run. Core folds none of
them into a key (2026-10-14): a lockfile or install setting keys a task
only through the plugin that claims it, and its `key` hook decides how.
The bytes read here are what the run compares against when a task may
have rewritten one (`orchestrator/fingerprint-watch.ts`,
[`fingerprint-watch.md`](./fingerprint-watch.md)).

## Public surface

```ts
export function readClaimedFiles(
  workspaceRoot: string,
  names: Iterable<string>,
  reads?: LoadReads,
): Promise<ReadonlyMap<string, Uint8Array>> // the bytes of each name present
export function bunPatchFiles(bytes: Uint8Array): string[] // the patches a bun.lock names
```

`readClaimedFiles` reads through the load's `reads` (workspace.md), so a
root file the load already read is not read again.
Each name costs one `open`: the read's ENOENT (or EISDIR) is the
absence, where an `exists()` stat before it doubled the calls for every
file present (`tests/syscall-repeats.unsafe.test.ts`). With nothing
claimed, nothing is read.

`bun.lock` names a patch by path (`patchedDependencies`), never by its
content, so an edited patch leaves it byte-identical while `bun install`
applies the new one. `bun()` folds each named patch itself (item 1014).
On a named patch's edit, `--affected` asks the plugin that claims
`bun.lock` about `bun.lock`, with the patch's bytes at the base ref and
in the working tree in `change.extras`, when the claim names the patch
through `extraFiles`. `bun()` selects only the projects that reach the
patched package. A claimant without `extraFiles` widens to every
project (`affected.ts`). A lockfile without the key is not parsed.

The same holds for any file a claim's `extraFiles` names, and for a
directory it names (a `file:` dependency a manager copies at install or links, or a `link:` / `portal:` directory that is no workspace):
a changed path outside every project below the root loads the claims,
and one equal to or under a named path asks the claimant about its
lockfile. A directory's two sides are not its bytes; they differ, so only
the projects reaching it move. A diff inside the projects loads no claim.

## Claiming a file (`VxPlugin.fingerprint`)

A plugin that reads a root file declares `fingerprint: { files:
['bun.lock'], affected(change, ctx), extraFiles?(file, bytes) }`
(`extraFiles`: the files a claimed file names that the plugin's key
reads too, such as `bun.lock`'s patches and a `file:` dependency's
directory). The schema refuses a
second claimant for one file. `fingerprintClaims(plugins)` in
`plugin-host.ts` indexes the claims. `--affected`
(`workspace/affected.ts`) asks the claimant's `affected` with the file's
bytes at the base ref and in the working tree and selects the projects
it names; `undefined` ("cannot tell") selects every project. An
unclaimed root file is an ordinary path, owned by the root project.
`vx watch` re-reads the set on a claimed file's change, and the keys
decide. `@vzn/vx-lockfile` (`bun()`, `pnpm()`, `npm()`, `yarn()`) are
the claimants, over the shell in [`lockfile-claim.md`](./lockfile-claim.md).

What each claims:

| Plugin   | Lockfile                                       | Install settings                                                                           |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm()` | `pnpm-lock.yaml`                               | `pnpm-workspace.yaml`, `.npmrc`, `package.json` (its `pnpm` field)                         |
| `bun()`  | `bun.lock` (a lone `bun.lockb` is refused)     | `bunfig.toml`, `.npmrc`                                                                    |
| `npm()`  | `npm-shrinkwrap.json` over `package-lock.json` | `.npmrc`                                                                                   |
| `yarn()` | `yarn.lock`                                    | `.yarnrc.yml`, `.yarnrc`, `.npmrc`, `package.json` (`workspaces.nohoist`, `installConfig`) |

An install setting moves `node_modules` under a byte-identical lockfile:
bun 1.4.2 with `[install] linker = "isolated"` rewrote no byte of
`bun.lock` and moved every dependency out of the root `node_modules`
(D-7), and a Yarn 4 catalog flip rewrote no byte of `yarn.lock`
(turborepo#12635). So each plugin folds its settings whole into every
task. Only the root copies are read.

Deliberately unclaimed: `.vx/workspace.{ts,mts,js,mjs,cts,cjs}`.
Everything it declares — `concurrency`, `cache.dir`, `timeout`, the
plugin list — is placement, storage or observability, never what a
command produces; folding it would split the cache between a laptop
and a CI runner declaring `reapi()`.

## Tests

`tests/in-run-writes.test.ts` pins the read and the watch (an
unclaimed file is not watched). `tests/affected.test.ts` pins the
`--affected` half of a claim; `packages/vx-lockfile/tests` the key half.
