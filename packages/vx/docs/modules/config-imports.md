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
/** Absolute resolved targets of the RELATIVE specifiers in `source`. */
export function scanLocalImports(source: string, fromDir: string, loader: 'ts' | 'js'): string[]

export function configImportOwners(a: {
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  changed: readonly string[] // workspace-relative POSIX
  skip: ReadonlySet<string> // already-selected projects
}): Promise<Set<string>>
```

## How it works

Nothing is evaluated. `Bun.Transpiler.scanImports` reads the
specifiers and `Bun.resolveSync` turns them into paths — static
analysis, so the `project-loader.ts` note that a cache-bust "cannot
reach the config's import closure" (which is about runtime `import()`)
does not apply.

1. Roots are every project's `configPath`, minus `skip`.
2. Scan each file, keep specifiers starting with `./` or `../`,
   resolve them, and record the REVERSE edge `target → importer`.
   Targets outside the workspace, or under `node_modules`, are dropped.
3. **Descend only through files owned by NO project.** A config
   reaching into another project records the edge and stops.
4. One reverse BFS from the changed set answers every root at once.

Any read / parse / resolve failure skips that file silently. A config
that will not load cannot be shown to import anything, and failing
selection over a broken out-of-scope file would break a working build.

## The two rules that bound it

**Relative specifiers only.** A bare specifier is a package; it moves
when the lockfile moves, and the workspace fingerprint already selects
everything on a lockfile change.

**No descent past a project boundary.** This is what makes the walk
affordable. This repo's `apps/docs/vx.config.ts` imports
`../../src/index.ts`; following that edge transitively would drag
substantially all of core `src/` into the closure. The edge is
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

A workspace whose configs have NO relative imports costs 80 ms at 1000
configs — so the price is dominated by READING the config files, not by
resolving imports, and the closure is close to free once the read is
paid. For scale: full config EVALUATION, which selection deliberately
avoids, is ~200 ms at that size. On this repo (5 projects) the channel
costs 0.36 ms.

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

Measured for context rather than asserted: full descent from
`apps/docs/vx.config.ts` reaches 78 files in 15 ms here, so the cost of
closing this is not scan time — it is that an arbitrary project's
source tree becomes the walk's bound, and that every edit inside it
selects the importing project.

## Known over-selection

Editing core `src/index.ts` now selects `@vzn/vx-docs`, because its
config imports `defineProject` from there. The import edge is real; the
key change is not, since `defineProject` is identity. vx cannot tell
those apart without evaluating, and selection may over-select safely
(it is never hashed) but must never under-select. A config importing
its helpers by BARE specifier opts out of this channel.
