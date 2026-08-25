# `--affected` blind to config import closures — design

> **Status:** proposal
> **Defect:** CONFIRMED by executed repro (see below). Under-selection, not
> a stale hit: no `CACHE_VERSION` bump is owed — selection is never hashed.

## What we're solving

A `vx.config.*` may import any file it likes. The cache key sees the
**resolved** config (architecture principle #4), so a change to an imported
file re-keys every task whose fields it feeds. `--affected` maps changed
paths to projects by **directory containment** only, so an imported file
that lives outside the importing project's dir selects nothing.

Executed repro (`packages/app/vx.config.mjs` doing
`import { FLAG } from '../../shared/flag.mjs'`, `command: 'echo ' + FLAG`):

- `loadProjectConfig` before the edit → `{"command":"echo one"}`,
  after → `{"command":"echo two"}`. Input hashing sees it.
- `affectedProjects({ workspaceRoot, since: 'HEAD', projects })` → **empty set**.

This is the exact class already fixed once for lockfiles and workspace
definition files, and the comment recording that fix states the principle
verbatim — `src/workspace/affected.ts:89-96`, quoting `docs/cli.md:151`:

> "input hashing sees it, so `--affected` must too."

Today that sentence is a claim the code does not honour for this input
channel, which is the "comment claiming a guarantee the code does not have"
defect class in its own right.

**The class is wider than the repro.** Two shapes, both confirmed present:

1. **Orphan target** — the imported file belongs to no project
   (`shared/flag.mjs`). Selects nothing. This is the repro.
2. **Cross-project target** — the imported file belongs to _another_
   project. This repo does it: `apps/docs/vx.config.ts:1` is
   `import { defineProject } from '../../src/index.ts'`. A change to
   `src/index.ts` selects `@vzn/vx` (containment) and never `@vzn/vx-docs`.
   `--filter '...[base]'` does **not** rescue this one either:
   `apps/docs/package.json` has no `@vzn/vx` dependency, so the package
   graph has no edge to close over.

A fix that only handles (1) leaves (2) live in this very repo. Both are
the same missing channel: _file → project_ through the config's imports.

## Access pattern

- Called from exactly one place: `resolveFilters` in `src/cli/run.ts:715`
  (`--affected` is sugar for `--filter '[<ref>]'`, so both forms land here).
- Once per distinct git ref per run, before `prepareRun`. Never on a hot path.
- Input: the changed-path set (tens of paths typical, thousands on a big
  branch diff) and `ProjectMeta[]` (`{name, dir, packageJson, configPath}`).
  Configs are **not** evaluated during selection, deliberately —
  `src/orchestrator/prepare.ts:155-162` records that evaluating 1090 configs
  costs ~200 ms and is the dominant fixed cost of small runs.
- Output: a set of project names. **Selection is not hashed**
  (`affected.ts:97`), so widening it can never produce a wrong answer — only
  a slower run. Narrowing it produces a wrong _green_, which is the failure
  we have.

Cost asymmetry, stated plainly: an over-selected project re-hashes and
probes the cache; if its key really is unchanged it is a cache **hit** plus
an artifact restore, and any uncached task in it re-executes. An
under-selected project is a CI run that reports green having tested nothing.

## Options considered

**A. Any orphan change ⇒ every project affected.** Sound, and it mirrors the
lockfile widening already in the code. Rejected: at this repo's shape, a
`docs/**` or `README.md` edit — `docs/` is a root directory owned by no
project — would select all five projects, and on a 1090-project workspace it
turns every root-level touch into a full-graph run. The lockfile widening is
justified because a lockfile provably re-keys _every_ task; an arbitrary
orphan provably re-keys _none_.

**B. Compare each project's resolved-config digest against a baseline.**
Precise in principle, rejected on two counts. (i) Semantics: `--affected` is
defined against a **git ref**; a cache baseline is not, so a project would
become "affected" or not depending on local cache state. (ii) Cost: the
baseline is the config _as of `<since>`_, which means materialising the old
tree (`git worktree`) and evaluating every config's import closure there.
That is a worktree checkout per `--affected` invocation.

**C. Orphan with a JS/TS extension ⇒ every project affected.** Cheap, no new
machinery, and wrong for a nameable reason: this repo's `bench/` and
`scripts/` are root-level TS that no config imports, so ordinary tooling
edits would select the world. It is option A wearing a heuristic, and the
heuristic has no principle behind it. It is also _strictly_ worse than E,
which answers the same question exactly rather than by extension.

**D. Document the limitation; require `cache.inputs.workspaceFiles`.** The
honest fallback, and it is what the code does today by omission. Rejected as
the _primary_ answer because the escape hatch does not cover shape (2) at
all — `workspaceFiles` globs are workspace-relative and would have to name
another project's source, which reads as a boundary violation — and because
the failure it leaves in place is a silent green in CI. Kept as the answer
for the residuals E cannot see (below).

**E. Static import-closure scan of the config files.** Recommended. Two
sub-variants were weighed:

- **E1, orphan targets only** (extend the existing orphan channel). Fixes
  the repro with zero new false positives, leaves shape (2) live in this
  repo. Rejected: it fixes the line, not the class.
- **E2, record every local import target, descend only through orphans.**
  Recommended. Detailed below.
- **E3, full transitive descent through every target.** Rejected: descending
  through `apps/docs/vx.config.ts → ../../src/index.ts` pulls in
  substantially all of core `src/`, so every core edit would select
  `@vzn/vx-docs`. Bounded by nothing in particular, and it dissolves
  project boundaries (architecture principle #6).

**F. Record the import closure in `vx-lock.json` at `vx lock` time.**
Rejected for now: it is a versioned on-disk format change that helps only
frozen CI, and E is cheap enough that it buys nothing. Noted so it is not
re-proposed without a measurement that says E is too slow.

## Recommendation

Add a third _file → project_ channel to `affectedProjects`, alongside
containment and `workspaceFiles`: **the static import closure of each
project's config file, following relative specifiers only, descending only
through files that belong to no project.**

Three rules, each with a reason:

1. **Relative specifiers only** (`./…`, `../…`). A bare specifier
   (`@acme/preset`) is a _package_ dependency: it needs a `package.json`
   entry to resolve at all, so the package graph already knows the
   relationship and `--filter '...[base]'` is its documented answer.
   Following bare specifiers would also make selection depend on
   node_modules layout and install state — measured: in this repo
   `Bun.resolveSync('@vzn/vx', 'packages/vx-github')` realpaths through the
   self-link to `<root>/src/index.ts`, so resolving them would quietly turn
   `--affected` into partial dependent semantics, which it deliberately is
   not (`docs/cli.md:133`).
2. **Record every resolved target**, whether it belongs to a project or not.
   The `apps/docs` case is exactly a target owned by another project, and it
   is invisible to every other channel.
3. **Descend only through targets owned by no project.** An orphan file
   belongs to nobody, which is precisely the gap. A file inside a project is
   a boundary: record the edge, stop. This is what keeps the closure small
   and keeps principle #6 intact.

No new schema field. No new config surface. No new dependency. No evaluation
of any config.

### Why this is affordable

Measured on this box (Bun 1.4.0, warm page cache), on 1090 synthetic
`vx.config.ts` files of ~400 bytes with two import specifiers each:

| step                                                   | cost         |
| ------------------------------------------------------ | ------------ |
| read 1090 configs (`Bun.file().text()`, `Promise.all`) | 8.5–9.2 ms   |
| `Bun.Transpiler.scanImports` × 1090                    | 10.4–11.9 ms |
| `Bun.resolveSync` × 2180                               | 3.3 ms       |
| **total**                                              | **~23 ms**   |

Against the ~200 ms full-config **evaluation** that `prepare.ts` goes out of
its way to avoid, and against a `--affected` invocation that already spawns
two `git` processes. The implementer must re-measure on the `bench/`
synthetic workspace and record the number; the claim above is one box, warm.

Note the existing orphan path already costs far more than this: when there
are orphans and no `vx-lock.json`, `workspaceGlobOwners`
(`src/cli/run.ts:648-680`) **evaluates every project config in the
workspace**. This proposal adds no cost to that path and does not touch it.

### Feasibility evidence (the "import graph is infeasible" constraint)

`project-loader.ts:53-56` says a repeat in-process load cannot see a
config's import closure. That is true of `import()` — the module registry
does not expose the graph — but the closure is recoverable **statically**,
without executing anything. Verified in this checkout, Bun 1.4.0:

```
Bun.Transpiler({loader:'ts'}).scanImports(src)
  → [{kind:'import-statement', path:'../../shared/flag.mjs'},
     {kind:'import-statement', path:'@vzn/vx'},
     {kind:'dynamic-import',   path:'./dyn.ts'}]
  → require('./cjs-thing.js')     ⇒ {kind:'require-call'}
  → export { a } from './re.ts'   ⇒ captured
  → import type { T } from './t'  ⇒ DROPPED  (correct: type-only imports are
                                    erased, so they cannot move a resolved value)

Bun.resolveSync('../../shared/noext', dir) → /…/shared/noext.ts
Bun.resolveSync('../../shared/dir',   dir) → /…/shared/dir/index.ts
Bun.resolveSync('./missing.ts',       dir) → throws ResolveMessage
```

This is strictly better than the regex `prune.ts:109` already ships
(`SPECIFIER_RE`): a real parse, with `kind`, and no false hits inside
strings or comments. **Do not add a second regex scanner** — the two copies
would drift, which is the recurring class. See "Open question 1" on whether
`prune.ts` should be migrated onto the same helper in a later wave.

## Concrete spec

### New module: `src/workspace/config-imports.ts`

```ts
/** Absolute, realpath'd resolved targets of RELATIVE specifiers in `source`. */
export function scanLocalImports(source: string, fromDir: string, loader: 'ts' | 'js'): string[]

export interface ConfigImportOwnersArgs {
  /** Realpath'd. Every path compared against it must be realpath'd too. */
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  /** Workspace-relative POSIX paths, the same list containment consumed. */
  changed: readonly string[]
  /** Project names already selected — their configs are not scanned. */
  skip: ReadonlySet<string>
}

/** Projects whose config file transitively imports one of `changed`. */
export function configImportOwners(a: ConfigImportOwnersArgs): Promise<Set<string>>
```

Algorithm:

1. Short-circuit to the empty set when `changed.length === 0` or
   `skip.size === projects.length`.
2. Roots: every `p.configPath` where `p.configPath` is a non-empty string
   and `!skip.has(p.name)`. Record `rootOwner: Map<absConfigPath, name>`.
3. Worklist scan, memoised on absolute path. For each file: read, pick the
   loader from the extension (`.ts`/`.mts`/`.cts` → `'ts'`, else `'js'`),
   `scanImports`, keep specifiers starting with `./` or `../`,
   `Bun.resolveSync(spec, dirname(file))`. Drop a target that resolves
   outside `workspaceRoot` or contains a `node_modules` path segment.
   Record the reverse edge `target → file`. **Enqueue the target only if it
   is owned by no project** (reuse the same ancestor-walk containment map
   `projectsContaining` builds — it must be shared, not re-derived).
4. Any read / parse / resolve failure: skip that file silently. Matches the
   existing convention at `src/cli/run.ts:673-676` — "a config that will not
   load cannot be shown to declare a matching glob", and failing selection
   over a broken out-of-scope config would break a working build.
5. Reverse BFS from each changed path (`resolve(workspaceRoot, rel)`) over
   the reverse-edge map; every root reached contributes `rootOwner.get(root)`.
   O(V+E) once, independent of the root count.

Cycles are handled by the visited set; there is no depth cap and none is
proposed — the walk is bounded by the reachable _orphan_ module set, which
is the shared-tooling tree, not the source tree.

### Wiring: `src/workspace/affected.ts:102-105`

```ts
const { owned, orphans } = projectsContaining(workspaceRoot, changed, args.projects)
// NEW — third channel, runs regardless of whether there are orphans:
for (const n of await configImportOwners({
  workspaceRoot,
  projects: args.projects,
  changed,
  skip: owned,
}))
  owned.add(n)
if (orphans.length === 0 || args.workspaceGlobOwners === undefined) return owned
for (const name of await args.workspaceGlobOwners(orphans)) owned.add(name)
return owned
```

The channel runs on the **full** changed set, not just `orphans` — shape (2)
has an owned target by definition. `skip: owned` is passed _before_ the
workspaceFiles channel widens it; ordering is irrelevant to the result
(scanning an already-selected project's config only wastes a read).

`projectsContaining` should return its `dirToName` map (or move the
containment lookup into a tiny shared helper) so the new module does not
build a second copy of the same index.

### The #1 implementation hazard: realpath

`Bun.resolveSync` returns **realpath'd** paths — measured:
`Bun.resolveSync('../../shared/preset.ts', '/tmp/vxscan/pkgs/p0')` →
`/private/tmp/vxscan/shared/preset.ts` on macOS. Changed paths arrive as
`path.resolve(workspaceRoot, rel)`, which is _not_ realpath'd. Test fixtures
use `mkdtemp(os.tmpdir())`, and `/var` → `/private/var` on darwin, so a naive
implementation compares `/var/folders/…` against `/private/var/folders/…`
and silently matches nothing — a probe that reaches the wrong path and fails
identically to one that found nothing. Realpath the workspace root **once**
at entry and resolve everything against that. This repo has already shipped
one macOS-only symlinked-base containment defect; that is the precedent.

### Tests (`tests/affected.test.ts` — it imports

`../src/workspace/affected.js` directly, so no façade export is needed and
the `src/index.ts` snapshot does not move)

Pins:

1. **The repro.** `packages/app/vx.config.mjs` imports `../../shared/flag.mjs`;
   editing `shared/flag.mjs` selects `app`.
2. **Transitive through orphans.** `shared/flag.mjs` imports `./deep.mjs`;
   editing `shared/deep.mjs` selects `app`.
3. **Cross-project target, one hop.** `apps/x/vx.config.mjs` imports
   `../../packages/lib/preset.mjs`; editing that file selects **both**
   `lib` (containment) and `x` (import channel).

Controls — these are what prove it does not over-select, and they are the
half of this design that matters most:

4. **Unrelated orphan module.** `tools/build-helper.mjs` exists, is a `.mjs`
   at the workspace root, and no config imports it. Editing it selects
   **nothing**. This is the assertion that refutes option C, and it must
   assert the exact empty set, not the absence of one name.
5. **Sibling orphan.** `app`'s config imports `shared/a.mjs`; editing
   `shared/b.mjs` selects nothing.
6. **No descent past a project boundary.** `x`'s config imports
   `../../packages/lib/preset.mjs`, and `preset.mjs` imports
   `./internal.mjs` (also inside `lib`). Editing `packages/lib/internal.mjs`
   selects `lib` and **not** `x`. This pins rule 3 — the whole reason E2 is
   affordable — and it is the test that fails if someone "improves" the
   scanner into E3.
7. **Bare specifier not followed.** A config importing `@vzn/vx` (or any
   installed package) contributes no edge; the control is that no project is
   selected when a file under `node_modules` changes.
8. **Docs-only orphan.** Editing `docs/x.md` still selects nothing — the
   existing "nothing changed exits 0" behaviour is unchanged.

Differential: disable the new channel and pins 1–3 must fail; keep it and
controls 4–8 must still pass. Both directions, or the fix can degenerate
into "select everything".

### Docs, same wave (a feature is not done until its docs land with it)

- `docs/cli.md:148-163` — a paragraph after the lockfile one: the config
  import channel, the relative-only rule, and the residual list verbatim.
- `docs/modules/affected.md` — **already stale** and must be corrected here:
  its `AffectedArgs` block predates `workspaceGlobOwners`, and its step 3
  still describes the longest-dir sort that the ancestor walk replaced.
- `docs/modules/config-imports.md` + an entry in `docs/modules/README.md`,
  house shape (purpose / public surface / invariants / tests).
- `docs/schema.md` — no change. Nothing here is user-authored.

## What's out of scope

- **`vx.workspace.ts` and its imports.** `fingerprint.ts:28-37` deliberately
  keeps the workspace config out of the fingerprint: everything it can
  declare is placement, storage or observability, never what a command
  produces. Nothing it imports can move a cache key, so widening selection
  for it would be pure cost. (`vx prune` already scans it, for a different
  question — runnability of a subset.)
- **Computed specifiers.** `import(\`./\${env}.ts\`)`is invisible. Same
blindness`prune.ts:40-41` documents; say so, do not sell completeness.
- **Bare specifiers**, including workspace packages — rule 1. Residual:
  `--filter '...[base]'`, which requires the `package.json` dependency to be
  declared. Where it is not (this repo's `apps/docs`), the relative-import
  channel is what covers it, which is exactly why rule 2 exists.
- **Runtime file reads from a config** (`readFileSync('../version.txt')`,
  `execSync`). Not an import; `cache.inputs.workspaceFiles` is the answer,
  and `cache.inputs.runtime` for the command case.
- **Imports above the workspace root.** `git diff --relative`
  (`affected.ts:57-63`) already drops changes above the root, correctly —
  they belong to no project and are usually outside the repo.
- **Making `--affected` include dependents.** Unchanged, deliberate,
  documented at `docs/cli.md:133`.
- **A `CACHE_VERSION` bump.** Not owed. Selection is never hashed; no stored
  bytes and no key derivation move. State this in the log entry.
- **Deleted imported files.** A deleted target fails `Bun.resolveSync`, so
  the edge vanishes and the change is missed — but the config then fails to
  load and the run errors loudly instead of going green. Documented, not
  handled.

## Open questions

1. Should `prune.ts`'s `SPECIFIER_RE` migrate onto `scanLocalImports`? The
   questions differ (prune wants _all_ specifiers including bare ones, to
   decide copyability; this wants resolved local files), so a shared helper
   would need both modes. Recommendation: **not in this wave** — land the
   scanner, then migrate prune in a follow-up if the shared helper stays
   honest. Two scanners is a drift risk that must be recorded either way.
2. Should the scan be skipped under `--frozen`? `vx-lock.json` holds resolved
   configs but not import closures, so no — there is nothing cheaper to
   consult. Revisit only with option F.
3. `apps/docs/vx.config.ts` importing `../../src/index.ts` will, after this
   lands, make every core `src/index.ts` edit select `@vzn/vx-docs` (an Astro
   build). That is a **true** edge and a **false** positive: `defineProject`
   is identity, so the resolved config does not move, and vx cannot know
   that. Changing that one line to `import { defineProject } from '@vzn/vx'`
   removes it from the channel. Worth doing, but as a deliberate follow-up
   with its reasoning recorded — not silently, because it is the repo
   opting _out_ of a correctness channel.

## Why this is the right move

- It answers the actual question — "which files feed this config?" —
  instead of approximating it by extension (C) or by giving up (A).
- It closes the **class**, both shapes, including the one live in this
  repo that no other channel and no `...[base]` can reach.
- It costs ~23 ms measured on a 1090-project workspace and evaluates
  nothing, so the scoped-config-loading property `prepare.ts` protects is
  untouched.
- Widening can only cost time; the defect it removes costs a green CI run
  that tested nothing. That asymmetry is the whole argument, and it is the
  same one the lockfile widening already won.
- No new schema field, no new dependency, no new config surface — a
  standing non-goal ("a schema field would duplicate the language") is not
  approached from any side.
- Every rule it applies is falsifiable by a control test, and the controls
  are specified before the implementation.
