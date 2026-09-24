# A sandboxed task reads a linked sibling unseen (2026-09-24)

> **Status:** proposal (architect, 2026-09-24), for STATUS Next 17.
> Nothing here is implemented. Touches the owner decision of 2026-09-05
> ("the sandbox derives nothing from `cache`"). § Open questions asks
> for a sign-off.

## What we're solving

`sandboxRequestFor` grants every `node_modules` link from the project
and from the workspace root (`linkedDeps`). It reports denials only
inside the project (`reportWithin`). So a sandboxed, cached task can read
workspace package P's files through its link with no edge to any of P's
tasks. The read is allowed and nothing reports it. An edit in P does not
move the task's key, and the next run replays the old result: the stale
hit the sandbox exists to rule out.

The probes found a second hole in the same line. npm and Yarn classic
link **every** workspace package at the root, the task's own package
included. So `linkedDeps` grants the task's own project directory in
full, whatever its `allow.read` says. The correctness page's demo
(grant = inputs = `src/**`, then read `banner.txt`) gives a stale hit in
any npm or Yarn workspace.

## Access pattern

- **Who hits it:** a task with both `exec.sandbox` and `cache`. An
  unsandboxed task has the same hole, but vx never claimed to prove its
  reads. An uncached task has no key that could be stale.
- **What it reads:** a sibling's `src/` (a "just-in-time" package
  consumed as source, as every package in this repo is), a sibling's
  `dist/` after `^build`, or its own files outside its grant.
- **How often the grant is computed:** once per executed sandboxed task.
  Cache hits never compute it (`armSandbox` and `sandboxRequestFor` run
  only on the execution path). Measured today on this checkout:
  `sandboxRequestFor` for `@vzn/vx-github`, which yields 9 read entries,
  takes **0.57 ms min / 0.74 ms median of 30**.
- **Who lays out the links:** the installer (probe P6). npm 10 and Yarn
  1.22 link every workspace package at the root. pnpm 12 and Bun 1.4.2
  link only the dependant's declared dependencies, under
  `<project>/node_modules`. pnpm's `node_modules/.pnpm/node_modules`
  hoist is not scanned by `linkedDeps`, which reads only depth 0 and
  `@scope/` directories. This checkout's root `node_modules/@vzn` dates
  from the 2026-09-08/10 installs and links seven packages, so the grants
  on this box differ from a fresh CI install.

## Probes (fixture in the session scratchpad, `bun packages/vx/src/bin.ts`)

The fixture has `packages/ui` (`@x/ui`, `src/index.js` exporting
`label`), `packages/app` (depends on `@x/ui`, `workspace:*`) and
`packages/secret`. The root `node_modules/@x/{ui,app}` are symlinks,
matching npm's layout. `app#test` is `bun src/check.js`, which imports
`@x/ui`, with `sandbox: { allow: { read: ['.'] } }` and inputs
`src/**`, `package.json`. It has no `dependsOn`.

**P1: stale hit, nothing reported.**

```
=== run 1 (ui v1)                      ui label: v1   success, 1 miss
=== run 3 (ui edited to v2)            ui label: v1   up-to-date
--- the same command, unsandboxed:     ui label: v2
=== run 4 (ui v2 committed)            ui label: v1   up-to-date
vx why: key 211c55221d6e23e4 both runs, "cache key unchanged"
```

No `SANDBOX VIOLATIONS` block on any run. Committing the edit changes
nothing either: the git blob OID of `ui/src/index.js` is in no key.

**P2: this box does enforce read denies (a belief refuted).** The brief
said a cross-project `cat` once succeeded on this box. It did, and the
link grant is why. `SRT_DEBUG=1` shows the tmpfs over the workspace root
and then `Re-allowed read access within denied region: …/packages/ui`
and `…/packages/app`, both added by `linkedDeps`. Controls from the same
task (`read: ['.']`):

```
cat ../ui/README.md        (linked)     success: "ui readme v1"
cat ../secret/token.txt    (unlinked)   failed: No such file or directory
echo hi > undeclared.txt                failed: Read-only file system
```

The unlinked sibling's denial is enforced but not reported, because it
lies outside `reportWithin`, as designed.

**P3: the self-link widens the task's own grant.** A task with
`read: ['src/**']`, inputs `src/**`, runs `cat banner.txt`:

```
root link node_modules/@x/app present:  "banner v1" success; edit banner → up-to-date, prints v1
root link removed, --force:             failed, 1 sandbox violation
                                        openat(banner.txt) = -1 ENOENT  [<ws>/packages/app/banner.txt]
```

**P4: an edge to a keyed task in P is the fix, and it works today.** The
fixture adds `ui#source` (`true`, inputs `src/**`) and
`app#test.dependsOn: ['^source']`: ui v2 → success; edit ui to v3 →
miss, prints v3; restore v2 → up-to-date.

**P5: the edge is package-level, not file-level (the residual).**
`app#readme` has `dependsOn: ['^source']` and runs
`cat ../../node_modules/@x/ui/README.md`. Editing `ui/README.md` →
up-to-date, prints the old text. `ui#source`'s inputs (`src/**`) do not
cover the file read.

**P6: installer layouts.** The fixture is the same three packages with
no lockfile.

```
bun 1.4.2   packages/app/node_modules/@x/ui -> ../../../ui
npm 10      node_modules/@x/{ui,app,secret} -> ../../packages/*
yarn 1.22   node_modules/@x/{ui,app,secret} -> ../../packages/*
pnpm 12.6   node_modules/.pnpm/node_modules/@x/{ui,app,secret}, packages/app/node_modules/@x/ui
```

**P7: option (b) on the runtime, driven through `runSandboxed`.** This
probe drove core's own `runSandboxed` with `baseAllowRead` narrowed by
hand:

```
bun src/check.js | today (ui + self granted)          exit 0  "ui label: v2"  violations []
bun src/check.js | ui withheld, report within app     exit 1  ENOENT reading ".../node_modules/@x/ui"  violations []
bun src/check.js | ui withheld, report within ws      exit 1  violations ["openat(<ws>/node_modules/@x/ui) = -1 ENOENT  [<ws>/packages/ui]"]
```

Withholding the grant makes the task fail on both platforms by
enforcement. The report names the sibling only if `reportWithin` covers
it. The violation carries the real path (`[<ws>/packages/ui]`), so a
filter on the withheld directories needs no new path logic.

**P8: this repo under the self-link rule.** The probe ran through
`runSandboxed`, with the grant built by today's `sandboxRequestFor` and
then filtered:

```
@vzn/vx#check.bun  today: exit 0, no violations
                   self-link withheld: exit 0, 1 violation
                   openat(<repo>/packages/vx/bunfig.toml) = -1 ENOENT
@vzn/vx#source     both arms: exit 0, no violations
```

Bun probes `bunfig.toml`. `check.bun` grants only
`scripts/bun-floor.ts` and `src/util/**`, and today it passes only
because the root link grants all of `packages/vx`.

## Does anything in the key already cover the linked package?

No. Each part was checked against the source.

- **The project's `package.json` bytes** (`hashProjectPackageJson`).
  These are app's bytes, and `"@x/ui": "workspace:*"` does not change
  when ui's source does. P1's key did not move.
- **The workspace fingerprint** (`workspace/fingerprint.ts`) hashes the
  lockfiles and `pnpm-workspace.yaml` at the root. A source edit changes
  neither.
- **The lockfile claim** (`orchestrator/lockfile-claim.ts`,
  `@vzn/vx-lockfile`). `digest(decode(bytes))` runs over the lockfile
  text only. In `bun.ts` a `workspace:` dependency is a node in the
  lockfile's graph, so app's digest folds ui's **third-party reach**
  (what ui's manifest resolves to), never ui's files. The claim keys the
  installed tree, not workspace package contents.
- **The cascade** (`upstream.ts`, `filterUpstreamHashes`) is the only
  path from P's files into T's key, and it has two gates the
  "any `dependsOn` edge" reading misses:
  - `cache.inputs.tasks` can drop an upstream from the fold at any hop.
  - An upstream with no `cache` still gets a hash (`execute-task.ts`
    computes it for every exec task), but that hash folds no files. So
    an edge to an uncached `P#build` carries none of P's content.

## Options considered

**(a) Report a read under an unkeyed linked package, keep the grant.**
Rejected because correctness would ride on the report channel, which is
the one thing this design cannot lean on.

- An **allowed** read raises no denial. Seatbelt logs denials, and its
  store is lossy under load (Decision, item 586). On Linux the strace
  log does record successful `openat`s (the probe's trace holds
  `packages/ui/src/index.js` returning fd 7), but strace is optional.
  `runSandboxed` skips it when absent and keeps enforcing.
- So (a) catches the hole on Linux with strace, and on no other
  configuration.
- Cost: none for setup. The report walk would parse success lines too,
  which the log already holds (`--seccomp-bpf` stops on every `openat`),
  so it adds one regex per line.

**(b) Deny: grant a linked package only when the task's key covers it.
Recommended.**

- Correctness: enforced by bwrap and seatbelt, independent of any
  report. A denied read cannot shape the output, so even a task that
  copes with the ENOENT caches a result that is right for its key.
- Cost: one memoized structural walk per run, and fewer binds than
  today.
- What breaks: a sandboxed, cached task that reads a sibling it has no
  keyed edge to. That is exactly the stale-hit shape, so it should
  break. Also a tool that walks the root `node_modules` into an
  unrelated package; its remedy is `ignore.read`.

**(c) Fold the linked packages' files into the key automatically.**
Rejected: this is the inference CLAUDE.md rejects.

- It would be correct at package level.
- But it keys each task on every linked package's whole tree. Under npm
  or Yarn that is every package in the workspace (P6), so a README edit
  anywhere re-runs every sandboxed task.
- Cost: hashing every linked tree per task. Git OIDs make that cheap
  when the tree is clean, but not free.

**(d) Document only.** Rejected. It leaves the correctness page wrong:
its demo is a stale hit under npm and Yarn (P3), and the sandbox would
keep advertising a proof it does not give.

### The Turbo shape, and whether "any `dependsOn` edge" is enough

- **A Turbo repo with `dependsOn: ['^build']`, reading siblings'
  `dist/`.** Covered. `P#build` is cached; `turbo()` gives every mapped
  task `cache` with `**/*` default inputs (`turbo-map.ts`). Its key
  determines `dist/`, and T folds that key. Reading `dist/` after the
  edge is the input-key cascade working, which is legitimate.
- **Turbo's own "just-in-time" packages (no `build`).** `^build` matches
  nothing in P, so T has no key into P and (b) refuses the read. Turbo
  has the same hole and documents the "transit node" pattern for it,
  which is what this repo's `source` tasks are (item 687).
- **Adoption is unaffected.** `turbo()`, `nx()` and `vx init` emit no
  `exec.sandbox` (grep: no `sandbox` in `vx-migrate/src` or
  `workspace/migration.ts`), so only a task someone deliberately
  sandboxed changes behaviour.

"Any transitive `dependsOn` edge into P" is **not** the rule, for three
reasons:

1. The edge must be **folded**. `cache.inputs.tasks` can exclude it at T
   or at any hop.
2. It must reach a task in P that **declares `cache`**. Otherwise P's
   files are in no key (see the cascade gates above).
3. Even then it is **package-level**. It proves that some of P's
   declared inputs are in T's key, not that the file T read is. P5 is
   the counterexample: an edge to `P#source` (`src/**`) and a read of
   `P/README.md`.

That residual is the same class the correctness page already names for
a project's own files ("the check is only as narrow as the grant"). It
is now stated for P too. Reading P's outputs is covered, because
`P#build`'s key determines them.

## Recommendation

(b). Core's implicit dependency grant is bounded by what the task's key
answers for. The user's own grants are untouched and still derive
nothing from `cache`. Relative to today, the rule only ever removes
grants.

### The exact rule

For a sandboxed task T in project A, with `L` = the canonical link
targets `linkedDeps` finds (unchanged):

1. **Self and ancestors are never granted implicitly.** A target equal
   to `realpath(A)`, or containing it, is dropped from `L`. The task's
   own project is governed by its `allow.read` alone. This applies
   whether or not T declares `cache`.
2. **Targets outside the workspace root are granted as today.** They lie
   outside the deny anchor, so the grant is a no-op either way.
3. **Tasks with no `cache`** (persistent dev servers, `check.bun`) are
   granted the rest of `L`. They have no key to be stale, and withholding
   would break every dev server that serves a sibling's source.
4. **Tasks that declare `cache`** are granted target D ∈ `L` only if D is
   the canonical directory of a project in **K(T)**. Every other D inside
   the workspace root is **withheld**.
5. **K(T)**, the keyed projects, is the set of projects of every task U
   reachable from T through the fold relation, where U declares `cache`.
   T itself is excluded. The fold relation:
   - an exec task X (cached or not) folds its `dependsOn` targets as
     selected by X's own `cache.inputs.tasks` (absent means all);
   - a group folds every `dependsOn` target.

   It is the relation `filterUpstreamHashes` and `computeGroupHash`
   apply at hash time, computed on the graph instead of on outcomes.

6. **Withheld targets are reported.** A denial whose real path lies
   under a withheld D is reported alongside those inside A, and the
   usual fail-on-violation policy applies. The orchestrator appends one
   line per withheld package hit, in the shape of
   `untouchedPlaceholderLine`, and only when such a violation exists, so
   it never reddens a pass:

   > vx: `@x/app#test` read `packages/ui` through `node_modules/@x/ui`,
   > and its key folds no cached task of `@x/ui`, so an edit there would
   > not re-run it. Add a `dependsOn` edge that reaches one (`^build`
   > where `@x/ui#build` keys its sources, or a `source` task), or grant
   > and key the files yourself (`allow.read` plus
   > `cache.inputs.workspaceFiles`).

`workspaceFiles` does **not** unlock a package grant. It is a cache
declaration, and letting it widen the sandbox is the coupling the owner
removed on 2026-09-05. The explicit route (`allow.read` plus
`workspaceFiles`, as `vx-docs` already does) keeps working, because
user grants are untouched.

### Where it lives

- **`orchestrator/upstream.ts`.** Split the selection out of
  `filterUpstreamHashes` into a node-level
  `selectFoldedDeps(deps: TaskNode[], filter, selfProject, selfId)`.
  The hash path maps the selection to hashes and K(T) walks it. That
  leaves one copy of the matcher; the CLAUDE.md rule is to suspect a
  second copy first.
- **`orchestrator/keyed-projects.ts` (new).** K(T) as a lazily memoized
  walk over the run's `TaskGraph`, keyed by task id. Only tasks that
  execute ask for it, so a warm all-hit run pays nothing.
- **`orchestrator/sandbox-request.ts`.** `sandboxRequestFor` gains
  `keyed: ReadonlySet<string> | undefined`, with `undefined` meaning an
  uncached task. `linkedDeps` returns targets split into
  granted / withheld, by canonical directory equality with the
  projects' canonical directories. Both call sites pass it: the cached
  path through the executor, and the persistent path, which always
  passes `undefined`.
- **`exec/executor.ts`, `ExecuteSandbox`.** Add
  `readonly reportLinked: readonly string[]` (additive: `reportWithin`
  keeps its type, and `@vzn/vx-reapi` reads neither field).
  `exec/sandbox-violations.ts`'s `withinReported` keeps a violation
  under `within` or under any `reportLinked` entry.
- **`execute-task.ts`** appends the hint line. It is stale-hit-critical
  only in the safe direction: it touches the failure path and never a
  save.

### Performance

- **Warm path:** unchanged. A hit computes no sandbox request.
- **Per executed sandboxed task:** `linkedDeps` does the same readdir and
  realpath calls it does today (0.57 ms min above). It adds a set lookup
  per link and binds fewer paths.
- **K(T):** one walk of the reachable subgraph per run, memoized, over
  sets of project directories. This is an estimate, not a measurement:
  well under a millisecond on this repo's graph. The item measures it on
  `vx-bench`'s 1,000-package synthetic workspace, plus an A/B of the
  gate's wall time (min-of-N, before-arm from a worktree).
- **The report walk:** the strace parse is unchanged. `withinReported`
  compares against 1 + |withheld| prefixes instead of 1.

### macOS seatbelt and `weakerWhenNested`

- **Seatbelt.** Enforcement is the profile's own allow list, the same
  mechanism that grants links today, and seatbelt matches the resolved
  path, so a read through the link is judged at `packages/ui`.
  Correctness therefore does not depend on the report. What the lossy
  log (item 586) can drop is the violation line and so the hint: the
  task still fails on its own ENOENT, and is never cached. A task that
  swallows the ENOENT and succeeds produced an output that cannot depend
  on P, which is correct for its key.
- **CI coverage on darwin.** CI runs the sandbox e2e suite on Linux only
  (`tests/helpers/sandbox-gate.ts`). The seatbelt line shape is held
  instead by a synthetic row through `reportableViolations` (R9).
- **`weakerWhenNested`.** On Linux it changes only how `/proc` is
  mounted (SRT 0.0.76 `linux-sandbox-utils.js`: `--bind /proc` instead of
  `--proc`). The filesystem deny, and so this rule, is identical in both
  modes. A nested vx inside a sandboxed task sees a withheld sibling as a
  dangling link; `linkedDeps`'s `realpath(...).catch` drops it, so the
  inner run grants nothing extra. macOS cannot nest, as today.

### What this repo's configs need

Item 687 already made every consumer of a sibling's source key it:
`install` → `^build` → `<dep>#build` → `<dep>#source`, cached on
`src/**`. So under rule 4:

- **Covered:** every plugin's `test` and `lint.oxlint` (`@vzn/vx` via
  `source`), and `vx-docs` and `vx-bench` for the plugins they import.
  All of them `dependsOn: ['install']`.
- **Explicit reads, unaffected:** `vx-docs`'s cross-package reads
  (`SIM_READ`, `../vx/src/**`, `CHOOSING_PROOFS`), which are
  `allow.read` plus `workspaceFiles`.
- **Needs a change under rule 1:** `@vzn/vx#check.bun` (P8). Add
  `bunfig.toml` to its `ignore.read`, or grant it. Any other
  narrow-grant task the gate turns red gets the same treatment. The
  item runs the gate on a checkout with a fresh `bun install` **and**
  on this box's stale root links, because the two lay links out
  differently (P6).
- **Unaffected:** `source` tasks (`true`, `read: []`), in both arms of
  P8.
- **`tests/core-source-key.unsafe.test.ts` stays.** It holds the edges
  for unsandboxed readers too, which no sandbox rule sees.

## Rows (tests)

Each row lists the mutation that must turn it red. A row without one is
a control.

- **R1** (`sandbox-request.test.ts`). Links to a keyed sibling, an
  unkeyed sibling, the task's own project, an ancestor and a target
  outside the root. Asserts the **exact** `baseAllowRead` and
  `reportLinked` sets for a cached task. Red with self-exclusion removed
  (own dir appears); red with the keyed filter ignored (unkeyed sibling
  appears).
- **R2** (same file). R1 with the root reached through a symlink
  (`/tmp/link -> /tmp/real`), the macOS `/var` shape reproduced on
  Linux. Same exact sets. Red if either side of the directory
  comparison is left uncanonical.
- **R3** (`keyed-projects.test.ts`, new):
  - group chain to a cached `source` gives `{ui}`;
  - only an uncached `P#build` reached gives `{}`;
  - T's `inputs.tasks: ['!^build']` gives `{}`;
  - a mid-chain hop with `inputs.tasks: []` stops the walk there;
  - a transitive route through a third project.

  One mutation per guard: count uncached tasks as covering, skip T's
  filter, skip the hop filter, stop at groups.

- **R4** (same file, against the source of truth). For the fixture
  graphs, computes real keys with `run()`:
  - editing an input file of a cached task in each P ∈ K(T) moves T's
    hash;
  - editing any file of a linked P ∉ K(T) does not.

  This holds K(T) to the key itself rather than to its own
  implementation, and it goes red if `selectFoldedDeps` and the hash
  path diverge.

- **R5** (`sandbox-runtime.unsafe.test.ts`). P1 as a row, in two link
  shapes: root (npm/Yarn) and `<project>/node_modules` (pnpm/Bun).
  - `app#test` fails, with exactly one violation under `packages/ui`
    and the hint line naming `@x/ui`.
  - Today it succeeds, and after an edit to ui it is a hit (red).
- **R6** (same file, control). P4: with the `^source` edge the task
  passes, an edit to ui is a miss, and restoring the file restores the
  hit. Passes both before and after.
- **R7** (same file). P3, the correctness demo: `read` = inputs =
  `src/**`, with the root self-link, and `cat banner.txt`. Fails with the
  violation on `banner.txt`. Today it succeeds and gives a stale hit
  (red).
- **R8** (same file, control against over-reach). The same unkeyed read
  from a task with no `cache` succeeds. Red if rule 4 is applied to
  uncached tasks.
- **R9** (`sandbox-violations` unit, both line shapes). A seatbelt
  `deny(1) file-read-data <ws>/packages/ui/src/index.js` record and a
  strace line are both kept when under `reportLinked` and dropped when
  under an unrelated sibling. Red with `withinReported` ignoring the
  list.

## What's out of scope

- **File-level coverage** (the P5 residual). There are two ways to close
  it, and both are rejected here:
  - Derive per-prefix grants from the keyed tasks' input globs. That
    derives sandbox grants from `cache` declarations file by file, the
    2026-09-05 coupling, and refuses resolver probes (`tsconfig.json`,
    `bunfig.toml`) that users would then have to key.
  - A Linux-only allowed-read check over the strace log. That splits
    the platforms, and macOS has no equivalent channel.

  Documented as a limit next to the existing "grant wider than inputs"
  bullet.

- **Unsandboxed tasks.** The same read is a stale hit there, and it
  always was. The contract is declared inputs; the sandbox is the opt-in
  proof.
- **Project constraints.** "May app depend on ui" is a lint policy
  (capability audit § Project constraints), not a key question.
- **Third-party `node_modules` contents.** These are keyed by the
  lockfile (the fingerprint or the claim), unchanged.
- **Executors that ship the sandbox request elsewhere.** They receive
  the narrower list and the new field; whether they enforce it is
  theirs.
- **A shorthand for `source` tasks.** This repo carries eight identical
  lines per package. Not proposed until the hint line shows real users
  hitting it.

## Open questions

1. **Owner sign-off on the 2026-09-05 boundary.** The user's grants
   still derive nothing from `cache`. But core's implicit dependency
   grant becomes bounded by the key, and declaring `cache` on a task
   narrows that grant (rule 3 against rule 4). The recommendation holds
   that "`cache` may only narrow core's own grant, never widen anyone's"
   is compatible with the decision. The owner should confirm, and the
   Decisions list should record it either way.
2. **Should rule 4 cover uncached tasks through `dependsOn` reach?**
   Recommended no (R8): there is no key to be wrong, and dev servers
   would break. Revisit only if an uncached-but-sandboxed use shows a
   need.

## Why this is the right move

- Correctness comes from **enforcement**, not a report. It holds with
  seatbelt's lossy log and without strace, where (a) would not.
- It **never grants more than today**. Every change is a removal, and
  the one it adds to the report is the removal's own explanation.
- This repo already pays the price: item 687's `source` tasks are the
  edges the rule asks for. The one fallout, `check.bun`, is a narrow
  grant that was silently widened.
- **Zero warm-path cost.** It touches only tasks that execute, and they
  bind fewer paths.
- It fixes a false claim on the site. The correctness demo is a stale
  hit under npm and Yarn today.

## Item split

1. **Withhold the self-link (rule 1).** Size S, about half a day.
   - Code: `linkedDeps` drops the project's own canonical dir and any
     ancestor of it.
   - Rows: R1's self parts, R2, R7.
   - Repo: whatever the gate turns red, starting with `check.bun`.
   - Docs: `guides/sandboxing.md` ("The one grant vx makes for you"),
     `learn/correctness.mdx` (the `node_modules` bullet and the demo's
     claim), `schema.md` about line 978, `cli.md` about line 988, and
     `flows.md` about line 218.
   - Can ship alone. It is independently a stale-hit fix.
2. **Bound the linked grant by the key (rules 2–6).** Size M, 1 to 1.5
   days.
   - Code: `selectFoldedDeps` split, `keyed-projects.ts`,
     `sandboxRequestFor` signature and both call sites,
     `ExecuteSandbox.reportLinked` (façade type; module page),
     `withinReported` over the list, and the hint line.
   - Rows: R1 (keyed parts), R3, R4, R5, R6, R8, R9.
   - Perf: the K(T) cost on `vx-bench`'s 1,000-package workspace, and an
     A/B of the gate's wall time.
   - Docs: the same pages, plus `caching.md` § Cross-project boundaries
     (the sandbox now enforces "only through `dependsOn`" for sandboxed
     cached tasks) and the P5 residual as a stated limit.
   - STATUS: Next 17 → DONE, and a Decisions entry for open question 1.
