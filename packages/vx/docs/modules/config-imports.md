# `src/workspace/config-imports.ts` — the config-import selection channel

## Purpose

Answer one question for `--affected`: **which projects' `vx.config.*`
transitively import this changed file?**

vx hashes the RESOLVED config (architecture principle #4), so a value a
config imports participates in the cache key. Editing such a file
re-keys the task — and `affected.ts` states the rule this module exists
to keep: _"input hashing sees it, so `--affected` must too."_ Neither
existing channel can see it. Containment maps a file to the project
that OWNS it, and `cache.inputs.workspaceFiles` maps a file a project
DECLARED. A config import is neither.

## Public surface

```ts
/** The bare specifiers in `source` no `node_modules/<package>` above `fromDir` provides
 *  (what Bun would auto-install); builtins and `@vzn/vx` never count. */
export function unprovidedBareImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
): string[]

// Whether Bun's parser finds an ESM `export` in `source` — the loader
// serves only such a config from the bytes it read (project-loader.md).
export function hasEsmExport(source: string, loader: 'ts' | 'js'): boolean

export interface ConfigImportOwnersArgs {
  /* workspaceRoot, projects, changed paths */
}
export function configImportOwners(a: ConfigImportOwnersArgs): Promise<Set<string>>

export function configImportOwners(a: {
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  changed: readonly string[] // workspace-relative POSIX
  skip: ReadonlySet<string> // already-selected projects
  realDirs?: ReadonlyMap<string, string> // project dir → realpath, when the caller has them
}): Promise<Set<string>>
```

## How it works

Nothing is evaluated. `Bun.Transpiler.scanImports` reads the
specifiers and `Bun.resolveSync` turns them into paths — static
analysis, so the `project-loader.ts` note that a cache-bust "cannot
reach the config's import closure" (which is about runtime `import()`)
does not apply.

1. Roots are every project's `configPath`, minus `skip`.
2. Read each level of the walk together, scan each file (a file with no
   quoted `./`, `../` or escape skips the scan), keep specifiers starting with `./` or `../`,
   resolve them, and record the REVERSE edge `target → importer`.
   Targets outside the workspace, or under `node_modules`, are dropped.
3. **Descend only through files owned by NO project.** A config
   reaching into another project records the edge and stops.
4. One reverse BFS from the changed set answers every root at once.

Any read or parse failure skips that file silently: failing selection
over a broken out-of-scope file would break a working build. A
specifier that does not RESOLVE still records its edge, to the path it
names (and, bare of an extension, to each file Bun would have tried):
most often the change itself deleted or renamed the target, and the
config importing it is the project the change broke. Without the edge,
`--filter '[HEAD]'` exited 0 with that config broken (item 958).

**A file a config READS is not followed.** The scan sees imports only:
a config that reads `shared/cfg.json` with `readFileSync` folds its
bytes into the key (resolved-config hashing) while selection never
learns of the edge. Import the file instead (`import cfg from
'../../shared/cfg.json' with { type: 'json' }` is followed), or declare
it in `cache.inputs.workspaceFiles`. Selecting every config the purity
gate cannot vouch for on any unowned change was weighed and left: it
would run every such project on a README edit.

## The two rules that bound it

**Relative specifiers only.** A bare specifier is a package; it moves
when the lockfile moves, and the workspace fingerprint already selects
everything on a lockfile change. The exception is a bare specifier the
nearest tsconfig maps through `paths` or `baseUrl`: Bun loads its target
from disk, so it is an edge like a relative one, a deleted target
included (D-27). A config quoting no bare specifier such a tsconfig
maps is not scanned for one; at 5,000 configs that each import a
package and sit under a tsconfig, the lookup costs a one-file change
140 → 200 ms, and nothing when the configs import only `@vzn/vx`.

**No descent past a project boundary.** This is what makes the walk
affordable. When this repo's docs package config still imported core by
relative path (`../../src/index.ts`), following that edge transitively
would have dragged substantially all of core `src/` into the closure
(today it imports the bare `@vzn/vx`). The edge is
recorded (so editing `src/index.ts` selects `@vzn/vx-docs`), but the
walk stops there, and containment already selects the project owning
the target.

## Realpath

`Bun.resolveSync` returns **realpath'd** paths, so the workspace root
is realpath'd INSIDE this module rather than by the caller. A raw root
fails every containment check and reports "no imports" — which is
indistinguishable from a clean tree. Owning the normalisation in one
place makes that misuse unrepresentable; the first benchmark written
against this API hit exactly that trap and measured a code path that
found nothing.

## Cost

Measured (Bun 1.4.0, warm, min-of-5, synthetic workspace, every config
importing a shared preset that imports a second file):

| configs | scan   | selected |
| ------- | ------ | -------- |
| 100     | 9.1 ms | 100      |
| 1000    | 87 ms  | 1000     |

Since D-23 a level's files are read together and a config with no
relative-specifier candidate skips the scan: `affectedProjects` for one
changed file at 5,000 configs with no relative imports went 433 → 140 ms
(min of 10, three interleaved rounds; A/A 433–445).

Before that, a workspace whose configs have NO relative imports cost 80 ms at 1000
configs — so the price is dominated by READING the config files, not by
resolving imports, and the closure is close to free once the read is
paid. For scale: full config EVALUATION, which selection deliberately
avoids, is ~200 ms at that size. On this repo (5 projects when measured)
the channel cost 0.36 ms.

## Where this stops

The boundary rule buys a bounded walk and pays for it in completeness.
Both cases below are UNDER-selection, they are deliberate, and they are
pinned by tests so a future change has to face them:

**A config importing into another project gets ONE hop.** `x`'s config
imports `packages/lib/preset.mjs`; editing `preset.mjs` selects `x`, but
editing `packages/lib/internal.mjs` — which `preset.mjs` imports — does
not. `lib` is selected by containment; `x` is not, even though the value
flows into its resolved config. Following it would make the walk's cost
the size of an arbitrary project's source tree rather than the shared
tooling set.

**When the workspace root is ITSELF a project, transitivity through
shared files disappears.** vx supports a root `"."` member (this repo
uses one for core `@vzn/vx`), and that project's directory is the whole
workspace — so every `shared/**` file is "owned" and the walk stops at
the first hop. `app`'s config importing `shared/flag.mjs` still selects
`app` when `flag.mjs` changes; it does NOT when `shared/deep.mjs`
changes and only `flag.mjs` imports it. In a root-is-a-project
workspace, keep config helpers one hop from the config, or import them
by a specifier the containment channel already covers.

Measured for context rather than asserted: full descent from that
relative-import config reached 78 files in 15 ms here, so the cost of
closing this is not scan time — it is that an arbitrary project's
source tree becomes the walk's bound, and that every edit inside it
selects the importing project.

## Known over-selection

A config that imports a file by relative path is selected by every edit
to that file, even when the imported value cannot change the key (an
identity like `defineProject`). vx cannot tell those apart without
evaluating, and selection may over-select safely (it is never hashed)
but must never under-select. A config importing its helpers by BARE
specifier opts out of this channel; every config in this repo imports
`@vzn/vx` that way (`@vzn/vx-docs` once imported core's `src/index.ts`
relatively and was selected by every edit to it).

## `unprovidedBareImports` (item 239)

The bare specifiers of a config that no `node_modules/<package>` above it
provides — the ones Bun would auto-install from the npm registry when no
`node_modules` exists anywhere above (sixteen connections and 150 ms before
"cannot find", measured 2026-09-16). The loader refuses such a config before
evaluating it: `cannot find '<name>' — no node_modules above the config
provides it; install the workspace's dependencies first`. Builtins, `@vzn/vx`
(the core alias), relative or absolute specifiers, and package.json
subpath imports (`#tasks`: Bun maps them inside the package and never asks
the registry, D-28) are never listed.
Nor is a specifier the nearest `tsconfig.json` (else `jsconfig.json`) maps,
through `paths` or `baseUrl` with relative `extends` followed, to a file on
disk: Bun loads that file and never reaches the registry (D-26).
`tests/config-missing-import.test.ts`.
