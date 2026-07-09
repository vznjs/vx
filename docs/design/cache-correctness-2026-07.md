# Provable cache correctness — design

> **Status:** proposal
>
> Flagship capability: vx is the only monorepo task runner that can
> _prove_ a task's cache entry is safe to reuse, instead of hoping. Two
> proofs: **determinism** (the outputs are a pure function of the
> declared inputs) and **input-completeness** (the declared
> `cache.inputs` are the whole read set). Both are the principled,
> _explicit_ alternative to the owner-rejected auto-input inference
> (fspy/strace guessing): vx never guesses your inputs — it proves the
> ones you declared are complete and that the task is reproducible, and
> fails loud with the exact paths when they aren't.

## What we're solving

Turbo, Nx, and vite-task all share one unspoken assumption: **if the
declared input hash matches, the cached output is correct.** Nothing
verifies it. Under-declare an input and you get a silent stale hit — a
green build serving wrong bytes. Ship a non-hermetic task (a compiler
that embeds `Date.now()`, a bundler with hashmap-ordered chunks) and
the cache replays one arbitrary past output forever, masking real
divergence. The industry's answer is "declare your inputs carefully"
and, at best, filesystem tracing to _guess_ them (which can't run
before the task does, and which the owner has explicitly rejected as
magical).

vx's architecture already carries the primitives to do better:

- **Content-addressed outputs.** Every cacheable miss resolves its
  output file set (`resolveOutputs` in `src/orchestrator/execute-task.ts:457`)
  and packs it into a `<hash>.tar.zst`. We can re-run a task and
  bit-compare its outputs.
- **A content-hash primitive that ignores mtime.** `Cache.hashFile`
  (`src/cache/cache.ts:962`) returns a git blob OID of a file's bytes,
  with an mtime+size memo that _re-reads whenever the file changes_.
  It is the exact primitive `Cache.key` folds for input files
  (`cache.ts:1105`). Reusing it gives a mtime-independent output digest
  for free — no new hash.
- **An OS sandbox whose baseline is the declared input set.**
  `runSandboxed` (`src/exec/sandbox-runtime.ts:283`) already runs a
  task with `allowRead = resolved cache.inputs.files` and
  `denyRead = [workspaceRoot]`, and on Linux (via strace, `sandbox-runtime.ts:428`)
  and macOS (violation store) surfaces the **exact undeclared paths**
  the task read. That is a ready-made input-completeness oracle.
- **The run-twice muscle.** `executeCachedTask`'s miss path is already
  a retry loop that cleans outputs and re-spawns (`execute-task.ts:316`),
  and within-run flaky detection already ships. "Run it again, compare"
  is an established pattern here.

The feature composes these into two opt-in proofs surfaced as a run
mode. It is **off by default and zero-cost when off** — a plain
`vx run` never touches any of this.

## Access pattern

- Invoked in CI or on a schedule, not every keystroke:
  `vx run build --all --verify` (nightly / merge-queue), or a targeted
  `vx run @scope/pkg#build --force --verify`.
- Per verified task: one extra full execution (determinism) and/or one
  sandboxed execution (input-completeness). Non-verified tasks (cache
  hits, no-output tasks, groups, persistent, non-cacheable) pay
  nothing.
- Reads: the just-saved artifact's outputs on disk. Writes: nothing new
  to the cache — verification is a pure side-channel; it never changes a
  key, an artifact, or a stored row (Phase 1).
- Output: a per-task verdict + a run-level summary; a non-hermetic task
  turns the run red (exit non-zero) so CI catches it.

## The two proofs, precisely

### Proof 1 — determinism (platform-independent; Phase 1, the wow)

**Claim proven:** for a task that executed this run, the bytes stored
in its cache entry are a pure function of its declared inputs — so a
future cache hit replays exactly what a fresh run would produce.

**Mechanism (all inside `executeCachedTask`, `src/orchestrator/execute-task.ts`):**

1. The normal miss path runs the winning attempt and reaches the save
   block (`execute-task.ts:456`). There, `resolveOutputs` /
   `resolveWorkspaceOutputs` already produce the absolute output paths.
   Compute the **attempt-1 output fingerprint** right there — before the
   verify re-run, while the tree is attempt-1's:

   ```
   fp1 = new Map(rel -> await cache.hashFile(abs))   // over project + workspace outputs, sorted
   ```

   Reuses `cache.hashFile` (the input-hashing OID primitive). No new
   hash, no artifact repack. The map (not just a scalar) is kept so the
   report can name _which_ outputs diverged.

2. `cache.save(...)` persists attempt 1 exactly as today. **Exactly one
   save** — the verify re-run below never saves.

3. **Re-run gate.** Proceed only when all hold, else skip with a benign
   verdict:
   - `args.verify?.determinism` is on;
   - the task executed this run (miss path — hits didn't run, so
     Phase 1 reports them `not-verified`; use `--force` to
     re-execute + verify a warm graph);
   - `effectiveExitCode === 0` and not `result.timedOut` and not aborted;
   - the output set is non-empty (a no-output task — `lint`, `typecheck`
     — has nothing to replay but stdout; report `no-outputs` and skip
     the re-run, which also keeps the cost model bounded to
     output-producing tasks).

4. **Re-execute fresh, without saving.** Clean the declared outputs
   (`cleanOutputs` / `cleanWorkspaceOutputs` — the same path the retry
   loop uses at `execute-task.ts:326`), then run one more attempt via
   the same spawn closures the retry loop uses. Factor the retry loop's
   per-attempt body (clean → `runSandboxed`/`runCommand` →
   exit/violation classification) into a local `runAttempt()` so the
   verifier and the retry loop can't drift.
   - Re-run exits non-zero / times out → verdict `rerun-failed`
     (nondeterministic by definition: identical inputs, different
     outcome — the strong form of "flaky").

5. Compute the **attempt-2 fingerprint** `fp2` over freshly re-resolved
   outputs (re-globbed, so a changed _file set_ is caught too, not just
   changed contents).

6. **Restore the canonical bytes.** `cache.restoreOutputs(hash, projectDir, workspaceRoot)`
   re-materializes attempt 1 (and re-syncs mtimes). After this, disk ==
   the cached artifact regardless of the verdict, so downstream tasks in
   the same run and the on-disk tree stay consistent with the cache.
   No double-save, no inconsistency.

7. **Verdict.** `fp1` vs `fp2`:
   - equal → `proven-deterministic`;
   - differ → `nondeterministic`, carrying the diff
     (`added` / `removed` / `changed` rels) for the report.

**Why per-file OID fold, not "compare the artifact bytes":** the
`<hash>.tar.zst` embeds seconds-resolution mtimes and entry ordering,
so two byte-identical output trees produce _different_ artifacts. The
comparison must be over content. `Cache.hashFile` is content-only
(mtime is just its memo key), so `fp1`/`fp2` compare true bytes. The
digest fold is `xxh3` seed-chaining — the same construction `Cache.key`
already uses (`cache.ts:1031`). Nothing new is invented.

**Why not the old stored outputs-hash:** there isn't one. v22
(`cache.ts:55`) removed output-content hashing from every cache key on
purpose. Determinism verification computes a _fresh_ content digest of
the two runs; it never resurrects output-fold hashing into keys.

New code lives in `src/orchestrator/verify.ts` (peer of `task-hash.ts`):
`hashOutputTree(cache, entries)`, `diffOutputTrees(a, b)`, and the
`classifyDeterminism(...)` step. The cache module is untouched.

### Proof 2 — input-completeness (sandbox-backed; Phase 2)

**Claim proven:** the union of `cache.inputs.files` /
`workspaceFiles` / `runtime` is the task's whole workspace read set —
so no undeclared file can silently change output without changing the
key.

**Mechanism:** run the task **once, sandboxed**, with the baseline
`execute-task.ts:395` already builds (`baseAllowRead` = resolved
inputs, `baseDenyRead = [workspaceRoot]`) — but force it on for every
cacheable task regardless of whether the user declared `sandbox: {}`.
A read of a workspace path outside the declared inputs is a proof
failure. Surface the offending paths as an actionable message:

```
@scope/api#build read undeclared inputs:
  src/generated/schema.ts
  ../shared/constants.ts
add them to cache.inputs.files / workspaceFiles, or allow via --verify-allow
```

The paths already flow out of the sandbox: `parseStraceViolations`
(`sandbox-runtime.ts:428`) yields the absolute path per denied
`openat`, and macOS's violation store carries the syscall line. vx just
relabels `sandboxViolationLines` from "sandbox violation" to
"undeclared input."

**Platform honesty (state it plainly in the docs):**

| Host                                                                                         | Result                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                                                                                        | Full: violation store names every undeclared path.                                                                                              |
| Linux + `strace` on PATH                                                                     | Full: strace names every undeclared `openat`.                                                                                                   |
| Linux, no `strace`                                                                           | Degraded: bwrap denies structurally, the task fails on `ENOENT`, but vx can only say "an undeclared input was read (install strace for paths)." |
| Sandbox unavailable (Ubuntu 24 AppArmor blocks unprivileged userns, `sandbox-runtime.ts:80`) | `--verify=inputs` errors clearly and does not silently pass.                                                                                    |

Because a hermetic-looking task legitimately reads a few
outside-workspace paths (system CA certs, `~/.config` tool state),
`--verify=inputs` leans on the same allowlist as Proof 1 plus the
existing per-task `sandbox` allowances. That richer allow surface is
why input-completeness is Phase 2, not Phase 1.

## The surface

**Recommendation: a run mode, `vx run --verify[=<what>]`.** Verification
is a property of an execution, so it rides the run that is already
happening — no separate discovery/graph pass, and it composes with
every existing selector (`--all`, `--filter`, `--affected`, `--force`).

- `--verify` (bare) = `--verify=determinism` — the Phase-1, everywhere
  proof.
- `--verify=inputs` — Phase 2 sandbox proof.
- `--verify=all` — both (the first, cache-writing execution is
  sandboxed; the verify re-run proves determinism → ~2× exec).
- `--verify-allow=<pkg#task>[,…]` — run-level escape hatch (Phase 1):
  listed tasks still re-run and diff, but a divergence is reported
  `allowed-nondeterministic` (yellow) and does **not** fail the run.
  Zero schema change, never hashed.

`RunOptions.verify?: { determinism: boolean; inputs: boolean; allow: ReadonlySet<string> }`
(`src/orchestrator/options.ts`), threaded into `ExecuteArgs.verify`
via `buildExecuteArgs` (`run.ts:399`), and into `RunRequest` (both
protocol mappers, `orchestrator/protocol.ts`) so a delegated run
verifies server-side — exactly the pattern `retries`/`timeout` follow.

**Rejected surfaces:**

- _A `vx verify` subcommand_ as the primary entry — it would duplicate
  the whole scope/selector layer of `vx run`. Keep it as optional
  Phase-3 sugar for `run --force --verify=all`.
- _Always-on verification_ — violates the zero-cost-by-default rule and
  doubles every CI run.
- _A per-task config field in Phase 1_ — see Phasing; deferred to
  Phase 2 to keep Phase 1 free of any cache-key surgery.

### Report shape

Per-task verdict on `TaskOutcome.verify` (new optional field on
`src/graph/scheduler.ts:TaskOutcome`, structural, never hashed):

| Verdict                    | Meaning                                                   | Run impact    |
| -------------------------- | --------------------------------------------------------- | ------------- |
| `proven-deterministic`     | re-ran, outputs bit-identical                             | —             |
| `nondeterministic`         | re-ran, outputs differ (carries changed rels)             | **fails run** |
| `rerun-failed`             | re-run exited non-zero / timed out                        | **fails run** |
| `undeclared-inputs`        | Phase 2: read outside declared inputs (carries paths)     | **fails run** |
| `allowed-nondeterministic` | diverged but in `--verify-allow`                          | —             |
| `no-outputs`               | cacheable, no declared outputs — nothing to replay        | —             |
| `not-verified`             | didn't execute (hit) / not cacheable / group / persistent | —             |

End-of-run summary section (rendered by the summary layer, after the
existing cache meter):

```
 Verify:   12 proven · 1 nondeterministic · 3 n/a · 40 not-verified
   ✗ @scope/bundler#build — nondeterministic
       changed: dist/app.[hash].js, dist/app.[hash].js.map
```

**Exit code:** in verify mode the run's `ok` (`run.ts:551`) gains a
second clause — clean unless some outcome's `verify` is
`nondeterministic` / `rerun-failed` / `undeclared-inputs`. A plain
(non-verify) run's `ok` computation is byte-identical. So CI goes red
precisely when a cache entry is provably unsafe.

## Correctness + interactions

- **Cache key / artifact bytes: untouched.** `verify` and
  `--verify-allow` are `RunOptions` only — never in `CacheKeyInput`,
  never in the config object, never folded. The re-run does not save.
  A `--verify` run cache-hits a plain run's entry, and vice versa.
  Pin it with a key-stability test, exactly as `--retry`/`--timeout`
  did. **No `CACHE_VERSION`/`SCHEMA` bump** in Phase 1.
- **CachePolicy axes.** Verification observes the miss path, so it
  cooperates with policy: `--force` (reads off, writes on) makes every
  task execute → the whole graph is verifiable in one command
  (`vx run --all --force --verify`); `--no-cache` (writes off) means no
  save and no `fp1` reference — verification no-ops (nothing was
  cached to prove safe).
- **`--frozen`.** Orthogonal. Under frozen configs the re-run uses the
  identical pinned config, which is exactly what you want.
- **Remote cache / LayeredCache.** A remote hit didn't execute →
  `not-verified`. Verification is a purely local re-execution vs. the
  local save; it needs no network and never blocks the upload drain.
- **Two-tier scheduler.** No scheduler change: the verify re-run lives
  inside `executeTask`, so a verified task simply reports a longer
  wall time. Restore-tier/`preProbed` hits are never executed, hence
  never verified in Phase 1 (correct — they didn't run).
- **Retries / timeout / flaky.** The verifier reuses the extracted
  `runAttempt()` and the same `effectiveTimeout`. A `rerun-failed`
  verdict is the strong superset of the within-run flaky signal
  (proves output divergence, not just exit-code wobble); Phase 3 can
  feed it into the flaky-tasks card.
- **Group / persistent / aborted.** Excluded by construction —
  `executeGroupTask` / `executePersistentTask` never reach the verify
  hook, and an aborted/timed-out task returns before it.

### Perf / cost model

- Verified task cost ≈ **2× its exec** (determinism) or **1× + sandbox
  overhead** (inputs) or **~2× + sandbox** (all). Everything else is
  unchanged.
- Only **output-producing, executed, cacheable** tasks re-run — the
  `no-outputs` skip means `lint`/`typecheck` (often the bulk of a
  graph) cost nothing. A realistic `--verify` cold run is well under
  2× total.
- Phase 2 adds `--verify-sample=<0..1>` to verify a random fraction per
  run (amortize across CI runs) — deferred, not Phase 1.

## Phasing

1. **Phase 1 — determinism verifier behind `--verify`.** The smallest
   slice that delivers "vx proves determinism." `verify.ts` +
   `runAttempt()` extraction + the hook in `executeCachedTask` +
   `RunOptions.verify`/`--verify`/`--verify-allow` + `TaskOutcome.verify`
   - the summary section + the `ok` clause + `RunRequest` threading.
     Zero cache-key/schema change. Tests: deterministic task → proven;
     a task that appends `date +%s%N` to an output → nondeterministic
     with the changed rel named; `no-outputs` skip; `--verify-allow`
     greens a known-nondeterministic task; key-stability pin
     (`--verify` hits a plain entry); hit → `not-verified`;
     `--force --verify` verifies a warm graph.
2. **Phase 2 — input-completeness via the sandbox.** `--verify=inputs`
   / `=all`, forcing the declared-input baseline sandbox onto cacheable
   tasks, relabeling violations as undeclared-inputs, with the platform
   matrix + a clean error when the sandbox is unavailable. Promote the
   escape hatch into a per-task config field `cache.verify?: boolean`
   (default true) — and exclude it from the config hash by stripping it
   in `hashTaskConfig` (`task-hash.ts:169`) before `JSON.stringify`, so
   toggling it never invalidates a key (guard test pins byte-identical
   hash with/without the field). Optional per-output ignore globs
   (`cache.verify.ignore`) for a legitimately-timestamped artifact.
3. **Phase 3 — persistence + dashboard.** Additive `verified?:` field
   on `TaskTelemetry` (`orchestrator/telemetry.ts`; additive-optional,
   no `TELEMETRY_SCHEMA_VERSION` bump — the `attempts` precedent) and a
   nullable per-entry verification record (a `verifications` table or
   `entries.verified` column; SCHEMA bump, **no** CACHE_VERSION bump —
   analytics-only, exactly like the Tier-3 tables). A "Hermeticity"
   card in the cloud dashboard beside the flaky-tasks card; a
   `vx verify` sugar subcommand.
4. **Phase 4 — cross-machine fingerprint diff.** Ship each task's
   output fingerprint (the Phase-1 `fp1`) over telemetry to the serve,
   keyed by cache key; the serve diffs fingerprints reported by
   different machines/arches for the same key and alerts on divergence
   — proving cross-platform determinism (absolute-path leaks,
   arch-specific codegen) that a single-machine re-run can't catch.
   Reuses the Phase-1 primitive end to end. **SHIPPED** — design +
   record in `docs/design/verify-cross-machine-2026-07.md`
   (`--verify=fingerprint`, the serve's `fingerprints.db` sidecar +
   `GET /v1/hermeticity`, and the Insights Hermeticity card).

## What's out of scope

- **Auto-input inference.** Verification never adds inputs for you. It
  proves the ones you _declared_ are complete and, when they aren't,
  fails with the exact paths for you to declare. That is the explicit,
  correctness-first inverse of fspy/strace guessing (owner-rejected,
  `CLAUDE.md` non-goals).
- **Not a replacement for explicit inputs**, and not sandboxing by
  default.
- **Not verifying cache hits** — a hit didn't run; `--force` re-executes
  to verify.
- **Not a correctness proof of the task's logic** — only reproducibility
  (determinism) and read-set completeness (inputs).
- **Not bit-for-bit cross-toolchain reproducibility** beyond what
  byte-comparison observes (that's Phase 4's cross-machine diff, and
  even then it only reports divergence).

## Open questions

- **Side-effecting tasks.** A task that publishes to a registry / sends
  a request runs its side effect twice under determinism verification.
  Such tasks generally shouldn't be cached at all; document that, and
  let `cache.verify: false` (Phase 2) exempt them. Do we also want a
  Phase-1 heuristic warning? (Lean no — keep Phase 1 mechanical.)
- **stdout in the determinism comparison.** Phase 1 compares outputs
  only, not replayed stdout (build tools spew timestamps; stdout is
  cosmetic and never consumed downstream — downstream reads output
  files + folds the upstream _input_ key). Confirm we never want a
  `--verify=stdout` strict mode.
- **Sampling default.** Should `--verify` without `--verify-sample`
  verify everything (Phase 1 does) or default to a fraction? Start with
  everything; add sampling in Phase 2 once cost is felt.

## Why this is the right move (bullets)

- It is a capability **only vx's architecture unlocks** — content-addressed
  outputs + a mtime-independent content hash + a declared-input sandbox
  already exist; no competitor has all three, so none can prove either
  claim. This is a genuine lead, not a feature copy.
- It is the **principled answer to the auto-input question** the owner
  closed: explicit inputs, _proven_ complete, never guessed.
- **Zero-cost and zero-risk when off** — pure `RunOptions` side-channel,
  no cache-key/artifact/schema change in Phase 1; a plain `vx run` is
  byte-identical.
- **Small, well-bounded seam** — one helper module, one extracted
  `runAttempt()`, one hook in `executeCachedTask`, reusing
  `hashFile` / `cleanOutputs` / `restoreOutputs` / `runSandboxed`
  verbatim.
- **CI-shaped payoff** — a provably-unsafe cache entry turns the build
  red with the exact task and diverging paths, turning "trust the hash"
  into "prove the hash."
