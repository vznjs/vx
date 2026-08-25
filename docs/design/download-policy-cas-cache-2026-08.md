# Download policy + deferred outputs (2026-08)

> **Status:** proposal (2026-08-25). This is the staged remainder of
> `plugin-executor-reapi-2026-08.md` §9 phase 3 and roadmap item 4: the
> `--download=all|toplevel|none` run option, the `deferred`/`cache` kinds
> of the `ExecuteResult.outputs` discriminator (deliberately unshipped on
> 2026-08-25, thirtieth wave: no consumer existed), and the local-cache
> shape they require. The headline finding of working the design through
> is that they require **no local-cache reshape at all** — the
> "CAS-shaped local cache" the roadmap anticipated turns out to be the
> wrong move for vx's measured artifact shape, and this doc retires that
> phrase with a cost-out (§3).

## 1. What we're solving

With remote execution (`@vzn/vx-reapi` phase 2, shipped), a task runs on
a worker and `materialiseOutputs` downloads every output to the
submitter's disk. For a chain of remote tasks that is pure waste: the
next task's inputs graft the upstream's outputs by reference
(worker→CAS→worker, the exec-record mechanism), and the submitter needs
the bytes only when

- a **locally**-placed task's command will read them, or
- the user asked for them (the requested tasks' outputs), or
- nothing at all (CI that only wants the verdict + telemetry).

Bazel calls this Build without the Bytes
(`--remote_download_outputs=all|toplevel|minimal`). vx's version is
`--download=all|toplevel|none`, and the seam-level carrier is the
`ExecuteResult.outputs` discriminator that §4 of the parent design
already specifies but did not ship:

```ts
readonly outputs:
  | { kind: 'disk' }
  | { kind: 'deferred'; materialize(): Promise<void> }
  | { kind: 'cache' }
```

Everything here composes with two mechanisms that already exist and must
not be duplicated:

- **`exec.remote: 'only'`** — the per-task permanent form of "never on
  my disk", with the exec-record repeat-run short-circuit
  (`execDigestFor(vxKey)` → `ActionResult` with per-file digests,
  workspace-relative paths) written on EVERY successful remote
  execution in `packages/vx-reapi/src/executor.ts`.
- **The v27 per-artifact local cache** (`Bun.Archive` + `.vx-meta.json`
  sidecar, `<hash>.tar.zst`, SQLite index) — one week old, measured
  fast, stale-hit-critical.

## 2. Access pattern

What actually moves today on a remote-executed miss, per task:

| transfer                               | size                     | needed by                            |
| -------------------------------------- | ------------------------ | ------------------------------------ |
| input diff upload (`FindMissingBlobs`) | proportional to the diff | the worker — unavoidable             |
| output download (`materialiseOutputs`) | full output set          | **often nobody** — this doc's target |
| local `Cache.save` pack + write        | full output set again    | the next warm run on this machine    |
| remote tar.zst upload (LayeredCache)   | full output set again    | other machines' plain cache hits     |

Measured context (decision log, 2026-08-24): typical vx artifacts are
KB–MBs; pack of 300 files / 12 MB costs 11 ms; local restore is
indistinguishable from the old path at ≤ 12 MB and pays +28% time /
+19% peak RSS at 150 MB (peak ≈ 4.5× artifact bytes, structural to
`Bun.Archive.files()`). The dominant avoidable cost in a remote-exec CI
run is the **download + re-save + re-upload** of intermediate outputs
nobody on the submitter reads — network bytes, not local CPU.

Frequency: the deferred path fires on remote MISSES only. Local
executions, local cache hits, and remote cache hits (tar.zst ingest) are
untouched by this design.

## 3. The load-bearing decision: the remote store is already the deferred cache

The question the roadmap left open ("local cache as CAS + AC, so a
remotely-executed task's Tree and a cached entry are the same thing")
presumes deferral needs a local representation. It does not. A deferred
task's outputs already have a durable, addressable home: the REAPI CAS
holds the blobs, and the exec record under `execDigestFor(vxKey)` lists
them file-by-file with workspace-relative paths. That record IS the
cache entry for the deferred state — cross-run, cross-machine, already
written today, already consumed by the graft path.

So: **the local cache stays per-artifact and untouched. Deferral is a
run-scoped state in the orchestrator plus a widened read of the exec
record in the plugin.** Materialisation converges to an ordinary local
entry (§5.4), so the two-shapes problem never arises.

### 3.1 Cost-out: per-file local CAS vs per-artifact (question 3)

| axis                 | per-file CAS (Bazel-style)                                                                                                  | per-artifact + exec record (chosen)                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CACHE_VERSION        | mandatory bump (container change, v27 precedent: not self-healing) — one week after v27 landed                              | **no bump**; v27 entries stay valid                                       |
| local save cost      | + content-hash every output (sha256 to align with REAPI; vx keys are xxh3 INPUT keys, outputs were never content-addressed) | unchanged (0.3–11 ms measured)                                            |
| eviction / prune     | refcount or mark-sweep GC over shared blobs; `vx cache prune` rewritten                                                     | one unlink per entry (unchanged)                                          |
| compression          | per-blob frames; small-file ratio worse than one solid tar.zst stream                                                       | solid stream (unchanged)                                                  |
| remote wire          | `RemoteCacheLayer` ships tar.zst verbatim today; per-file forces re-pack per upload OR a wire redesign                      | one entry = one wire payload (unchanged)                                  |
| dedup across entries | wins — but unquantified for vx workloads, and artifacts are MBs                                                             | none (accepted; nothing measured says we need it)                         |
| restore memory       | fixes the 4.5× peak — which only bites at atypical ≥ 100 MB artifacts                                                       | unchanged; already recorded as an open item with a streaming escape hatch |
| deferred outputs     | natural fit locally — but the deferred bytes are REMOTE by definition, so the local shape is irrelevant to them             | exec record covers it with zero new storage                               |

The only real wins of a local per-file CAS (dedup, restore memory)
address costs nobody has measured as binding, while its costs land on
the hot save path, the prune path, the wire contract and the
version story simultaneously. **REJECTED.** Re-open only with a
measured workload where artifact-level storage demonstrably loses
(e.g. ≥ 100 MB artifacts with high cross-key overlap).

### 3.2 `cas-backend.ts` / `digest.ts`: not the foundation here

Evaluated as instructed, not assumed. `FsCASBackend` is an
artifact-store shim, not a blob store — `pathFor` hardcodes the
`<hash>.tar.zst` suffix — and `Digest` carries no hash-function
discriminator (a 16-hex xxh3 key and a 64-hex sha256 blob digest would
coexist ambiguously). Neither is needed by this design: core never sees
a blob digest (the exec record's digests live entirely plugin-side,
in the reapi wire types), and the deferral registry holds opaque
closures (§5.3). Both files stay module-internal and UNUSED by this
arc; a later audit wave may delete them or reshape them when a real
blob-store consumer appears. This doc creates no new consumer for them
— doing so would be exactly the speculative-foundation move the
non-goals list warns about.

## 4. `--download` (question 1)

### 4.1 Where it lives

**`RunOptions.download?: 'all' | 'toplevel' | 'none'` + the CLI flag.
NOT a task-config field.** Default `'all'` (today's behaviour,
byte-for-byte).

- The per-task permanent form already exists: `exec.remote: 'only'`
  ("these outputs never belong on a submitter's disk"). A per-task
  `download` field would be a second knob over the same space with a
  confusing interaction matrix.
- Download policy is transfer tuning — it can never change what a
  command produces — so it must never split a cache key. Because it is
  a RunOption, it is stripped by construction: RunOptions are never
  folded (same class as `--verify`, `--retry`, `--timeout`). No new
  stripping site in `task-hash.ts`, no key-derivation change, and a pin
  asserts keys are byte-identical across all three values.

### 4.2 The per-task decision function (plan time)

Core decides ONE effective mode per task before scheduling, alongside
placement, and `--dry`/`--graph` show it:

```
mode(task) =
  'never'     if exec.remote === 'only'            (existing semantics, unchanged)
  'eager'     if task is placed LOCAL              (local exec writes in place)
  'eager'     if download policy is 'all'
  'eager'     if policy is 'toplevel' AND task.requested
  'eager'     if task is NOT deferral-eligible     (§4.3 — correctness gate)
  'deferred'  otherwise
```

`toplevel` deliberately makes requested tasks EAGER at plan time rather
than deferring them and materialising at run end: eager materialisation
happens inside each task's own completion (today's code path, overlapped
with the rest of the run), while a run-end batch would serialise the
downloads after the last task. The request carries the decision:
`ExecuteRequest.download: 'eager' | 'deferred'` (`'never'` keeps riding
the existing `remoteOnly` flag). The local executor ignores it and
always returns `{ kind: 'disk' }`.

### 4.3 Deferral eligibility — the correctness gate

The one way deferral could corrupt a key: a task whose
`cache.inputs.files` globs (or `inputs.workspaceFiles`) can OBSERVE a
producer's outputs on disk derives a different key depending on whether
those outputs were materialised. That is precisely the relation
`stable-keys.ts` already computes conservatively (same-project
output-producers + any `workspaceFiles` involvement, folded
transitively). Reuse it, inverted:

**A producer is deferral-eligible iff no task in the run graph could
fold its on-disk outputs into a key** — no task's input globs can MATCH
the producer's output globs, no task declares `inputs.workspaceFiles`
that could reach it, and the producer declares no
`outputs.workspaceFiles`. Ineligible producers silently run `eager` (a
refusal would break a working build; the gate is a downgrade, never an
error), and `--dry` names the downgrade reason.

**CORRECTED at implementation (2026-08-25).** This paragraph first read
"no task's project-relative input globs _share the producer's project_".
Sound, but INERT: every ordinary workspace has a sibling reading the
project (`test` reads `src/**` while `build` writes `dist/**`), so that
rule marks essentially every producer ineligible and leaves
`--download=none` with nothing to defer — phase 1's consumable claim
would have been false on arrival. The shipped gate compares the globs'
STATIC PREFIXES, which answers the question actually being asked
(`src/**` cannot match `dist/**`) and keeps the conservatism where it
matters: a leading wildcard yields `.` and reaches everything, a
cacheable task with no declared `files` counts as reading its whole
project, and `workspaceFiles` on either side ignores project
boundaries — all three force ineligible. Project boundaries still bound
the search to the producer's own project, and a task never observes its
own outputs (excluded from its own key by construction).

**SECOND CORRECTION (2026-08-25, post-ship hostile pass).** Both the
original rule and its prefix refinement examined only `inputs.files` /
`inputs.workspaceFiles`. A `cache.inputs.runtime` command is a SHELL
command whose reads cannot be bounded — it can `cat` a producer's
output, or path-escape its project to do it — and its stdout is folded
into the key, so its answer moves with whether the bytes were fetched.
Deferral sharpens the hazard rather than merely inheriting it: skipping
the output clean is precisely what leaves a stale prior build for such
a command to sample. A run declaring any runtime input therefore defers
NOTHING. Blunt, and deliberately so: no static analysis can separate
`node -v` from `cat dist/version.txt`, which is the same reason vx
refuses to infer inputs by tracing. Such workspaces get today's eager
behaviour, never worse than before the flag existed.

Cross-run residual, reasoned through rather than hand-waved: a FUTURE
run's consumer that reads the producer's outputs via globs either (a)
declares `dependsOn` on the producer — then the producer is in that
run's graph and the same-run analysis makes it eager there; the key
honestly folds whatever is on disk in the meantime, and disk state and
command view always agree, so no stale hit exists — or (b) reads them
with no `dependsOn`, which is undeclared behaviour already outside vx's
contract (the same rule the git-snapshot invalidation and restore paths
document). `--verify` runs pin all placement local (2026-08-24 wave),
so nothing defers under a proof. **CORRECTED post-ship (2026-08-25):
that pinning applies to `--verify=inputs` ONLY.** Determinism and
fingerprint modes leave placement alone, so a remote task DID defer
under them — and the verifier, finding no outputs on disk, reported
`no-outputs` (an n/a verdict) for a task that declares outputs and was
simply never examined. The run now forces `--download=all` whenever any
verify mode is requested, and says so when it overrides an explicit
flag: a proof must observe what it proves.

## 5. The `deferred` kind (questions 2 and 4)

### 5.1 Contract

The executor returns `{ kind: 'deferred', materialize }` when the
request said `download: 'deferred'` and the action succeeded.
`materialize()` is the existing `materialiseOutputs` logic captured as
a closure over the `ActionResult`: batch-read blobs ≤ 1 MB, ByteStream
the rest, write under `cwd` honouring executable bits, symlinks and
`Tree` directories. Idempotent per call site because core memoises it
(below); the closure itself may assume at-most-once.

### 5.2 What core does — the save path and `isOutputsCurrent`

On `deferred`, `execute-task`:

- **skips the local save entirely** — no artifact, no `entries` row, no
  `output_files` rows, no `entry_inputs`. The parent design's §4
  sentence stands: the remote entry is the executor's own (the exec
  record + the server's native AC). A partial local record (row without
  artifact) is exactly the corrupt-entry shape `restoreOutputs` exists
  to refuse; writing none is the only clean answer.
- **skips the pre-exec output clean** (same as `remoteOnly` today): the
  bytes to replace the wiped tree with are deliberately not coming.
  Stale prior-build outputs may remain on disk; the eligibility gate
  guarantees no key in the run can see them, and the run summary names
  every deferred task so the user knows `dist/` is not current.
- registers `{ materialize, hash, entryMeta: { stdout, durationMs,
command } }` in a run-scoped `DeferredOutputs` registry keyed by task
  id, and stamps the outcome (`TaskOutcome.outputs: 'deferred'`,
  additive optional field — telemetry `task.end` and the summary ride
  it; no TELEMETRY_SCHEMA_VERSION bump, same additive precedent as
  `where`).

**`isOutputsCurrent` needs no change and never lies**: it only runs on
a local cache hit, over that entry's `output_files` rows. A deferred
task writes no rows, so there is nothing to compare — the question
cannot arise. A PRIOR run's normal local entry for the same key is
served as an ordinary local hit before placement ever happens (a local
hit beats any deferral; `--download` gates network transfer, not local
restore). After materialisation converges (§5.4) the rows exist again
and the check behaves exactly as for a saved-then-restored entry,
because the convergence save goes through the ordinary
`Cache.save` — one owner, no second entry shape.

### 5.3 `materialize()`: who calls it

**Core, in exactly one place:** before the exec attempt of a
LOCALLY-placed, cache-missing task whose transitive dependency closure
contains deferred producers. Which upstream bytes a command reads is
unknowable (that is why `dependsOn` exists), so the closure is taken
transitively and each producer materialises once, memoised run-wide,
concurrently, on the consumer's worker slot (it is that task's real
critical path; overlap refinements are out of scope, §15).
`remote: 'only'` producers are excluded — never materialised, their
contract — and a cache-HIT consumer triggers nothing (it reads no
inputs). There is no run-end caller: `toplevel` made requested tasks
eager at plan time (§4.2), and `none` means none. Cross-run wants no
caller either — that is the exec-record short-circuit's job (§6).

Sequencing per producer, mirroring `restoreHit` so the two cannot
drift: core cleans the producer's declared outputs → the closure writes
→ core runs the convergence save (§5.4) → core marks the exact paths in
the `gitFilesCache` (`markOutputsChanged` / workspace twin).

### 5.4 Convergence: materialised ⇒ ordinary local entry

After the closure writes, core resolves the declared output globs and
calls the ordinary `cache.save` with the stashed `entryMeta` (policy
gates apply — `willWrite` off saves nothing, as everywhere). From that
moment the machine is byte-indistinguishable from a `--download=all`
run for that task: normal entry, normal rows, next run is a plain local
hit, `isOutputsCurrent` skips restores. Deferral leaves no permanent
third state behind — that invariant is what keeps every downstream
reader (`get`, prune, verify, metrics) unchanged.

### 5.5 Failure semantics

`materialize()` can fail for real (CAS eviction — the AC and CAS evict
on independent schedules; the executor already warns on this class for
grafts). A consumer that needed the bytes then CANNOT run correctly, so
core **fails that consumer loudly**, naming the producer and the remedy
(`re-run the producer with --force, or use --download=all`) — never a
silent degrade, because executing against a half-materialised tree is
the stale-input class with extra steps. The producer's own outcome
(already reported `success`) stands; it did succeed.

## 6. Cross-run: widen the exec-record short-circuit (plugin-only)

Today the `getActionResult(execDigestFor(cacheKey))` repeat-run
short-circuit fires only for `remoteOnly`. It widens to any
remote-placed task whose local + remote artifact probes missed (the
deferred producer's steady state on a fresh machine) — still behind
the existing `ExecuteRequest.refresh` guard, exactly as the
`remoteOnly` path is today: `--force` skips the record and re-executes
(the tenth-wave rule — a private cache that ignores `--force` is still
a cache), and the widening must not reopen it: a record hit
skips the Merkle build, the upload pass and `Execute`, then applies the
run's download mode — `deferred` registers a closure over the record's
digests; `eager` materialises from the record (with the existing
`findMissingBlobs` completeness check; any gap falls through to a real
`Execute`). Two plugin-side additions, both additive under the existing
`vx-reapi-exec-v1` sentinel (no rekey — old records read fine):

- the record gains `stdout_digest` (the executor already holds the
  stdout bytes; one small blob upload) so a short-circuited task can
  replay stdout — absence degrades to `''`, never to wrong bytes;
- the short-circuit's ExecuteResult reports the correct `outputs` kind
  instead of unconditionally returning nothing.

Accepted cost, documented: under `toplevel`/`none` the vx tar.zst
artifact is never packed anywhere, so a machine that hits the SAME key
with a purely-local placement (e.g. `remote: false` there) gets no
remote cache hit and re-executes. Correct, just a lost hit; teams that
need cross-machine artifact hits for a task keep it eager.

## 7. The `cache` kind

For a same-checkout executor (the community-cloud recipe: an agent runs
the assignment as a scoped `vx run` and saves the artifact to the
SHARED cache under the full-run key — the §6.3 induction law of the
parent design). The executor returns `{ kind: 'cache' }`; core then:

1. `cache.get(hash)` — the LayeredCache read-through pulls + ingests
   the entry the agent saved. `null` here is a **contract violation**:
   fail the task loudly naming the executor (never silently re-run —
   that would mask a broken agent forever).
2. clean + `restoreOutputs` + `markOutputsChanged`, reusing the
   `restoreHit` internals (one restore path, not two).
3. skip core's own save. Outcome stays `success` (+ `where`) — the task
   executed; it is not a cache hit.

Honesty about consumers: nothing in-tree returns `cache` today.
It ships LAST (§13 phase 4), with core's branch + a fake-executor
contract pin as its consumer proof and the recipe documented — not
earlier, per the thirtieth wave's dead-schema reasoning. Widening the
result union later is additive for executors (only core consumes it).

## 8. The placement/transfer lattice, unified

| effective mode | outputs land locally                                        | local entry               | who sets it                                                                  |
| -------------- | ----------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `eager`        | at task completion                                          | ordinary save             | default; `--download=all`; requested under `toplevel`; eligibility downgrade |
| `deferred`     | lazily, if a local consumer or a later eager run needs them | on materialisation (§5.4) | `--download=toplevel`/`none`                                                 |
| `never`        | never                                                       | never                     | `exec.remote: 'only'` (task author)                                          |

`remote: 'only'` is the degenerate point of the same machinery
(deferred + materialisation forbidden + local no-op fallback), which is
why this design adds no second code path for it — internally the
registry and the skip-save/skip-clean branches are shared.
`--download` never overrides `'only'` in either direction.

## 9. Versioning — explicitly, per the CACHE_VERSION invariant

- **`CACHE_VERSION` stays `vx-cache-v27`.** Neither bump case applies:
  no stored bytes become wrong under an unchanged key (a deferred task
  stores NOTHING locally; eager paths are byte-identical to today), and
  the artifact container is untouched (v27 artifacts keep restoring
  correctly). Key derivation is untouched — `--download` is never
  folded (§4.1). Existing entries remain valid and keep hitting.
- **`SCHEMA_VERSION` stays `v24`.** No new tables; the deferral
  registry is run-scoped memory, by design (§3).
- **Exec-record sentinel stays `vx-reapi-exec-v1`** — `stdout_digest`
  is additive; a v1 record without it replays empty stdout, never wrong
  bytes.
- **Telemetry schema:** `TaskOutcome.outputs` is an additive optional
  field on `task.end`, same no-bump precedent as `where` (2026-08-25).
  The otel losslessness tripwire will force the span mapping, as built.

## 10. Memory

The local restore path is unchanged, so the recorded v27 numbers
(peak ≈ 4.5× artifact bytes, +28%/+19% at 150 MB, wash ≤ 12 MB) carry
over untouched. Materialisation is strictly LIGHTER than an artifact
restore: per-file fetches peak at ~max(1 MB batch, largest single
blob), with no whole-artifact decompression resident. The convergence
save adds one pack per materialised producer — 0.3–11 ms at measured
sizes, on a path that just paid a network round-trip anyway.

## 11. Core/plugin inventory: add / keep / unchanged

| item                                                                                 | verdict                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `RunOptions.download` + `--download` CLI + plan-time mode + `--dry` surface          | **Add** (core, phase 1)                                      |
| `ExecuteResult.outputs` discriminator: `disk`/`deferred`                             | **Add** (core seam + reapi, phase 1)                         |
| Deferral eligibility gate (reusing `stable-keys` relations)                          | **Add** (core, phase 1)                                      |
| `DeferredOutputs` registry + lazy materialisation + convergence save                 | **Add** (core, phase 1)                                      |
| `TaskOutcome.outputs` + summary/telemetry surface                                    | **Add** (core, phase 1)                                      |
| `toplevel` value                                                                     | **Add** (phase 2)                                            |
| Exec-record short-circuit widening + `stdout_digest`                                 | **Add** (plugin only, phase 3)                               |
| `outputs: { kind: 'cache' }` handling + recipe                                       | **Add** (phase 4)                                            |
| Local cache container, `Cache.save`/`restoreOutputs`/`isOutputsCurrent`, prune, wire | **Unchanged** — the point of §3                              |
| `cas-backend.ts` / `digest.ts`                                                       | **Unchanged and unused** by this arc (§3.2); audit candidate |
| `CACHE_VERSION` / `SCHEMA_VERSION`                                                   | **Unchanged** (§9)                                           |

## 12. Rejected alternatives

- **Per-file local CAS (Bazel-style).** Costed in §3.1: a mandatory
  CACHE_VERSION bump one week after v27, sha256 on the hot save path,
  GC complexity, a wire redesign — against unmeasured dedup wins.
- **A local "deferral stub" entry** (`entries`/`output_files` rows
  carrying remote digests, no artifact). Creates a second entry shape
  every reader (`get`, `restoreOutputs`, `isOutputsCurrent`, prune,
  verify, metrics) must learn, to save one `GetActionResult` round trip
  that the plugin already makes cheaply. The remote store is the truth
  for remote bytes; two truths is the dual-store-coherence bug class
  the 2026-08-24 waves just inverted OUT of the tree.
- **A task-config `download` field.** `remote: 'only'` is the per-task
  form; a second knob would need its own key-stripping site and an
  interaction matrix with the run flag. Run-level control + the
  eligibility gate covers the real cases.
- **Run-end batch materialisation for `toplevel`.** Serialises
  downloads after the last task; plan-time eager overlaps them with the
  run for free and reuses today's code path.
- **Materialising without the convergence save.** Leaves a
  materialised-but-unindexed tree: every later run re-fetches bytes
  that are already on disk, and the machine has a permanent third state.
- **Packing the vx tar.zst on the worker** (so deferred tasks still
  feed the artifact wire). The worker would need vx's container format
  and sidecar semantics — a smart server, exactly the grain REAPI's
  interchangeability forbids.
- **Shipping all three discriminator kinds at once.** `cache` has no
  producer until a same-checkout executor exists; it ships with its
  consumer proof (phase 4), not before — the thirtieth wave's rule.

## 13. Phases — each independently consumable

1. **`--download=all|none` + `disk`/`deferred`, end to end.** This is
   the first consumable slice, precisely: core ships the RunOption +
   CLI parse, the plan-time mode + eligibility gate, the request field,
   the registry, skip-save/skip-clean on `deferred`, lazy
   materialisation + convergence save for locally-placed consumers, the
   fail-loud eviction path, and the `--dry`/summary/telemetry surfaces;
   `vx-reapi` honours `download` and returns the `deferred` kind with
   the closure. Consumable as: a CI job runs
   `vx run build --all --download=none` against a REAPI cluster and
   moves zero output bytes to the runner, while a laptop's mixed run
   still works because local consumers materialise lazily. `all`
   remains byte-identical to today.
2. **`toplevel`.** The requested-set split in the plan-time decision
   function + pins. Small by construction (§4.2).
3. **Exec-record short-circuit widening + `stdout_digest`.** Plugin
   only; makes repeat `--download=none` runs skip Merkle/upload/Execute
   and gives short-circuited tasks stdout replay.
4. **`{ kind: 'cache' }`** + the same-checkout executor recipe doc +
   the contract pins.

## 14. Testing (differential, per the standing rules)

- **Key identity:** one workspace, three `--download` values → three
  byte-identical key sets (the stripping pin; fails if anyone folds it).
- **Eligibility, both directions:** a same-project glob consumer forces
  its producer eager (deferring it must fail this pin); an isolated
  producer defers (the false-positive control — the gate must not
  degenerate into "everything eager").
- **No-local-entry:** a deferred task leaves no `entries` row, no
  artifact, no `output_files`/`entry_inputs` rows.
- **Lazy materialisation:** a locally-placed dependent finds the bytes
  on disk before its command runs; removing the materialisation call
  fails exactly this pin. Memoisation: two consumers, one fetch.
- **Convergence:** after materialisation, the next run is a plain local
  hit and `isOutputsCurrent` can skip; the entry is byte-equivalent to
  an eager run's (compare `output_files` rows + artifact readability).
- **Never-clean:** deferred leaves pre-existing disk state untouched;
  `remote:'only'` is never materialised even with local dependents.
- **Fail-loud:** an evicted blob fails the CONSUMER with the producer
  named; the producer's outcome stays `success`.
- **Live e2e** (`exec-e2e.test.ts` pattern, NativeLink + bazel-remote):
  a two-task remote chain under `none` executes with zero
  `materialiseOutputs` traffic (assert the exact blob-read set, not
  "fewer"); phase-3 short-circuit replays stdout from the record.
- **`cache` kind (phase 4):** fake executor saves to the shared cache
  and returns `cache` → outputs restored through the ordinary path, no
  double save; a lying executor (returns `cache`, saved nothing) fails
  loudly.

## 15. What's out of scope

- Any local-cache container or schema change (§3, §9).
- Prefetching materialisation before the consumer starts (overlap
  refinement — measure the slot-blocking cost first).
- A standalone `vx download <task>` verb for fetching after a
  `--download=none` run — re-running with `--download=toplevel` covers
  it via the phase-3 short-circuit; a verb is UX sugar for later.
- Changing cache POLICY semantics: `--download` governs
  remote-execution output transfer only; locally-executed tasks and
  `--cache=...` axes are untouched and orthogonal.
- Partial materialisation (single files out of a deferred set) — the
  task is the unit, as everywhere in vx.
- Deleting/reshaping `cas-backend.ts`/`digest.ts` (noted for an audit
  wave, not done here).

## 16. Open questions

- Should the summary's deferred marker also print the aggregate bytes
  left remote (the exec record has sizes)? Cheap, but summary width is
  contended — decide at implementation with the logger owner.
- Phase-3 short-circuit + `--verify`: verify pins placement local, so
  the short-circuit never fires under a proof — confirm the pin covers
  the widened path once it exists.
- Whether the eligibility downgrade should warn once per run (vs only
  `--dry`) when it makes `--download=none` mostly ineffective on a
  glob-heavy workspace.

## 17. Why this is the right move

- **Zero cache-version risk in the worst failure class.** No container
  change, no key change, no stored bytes to get wrong — deferral stores
  nothing locally and converges to the existing, week-old, measured v27
  shape. CACHE_VERSION and SCHEMA_VERSION both stand still.
- **It composes instead of duplicating.** The exec record, the graft
  path, `remote: 'only'`, `stable-keys`, `restoreHit`, the save path —
  every mechanism this needs already exists; the design adds one
  run-scoped registry and one request field, and unifies `'only'` as
  the lattice's fixed point rather than a parallel code path.
- **The correctness gate is inherited, not invented.** Key-observability
  of outputs is exactly the relation the short-circuit/prefetch
  stability analysis already computes conservatively; reusing it means
  one owner for the class.
- **Honest about what it does not buy.** Deferred tasks feed no
  tar.zst artifact wire (a named, accepted lost-hit case), `none` on a
  glob-heavy workspace degrades toward `all` via the gate, and the
  per-file-CAS wins (dedup, restore RSS) are explicitly forgone until
  measurement says otherwise.
- **Every phase lands whole.** The first slice is a complete,
  CI-consumable feature; nothing ships behind a flag waiting for a
  later phase to give it meaning.
