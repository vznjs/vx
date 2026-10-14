# `src/workspace/packages.ts` — package-manager members, for `vx init`

## Purpose

The members `package.json#workspaces` or `pnpm-workspace.yaml` list, read
for `vx init` alone: its scripts mapper, and the root it writes
`.vx/workspace.ts` at. A run never reads them; a project is a directory
holding a vx.config ([`workspace.md`](./workspace.md)). A lockfile plugin
(`@vzn/vx-lockfile`) names the members in a run, and `@vzn/vx-migrate`
reads their manifests itself. Supports pnpm / npm / yarn / Bun
workspaces, plus a single-project mode (bare `package.json` with no
`workspaces` field).

Package globs take the package manager's full grammar: a negated entry
(`!packages/fixtures`, `!**/test/**`) subtracts from what the positive
globs found — a literal one excludes its tree, and a wildcard one is
matched against the member's manifest (`<pattern>/package.json`) as pnpm
matches it, so `!**/test/**` excludes `packages/test` itself (item 986) —
in both discovery and the root-claim walk. A negation applies whatever
its position, as pnpm reads its own file: a later positive glob does not
re-include what it excluded. npm and bun read `package.json` `workspaces`
in order and disagree with each other (npm drops a negation a later
pattern matches as text; bun lets the last pattern matching a path
decide), so a list that re-includes after a negation names a member vx
leaves out (probed npm 10 and bun 1.4, D-147). A read that finds nothing
(a missing directory, a dangling link, no config) is absent; a read the
process could not make, out of file descriptors (`EMFILE`, `ENFILE`),
fails with the `ulimit -n` hint, where it had read the workspace as empty
(D-60). A symlinked member is found by any glob without `**`
(`packages/*`, `packages/{a,b}`, `pack*/*`); only `packages/*` found one
until item 987. Under `**` links are not followed, so the scan never walks
a pnpm `node_modules` link farm. Handed to the glob engine raw, a leading
`!` negated the whole pattern and made every manifest in the tree a member
(2026-09-10). Every entry goes through `normalizeBunGlob` first:
`!./packages/legacy` and `!packages//legacy` excluded nothing until they
did (same day). A trailing slash is dropped before that, as npm and pnpm
drop it: `normalizeBunGlob` gives a task glob's trailing slash the meaning
`/**`, and `packages/*/` found every example and fixture package at any
depth (item 985). A member glob keeps the package manager's grammar, so a
bracket there is a class and `\[` a literal bracket — unlike a task glob,
where a bracket is literal (item 667). The one form it refuses is extglob
(`!(…)`, `@(…)`, `+(…)`, `*(…)`, `?(…)`): npm and yarn read
`packages/!(x)` as an exclusion, `Bun.Glob` has no extglob and its scan
widened the segment to a wildcard (x became a project, turborepo#3766), so
`assertGlobList` refuses the entry by name, with the exact `!` rewrite
when the group is a whole segment of plain names. A brace whose
alternatives hold a slash (`packages/{a,nested/b}`) is scanned as its
expansions: `Bun.Glob`'s scan found nothing for one, though its match
reads it, so both packages vanished while the root still claimed them
(D-2).

## Public surface

```ts
export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

export interface PackageWorkspace {
  root: string
  packageGlobs: string[] // patterns relative to root
}

export interface PackageMeta {
  name: string // package.json#name
  dir: string // absolute package directory
  packageJson: PackageJson
  configPath: string | null // absolute path to vx.config.{ts,mts,js,mjs,cts,cjs}
}

// where `vx init` and @vzn/vx-migrate put .vx/workspace.ts when there is
// none: the package manager's root, by the claim rule below
export function findManifestRoot(start: string, reads?: LoadReads, uid?: number): Promise<string>
export function loadPackageWorkspace(root: string, reads?: LoadReads): Promise<PackageWorkspace>
// The members, collecting each nameless member's dir into `nameless` (vx init)
export function discoverPackages(
  workspace: PackageWorkspace,
  nameless?: string[],
): Promise<PackageMeta[]>
// discoverPackages over loadPackageWorkspace(root)
export function listPackages(root: string): Promise<PackageMeta[]>

// Workspace members whose package globs match no directory — `vx init`
// says so with `unreachedHint`, which names them and what to check.
export function unreachedPackages(workspace: PackageWorkspace): Promise<string[]>
export function unreachedHint(unreached: readonly string[], root: string): string

// Whether a member glob reaches any package.json but the root's,
// addressable or not; `vx init` names globs that reach none (M-46).
export function reachesManifest(workspace: PackageWorkspace): Promise<boolean>
```

## Rules

### `findManifestRoot(start)`

Where `vx init` and `@vzn/vx-migrate` write `.vx/workspace.ts` when there
is none yet. Walks up from `start` to the git top-level, or to the
filesystem root outside git, where it stops above `start` at a manifest
another user owns (root aside). A directory is a root CANDIDATE if it
contains either:

- `pnpm-workspace.yaml`, OR
- `package.json` (with or without a `workspaces` field).

**The nearest candidate that CLAIMS `start` wins** — one of the
directories between it and `start` matches one of its package globs.
Every member has its own `package.json`, so first-match-wins would make
an init from inside a package treat that package as the whole workspace.
Claiming reads the same globs `loadPackageWorkspace` applies, and only a
directory holding a manifest can be the claimed member, as only such a
directory is listed, so "the root that claims me" and "the root that
lists me" cannot diverge. They did until item 989: `packages/*` matched a
manifest-less `packages/tools`, and the standalone package below it was
claimed by a workspace that does not list it. Nor can a directory
discovery skips be claimed: a `node_modules` path, or a dot-dir a
wildcard reached (`packages/*` over `packages/.tpl`). The walk matches
each glob against the member's manifest path, as discovery does, so
`packages/**` claims `packages` itself when it holds a `package.json`
(npm lists it too). A `pnpm-workspace.yaml` is a hard root, as pnpm has
it: the walk stops at the nearest one, listed by an outer workspace or
not (item 990). A `package.json` with `workspaces` of its own is a root
the same way unless the outer root lists that directory itself, as npm
reads it (D-137). The converse holds too: an outer root that lists both
the nested root and the claimed member (`packages/**` over
`packages/inner` and `packages/inner/sub`) owns the member (X-3).

When nothing claims `start` — a standalone package, or a subdirectory
of a single-project repo — the nearest candidate wins. A bare
`package.json` without `workspaces` means single-project mode: the root
itself IS the package. Throws a `UserError` if no candidate is found.
`unreachedPackages(workspace)` is the failure-path check for that mode:
one shallow scan (two levels, `node_modules` and dot directories
skipped) for the `package.json` files the missing globs never reach, and
`unreachedHint` is the line `vx init` prints for them — the cause, the
packages, the `workspaces` entry to add (the `packages` entry, where a
`pnpm-workspace.yaml` holds pnpm's settings and no `packages:`).

### `loadPackageWorkspace(root, reads?)`

Reads the package-glob list (through `reads`, so the manifest
`findManifestRoot` just read is not read again):

| Manager                | Source                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| pnpm                   | `pnpm-workspace.yaml`'s `packages:` field (via `Bun.YAML.parse`) |
| npm / yarn / bun (new) | `package.json` `workspaces: string[]`                            |
| yarn (legacy)          | `package.json` `workspaces: { packages: string[] }`              |
| single project         | `package.json` without `workspaces` → returns `['.']`            |

A `workspaces` object without `packages` (bun's `{ catalog }`, yarn's
`{ nohoist }`) is the single project too, as bun and yarn read it. A
`pnpm-workspace.yaml` without a `packages:` list, or with an empty one
(the list commented out), defers to `package.json`, as pnpm does. A yarn
`workspaces: { packages: null }` is the single project too, as yarn 1 and
4 read it.

### `discoverPackages(workspace, nameless?)`

Globs every `package.json` matching the patterns (`Bun.Glob`,
`onlyFiles: true`, `dot: false`). For each:

- Skip if no `name` field (`nameless` collects the directory for
  `vx init`, which names one that has scripts, D-106).
- A member outside the workspace root (`../ext/*`, an absolute glob) is
  refused naming its directory: npm and pnpm take one; move the root up
  to a directory that holds every member.
- A file this user may not read is refused as a read (D-132):
  `<file>: not readable by this user (EACCES)`. A member directory it may
  not search hides whether a manifest is there, so it is named on stderr
  and skipped. Any other glob shape is scanned, and the scan stops at
  such a directory and cannot skip it, so the load is refused naming the
  directory and the glob.
- A name several manifests share: pnpm accepts it (vite's playground,
  sveltejs/kit's test apps). With no vx config among them they are left
  out, named on one stderr line; with one, a `UserError` names every
  root-relative path and the way on (rename one, or a `!` glob).
- One package reached by two paths, a member and a link to it
  (`apps/docs` linking to `../packages/docs`), is one package, kept at the
  path that reaches it through no link (D-135).
- The first existing `vx.config.{ts,mts,js,mjs,cts,cjs}` sibling becomes
  `configPath`.
- `node_modules` paths are skipped even when a `**` glob would match them.
- The root package is a member too when it holds a vx config and no glob
  lists `.` (D-39).

Returns the members sorted by `name`.

## Tests

`tests/workspace.test.ts` (globs, manifests, the claim walk, refusals),
`tests/workspace-*.test.ts` (one rule each), `tests/init.test.ts` (what
`vx init` does with them).
