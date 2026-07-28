# Turbo / Nx parity: behavioural contracts vx does not pin (2026-07)

Two independent research passes, run 2026-07-28 against the current upstream
trees, cataloguing behaviour those runners' own suites pin that vx has no
equivalent test for. Commissioned by the owner directive _"Check nx and turbo
repo make sure we cover everything."_

**This does not replace `docs/design/turbo-nx-test-gaps.md` (2026-05); it
corrects and extends it.** The prysk/cram `.t` integration tests that document
cites **no longer exist** in `vercel/turborepo` — they were ported to Rust at
`crates/turborepo/tests/*.rs` (70 files, 16.6k lines), which is what the Turbo
half below cites. The fixtures still live at
`turborepo-tests/integration/fixtures/`.

## Discipline both passes were held to

- Every item grepped against `tests/` and `packages/cloud/tests/` **before**
  being listed. A catalogue padded with already-covered items is worse than a
  short honest one.
- Items already recorded as deliberate divergences in `docs/comparison.md` or
  the 2026-05 doc are excluded.
- Each pass ends with a **"checked and already covered"** table (21 rows for
  Turbo) and a **"deliberately not listed"** section naming the owner-rejected
  features (`namedInputs`, `targetDefaults`, token substitution, executor
  batching, globals, `$TURBO_ROOT$`, env modes, prune, daemon, `//` root
  tasks). Those exist so the next pass does not re-tread this ground.
- HIGH means _could be a wrong cache hit, a silently wrong selection, or lost
  work in distributed mode_ — not "looks important".

Counts: Turbo **6 HIGH / 12 MED / 7 LOW**; Nx **9 HIGH / 7 MED / 3 LOW**.

## The finding both passes reached independently

**A negation-only `cache.inputs.files` folds ZERO file inputs.**
`resolveFiles()` does `if (positive.length === 0) return []`, so
`files: ['!**/*.spec.ts']` — which every gitignore-trained reader parses as
"everything except specs" — silently means _nothing_. The task's key then stops
moving with its source: a permanent stale hit from a config that reads fine and
passes validation.

Turbo makes this a hard config error (two tests in `bad_turbo_json_test.rs`);
Nx's `filterUsingGlobPatterns` pins the opposite semantics explicitly ("when
negative patterns" → everything minus these). Both passes reproduced it against
a real fixture, one through `resolveFiles` directly and one end-to-end through
the CLI.

Two reviewers arriving at the same defect from different upstreams, by
different methods, is the strongest signal either pass produced.

## Reproduced end-to-end against the real CLI

These are **live defects**, not theoretical gaps. Each was run against a
throwaway fixture, not reasoned about.

1. **A gitignored file named explicitly in `cache.inputs.files` contributes
   nothing to the key.** vx's file universe is
   `git ls-files --cached --others --exclude-standard`, and user globs only
   _filter_ that set — so an ignored path can never be filtered back in.
   Declared a gitignored input, edited v1→v2: the second run reported
   `up-to-date` and left the output at v1, while replaying the cached stdout so
   the run _looked_ like it executed. Turbo pins the opposite explicitly
   (`gitignored_inputs_test.rs`). The existing vx test covers only the broad
   `**/*` case — which is correct behaviour, and hides this one.

2. **Two tasks in one project with overlapping `outputs.files` destroy each
   other's outputs while the run stays green.** A hazard vx _created_ with its
   strict output-ownership rule: Turbo restores additively and cannot hit it,
   which is why no Turbo test surfaces it and why this needs its own pin.
   Reproduced at `--concurrency 1`: `2 success · 2 local` hits with
   `dist/one.txt` simply gone, including after wiping `dist/` and re-restoring.
   Under real parallelism, which task survives is a race.

3. **Negation in `cache.outputs.files` is a total silent no-op**, unlike
   `inputs.files`, which does split on `!`. The excluded subtree is both
   archived into every cache entry _and_ deleted before every exec and restore.
   Both halves verified, including the `output_files` rows.

4. **`--affected` and the cache key disagree about what an input is.**
   `projectsContaining` knows only project _directories_, so a change to a
   `cache.inputs.workspaceFiles` target or to any package-manager lockfile
   busts every affected cache key while selecting **zero** projects —
   `vx run test --affected` exits 0 having run nothing. Nx runs four locators
   for exactly this reason. `docs/cli.md:139` states the violated principle
   verbatim: _"input hashing sees it, so `--affected` must too."_

5. **`ESSENTIAL_ENV` forwards `NODE_OPTIONS`, `LC_ALL` and `CI` to every
   child, and no cache key can see them.** An implicit 24-name pass-through
   nobody declared and nobody can remove, three entries of which change what a
   task _produces_ — `NODE_OPTIONS=-r ./hook.js` changes emitted bytes, locale
   changes `sort` order. `docs/schema.md` is the tell: the `passThrough` bullet
   says "NOT folded into the cache key", the essentials bullet directly above
   says nothing.

6. **An arbitrary file write via `git diff --output=<path>`.** An option-like
   `--affected=<base>` is passed through to git, which treats it as an option;
   the write was reproduced in a throwaway repo. **Not exploitable at HEAD** —
   but only because `verifyRef` happens to run first and its exit 1 is fatal, a
   branch that was itself rewritten on 2026-07-26. Nx rejects option-like refs
   explicitly, before invoking git.

## Recorded as landmines, not live bugs

Called out separately because inflating them would devalue the list above.

- Without `--frozen`, every distributed agent live-evaluates its own TypeScript
  configs under its own environment. `dist-hash-equality.test.ts` scopes itself
  to "same configs" as a _precondition_; nothing tests, detects, or warns about
  the diverged case.
- The `--affected` memo is sound _today_ precisely because the probe
  environment is ambient; it becomes wrong the moment that stops being true.
- `src/workspace/affected.ts`'s header comment claims `<since>...HEAD`
  three-dot semantics while the code runs a two-dot `git diff <since>`. A
  doc/code contradiction worth fixing independently of any test.

## Negative results worth keeping

- **vx's flakiness rule has no gap against Nx's.** It matches Nx Cloud's
  same-key-mixed-outcome signal and adds a within-run-retry signal Nx lacks.
- Symlink hashing, deleted/renamed/gitignored file handling in the hasher,
  `validateOutputs`, `--affected` + `--filter` union semantics, mixed
  valid/malicious tar entries, malformed-manifest error paths, absolute paths
  in inputs/outputs, and env-value plaintext capture were all checked and found
  **already covered**.

## Deliberately not acted on here

These are source defects, not test gaps. Fixing the negation case changes cache
keys for every affected config, so it needs its own wave with a
`CACHE_VERSION` decision — see `.claude/skills/bump-cache-version`. Landing
them inside a test-expansion change would bury that decision.

---

The full per-item catalogues follow, each in the shape
_upstream behaviour → vx equivalent → existing coverage → proposed test →
value_, with source citations pinned to the commits named above.

---

## Index

**HIGH (6)** — four of the six were reproduced end-to-end against the real CLI;
three are wrong cache hits / wrong output trees.

| #   | Finding                                                                                   | Reproduced?               |
| --- | ----------------------------------------------------------------------------------------- | ------------------------- |
| H1  | A gitignored file explicitly named in `cache.inputs.files` contributes nothing to the key | yes — stale hit           |
| H2  | Negation-only `cache.inputs.files` (`['!dist/**']`) hashes ZERO files                     | yes — permanent stale hit |
| H3  | `--affected` is a two-dot diff, so a diverged base marks other people's packages affected | yes — over-selection      |
| H4  | Two tasks with overlapping `outputs.files` delete each other's outputs; run stays green   | yes — wrong output tree   |
| H5  | `--filter .` silently selects the whole workspace                                         | yes — wrong selection     |
| H6  | Negation in `cache.outputs.files` is a silent no-op (captured AND deleted)                | yes — inverted intent     |

**MEDIUM (12)**: M1 DOT escaping · M2 recursive `vx run` · M3 `pkg#task` vs
`--filter=!pkg` · M4 anchored/bare cross-product · M5 odd filenames in input
hashing · M6 empty `name` field · M7 watch edit-during-initial-run · M8 watch
same-content write · M9 task stdin EOF · M10 `--concurrency 50%` / range refs ·
M11 `cache.inputs.tasks` typo decoupling · M12 output shape transitions.

**LOW (7)**: L1 symlink hash semantics · L2 `../` path filters · L3 root-member
affected · L4 fingerprint doc drift · L5 watch across `git checkout` · L6 prune
racing a save · L7 control-character log replay.

Two sections at the end record what was **checked and already covered** (21
contracts) and what is **explicitly not a gap** (Turbo features vx has rejected),
so the next reader does not re-derive them.

---

## HIGH

### H1. A gitignored file that is EXPLICITLY declared in `cache.inputs.files` silently contributes nothing to the cache key

- **Turbo behaviour**: `crates/turborepo/tests/gitignored_inputs_test.rs:10`
  `test_gitignored_file_in_explicit_inputs` — writes `packages/util/internal.txt`,
  adds it to `.gitignore`, declares it in the task's `inputs`, and asserts
  (a) `internal.txt` **appears in the run summary's `inputs` map** ("internal.txt
  should appear in inputs despite being gitignored") and (b) editing it produces a
  **cache miss** with a different per-file hash. `final_hash_contract.rs:365`
  `gitignored_explicit_input_hashes` snapshots the same transition at the
  task-hash level. So in Turbo an explicit `inputs` entry **overrides** gitignore.
- **vx equivalent**: `src/cache/inputs.ts` `resolveFiles` — the file universe comes
  from `git ls-files --cached --others --exclude-standard`, and the user's
  `inputs.files` globs are a _filter on top of that set_. An ignored path is never
  in the set, so it can never be filtered back in.
- **Existing vx coverage**: NONE for the explicit-declaration case.
  `tests/inputs.test.ts:429` `gitignored files are excluded (workspace-root
.gitignore)` pins the **broad-glob** case (`files: ['**/*']`), which is the
  correct-and-desirable behaviour. No test declares an ignored path _by name_.
- **Reproduced** (real CLI, `packages/a` declares `inputs.files:
['generated.txt']`, `outputs.files: ['out.txt']`, `.gitignore` contains
  `packages/a/generated.txt`):

  ```
  RUN1  → 1 miss,  out.txt = v1
  edit generated.txt v1 → v2
  RUN2  → ┌─ a#build > up-to-date • 77a8d71a   … 1 up-to-date
          out.txt = v1        ← STALE
  ```

  The replayed stdout even prints the task's `RAN` line, so the run _looks_ like
  it executed.

- **Proposed test** (`tests/stale-hit.test.ts`, alongside the three existing
  real-CLI stale-hit cases): build the fixture above, run, change the gitignored
  declared input, run again, assert the second run is **not** a hit and that
  `out.txt` holds the new content. Then a second unit case in
  `tests/inputs.test.ts`: `resolveInputs({ inputs: { files: ['secret.txt'] } })`
  where `secret.txt` is gitignored returns it — or, if the decision is to keep
  the current semantics, a test that pins the **loud failure** instead (see
  "design options" below).
- **Design options** (this needs an owner call, not just a test): (a) match Turbo —
  union `git ls-files` output with an explicit non-glob `inputs.files` entry that
  exists on disk; (b) keep the exclusion but make it **loud** — the loader or the
  resolver errors when a literal (metacharacter-free) `inputs.files` entry
  resolves to a path that exists on disk but is gitignored. Either kills the
  silent stale hit; (b) is cheaper and matches vx's "explicit over magical" rule.
  Doing nothing is the only bad option, because the failure mode is exactly the
  class `docs/caching.md` opens by calling "the worst failure mode of a task
  runner".
- **Value**: HIGH — reproduced wrong cache hit, no attacker, ordinary config
  (`dist/`-style generated inputs consumed by a downstream task are gitignored in
  most repos).

### H2. A negation-only `cache.inputs.files` hashes ZERO files — permanent stale hit

- **Turbo behaviour**: `crates/turborepo/tests/bad_turbo_json_test.rs:338`
  `test_structured_startup_rejects_negative_only_globs_without_defaults` and
  `:371` `test_structured_jit_rejects_negative_only_globs_without_defaults` —
  `inputs: [{ mode: …, globs: ["!src/generated/**"] }]` is a **hard config error**
  ("negative" + "withDefaults" in stderr). Turbo refuses a glob list that can
  only subtract, because with no positive term it selects nothing. (The legacy
  form's answer is the `$TURBO_DEFAULT$` sentinel — an explicit "start from the
  defaults, then subtract".)
- **vx equivalent**: `src/cache/inputs.ts:500` `resolveFiles` splits entries into
  `positive` / `negative` and then `if (positive.length === 0) return []`. The
  loader (`src/workspace/project-loader.ts`) validates `inputs.files` is a
  `string[]` but says nothing about its content.
- **Existing vx coverage**: NONE. `tests/inputs.test.ts` covers negation only in
  the _mixed_ form (`['src/**', '!**/*.test.ts']`, lines 323 and 533). Nothing
  exercises an all-negative list.
- **Reproduced** (`cache: { inputs: { files: ['!dist/**'] }, outputs: { files:
['out.txt'] } }`):

  ```
  RUN1                → 1 miss,   out.txt = v1
  edit src/in.txt v1 → v2-CHANGED
  RUN2                → 1 up-to-date  (hit),  out.txt = v1   ← STALE, forever
  ```

  A reader of `['!dist/**']` means "everything except dist" — the exact reading
  gitignore syntax trains them into. vx silently means "nothing".

- **Proposed test**: (a) a `tests/project-loader.test.ts` case asserting a
  `cache.inputs.files` list whose every entry starts with `!` is REJECTED at load
  with a message naming the task and suggesting `['**/*', '!dist/**']`; (b) a
  `tests/inputs.test.ts` unit case pinning that a _mixed_ list still subtracts
  (control, already passing) so the fix cannot over-reject.
- **Related, same mechanism, worth a second case**: a positive glob that matches
  nothing (a typo — `files: ['sr/**']`) also yields zero hashed files and the
  same permanent hit. Rejecting that statically is not possible, but a run-time
  **warning** ("task a#build declared inputs.files but resolved 0 files") is
  cheap and would have caught both shapes. Consider pinning the warning.
- **Value**: HIGH — reproduced permanent wrong cache hit from a config a user
  would reasonably write.

### H3. `--affected` uses two-dot `git diff <base>`, so a diverged base branch marks OTHER people's packages affected — and the source comment claims the opposite

- **Turbo behaviour**: `crates/turborepo/tests/affected_test.rs`
  `test_affected_merge_base_diverged` — branch `my-branch` changes `apps/my-app`;
  `main` then independently changes `packages/util`; back on `my-branch`,
  `turbo ls --affected` asserts `my-app` is listed and **`util` is NOT**
  ("util changed on main, not branch"). Turbo diffs from the **merge base**
  (three-dot), which is also what `TURBO_SCM_BASE`/`TURBO_SCM_HEAD` feed
  (`test_affected_scm_base_override`, `test_affected_scm_head_override`).
- **vx equivalent**: `src/workspace/affected.ts:52` runs
  `git diff --no-renames --relative --name-only -z <since>` — a **two-dot** diff
  of `<since>`'s tip against the working tree. The file's own header comment
  (line 4) says _"The diff is `<since>...HEAD` plus working-tree changes"_ —
  three-dot notation, which the code does not implement. `docs/cli.md` §
  `--affected` also doesn't state which.
- **Existing vx coverage**: NONE. `tests/affected.test.ts` covers
  committed-only history, staged-only, working-tree-only, deletes, renames,
  many-commit ranges and `defaultAffectedBase` — but every case is a **linear**
  history. No test creates a second branch that moves the base ref forward.
- **Reproduced**:

  ```
  main:      init
  my-branch: change packages/app/src/in.txt   (commit)
  main:      change packages/util/src/in.txt  (commit)
  my-branch: vx run build --affected=main --dry
             →  app#build   cache miss — would exec
                util#build  cache miss — would exec     ← util changed on MAIN
  git diff --name-only main        → app, util      (what vx runs)
  git diff --name-only main...HEAD → app            (merge-base / turbo)
  ```

- **Why it matters**: the flagship CI recipe is
  `vx run test --affected=origin/main` on a PR. Every merge into `main` while
  the PR is open widens vx's affected set by _everyone else's_ changes, so on a
  busy monorepo `--affected` converges on "run everything" — the exact cost the
  flag exists to avoid. The direction is safe (over-selection, never a stale
  hit), which is why it can sit unnoticed indefinitely.
- **Proposed test** (`tests/affected.test.ts`): build the two-branch fixture
  above and assert `affectedProjects({ since: 'main' })` contains the
  branch-changed project and **not** the main-only one; plus a control that a
  working-tree edit on the branch is still picked up (merge-base diff must not
  drop uncommitted work — this is why the fix is
  `git merge-base <since> HEAD` then diff against that, **not** a bare
  `git diff <since>...HEAD`, which would drop the worktree).
- **Value**: HIGH — silently-wrong (over-broad) selection on the documented CI
  path, plus a source comment that asserts the behaviour the code lacks. Fixing
  it is ~3 lines (`git merge-base --fork-point`-less: `git merge-base <since>
HEAD` → diff against the result); the test is the load-bearing part.

### H4. Two tasks in one project declaring OVERLAPPING `cache.outputs.files` destroy each other's outputs — the run stays green

- **Turbo behaviour**: Turbo restores **additively** and never wipes, so
  overlapping outputs are merely ambiguous, not destructive. It still pins that
  output paths are attributed per-task/per-package:
  `crates/turborepo/tests/run_caching.rs:1348`
  `test_dependency_outputs_distinguishes_cross_package_output_paths` (two
  packages each writing `dist/generated.txt` must stay distinguishable), and
  `:1708` `test_gitignored_output_deletion_restores_from_cache` (a deleted
  output is restored on a hit). vx's _strict output ownership_
  (`docs/caching.md` § "Strict output ownership": declared outputs are wiped
  before exec **and** before restore) is a vx-only rule — and therefore a
  vx-only failure mode that no Turbo test can surface. That is precisely why it
  needs its own pin.
- **vx equivalent**: `src/cache/inputs.ts` `cleanOutputs`, called from
  `src/orchestrator/execute-task.ts` on both the miss path (pre-exec) and the
  hit path (pre-restore), whenever `willWrite`.
- **Existing vx coverage**: NONE. `tests/inputs.test.ts` pins that `cleanOutputs`
  removes declared globs, does not touch undeclared files, and respects project
  boundaries — all _single-task_ properties. No test has two tasks whose output
  globs intersect.
- **Reproduced** (one project, `gen1` → `dist/one.txt`, `gen2` → `dist/two.txt`,
  **both** declaring `outputs.files: ['dist/**']`, run with `--concurrency 1` so
  it is deterministic rather than a race):

  ```
  RUN1 cold   → 2 success · 2 miss        dist/ = two.txt          ← one.txt gone
  RUN2 warm   → 2 success · 2 local       dist/ = two.txt
  rm -rf dist
  RUN3 warm   → 2 success · 2 local       dist/ = two.txt          ← restore did not fix it
  ```

  `gen1` reports a green cache hit and its artifact is then deleted by `gen2`'s
  pre-restore clean. Nothing in the run output hints that half the declared
  output tree is missing. Under real parallelism _which_ task survives is
  nondeterministic.

- **Proposed test**: `tests/inputs.test.ts` (or a new `tests/output-ownership.test.ts`)
  — the fixture above, driven through the real orchestrator at `--concurrency 1`,
  asserting `dist/one.txt` **and** `dist/two.txt` both exist after a cold run and
  after a warm restore. It will fail today; that is the point. Pair it with a
  loader-level case once the remediation is chosen.
- **Remediation options** (needs an owner call): (a) reject at config load —
  two tasks in the same project whose `outputs.files` glob sets can intersect is
  a config error (cheapest, matches "explicit over magical", and overlapping
  outputs are almost always a modelling mistake); (b) narrow the clean to the
  files the task's own cache entry recorded (`output_files` rows) rather than
  re-globbing, which keeps the strict-ownership guarantee for a task's own
  files without claiming its siblings'; (c) document the hazard and pin (a
  test that asserts today's destructive behaviour, so at least it is a decision).
- **Value**: HIGH — green run, silently wrong output tree, ordinary config (two
  codegen tasks writing into one `dist/`), and it is a hazard vx _created_ with
  a rule it advertises as a differentiator.

### H5. `--filter .` is accepted, undocumented, and silently selects the ENTIRE workspace

- **Turbo behaviour**: `crates/turborepo/tests/infer_pkg_test.rs` —
  `test_infer_from_packages_subdir` (`-F '{./util}'` run from `packages/`
  selects `util`), `test_filter_sibling_directory` (`-F '../apps/*'` from
  `packages/` selects `my-app`), `test_cwd_overrides_inference`. Turbo resolves
  path filters **relative to the invocation cwd**, so `.`/`./x`/`../x` mean what
  a shell user expects. pnpm's filter DSL — which vx's is modelled on — is the
  same.
- **vx equivalent**: `src/workspace/filter.ts:74` — `if (s.startsWith('./') || s
=== '.') { isPath = true; matcher = path.resolve(workspaceRoot, s) }`. Path
  filters resolve against the **workspace root**. `docs/cli.md` documents
  `./<dir>` as "relative to workspace root" (a deliberate, defensible choice) but
  **does not document the bare `.` form at all** — and `path.resolve(root, '.')`
  is the root itself, which is "at or under" every project dir.
- **Existing vx coverage**: NONE for `.`. `tests/filter.test.ts` covers
  `./<dir>`, `{<dir>}` and an absolute path; no case passes a bare `.`.
- **Reproduced** (workspace with `packages/util` + `apps/web`, cwd =
  `packages/util`):

  ```
  vx run build --filter . --dry   → util#build AND web#build   (2 tasks, exit 0)
  vx run build --dry              → util#build                 (cwd inference, correct)
  ```

  So the flag a user reaches for to _narrow_ to the current package instead
  widens to everything, silently, exit 0. By contrast `--filter ./util` from
  `packages/` fails **loud** (`vx: filter "./util" matched no projects`), which is
  why only the `.` form is dangerous.

- **Proposed test** (`tests/filter.test.ts` + one CLI e2e): assert `parseFilter('.',
root)` / the resolved selection from inside a package dir. Whatever the chosen
  semantics, pin them: either (a) make `.` cwd-relative like the rest of the
  ecosystem (then `--filter .` from `packages/util` selects exactly `util`), or
  (b) reject bare `.` with a message pointing at `--filter ./<dir>` and plain
  cwd inference. Add a `../`-prefixed case at the same time — `--filter '../apps/*'`
  is not recognised as a path form at all today and falls through to the NAME
  matcher.
- **Value**: HIGH — silently-wrong selection, exit 0, no warning, and the
  direction is "runs the whole monorepo when you asked for one package". Lower
  blast radius than a stale hit (nothing is cached wrongly), but there is no
  signal at all that it happened.

### H6. Negation in `cache.outputs.files` is a SILENT NO-OP — the excluded tree is both captured into the artifact and deleted before every run

- **Turbo behaviour**: `crates/turborepo-lib/src/task_graph/visitor/mod.rs:1157`
  `CompiledOutputGlobs::new` splits every output glob on a leading `!` into
  `inclusions` / `exclusions`, and `matches()` returns `false` for any path an
  exclusion matches. `["dist/**", "!dist/cache/**"]` means what it reads like.
- **vx equivalent**: `src/cache/inputs.ts:260` `resolveOutputs` passes
  `args.outputs` **straight to `scanUnion`** with no `!` handling — unlike
  `resolveFiles` (line 500) and `resolveWorkspaceFiles` (line 151), which both
  split on `!`. So a `!`-prefixed entry is compiled as a positive `Bun.Glob`
  whose first literal character is `!`, matching nothing, and the tree the user
  meant to exclude stays fully inside the `dist/**` inclusion. `cleanOutputs`
  (line 285) resolves through the same function, so it deletes it too.
- **Existing vx coverage**: NONE. `tests/inputs.test.ts` exercises negation only
  in `inputs.files`. No `resolveOutputs` / `cleanOutputs` case passes a `!` entry,
  and `docs/schema.md` does not say whether outputs support negation.
- **Reproduced** (`outputs.files: ['dist/**', '!dist/cache/**']`, task writes
  `dist/app.js` and `dist/cache/state.bin`):

  ```
  RUN1                                  → dist/cache/state.bin = INCREMENTAL-STATE
  edit an input → cache miss → RUN2     → dist/cache/state.bin = DELETED
  sqlite output_files rows after a save →  dist/app.js
                                           dist/cache/state.bin   ← captured anyway
  ```

  Both halves of the intent are inverted: the excluded subtree is **archived**
  into every cache entry (artifact bloat, and machine-specific incremental state
  travels through a shared remote cache) and **destroyed** before every exec and
  every restore.

- **Proposed test**: `tests/inputs.test.ts` — `resolveOutputs({ outputs:
['dist/**', '!dist/cache/**'] })` excludes `dist/cache/*`, and `cleanOutputs`
  with the same globs leaves `dist/cache/state.bin` on disk while removing
  `dist/app.js`. Add a `tests/orchestrator.test.ts` e2e asserting a cache hit
  does not resurrect an excluded path. If the decision is instead to _reject_
  `!` in outputs, pin the loader rejection — the one unacceptable outcome is the
  current silent inversion.
- **Value**: HIGH — silent inversion of an explicit user instruction, with a
  destructive side effect (deletes files the user named as "do not touch") and a
  cache-content side effect. Not a wrong _hit_, which is why it is last in HIGH.

---

## MEDIUM

### M1. `--graph` DOT output does not escape task ids

- **Turbo behaviour**: `crates/turborepo/tests/graph_test.rs`
  `test_graph_to_html_escapes_task_names` — a fixture declaring tasks literally
  named ``back`tick``, `interpolate${globalThis.alert(1)}` and
  `break</script>out` is rendered to `--graph=graph.html`; the test asserts the
  dangerous forms are escaped (`break</script>out`) and that the
  template literal is not broken out of.
- **vx equivalent**: `src/cli/plan-format.ts:111` `formatGraphDot` interpolates
  `t.node.id` directly into DOT quoted strings:
  `` `  "${t.node.id}" [label="${label}", …]` `` and `` `  "${dep}" -> "${t.node.id}";` ``.
  Task names are arbitrary object keys in `vx.config.ts`, so `"`, `\` and
  newlines are all reachable.
- **Existing vx coverage**: NONE. `tests/plan-format.test.ts` has
  `emits a valid digraph with edges + per-status fillcolor` but only with plain
  ids.
- **Proposed test**: a `formatGraphDot` case over a plan whose task name contains
  `"` and `\` (and one with a newline), asserting the emitted document still has
  balanced quotes / one statement per line — i.e. escape `\` and `"` in both the
  node id and the label. Same class as the already-fixed GHA workflow-command
  escaping and the `run-report.ts` markdown `cell()` escaper.
- **Value**: MED — produces a malformed artifact rather than a wrong result, but
  vx has shipped this exact bug twice before in sibling formatters.

### M2. A task whose command re-invokes `vx run` is not detected — infinite recursion

- **Turbo behaviour**: `crates/turborepo/tests/recursive_turbo_test.rs`
  `test_recursive_turbo_invocation_detected` — a package script that calls
  `turbo run` is refused with `recursive_turbo_invocations` + "creating a loop".
  `missing_tasks_test.rs:test_no_recursive_turbo_warning_for_missing_task`
  pins the _converse_ (no false positive when the task simply doesn't exist).
- **vx equivalent**: none. `grep` over `src/orchestrator/run.ts`,
  `src/cli/run.ts` and `src/exec/env.ts` finds no depth counter, no sentinel env
  var, no guard. `buildIsolatedEnv`'s essentials allowlist forwards `PATH`, and
  `execute-task` prepends the project's `node_modules/.bin`, so a task whose
  command is `vx run build` re-enters the full orchestrator.
- **Existing vx coverage**: NONE.
- **Proposed test**: an e2e where `a#build`'s command is
  `vx run build` (resolved via the repo's own bin) and the run is expected to
  fail fast with a message naming the loop — implemented by exporting a
  `VX_RUN_DEPTH` (or a run-id sentinel) in `buildIsolatedEnv` and refusing above
  a small bound. Pair with a control that a task calling `vx --version` or
  `vx show` is unaffected.
- **Value**: MED — not a correctness bug, but the symptom (fork bomb / machine
  wedge) is severe and the trigger is an ordinary migration mistake
  (`"build": "vx run build"` left in a package.json script, or a group task
  shelling out).

### M3. `pkg#task` overriding an excluding `--filter=!pkg` is unpinned

- **Turbo behaviour**: `crates/turborepo/tests/pkg_task_entry_test.rs`
  `pkg_task_syntax_filter_exclusion_overridden` — `turbo run web#build
--filter=!web` still runs `web#build` (+ its dep `lib#build`), because a
  `pkg#task` entry adds its package regardless of filter exclusions.
- **vx equivalent**: `src/graph/task-graph.ts:132` `expandRequested` resolves an
  anchored spec directly against `projects`, ignoring `candidates` entirely, and
  `src/cli/run.ts:441` applies project scope to bare names only. So vx already
  behaves like Turbo — but by construction, not by contract.
- **Existing vx coverage**: `tests/task-selection.test.ts` covers "an anchored
  task still runs when a co-requested bare task selects nothing" (an _empty_
  scope) and "an anchored task naming an unknown PROJECT fails the run". No test
  passes a filter that **explicitly excludes** the anchored package.
- **Proposed test**: `vx run a#build --filter '!a'` runs `a#build`; control:
  `vx run build --filter '!a'` does not.
- **Value**: MED — the behaviour is correct today; the test stops a future
  filter refactor from silently making an explicit request unrunnable.

### M4. `pkg#task` does NOT widen the scope of a co-requested bare task (Turbo's cross-product) — unpinned either way

- **Turbo behaviour**: `pkg_task_entry_test.rs`
  `pkg_task_syntax_union_with_filter_cross_product` — `turbo run build
--filter=docs web#lint` runs `docs#build`, `web#lint`, **`web#build`** and
  `lib#build`: `web` enters the package scope via the `web#lint` entry, and the
  bare `build` then fans out over the widened scope.
- **vx equivalent**: `expandRequested` fans a bare name over `candidates`, and
  `candidates` come only from the filter/`--all`/cwd inference — anchored entries
  never widen it. So `vx run build --filter docs a#lint` runs `docs#build` and
  `a#lint`, but **not** `a#build`.
- **Existing vx coverage**: NONE — no test mixes an anchored entry with a bare
  entry under a filter.
- **Proposed test**: pin vx's narrower semantics explicitly (`a#build` is NOT
  pulled in), with a comment citing the Turbo cross-product so the divergence is
  a recorded decision rather than an accident. vx's reading is the more
  predictable one and should not be "fixed" — but it should be stated.
- **Value**: MED — a silent selection difference for anyone migrating a
  `turbo run build web#lint` invocation.

### M5. Input hashing has no coverage for filenames with spaces / quotes / non-ASCII

- **Turbo behaviour**: `crates/turborepo/tests/path_with_spaces_test.rs`
  `test_files_with_spaces_can_be_hashed` — creating `packages/util/with
spaces.txt` must not break hashing or the dry run.
- **vx equivalent**: `src/cache/inputs.ts` enumerates with
  `git ls-files -s --others --exclude-standard -z`, so `-z` should make these
  safe; `src/cache/tar.ts` then has to round-trip the name through the artifact.
- **Existing vx coverage**: partial and in the wrong place.
  `tests/affected.test.ts:240` covers a non-ASCII **changed** filename for
  `--affected`; `tests/inputs.test.ts` and `tests/artifact-roundtrip.test.ts`
  have no space/quote/non-ASCII case at all (grep for `spaces` in those files
  returns nothing).
- **Proposed test**: one `tests/inputs.test.ts` case that a file named
  `with spaces.txt`, one named `café.ts` and one containing a `"` all enter
  the resolved input set and contribute to the key; one
  `tests/artifact-roundtrip.test.ts` case that such names round-trip through
  pack → extract byte- and name-identically (the GNU-tar long-name path is
  already pinned; odd characters are not).
- **Value**: MED — the enumeration side is very likely already correct
  (`-z`), so this is a regression guard on the tar round-trip more than a
  suspected live bug.

### M6. A member `package.json` with an EMPTY `name` is silently skipped

- **Turbo behaviour**: `crates/turborepo/tests/invalid_package_json_test.rs`
  `test_empty_name_field` — setting `"name": ""` on a workspace member is a hard
  failure: `package.json must have a name field`. (`test_malformed_package_json`
  additionally requires the parse error to name the offending path — vx already
  covers that, `tests/workspace.test.ts:186`.)
- **vx equivalent**: `src/workspace/workspace.ts` skips a member with no usable
  name; the decision log records that a nameless member now WARNS, but only when
  the dir has a `vx.config.*`. `""` is falsy, so it takes the same path as
  missing.
- **Existing vx coverage**: `tests/workspace.test.ts:141` covers `'{}'` (no name
  → skipped). No case sets `"name": ""`, and none asserts the warning fires for a
  config-bearing member.
- **Proposed test**: a member with `{"name": ""}` **and** a `vx.config.mjs`
  warns (or errors) naming the directory, rather than vanishing from the project
  list — a vanished project means its tasks silently never run, which
  `tests/task-selection.test.ts` shows vx otherwise treats as a hard error.
- **Value**: MED — silent under-selection, but needs a malformed manifest to
  trigger.

### M7. `vx watch` — an edit landing during the INITIAL run is dropped, and nothing pins it

- **Turbo behaviour**: `crates/turborepo/tests/watch_test.rs`
  `watch_edit_during_build_triggers_rebuild` (an edit while a build is in flight
  must produce a rebuild) and `watch_rapid_edits_produce_single_rebuild`,
  `watch_no_concurrent_builds_of_same_package`, `watch_no_spurious_rebuild_after_settle`.
- **vx equivalent**: `src/cli/watch.ts` installs `fs.watch` handles only after
  the initial run's output is flushed. The decision log (2026-05-26 entry on the
  watch flake) records this as a **known, deliberately-unfixed product gap**:
  "an edit made during `vx watch`'s initial run is silently dropped". Edits
  during _subsequent_ cycles are handled by the `pending` reentrancy guard.
- **Existing vx coverage**: the five `tests/cli.test.ts` watch e2e cases all
  wait for the `watching N project(s)` readiness line before writing — i.e. they
  deliberately avoid the window. Nothing pins the dropped-edit behaviour.
- **Proposed test**: write to a watched input _before_ the readiness line
  appears and assert the documented outcome (today: no re-run; after a fix: a
  re-run). Even pinning today's behaviour is valuable — it converts an
  undocumented data-loss window into a decision with a failing test the day
  someone closes it.
- **Value**: MED — known-open, no test either way, and the symptom ("I saved and
  nothing happened") is the single most confusing thing a watcher can do.

### M8. `vx watch` — a same-content write should not re-execute

- **Turbo behaviour**: `watch_test.rs` `watch_same_content_write_does_not_rebuild`.
- **vx equivalent**: vx re-runs the whole orchestrator on every debounced event
  and lets the cache absorb it — so the _task_ should not re-execute (the key is
  unchanged), but a full discovery + hash cycle does run.
- **Existing vx coverage**: NONE. The watch e2e cases all change content.
- **Proposed test**: `touch`/rewrite an input with identical bytes during a
  watch session and assert the follow-up cycle reports a cache hit and the
  command's side-effect marker did not increment. This is the test that would
  catch a future mtime/ctime-sensitive regression in the `file_hashes` memo
  (which the SCHEMA v24 entry shows is a live risk area).
- **Value**: MED.

### M9. A task that reads stdin must see EOF and never hang

- **Turbo behaviour**: `crates/turborepo/tests/stdin_eof_startup_test.rs`
  `nonpersistent_task_sees_eof_on_stdin_in_stream_mode` — spawns a real run with
  a 15 s timeout and asserts the task printed `stdin bytes=0`, i.e. it saw EOF
  rather than blocking.
- **vx equivalent**: `src/exec/runner.ts:289` and `:440`, and
  `src/exec/sandbox-runtime.ts:97`/`:323`, all pass `stdin: 'ignore'` — the
  correct, hang-free choice.
- **Existing vx coverage**: NONE — `grep stdin tests/runner.test.ts` is empty.
- **Proposed test**: a task whose command is `cat; echo "bytes=$?"` (or
  `head -c 1 || true`) completes well inside the test timeout and reports empty
  stdin — a cheap guard on a property that is one word (`'inherit'`) away from a
  permanent CI hang, in a codebase whose decision log records four separate
  end-of-run hang fixes.
- **Value**: MED.

### M10. `--concurrency` percentage form and range-shaped git bases are rejected — pin the messages

- **Turbo behaviour**: Turbo accepts `--concurrency=50%` and git **ranges** in
  the filter DSL — `crates/turborepo/tests/filter_run_test.rs`
  `test_filter_git_range_two_dot_committed_change` uses `--filter=[HEAD^..HEAD]`
  alongside the single-ref `--filter=[HEAD^]` form.
- **vx equivalent**: `--concurrency 50%` → `vx run: invalid concurrency: 50%`
  (strict decimal-integer parse, a deliberate 2026-07-26 decision);
  `--affected=HEAD~1..HEAD` / `--filter '[HEAD~1..HEAD]'` →
  `vx run: git ref "HEAD~1..HEAD" did not resolve. Pass a branch or commit you
have locally.` Both fail loudly and correctly (verified).
- **Existing vx coverage**: `tests/cli-arg-hygiene.test.ts` pins numeric-flag
  strictness generally; nothing pins these two _migration-shaped_ inputs.
- **Proposed test**: two parser/e2e cases asserting the exact refusal, and
  improving the range message to say a range is not supported (today it says the
  ref "did not resolve", which sends a Turbo migrant looking for a missing
  branch). Cheap, and it is the difference between a 30-second and a 30-minute
  migration.
- **Value**: MED — pure DX, but both are things a Turbo user types on day one.

### M11. `cache.inputs.tasks` entries that match no upstream silently decouple the task

- **Turbo behaviour**: no direct analogue (Turbo has no upstream-hash filter);
  the closest contract is `run_caching.rs:1600`
  `test_dependency_outputs_globs_cannot_select_undeclared_outputs` and `:1667`
  `test_dependency_outputs_selected_dependency_must_declare_outputs`, where a
  `dependencyOutputs.from` selector that matches nothing is a **hard error**
  with remediation text ("Add outputs to … or remove it from
  dependencyOutputs.from"). Turbo refuses to silently narrow a dependency
  selector to nothing.
- **vx equivalent**: `src/orchestrator/upstream.ts` `filterUpstreamHashes` —
  a filter matching no upstream folds zero upstream hashes, which is exactly
  "fully decoupled from my dependencies" and is a documented stale-hit vector
  (`docs/caching.md` step 10).
- **Existing vx coverage**: PARTIAL — `tests/upstream.test.ts` pins
  `a pattern matching no project selects nothing` and `empty filter → nothing
contributes (fully decoupled)` at the unit level. What is missing is the
  **typo** shape: a bare exact name (`['buidl']`) that matches no upstream task,
  and any e2e that shows the resulting stale hit.
- **Proposed test**: an e2e where a consumer declares
  `cache.inputs.tasks: ['buidl']` (typo for `build`), the upstream's source
  changes, and the consumer still hits — then decide whether an
  exact-name entry that matches nothing should warn or error (patterns must stay
  silent, per the 2026-07-10 wildcard decision).
- **Value**: MED — real stale-hit vector, but it needs a typo in an
  advanced-usage field, and half the mechanism is already pinned.

### M12. Sequential restore across an output-shape change (file ↔ directory ↔ symlink)

- **Turbo behaviour**: `crates/turborepo-cache/src/cache_archive/restore.rs`
  `test_sequential_restores_symlink_then_directory` — a restore that must
  replace a symlinked output with a real directory (and the reverse).
- **vx equivalent**: `cleanOutputs` + `extractOutputs`. `cleanOutputs` calls
  `rm(f, { force: true })` on each **file** path resolved from the globs; a path
  that is now a _directory_ where the cached entry holds a file (or a symlink
  where a directory is expected) exercises a different branch of
  `src/cache/tar.ts`.
- **Existing vx coverage**: `tests/tar-security.test.ts` covers the _adversarial_
  symlink cases (pre-existing symlink not followed, directory containment) and
  `tests/cache.test.ts` covers `isOutputsCurrent` mode/size mismatch. Nothing
  drives a _benign_ shape transition end-to-end through two real runs.
- **Proposed test**: run 1 produces `dist/out` as a directory; change inputs so
  run 2 produces `dist/out` as a file; then restore run 1's entry from cache and
  assert the tree matches run 1 exactly. Repeat with a symlink.
- **Value**: MED — the v25 history shows this area produces silent, non-self-healing
  corruption when it goes wrong.

---

## LOW

### L1. Symlinked input hashing semantics are unpinned (and the doc's claim is inaccurate for symlinks)

- **Turbo behaviour**: `crates/turborepo-scm/src/package_deps.rs`
  `test_hash_symlink` — pins that a
  symlink hashes to git's blob of the **link target string**.
- **vx equivalent**: symlinks never get a trusted index OID (per
  `docs/caching.md`), so they fall through to `Cache.hashFile`, which reads via
  `Bun.file` and therefore hashes the **target's content**. Verified: changing
  the content of a file outside the project that a declared input symlinks to
  produces a cache MISS (safer than git semantics, but different from the
  documented claim that the fallback "is the same value the index holds").
- **Existing vx coverage**: `tests/inputs.test.ts` covers broken/cyclic symlinks
  not crashing. Nothing pins the hash _semantics_.
- **Proposed test**: pin the reproduced behaviour (target-content change ⇒ miss)
  and correct the sentence in `docs/caching.md` that claims fallback/index
  parity, adding "except symlinks".
- **Value**: LOW — behaviour is safe; the doc is wrong and the property is
  load-bearing for anyone reasoning about the v20 OID design.

### L2. `--filter` path forms: `../`-prefixed patterns are not recognised as paths

- **Turbo behaviour**: `infer_pkg_test.rs::test_filter_sibling_directory` —
  `-F '../apps/*'` from `packages/` selects `my-app`.
- **vx equivalent**: `src/workspace/filter.ts:74` treats only `./…`, `.`,
  `{…}` and absolute paths as path filters; `../apps/*` falls through to the
  **name** matcher and matches nothing. Verified: fails loud
  (`vx: filter "../apps/*" matched no projects`).
- **Existing vx coverage**: NONE.
- **Proposed test**: pin the loud refusal (and, if `.`/cwd-relativity is fixed
  per H5, decide whether `../` becomes a path form too).
- **Value**: LOW — loud failure, and `docs/cli.md` only ever documents `./<dir>`.

### L3. Root-level file change and the root project's affected status

- **Turbo behaviour**: `filter_run_test.rs::test_filter_git_range_with_unstaged`
  — an unstaged edit to a root-level `bar.txt` puts the root package (`//`) in
  scope; `affected_test.rs::test_root_package_json_change_does_not_globally_affect_tasks`
  pins that a root `package.json` edit does **not** affect every task.
- **vx equivalent**: `src/workspace/affected.ts` `projectsContaining` maps a
  changed path to its deepest owning project; the workspace fingerprint
  (`src/workspace/fingerprint.ts`) deliberately excludes root `package.json`
  ("hashed per-project via projectPackageJsonHash, not here"), so vx already
  matches Turbo's non-global behaviour.
- **Existing vx coverage**: `tests/affected.test.ts` covers "ignores changes
  outside any project directory". No case has the workspace root **as a member**
  (the `"."` member layout this repo itself uses) and asserts that a root-level
  edit selects the root project and nothing else.
- **Proposed test**: a `"."`-member workspace where editing a root file selects
  only the root project, and editing root `package.json` does not select the
  other members.
- **Value**: LOW — believed correct; worth pinning because the `"."` member is
  load-bearing for this repo's own config.

### L4. `docs/caching.md` claims the workspace fingerprint covers `package.json`'s `workspaces` field — it does not

- **Turbo behaviour**: n/a (documentation accuracy item found while checking
  `test_root_package_json_change_does_not_globally_affect_tasks`).
- **vx equivalent**: `docs/caching.md` § Invalidation paths says "Edit
  `pnpm-workspace.yaml` or `package.json`'s `workspaces` field → step 3
  (workspace fingerprint)". `WORKSPACE_FINGERPRINT_FILES` contains no
  `package.json`. Editing the `workspaces` array changes keys only indirectly
  (project membership changes which dirs are nested-project-excluded from a
  parent's globs), which is enough for correctness but is a different mechanism
  than the doc names.
- **Existing vx coverage**: NONE (no test asserts either the doc's claim or the
  real mechanism).
- **Proposed test**: the drift-guard style already used by
  `tests/schema-doc-drift.test.ts` / `tests/output-doc-drift.test.ts` — assert
  the documented invalidation triggers against the real fingerprint file list.
- **Value**: LOW — doc accuracy only; no wrong behaviour.

### L5. `vx watch` and a git branch switch

- **Turbo behaviour**: `crates/turborepo-filewatch/src/hash_watcher.rs`
  `test_switch_branch` / `test_switch_branch_with_inputs` — a `git checkout`
  that rewrites many files
  must re-hash correctly.
- **vx equivalent**: `vx watch` re-runs the orchestrator from scratch each
  cycle, so a checkout is just a burst of fs events collapsed by the debounce.
- **Existing vx coverage**: NONE (the 2026-05 gap doc flagged this; still
  uncovered — the five watch e2e cases only write single files).
- **Proposed test**: during a watch session, `git checkout` a branch that changes
  an input, and assert exactly one re-run with the new content.
- **Value**: LOW — cheap, and it is the one watch scenario where the debounce
  window is stressed by hundreds of simultaneous events.

### L6. Cache pruning concurrent with a save

- **Turbo behaviour**: `crates/turborepo-cache/src/fs.rs` eviction tests
  (`test_evict_removes_stale_entries`, `test_evict_by_size_removes_oldest_first`)
  plus the concurrency suite (`test_concurrent_writes_same_hash`,
  `test_read_during_write`) — all verified present at this commit.
- **vx equivalent**: `Cache.prune` deletes in one transaction + parallel `rm`;
  `restoreOutputs` was hardened in v25 to _throw_ when the artifact vanished
  mid-restore, "reachable via a concurrent `vx cache prune`".
- **Existing vx coverage**: `tests/cache.test.ts` covers concurrent writers and
  concurrent same-hash saves. Nothing runs a prune **while** a save/restore is in
  flight — i.e. nothing exercises the exact race the v25 note names as the
  motivation for the throw.
- **Proposed test**: start a restore, prune the entry underneath it, assert the
  run fails loudly (never a green hit over an emptied tree) and that the cache
  stays internally consistent.
- **Value**: LOW — the guard exists; the race that motivated it is untested.

### L7. `--output-logs` and cache-hit log replay fidelity for control characters

- **Turbo behaviour**: `run_logging.rs::test_log_prefix_modes` asserts the
  **cached log file** contains exactly what the live run printed (no prefixes
  leak into the stored log), and that a replay reproduces it.
- **vx equivalent**: vx stores stdout twice (artifact + `entries.stdout`) and
  replays from SQL on a local hit.
- **Existing vx coverage**: `tests/output-flow.test.ts` and
  `tests/status-line.test.ts` pin the framed shapes; the artifact round-trip
  pins byte-identity for a 20 000-line stdout (2026-07-27 entry). Not covered:
  stdout containing `\r` progress bars, raw ANSI, or a NUL byte surviving the
  SQLite `TEXT` column round-trip identically.
- **Proposed test**: a task emitting `\r`-heavy and ANSI-heavy output; assert the
  replayed bytes equal the executed bytes exactly.
- **Value**: LOW — the 20 000-line pin already covers the volume case; this is
  the encoding case.

---

## Checked and already covered (do not re-derive)

Each of these was a plausible Turbo-sourced gap; a grep of `/home/user/vx/tests/`
showed vx already pins it, so it is deliberately **not** listed above.

| Turbo contract                                                                                  | vx coverage                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Mixed valid + malicious tar entries → whole archive rejected, no partial extract                | `tests/tar-security.test.ts:505`                                                                                                  |
| Malformed member `package.json` error names the offending path                                  | `tests/workspace.test.ts:186`                                                                                                     |
| Absolute paths rejected in `inputs` / `outputs`                                                 | `tests/project-loader.test.ts:172`, `:298`                                                                                        |
| Deleted output restored on a cache hit                                                          | `tests/orchestrator.test.ts:1185`                                                                                                 |
| Env **values** never persisted in plaintext by the key-capture side channel                     | `tests/cache.test.ts:454`                                                                                                         |
| `--affected` + `--filter` stack as a UNION (Turbo intersects)                                   | `tests/filter.test.ts` "stacked: --filter ui --filter [main] unions…" + `docs/comparison.md` § Filter DSL — deliberate divergence |
| Non-existent `--filter` name / typo'd task name refuses the run                                 | `tests/task-selection.test.ts` (5 cases), `tests/cli.test.ts`                                                                     |
| `pkg#task` still runs when a co-requested bare task's scope is empty                            | `tests/task-selection.test.ts`                                                                                                    |
| Negation in `cache.inputs.files` subtracts                                                      | `tests/inputs.test.ts:323`, `:533`                                                                                                |
| gitignored files excluded from a broad `**/*` input glob                                        | `tests/inputs.test.ts:429`                                                                                                        |
| Untracked-but-not-ignored files participate; nested `.gitignore` anchoring; `.git/info/exclude` | `tests/inputs.test.ts` (git ls-files block)                                                                                       |
| Cross-project rename selects both source and destination projects                               | `tests/affected.test.ts`                                                                                                          |
| Non-ASCII changed filename selects its project                                                  | `tests/affected.test.ts:240`                                                                                                      |
| Cycle detection (self, cross-project)                                                           | `tests/task-graph.test.ts`                                                                                                        |
| `dependsOn` rejects filter-only forms (`*`, `^*`, `!name`)                                      | `tests/task-graph.test.ts`                                                                                                        |
| Concurrency cap, `--concurrency 1` serialization, failed-dep skip cascade                       | `tests/scheduler.test.ts`                                                                                                         |
| SIGINT/SIGTERM teardown, no orphaned children                                                   | `tests/signal-handling.test.ts`                                                                                                   |
| Task timeout kills and is not cached                                                            | `tests/task-timeout.test.ts`                                                                                                      |
| `--dry` never executes; `--dry=json` field set                                                  | `tests/cli.test.ts`, `tests/plan-format.test.ts`                                                                                  |
| Lockfile change invalidates every task                                                          | `tests/cache.test.ts` (workspace fingerprint)                                                                                     |
| Config change invalidates the task (resolved-config hash)                                       | `tests/config-staleness.test.ts`                                                                                                  |

## Explicitly NOT a gap (Turbo features vx has rejected or scoped out)

`globalDependencies` / `global.inputs` / `globalEnv` (owner-rejected 2026-07-05,
"no global" — TS presets are the mechanism); `$TURBO_ROOT$` / `$TURBO_DEFAULT$`
token substitution (vx uses real paths + `workspaceFiles`); env modes
(`--env-mode=strict|loose`); framework inference; `turbo prune`; the daemon;
root `//` package tasks and the include-vs-exclude-only filter-mode
classification that gates them; `futureFlags` (`strictTaskEntrypointSelection`,
`experimentalTaskCommand`, structured `inputs` modes / `dependencyOutputs`);
boundaries/tags; `turbo query` (GraphQL); Cargo-workspace support. Each is
already recorded as out-of-scope or rejected in `docs/comparison.md`.

---

# Nx behavioural contracts vx has no test for

Research date: 2026-07-28. Source: `nrwl/nx` @ master, sparse-cloned to
`scratchpad/nx/packages/nx/src` (full source incl. `*.spec.ts`).

**Scope note.** `docs/design/turbo-nx-test-gaps.md` (2026-05-17) already catalogues
~165 properties, and many of its "MISSING" rows have since shipped (`--continue`,
`dependsOn` wildcards, `workspaceFiles`, `runtime` inputs, `--cache-dir`, presigned
URLs, tar-security hardening). This document deliberately does **not** re-list any
of those. Everything below was (a) read out of an Nx spec file in this clone and
(b) grep-verified as uncovered in `/home/user/vx/tests/` and
`/home/user/vx/packages/cloud/tests/`.

Ranked HIGH → MED → LOW.

---

## HIGH

### H1. A negation-only `cache.inputs.files` silently folds ZERO file inputs

- **Nx behaviour**: `filterUsingGlobPatterns` treats positive patterns as an OR-set
  and negative patterns as an AND-filter _on top of the full file set_. Its explicit
  test **`should OR all positive patterns and AND all negative patterns (when negative
patterns)`** (`packages/nx/src/hasher/task-hasher.spec.ts:272`) passes ONLY negative
  patterns `['!{projectRoot}/**/*.spec.ts', '!{projectRoot}/**/*.md']` against four
  files and expects `['root/a.ts', 'root/b.js']` — i.e. **negation-only means
  "everything minus these"**, never "nothing". Implementation
  (`hasher/task-hasher.ts`, `filterUsingGlobPatterns`) short-circuits to the full set
  when the positive list is empty.
- **vx equivalent**: `resolveFiles()` in `src/cache/inputs.ts`. It splits the declared
  list into `positive`/`negative` on a leading `!`, then:

  ```ts
  if (positive.length === 0) return []
  ```

  So `cache.inputs.files: ['!**/*.spec.ts']` resolves to **zero file inputs**. The
  loader (`src/workspace/project-loader.ts:309-390`) validates only that entries are
  non-empty, non-absolute, `..`-free strings — a negation-only list passes.

  **Confirmed by execution**, not by reading — a real git fixture driven through the real
  `resolveInputs`:

  ```
  ["src/**"]                  -> [ "src/a.spec.ts", "src/a.ts" ]
  ["src/**","!**/*.spec.ts"]  -> [ "src/a.ts" ]        # negation works WITH a positive
  ["!**/*.spec.ts"]           -> [ ]                   # negation-only -> ZERO inputs
  []                          -> [ ]
  ```

- **Existing vx coverage**: NONE for the negation-only case.
  `tests/inputs.test.ts:316` (`negation in inputs.files strips matched files`) and
  `:526` (git path) both pass a positive glob alongside the negation.
  `tests/inputs.test.ts:276` pins `files: []` → `[]`, but that is the _explicitly
  empty_ case, not the negation-only case, and it pins the footgun rather than
  guarding it.
- **Proposed test**: In `tests/inputs.test.ts`, `resolveInputs` with
  `inputs: { files: ['!**/*.spec.ts'] }` over a project containing `src/a.ts` and
  `src/a.spec.ts`. Assert the CHOSEN contract explicitly — either (a) `['src/a.ts']`
  (Nx/Turbo semantics: implicit `**/*` base) or (b) the loader throws a `UserError`
  naming the "declare at least one positive glob" rule. Do **not** leave it silently
  returning `[]`. Add the mirror case for `cache.inputs.workspaceFiles`. Pair with an
  e2e in `tests/stale-hit.test.ts`: build with `files: ['!**/*.md']`, change
  `src/index.ts`, re-run, assert vx does NOT report `up-to-date`.
- **Value**: **HIGH** — silently-zero inputs means a task's key never moves with its
  source. That is a permanent stale cache hit, produced by a config that reads
  perfectly reasonable and passes validation. Same failure class as the four
  stale-hit defects fixed 2026-07-26.

### H2. A `runtime` input is memoized per `(projectDir, command)` but never sees the task's `exec.env`

- **Nx behaviour**: Nx has a dedicated regression test — **`should hash a shared
runtime input against each task env`**
  (`packages/nx/src/hasher/native-task-hasher-impl.spec.ts:229`). Two tasks in two
  projects declare the SAME runtime command
  (`node -e "console.log(process.env.SELECTED_ENV)"`) and are hashed in ONE
  `hashTasks` invocation with per-task envs
  (`{'parent:build': {SELECTED_ENV:'parent-env'}, 'child:build': {SELECTED_ENV:'child-env'}}`).
  The test asserts the two `runtime:<cmd>` detail hashes **differ**, and that batching
  produces byte-identical hashes to hashing each task alone. Nx explicitly guards
  against a shared runtime memo collapsing two different envs into one value.
- **vx equivalent**: `runRuntimeCommand()` / `resolveRuntimeValues()` in
  `src/cache/inputs.ts`; memo maps `HashCache.runtime` / `.workspaceRuntime` in
  `src/orchestrator/task-hash.ts:26`. `Bun.spawn(['sh','-c',command], { cwd, ... })`
  passes **no `env`**, so the probe inherits vx's ambient `process.env` — it never
  sees `exec.env.define` / `exec.env.passThrough`. The memo key is
  `projectDir + '\0' + command` (project scope) or the bare command (workspace scope).
- **Existing vx coverage**: NONE. `tests/runtime-inputs.test.ts` covers
  output-change-invalidates, live-under-`--frozen`, non-zero-fails, and
  workspaceRuntime-spawns-once — but nothing pins **which environment the probe runs
  in**, and nothing pins the memo/env coupling.
- **Proposed test**: Two tasks in the SAME project both declaring
  `cache.inputs.runtime: ['printenv MY_PROBE || true']`, with different
  `exec.env.define: { MY_PROBE: 'a' }` / `{ MY_PROBE: 'b' }`. Assert the documented
  contract explicitly: the probe reads the AMBIENT env, so both tasks fold the SAME
  runtime value, and the `define` values do not leak into it. Add a comment at
  `runRuntimeCommand` stating that the memo key is sound _only because_ env is
  ambient — so a future change that threads the task env in must also widen the memo
  key. Also worth an e2e: set `MY_PROBE` in the parent process, run, change it,
  re-run, assert re-execution.
- **Value**: **HIGH** — as a landmine rather than a live bug. Today the memo is sound
  because the env is constant across the run. The moment anyone "improves" the probe
  to run under the task env (an obvious-looking fix), the `(projectDir, command)` memo
  starts serving task A's probe output as task B's cache-key component → wrong key →
  stale hit. Nx has this exact regression test because they hit it. vx has neither the
  pin nor the comment.

### H3. `--affected` is blind to `cache.inputs.workspaceFiles` — a root-anchored declared input changes, the consuming project is never selected

- **Nx behaviour**: `filterAffected` (`packages/nx/src/project-graph/affected/affected-project-graph.ts`)
  runs FOUR touched-project locators, not one. The second is
  **`getImplicitlyTouchedProjects`**, whose whole job is "a changed file that lives
  outside every project dir still marks the projects whose declared `inputs` match it".
  Pinned by `project-graph/affected/locators/workspace-projects.spec.ts:115`
  **`should return projects which have touched files in their target inputs`** and
  `:135` (same via a workspace-level `namedInput`), with the negative control at
  `:159` **`should not return projects which have touched files inputs which are not
used by its targets`**.
- **vx equivalent**: `projectsContaining()` in `src/workspace/affected.ts:131`. It walks
  each changed path's ancestor dirs bottom-up and takes the first project dir hit — so
  a path under no project dir contributes nothing. `cache.inputs.workspaceFiles` /
  `cache.inputs.workspaceRuntime` are exactly the declared inputs that live outside the
  project dir (the documented escape hatch — `docs/schema.md`), and they ARE folded into
  the cache key, so the key busts correctly while the selection does not.
- **Existing vx coverage**: NONE. `tests/affected.test.ts:125`
  (`ignores changes outside any project directory`) pins the _opposite_ — it asserts the
  blindness as intended behaviour, with no `workspaceFiles` declaration anywhere in the
  fixture. `grep -n workspaceFiles tests/affected.test.ts` → no hits.
  `tests/workspace-files.test.ts` never touches `--affected`.
- **Proposed test**: In `tests/affected.test.ts`, a fixture where `packages/app` declares
  `cache.inputs.workspaceFiles: ['tools/**']` and nothing else changes except
  `tools/codegen.js`. Assert `app` IS in `affectedProjects(...)`. Second case: a project
  that does NOT declare a matching `workspaceFiles` glob is NOT selected (the
  `should not return projects which have touched files inputs which are not used` control
  — the fix must not degenerate to "any root change affects everything"). Requires
  threading the loaded configs' `workspaceFiles` globs into `affectedProjects`, which is
  the design decision the test forces.
- **Value**: **HIGH** — `docs/cli.md:139` states the governing principle verbatim:
  _"input hashing sees it, so `--affected` must too."_ This is that principle being
  violated by the one input axis explicitly documented for root-level files. Consequence:
  `vx run test --affected=origin/main` after a `tools/` change runs **nothing**, exits 0,
  CI is green, and the regression ships. Same class as the 2026-07-26 "`--affected` blind
  to non-ASCII filenames" defect, which was rated a real bug and fixed.

### H4. `--affected` is blind to a lockfile / workspace-fingerprint change — a dependency bump selects zero projects

- **Nx behaviour**: the fourth locator in `filterAffected` is `getJSTouchedProjects`
  (`plugins/js/project-graph/affected/touched-projects.ts`), which decomposes into
  `getTouchedNpmPackages` + `getTouchedProjectsFromLockFile`. Pinned by
  `plugins/js/project-graph/affected/lock-file-changes.spec.ts` (591 lines) and
  `npm-packages.spec.ts` (487 lines) — a lockfile edit resolves to the changed npm
  packages and then to every project consuming them.
- **vx equivalent**: `computeWorkspaceFingerprint()` in `src/workspace/fingerprint.ts`
  folds `pnpm-lock.yaml` / `package-lock.json` / `npm-shrinkwrap.json` / `yarn.lock` /
  `bun.lock` / `bun.lockb` / `pnpm-workspace.yaml` into **every** task's cache key. All
  seven live at the workspace root, i.e. inside no project dir, so `projectsContaining`
  returns the empty set for them.
- **Existing vx coverage**: NONE. `tests/affected.test.ts` has a lockfile-adjacent test
  (`:131`, `a vx-lock.json change never marks a project affected`) which pins the
  _deliberate exclusion of vx's own lockfile_ — the package-manager lockfiles are never
  exercised. `tests/cache.test.ts` covers the fingerprint's effect on the KEY only.
- **Proposed test**: `tests/affected.test.ts` — commit a fixture, then modify
  `bun.lock` (or `pnpm-lock.yaml`) at the root and nothing else. Assert the intended
  contract explicitly. Two defensible contracts, pick one and pin it: (a) every project
  is affected (Nx/Turbo `globalDependencies` semantics — the coarse-but-correct match to
  what the fingerprint already does to the keys), or (b) nothing is affected, with the
  reason documented at `projectsContaining` and in `docs/cli.md` next to the
  "input hashing sees it, so `--affected` must too" sentence, which today reads as a
  promise this case breaks.
- **Value**: **HIGH** — a dependency-bump PR (`bun update`, Renovate, Dependabot) is
  precisely the PR you most want `--affected` CI to test, and today it runs zero tasks
  and exits 0. Every cache key in the workspace changed; the selector saw nothing.

### H5. `--affected` does not include DEPENDENTS — a changed library never rebuilds/retests its consumers

- **Nx behaviour**: `filterAffectedProjects` in
  `packages/nx/src/project-graph/affected/affected-project-graph.ts` computes
  `const reversed = reverse(graph)` and traverses from every touched project through the
  reversed edges. "Affected" in Nx is _definitionally_ touched ∪ transitive dependents —
  that is what `nx affected -t test` means. Turbo matches (`--affected` is sugar for the
  `...[base]` filter form, where the leading `...` is the with-dependents operator).
- **vx equivalent**: `docs/cli.md:94` — "`--affected[=<base>]` … Sugar for
  `--filter '[<base>]'`". In `src/workspace/filter.ts:147` `applyFilters` only expands
  dependents when `f.withDependents` is set, which the bare `[<since>]` form does not set
  (only the `...pat` prefix does). So `--affected` selects the changed projects and stops.
- **Existing vx coverage**: NONE asserting either direction for `--affected`.
  `tests/filter.test.ts:131` covers `...pkg includes pkg and transitive dependents` for
  the explicit `...` form only; no test asserts what `--affected` does about dependents.
- **Proposed test**: `tests/filter.test.ts` / `tests/affected.test.ts` — workspace where
  `app` depends on `lib`; change a file in `lib` only; run the `--affected` resolution
  path. Assert the chosen contract for `app`. If the current changed-only behaviour is
  kept, ALSO pin `--filter '...[<base>]'` as the documented dependents form, and say so
  in the `--affected` doc section and in `docs/comparison.md` §"Deliberate divergences"
  (it is not listed there today, so this reads as an oversight rather than a decision).
- **Value**: **HIGH** — this is the semantics of the flagship CI recipe, and vx diverges
  from _both_ reference implementations in the unsafe direction. A change to a leaf
  library does not run the consuming app's tests. Note the divergence may well be
  intentional (vx's answer is "run `--all` and let the cache skip"), but an intentional
  divergence in the CI-critical selector with no test and no entry in the divergences
  inventory is one refactor away from being an accident.

### H6. `!` negation is honoured in `cache.inputs.*` but is a SILENT NO-OP in `cache.outputs.*` — and `vx migrate` generates configs that use it

- **Nx behaviour**: negation in outputs is a first-class, pinned semantic.
  `packages/nx/src/hasher/check-task-files.spec.ts:926`
  **`excludes paths matching a negated glob even when a positive glob matches`** and
  `:940` **`excludes paths inside a negated directory pattern (no glob)`** both assert a
  `!`-prefixed entry subtracts from what the positive output patterns matched. Nx also
  pins the ordering interaction with `..` resolution (`:802`
  `resolves \`..\` before applying a negated exclusion`).
- **vx equivalent**: `src/cache/inputs.ts`. Four resolvers, two behaviours:
  - `resolveFiles()` (`inputs.files`) — splits on a leading `!` into
    `positive`/`negative`, negatives become exclude globs. **Honoured.**
  - `resolveWorkspaceFiles()` (`inputs.workspaceFiles`, line 150-160) — same split.
    **Honoured.**
  - `resolveOutputs()` (`outputs.files`, line ~285) — `scanUnion(args.outputs, ...)`
    with the raw list, **no split**. Ignored.
  - `resolveWorkspaceOutputs()` (`outputs.workspaceFiles`, line 306-312) —
    `scanUnion(args.outputs, [], ...)`, **no split**. Ignored.

  Verified empirically that this is a dead pattern, not a differently-spelled one:
  `new Bun.Glob('!dist/**/*.map').match('dist/a.map')` → `false`;
  `.match('!dist/a.map')` → `true`. Bun.Glob has no negation operator, so a `!` entry
  matches only a path whose first character is literally `!`.

  **Confirmed end-to-end by execution** through the real `resolveOutputs`, against a
  fixture holding `dist/a.js` + `dist/a.js.map`:

  ```
  ["dist/**"]                   -> [ "dist/a.js", "dist/a.js.map" ]
  ["dist/**","!dist/**/*.map"]  -> [ "dist/a.js", "dist/a.js.map" ]   # negation inert
  ```

  Because `cleanOutputs` is `resolveOutputs` + `rm`, the same inert list means
  `dist/a.js.map` is also deleted before every exec and every restore.

  The loader visibly _anticipates_ negation in outputs: `hasParentSegment()`
  (`src/workspace/project-loader.ts:468`) strips a leading `!` before checking for `..`
  segments, and it is applied to `outputs.files` as well as `inputs.files`. So the
  validation layer treats `!dist/x` as a legitimate outputs entry that the resolver then
  silently drops.

- **Existing vx coverage**: NONE. `grep` across `tests/` finds negation used only in
  `inputs.files` (`tests/inputs.test.ts:323,533`, `tests/orchestrator.test.ts:1307,1338`).
  No test passes a `!` entry in `outputs.files` or `outputs.workspaceFiles`.
  **`tests/migrate.test.ts:74` makes this worse**: the Turbo migration fixture is
  `outputs: ['dist/**', '!dist/**/*.map']` — a standard Turbo idiom — and `vx migrate`
  emits it verbatim into the generated `vx.config.ts`, producing a config whose negation
  does nothing and whose only pinned assertion is that it round-trips as text.
- **Proposed test**: `tests/inputs.test.ts` — `resolveOutputs` over a project containing
  `dist/a.js` and `dist/a.js.map` with
  `outputs: ['dist/**', '!dist/**/*.map']`. Assert the chosen contract: either the map is
  excluded (implement the split, matching `resolveFiles`) or the loader throws
  `UserError` naming outputs-negation as unsupported. Mirror for
  `outputs.workspaceFiles`. Then the sharp companion in `tests/inputs.test.ts` →
  `cleanOutputs`: assert whether `dist/a.js.map` survives a clean — today it is deleted
  before every exec and before every restore, because the negation that was supposed to
  disown it is inert. Finally, update `tests/migrate.test.ts` to assert whichever
  contract wins (migrate must not emit a silently-inert entry).
- **Value**: **HIGH** — same syntax, same config object, opposite behaviour on the two
  halves, with zero diagnostics. The user-visible damage is on the destructive side:
  `cleanOutputs` wipes files the user believed they had excluded from vx's ownership,
  and the cached artifact carries bytes the user tried to keep out of it. And vx's own
  migration tool is a generator of exactly this config shape.

### H7. A distributed run without `--frozen` lets each agent LIVE-EVALUATE its own configs — nothing detects or warns about a diverged graph

- **Nx behaviour**: Nx treats "the agent's local graph diverged from the coordinator's"
  as a named, testable failure mode. `packages/nx/src/tasks-runner/utils.spec.ts:1038`
  is **`throws a descriptive error when a task references a project missing from the
graph`**, and its in-test comment names the scenario verbatim:
  `// e.g. a DTE agent whose local graph diverged from the coordinator's`. Nx's own DTE
  contract additionally requires every agent to check out the same commit before
  `nx-cloud start-ci-run` hands out work.
- **vx equivalent**: `packages/cloud/src/dist/` — `agent-loop.ts:317`
  (`const frozen = policy?.frozen ?? opts.frozen`), `scheduler.ts:105`
  (`deriveAssignPolicy`), `protocol-dist.ts:97` (`AssignPolicy.frozen`). vx propagates
  the submitter's `--frozen` per assignment (shipped 2026-07-18), and a dirty tree is
  refused. But `--frozen` is **optional**, and vx configs are TypeScript _programs_ that
  may read `process.env` — a documented, first-class capability. Without `--frozen`,
  every agent re-evaluates `vx.config.ts` under its OWN environment. Same commit, same
  clean tree, different resolved config ⇒ different resolved-config hash ⇒ different
  cache key for the same logical task.
- **Existing vx coverage**: NONE for the divergent case.
  `packages/cloud/tests/dist-hash-equality.test.ts` is the §6.3 correctness-law guard and
  its own header scopes itself to _"same commit, clean tree, **same configs**"_ — the
  divergence is an explicit precondition of the test, never an assertion. Nothing in
  `packages/cloud/tests/` (`dist-*.test.ts`, `agents-e2e.test.ts`) varies an agent's env
  or asserts any warning. `grep -rn 'divergen' packages/cloud/src` → no hits.
- **Proposed test**: `packages/cloud/tests/dist-hash-equality.test.ts` — a fixture whose
  `vx.config.ts` reads `process.env.BUILD_FLAVOR` into `exec.command` (or into
  `cache.inputs.env`, or any config value). Derive the submitter's stable keys with
  `BUILD_FLAVOR=a`, then run the agent-style scoped `run()` with `BUILD_FLAVOR=b`, and
  assert the two keys DIFFER — i.e. pin the hazard as a fact. Then assert the mitigation:
  the same pair under `frozen: true` (with a `vx-lock.json` written by `vx lock` at
  flavor `a`) derives IDENTICAL keys. Add the ergonomic half in
  `packages/cloud/tests/dist-backend.test.ts`: submitting a distributed run _without_
  `--frozen` emits a warning naming `--frozen` as the reproducibility guarantee — the
  same shape as the existing "no remote agents" warning.
- **Value**: **HIGH** — this is the lost-work-in-distributed-mode class. The submitter's
  `deriveStableKeys` output is what the serve stat-prunes against and what
  `materializeOutputs` later addresses; if agents derive different keys, artifacts land
  under keys the submitter never asks for and outputs come back silently unrestored, or
  the same logical task is executed on every agent because no one's key ever hits.
  Neither failure is loud. vx already built the exact mitigation (`--frozen` over the
  wire) — what is missing is the test that proves the hazard is real and the warning that
  tells a user to use it.

### H8. An option-like `--affected=<base>` is passed to `git diff` as an OPTION — arbitrary file write, blocked only incidentally

- **Nx behaviour**: Nx hardened this explicitly, with a dedicated describe block
  `resolving the affected base against git` in
  `packages/nx/src/utils/command-line-utils.spec.ts:507`. Six pinned properties:
  - `:528` `should resolve the merge base by passing revisions as arguments rather than
through a shell`
  - `:539/551/562` `should treat a shell substitution in --base / in nx.json defaultBase
/ in NX_BASE as an opaque revision` (all three ref sources)
  - `:575/582/589` **`should reject an option-like base` / `head` / `defaultBase` before
    invoking git**
  - `:596` `should fall back to the fork point without a shell when merge-base fails`

  Note the third pair: Nx rejects a `-`-leading revision _before invoking git at all_,
  independently of shell-safety.

- **vx equivalent**: `src/workspace/affected.ts`. `affectedProjects()` passes
  `args.since` verbatim as a trailing positional to
  `git diff --no-renames --relative --name-only -z <since>` (`gitPaths`, line ~52) and to
  `git rev-parse --verify --quiet <ref>` (`verifyRef`, line ~108). The value reaches there
  from `--affected=<base>` or the `[<since>]` filter form (`src/cli/run.ts:661`), i.e.
  from CI-controlled input such as `--affected=$GITHUB_BASE_REF`.

  **Shell injection: NOT possible** — both use `Bun.spawn({ cmd: [...] })` array form, no
  shell, so `$(...)` is opaque. That half is sound.

  **Argument injection: the vector is real and I demonstrated it.** In a throwaway repo:

  ```
  git diff --no-renames --relative --name-only -z "--output=<path>"
  → exit 0, and <path> is created with the diff contents
  ```

  `--output=` is a genuine `git diff` option; an option-like "ref" is an arbitrary file
  write. Neither `gitPaths` nor `verifyRef` passes `--` or `--end-of-options`, and neither
  screens for a leading `-`.

  What actually stops it today is **incidental**: `affectedProjects` awaits `verifyRef`
  first, `git rev-parse --verify --quiet` exits **1** for every option-like string I probed
  (`-`, `--`, `-c`, `-C..`, `--git-dir=/tmp`, `--output=/tmp/x`), and vx's exit-1 branch
  throws `UserError`. So the `git diff` is never reached — via that one call path, with
  that one exit-code branch. That branch was itself rewritten on 2026-07-26 ("only exit 1
  keeps the ref message now"), which is exactly how accidental guards get lost.

- **Existing vx coverage**: NONE. `grep -niE 'option-like|injection|substitution|--output'
tests/affected.test.ts` → zero hits. The suite covers a nonexistent ref
  (`throws UserError when the ref does not resolve`) and a git-level failure
  (`reports a git failure as a git failure`), but never a `-`-leading value, and nothing
  asserts that `git diff` is unreachable with one.
- **Proposed test**: `tests/affected.test.ts` — call `affectedProjects({ since:
'--output=<tmpfile>' })` against a real fixture repo; assert it REJECTS (UserError) **and**
  assert `<tmpfile>` does not exist afterwards (the second assertion is the one that
  survives a refactor of `verifyRef`). Repeat for `-`, `--`, and
  `--upload-pack=<script>`, and for the `[<since>]` filter spelling. Then make the guard
  deliberate rather than incidental: reject a `since` matching `/^-/` in `affectedProjects`
  before any spawn, and/or insert `--end-of-options` before the ref in both `gitPaths` and
  `verifyRef`.
- **Value**: **HIGH** — a demonstrated arbitrary-file-write primitive reachable from a
  CI-supplied string, currently prevented by an exit-code side effect in a different
  function rather than by any check that knows it is a security boundary. It is not
  exploitable at HEAD; it is one plausible edit (make an unresolvable ref warn-and-fall-back
  instead of throw, or add a second `gitPaths` caller) away from being exploitable, and
  nothing would fail.

### H9. The `ESSENTIAL_ENV` allowlist forwards behaviour-changing vars (`NODE_OPTIONS`, `LC_ALL`, `CI`) that no cache key can see

- **Nx behaviour**: Nx treats "exactly which environment the child sees" as a pinned
  contract rather than an incidental allowlist. `packages/nx/src/tasks-runner/task-env.spec.ts:276`
  is a dedicated `describe('getForceColorForChild')` with three cases
  (`should return FORCE_COLOR when it is explicitly set`, `should return "0" when
NX_ORIGINAL_FORCE_COLOR is "0" and FORCE_COLOR was deleted`, `should prefer FORCE_COLOR
over NX_ORIGINAL_FORCE_COLOR`) — Nx normalises the colour axis for children and keeps
  the original under `NX_ORIGINAL_FORCE_COLOR` so the transformation is reversible and
  testable. Nx's complementary rule is that anything that should affect the key must be
  declared as an `{ env: 'NAME' }` input (`hasher/task-hasher.spec.ts` env-input
  expansion), i.e. Nx forces the user to make the choice per variable.
- **vx equivalent**: `ESSENTIAL_ENV` in `src/exec/env.ts:11` — a hard-coded list of ~24
  names copied from the host `process.env` into every child:
  `PATH, HOME, SHELL, USER, LOGNAME, TMPDIR, TEMP, TMP, LANG, LC_ALL, LC_CTYPE, TERM,
COLORTERM, FORCE_COLOR, NO_COLOR, CI, NODE_OPTIONS, SYSTEMROOT, APPDATA, …`.
  The cache key folds **only** `cache.inputs.env` names the user declared
  (`resolveInputs` → `Cache.key` `envValues`). So every essential is an _implicit,
  undeclarable, unhashable pass-through_. Three of them change what a task produces:
  - **`NODE_OPTIONS`** — honours `--require`, `--conditions`, `--import`. A build run
    with `NODE_OPTIONS=-r ./instrument.js` emits different bytes than one without, under
    a byte-identical cache key. Restore the wrong artifact, silently.
  - **`LC_ALL` / `LC_CTYPE` / `LANG`** — collation. Any build step that shells out to
    `sort` (or any locale-sensitive comparator) produces different output ordering under
    `LC_ALL=C` vs `en_US.UTF-8`, same key.
  - **`CI` / `FORCE_COLOR` / `NO_COLOR` / `TERM` / `COLORTERM`** — change stdout bytes,
    and `CI` commonly switches test reporters and snapshot-write behaviour. vx **caches
    stdout and replays it on a hit**, so a warm run piped to a file replays the ANSI from
    whichever run populated the entry.
- **Existing vx coverage**: NONE for the key interaction. `tests/env.test.ts` (10 tests)
  covers only the _composition_ of the child env (essentials forwarded, passThrough,
  define precedence, binPaths on PATH). No test asserts that changing an essential leaves
  the key unchanged, and no test flags it as a hazard. `grep -rn 'NODE_OPTIONS|LC_ALL'
tests/` → hits only in `tests/colors.test.ts`, about vx's OWN terminal output.
  `docs/schema.md:319-331` is the tell: the `passThrough` bullet says
  _"NOT folded into the cache key"_ explicitly, and the `Essential allowlist` bullet
  immediately above says nothing at all about the key.
- **Proposed test**: `tests/cache.test.ts` — derive a task key with
  `envSource: { NODE_OPTIONS: '-r ./a.js' }` and again with
  `{ NODE_OPTIONS: '-r ./b.js' }`, assert the keys are IDENTICAL, with a comment naming
  this as the accepted-but-real hazard (a pin, so it can never change silently). Then the
  e2e that makes it concrete, in `tests/stale-hit.test.ts`: a task whose command is
  `node -e "console.log(process.env.LC_ALL)" > out.txt`, run under `LC_ALL=C`, then
  re-run under `LC_ALL=en_US.UTF-8`; assert what happens (today: cache HIT, `out.txt`
  restored with `C`). Finally, the fix this test should motivate: either fold the
  essentials into the key, or document them in `docs/schema.md` beside `passThrough`
  with the same "NOT folded into the cache key" sentence, or narrow the list (drop
  `NODE_OPTIONS`, which is the only genuinely output-changing one, and make it a
  `passThrough` the user must opt into).
- **Value**: **HIGH** — this is a wrong-cache-hit vector reachable with no malformed
  config at all, from a variable (`NODE_OPTIONS`) that dev shells and CI images routinely
  set differently. vx's architecture principle #1 is "Explicit over magical" and its
  `passThrough` docs are careful to state cache-invariance; the essentials list is the
  one place where 24 variables are magically passed through with that property
  undocumented and untested.

---

## MED

### M1. Cycle topologies: vx pins 2, Nx pins 8 — the untested ones are the sparse and multi-cycle shapes

- **Nx behaviour**: `packages/nx/src/tasks-runner/create-task-graph.spec.ts` has a named
  cycle matrix, each a separate `it`:
  - `:1644` `should handle cycles within the same project`
  - `:1724` all projects contain the target (`lib1:build → lib2:build → lib3:build →
lib4:build → lib1:build`)
  - `:1875` **not all projects contain the target** (`lib1:build → lib2:build → lib3 →
lib4:build`) — an intermediate project without the target
  - `:2004` **`should handle cycles where tasks seem to depend on themselves`**
    (`lib1:build → lib2 → lib1:build`) — wrap-back _through a pass-through project_
  - `:2074`, `:2204`, `:2313` three more sparse variants
  - `:2416` **`cycles between projects that do NOT create cycles between tasks`**
    (`app1:build → app2 ↔ app3:build`) — a package cycle that must NOT be reported as a
    task cycle
  - `:3470` **`dependencies with 2 cycles`** (`app1→app2↔app3→app4, app5→app6↔app7→app8`)
    — two disjoint cycles in one graph
    Plus `filterDummyTasks` `should filter out dummy tasks with 1 cycle` / `with 2 cycles`.
- **vx equivalent**: `buildTaskGraph` + `detectCycle` (`src/graph/task-graph.ts`), and the
  nearest-holder frontier walk at `:316-337` whose `visited` set is seeded with
  `projectName` (the 2026-07-26 fix for the direct wrap-back).
- **Existing vx coverage**: only four cycle-adjacent tests —
  `tests/task-graph.test.ts:140` (`^name never wraps back into the declaring project on a
package cycle`), `:155` (the pattern form), `:260` (`detects a cross-project cycle`,
  singular), `:277` (`detects a same-project task self-cycle`). Missing: the two-disjoint-
  cycles graph, the sparse wrap-back _through_ a target-less intermediate, and the
  package-cycle-that-is-not-a-task-cycle positive control.
- **Proposed test**: three cases in `tests/task-graph.test.ts`. (1) `a → b → a` where `b`
  declares NO matching task and `a` declares `dependsOn: ['^build']` — assert the graph
  builds with no self-edge and no `Cycle detected` throw (the pass-through variant of the
  2026-07-26 fix). (2) `app1 → app2 ↔ app3`, only `app1`/`app3` declaring `build` —
  assert a clean `app1#build → app3#build` graph and NO cycle error. (3) two disjoint
  4-node cycles in one workspace — assert `detectCycle` throws and that the message names
  a node from a cycle (guards against a DFS that only ever roots in the acyclic component).
- **Value**: MED — vx has already shipped one real bug in this exact family (the
  2026-07-26 `Cycle detected: a#build -> a#build` lie, plus the pattern form silently
  adding a bogus edge that _reached the cache key_). The fix was verified only against the
  direct-wrap shape; the sparse and multi-cycle shapes are where the same class hides.

### M2. Nothing asserts the task graph or any cache key is invariant to declaration / request order

- **Nx behaviour**: `create-task-graph.spec.ts:2656`
  **`should create deterministic task graphs regardless of target order`**, with a comment
  naming the regression it locks: _"dummy tasks (created when a dependency project doesn't
  have the required target) would have different dependency structures depending on the
  order targets were processed … leading to non-deterministic task graphs."_ The fixture is
  exactly the sparse case — `app1` declaring `test: ['^test','^lint']` and
  `lint: ['^lint']`, with `lib1` having no targets at all.
- **vx equivalent**: `buildTaskGraph` + `expandRequested` (`src/graph/task-graph.ts`), the
  frontier walk, `markSurfacedDeps`, `computeGroupHash` (`src/orchestrator/task-hash.ts:202`,
  which does sort), and `filterUpstreamHashes`.
- **Existing vx coverage**: NONE. `grep -riE 'determinist|order-independent|regardless of
.*order' tests/task-graph.test.ts tests/scheduler.test.ts tests/stable-keys.test.ts` →
  zero hits. `tests/cache.test.ts` pins order-independence of the _inputs_ to `Cache.key`
  (file order, upstream-hash order), but nothing pins that the GRAPH feeding those inputs
  is itself order-independent.
- **Proposed test**: `tests/task-graph.test.ts` — build the graph twice from the same
  workspace, once with `expandRequested(['test','lint'], …)` and once with
  `['lint','test']`, and once more with the `projects` Map built in reverse insertion
  order. Assert the three results are structurally equal: same node-id set, and each
  node's `deps` array deep-equal after sorting. Use the Nx fixture shape — an intermediate
  project declaring NEITHER task, so the pass-through frontier is exercised. Then the half
  that actually matters for caching: in `tests/task-hash.test.ts`, assert the derived key
  for a GROUP task is byte-identical across the two orderings.
- **Value**: MED — order-dependence here is invisible until it changes a key, at which
  point it presents as an unexplained cache miss (or, through `computeGroupHash`, as a
  group task that never hits). `computeGroupHash` sorts today; nothing stops that from
  regressing.

### M3. `cache.inputs.workspaceFiles` has the same negation-only footgun as H1

- **Nx behaviour**: same `filterUsingGlobPatterns` contract as H1 — Nx applies one
  positive-OR / negative-AND rule to `{workspaceRoot}`-anchored filesets and
  `{projectRoot}` filesets alike (`task-hasher.spec.ts:24`
  `should identify ^{workspaceRoot}/tools/**/* as a dependency fileset`, and the
  `filterUsingGlobPatterns` block applies to both).
- **vx equivalent**: `resolveWorkspaceFiles()` in `src/cache/inputs.ts:150-156` — same
  `positive`/`negative` split, same `if (positive.length === 0) return []`.
- **Existing vx coverage**: NONE. `tests/workspace-files.test.ts` (23 tests) covers
  resolution, boundaries, staleness and the migrate mapping, but never a negation-only
  list.
- **Proposed test**: `resolveWorkspaceFiles` with
  `workspaceFiles: ['!tools/**/*.md']` — assert the same contract chosen for H1, so the
  two halves cannot diverge. Worth writing as a shared table-driven test over all four
  resolvers.
- **Value**: MED — same permanent-stale-hit mechanism as H1, on the axis explicitly
  documented for root-level inputs; folded out of H1 only because it is one resolver down.

### M4. `--affected` has no sibling-prefix project-dir case, the exact family of the 2026-07-14 interloper bug

- **Nx behaviour**: `project-graph/affected/locators/workspace-projects.spec.ts:32` and
  `:44` — **two** near-identical tests both named `should return projects with the root
matching a whole directory name in the file path`, with roots `libs/a`, `libs/a-b`,
  `libs/a-b-c` and a change in `libs/a-b/index.ts`, asserting exactly `['ab']`. Nx pins
  it twice because prefix-vs-segment matching of project roots is a repeat offender.
  `:56` adds `should return the most qualifying match with the file path` (deepest wins).
- **vx equivalent**: `projectsContaining()` in `src/workspace/affected.ts:131` — the
  ancestor-`path.dirname` walk, which is segment-safe _by construction_ and takes the
  deepest match first.
- **Existing vx coverage**: NONE for sibling prefixes. `tests/affected.test.ts` covers the
  nested-project boundary (`:170`) but `grep -n 'e2e|app-' tests/affected.test.ts` returns
  nothing — no fixture has two project dirs where one name is a string prefix of another.
  `tests/nested-dirs.test.ts` covers this family for the OUTPUT-boundary function only.
- **Proposed test**: `tests/affected.test.ts` — a fixture with `packages/app`,
  `packages/app-e2e` and `packages/app-e2e-utils`; touch `packages/app-e2e/src/x.ts`;
  assert exactly `{'app-e2e'}` is affected (not `app`, not `app-e2e-utils`). Mirror the
  deepest-wins case with `packages/app` + `packages/app/nested`.
- **Value**: MED — vx shipped a HIGH-severity bug of precisely this shape on 2026-07-14
  (`computeNestedProjectDirs` breaking its scan on a sibling whose name extends the parent
  by a character sorting below `/`, silently emptying a project's nested set and breaking
  the hard boundary invariant). That fix pinned the _outputs_ side; the _selection_ side
  has the same hazard and no fixture.

### M5. `vx migrate` maps Turbo's negated `outputs` into a config where the negation is inert

- **Nx behaviour**: Nx validates outputs at configuration-merge time and errors on
  malformed shapes — `tasks-runner/utils.spec.ts:796` `describe('validateOutputs')` with
  `throws an error if the output is not an array`, `…entries that aren't strings`,
  `…is a glob pattern from the workspace root`, `…doesn't start with a prefix`. The
  principle: an outputs entry that cannot mean what it appears to mean is rejected, not
  silently accepted.
- **vx equivalent**: `src/cli/migrate-turbo.ts` (the `outputs` mapping) plus the
  `resolveOutputs` gap from H6.
- **Existing vx coverage**: `tests/migrate.test.ts:74` feeds
  `outputs: ['dist/**', '!dist/**/*.map']` through the Turbo path and asserts only that
  the generated config loads and round-trips. Nothing asserts what the negation _does_.
- **Proposed test**: after H6's contract is chosen, extend `tests/migrate.test.ts` to
  assert it — either the emitted config's negation is honoured end-to-end (build a real
  fixture, assert `dist/a.js.map` is neither captured nor cleaned), or migrate rewrites /
  TODO-comments the entry rather than emitting an inert one. `vx migrate`'s stated
  contract is "TODO comments for everything unmappable"; an inert negation is unmappable
  and currently gets neither.
- **Value**: MED — it is the generator half of H6, and `vx migrate` is the onboarding
  path, so it is where the inert config shape actually enters real workspaces.

### M6. No test drives `cache.inputs.files` with multiple overlapping positive globs plus a negation that straddles them

- **Nx behaviour**: `hasher/task-hasher.spec.ts:252`
  `should OR all positive patterns and AND all negative patterns (when positive and
negative patterns)` — two positives (`**/*.ts`, `**/*.js`) and two negatives
  (`!**/*.spec.ts`, `!**/*.md`) over one file set, asserting `['root/a.ts','root/b.js']`.
  The point is the _interaction_: `c.spec.ts` matches a positive and is removed by a
  negative; `d.md` matches no positive at all. Nx also pins `:306`
  `should handle projects with the root set to .` — the workspace-root project.
- **vx equivalent**: `resolveFiles()` — positives feed `positiveGlobs` (matched with an
  OR loop that `break`s on first hit), negatives are merged into `excludeGlobs` alongside
  `ALWAYS_IGNORE`, boundary ignores and `ownOutputs`.
- **Existing vx coverage**: partial only. `tests/inputs.test.ts:316`/`:526` each use ONE
  positive and ONE negation. Nothing exercises two positives with a negation that
  subtracts from one of them, and nothing asserts the precedence between a user negation
  and `ownOutputs` / boundary ignores when they overlap.
- **Proposed test**: `resolveInputs` with
  `files: ['src/**/*.ts', 'src/**/*.js', '!src/**/*.spec.ts']` over
  `src/a.ts`, `src/b.js`, `src/c.spec.ts`, `src/d.md` → assert exactly `['src/a.ts',
'src/b.js']`. Add the root-project variant (a project whose dir IS the workspace root,
  which this repo has as the `"."` member) so the `{projectRoot} = .` path is pinned.
- **Value**: MED — vx's combination rule is correct as written, but it is assembled from
  four separate exclude sources and one OR loop, and no test pins the composition. This is
  the cheapest test in the catalogue and it guards cache-key content directly.

### M7. Nx schedules a NO-HISTORY task FIRST; vx gives it the workspace median — and vx's own benchmark already measured that choice regressing

- **Nx behaviour**: `packages/nx/src/tasks-runner/tasks-schedule.spec.ts:497`
  **`should schedule task with no historial runtime first`**. With estimated timings
  `{app1:test: 200, app4:test: 500, lib1:test: 100}` and `app2`/`app3` having none, the
  asserted dispatch order is `lib1` (blocks others) → **`app2`** → **`app3`** (both
  unknown) → `app4` (500) → `app1` (200). Nx's rule is: unknown duration outranks every
  known duration. `:479` (`should schedule task with longer runtime first`) is the
  known-duration half.
- **vx equivalent**: `computePredictedPriorities()` in `src/orchestrator/predict.ts:24-39`.
  A node with no history falls back to the **workspace median** p50, and if history is
  entirely empty to `DEFAULT_DURATION_MS = 1000`. So unknown-duration nodes land in the
  _middle_ of the ordering, and on a cold cache where every node is unknown they are all
  equal → every priority ties → the scheduler degenerates to graph-insertion order.
- **Existing vx coverage**: the fallback itself is pinned
  (`tests/predict.test.ts:57` `falls back to workspace median when a node has no history`,
  `:64` `falls back to default duration when history is entirely empty`) — but nothing
  compares the two policies, and no test asserts anything about _dispatch order_ under
  mixed known/unknown history.
- **Proposed test / experiment**: this one is a benchmark run before it is a test. vx
  already owns the instrument — `bench/schedule-policy.ts` replays 9 graph shapes through
  a deterministic discrete-event sim of the real scheduler and already compares `count` vs
  `remCP` vs `remCP-cold`. Add a fourth policy, `remCP-unknown-first` (unknown p50 ⇒
  `+Infinity` rather than the workspace median), and re-run. Then pin whatever wins in
  `tests/predict.test.ts` as an explicit ordering assertion over a mixed-history table,
  in the Nx fixture's shape.
- **Value**: MED — the 2026-07-14 decision-log entry records the measured problem this
  addresses verbatim: _"cold predictive can REGRESS +0.1..+0.9% (uniform-duration
  fallback is a worse heuristic than reverse-dep-count on some shapes)"_, which is
  precisely the all-nodes-tie degeneration above. Nx's unknown-first rule is a
  named, production-tested candidate fix for it, and vx can evaluate it for the cost of
  one benchmark run with zero risk to the default path.

---

## LOW

### L1. `markSurfacedDeps` has no cyclic-group test

- **Nx behaviour**: `tasks-runner/utils.spec.ts:998`
  **`terminates on cyclic noop dependencies`** — two `nx:noop` (orchestrator-only) targets
  depending on each other; `expandInitiatingTasksThroughNoop` must return an empty set
  rather than recurse. Siblings: `:985` `returns an empty set for a noop with no
dependencies`, `:961` `recursively collapses nested noop orchestrators`.
- **vx equivalent**: `markSurfacedDeps()` in `src/graph/task-graph.ts:80-100` — the
  transparent-folder walk that descends through nested same-project group tasks. It uses a
  `visited` set + explicit stack, so it terminates.
- **Existing vx coverage**: `tests/task-graph.test.ts:577` `describe('markSurfacedDeps')`
  covers nested-group descent, stop-at-real-task, same-project-only and the zero case —
  but no cyclic-group case.
- **Proposed test**: two group tasks in one project, `a.dependsOn = ['b']`,
  `b.dependsOn = ['a']`, constructed directly as a node Map (bypassing `buildTaskGraph`);
  assert `markSurfacedDeps` returns 0 and terminates.
- **Value**: LOW — unreachable through the real pipeline, because `buildTaskGraph` runs
  `detectCycle` and throws before `markSurfacedDeps` is called. But `markSurfacedDeps` is
  an exported unit already tested directly, so the guard costs three lines and removes the
  ordering assumption.

### L2. Bare-name `--filter` requires the full scoped name; Nx (and pnpm) match on name segments

- **Nx behaviour**: `utils/find-matching-projects.spec.ts:293`
  **`should match on name segments`** — `findMatchingProjects(['foo'])` returns
  `['@acme/foo', 'foo_bar1', '@acme/nested/foo']`; matching is case-insensitive
  (`['Bar1']` → `foo_bar1`) and **only whole segments match** (`['fo']` → `[]`,
  `['nested/fo']` → `[]`). `:316` disambiguates scope-vs-name
  (`['test']` → `@test/test`, not `@test/test-e2e`).
- **vx equivalent**: `matchProjects` / the name-glob compiler in `src/workspace/filter.ts`
  (rewritten 2026-07-26 so `'*'` and `'*core*'` reach scoped names).
- **Existing vx coverage**: `tests/filter.test.ts` pins exact match, glob match and
  `preserves scoped glob names` — i.e. vx requires `--filter '@acme/foo'` or an explicit
  glob. No test states that a bare unscoped name does NOT match a scoped package.
- **Proposed test**: pin the divergence rather than change it —
  `--filter foo` against a workspace containing only `@acme/foo` selects nothing (and
  therefore warns / errors per the no-match rule), while `--filter '*foo'` selects it.
  Add a line to `docs/comparison.md` §"Deliberate divergences" → Filter DSL.
- **Value**: LOW — a UX divergence, not a correctness one, and vx matches Turbo here
  rather than Nx. Worth pinning only so the 2026-07-26 name-glob rewrite's boundary stays
  deliberate.

### L3. The flakiness classifier has no empty-candidate short-circuit test

- **Nx behaviour**: `packages/nx/src/native/tests/task_history.spec.ts:60`
  `should query flaky tasks` ends with `const r2 = taskHistory.getFlakyTasks([]);` and
  asserts it contains neither known hash — the empty-candidate set must short-circuit to
  nothing rather than degenerate to "all". Nx also restricts the flaky query to
  **cacheable** hashes only (`tasks-runner/life-cycles/task-history-life-cycle.ts`:
  `// Only check for flaky tasks among cacheable tasks`).
- **vx equivalent**: `classifyFailureMode` / `mixedOutcomeKeyCount` in
  `src/orchestrator/failure-mode.ts`, guarded by `KEYED_RUNS_SQL` (`hash <> ''`), and the
  cloud twin in `packages/cloud/src/db/analytics.ts`.
- **Existing vx coverage**: `tests/history.test.ts` / `tests/metrics.test.ts` cover the
  verdicts. vx's rule already MATCHES Nx's (same key, both failed and succeeded) and is
  strictly stronger (it also accepts a within-run retry) — this is **not** a rule gap.
  What is missing is the degenerate-input pin.
- **Proposed test**: `classifyFailureMode` with `counts = {total: 0, failures: 0,
retried: 0}` and with a project/task pair that has no rows at all → `'stable'`, never a
  DB error and never a flaky verdict. Mirror on the cloud side for a workspace with zero
  `task_runs`.
- **Value**: LOW — defensive; the `failures > 0` short-circuit already keeps the query off
  the empty path. Included because it is the one Nx flakiness assertion vx has no
  counterpart for, and because the cloud twin has repeatedly needed exactly this class of
  empty-set guard.

---

## Deliberately NOT listed (checked, vx is covered or has decided)

Recorded so a later pass does not re-tread them:

- **Flakiness rule itself.** Nx: same cache hash produced both a failure and a success
  (`native/tests/task_history.spec.ts:60`). vx: identical rule in
  `src/orchestrator/failure-mode.ts` `mixedOutcomeKeyCount`, plus a within-run-retry
  signal Nx lacks, plus the shared-rule guard that stops the two read surfaces drifting.
  Covered and ahead.
- **Symlink hashing.** Nx/Turbo both special-case it. vx harvests trusted git OIDs only
  for `mode 100644 / 100755` at stage 0 (`src/cache/inputs.ts:643-645`), so symlinks and
  gitlinks always fall back to content hashing — no dirty/clean divergence.
- **Deleted / renamed / gitignored files.** All three already pinned in
  `tests/inputs.test.ts` (deleted-but-tracked existsSync guard, untracked-not-ignored
  participate, nested `.gitignore` anchoring, `.git/info/exclude`) and
  `tests/affected.test.ts` (deleted file selects owner; cross-project rename selects both
  via `--no-renames`).
- **`validateOutputs`-class schema checks.** Nx `tasks-runner/utils.spec.ts:796`. vx's
  loader already rejects non-array, non-string, empty-string, absolute and `..`-containing
  outputs entries, each with a test in `tests/project-loader.test.ts:166-232`.
- **`cache` + `continuous` rejection.** Nx
  `project-configuration-utils.spec.ts:2447`. vx: `tests/project-loader.test.ts:91`
  `rejects cache + persistent`.
- **Duplicate / diamond dependency dedup.** Nx `create-task-graph.spec.ts:418`, `:1305`.
  vx: `tests/task-graph.test.ts:229` and `:174`.
- **`namedInputs`, `targetDefaults`, `{projectRoot}`/`{workspaceRoot}` token
  substitution, `^{projectRoot}` filesets, `dependentTasksOutputFiles`, executor
  batching, `.env` auto-loading, project tags.** All owner-rejected or explicitly
  out-of-scope per `docs/comparison.md` and the CLAUDE.md decision log. Nx pins them
  heavily; vx should not.
- **`externalDependencies` inputs.** Nx lets a target narrow which npm packages
  participate. vx folds the whole project `package.json` plus the workspace lockfile
  fingerprint — coarser, and deliberately so (`docs/comparison.md` "Where vx is ahead").

---

## Summary

**9 HIGH**, 7 MED, 3 LOW. The three sharpest:

1. **H1 — a negation-only `cache.inputs.files` folds ZERO file inputs.**
   `if (positive.length === 0) return []`. A config that reads fine and passes validation
   produces a task whose key never moves with its source: a permanent stale hit. Nx's
   `filterUsingGlobPatterns` pins the opposite (negation-only = everything minus these).
2. **H3/H4 — `--affected` and the cache key disagree about what an input is.**
   `projectsContaining` only knows project _directories_, so a change to a
   `cache.inputs.workspaceFiles` target or to any package-manager lockfile busts every
   affected key while selecting zero projects — `vx run test --affected` exits 0 having
   run nothing. `docs/cli.md:139` states the violated principle in as many words:
   _"input hashing sees it, so `--affected` must too."_
3. **H9 — `ESSENTIAL_ENV` forwards `NODE_OPTIONS` / `LC_ALL` / `CI` to every child, and
   no cache key can see them.** An implicit 24-name pass-through that no user declared
   and none can remove, three entries of which change what a task _produces_. Same key,
   different bytes — a wrong cache hit with no malformed config involved.

Two more worth calling out: **H8** is a demonstrated `git diff --output=<path>` arbitrary
file write from a CI-supplied `--affected` value, currently blocked only by an exit-code
side effect in a different function; **H7** is the distributed half — without `--frozen`,
every agent live-evaluates its own TypeScript configs under its own environment, and
nothing detects, warns about, or tests the diverged graph.
