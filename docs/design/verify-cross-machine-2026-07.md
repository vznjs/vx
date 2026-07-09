# Cross-machine fingerprint diff (`--verify` Phase 4) — design

> **Status:** proposed
>
> The last open phase of the provable-cache-correctness flagship
> (`docs/design/cache-correctness-2026-07.md` § Phasing item 4). A serve
> that receives output fingerprints keyed by cache key from runs on
> DIFFERENT machines/arches diffs them and names exactly which output
> files diverge for the same key — proving cross-platform determinism
> (absolute-path leaks, arch-specific codegen, mac-vs-linux toolchain
> drift) that a single-machine re-run cannot catch.

## What we're solving

Phase 1 proves a task deterministic **on one machine**: re-run, compare
bytes. But vx's cache key deliberately folds no os/arch — the same
commit on `linux-x64` and `darwin-arm64` derives the SAME key (that is
what makes a shared remote cache work). So a task that is perfectly
deterministic per-machine but platform-DEPENDENT (embeds `process.arch`,
links against a mac-only toolchain, leaks an absolute build path) poisons
a shared remote cache silently: **first writer wins**, and the other
platform restores wrong bytes forever. No single-machine proof can see
this. Two machines' fingerprints for the same key can.

The primitive already exists: `hashOutputTree` (`src/orchestrator/verify.ts`)
produces `Map<output-key, xxh3hex(raw bytes)>` — mtime-independent,
machine-independent (XXH3 is canonical; the 2026-07-07 BUG-1 fix moved it
off `Cache.hashFile`'s memo onto raw bytes, which incidentally also made
it the right cross-machine primitive: a git-OID fold would have been
repo-object-format-dependent and memo-poisonable). The telemetry contract
already carries `os`/`arch`/`host` on every `RunContextRecord`, and the
serve already ingests `RunSummaryRecord`s per workspace. Phase 4 is glue:
attach the fingerprint to the task's telemetry, persist it serve-side
keyed by `(cache key, platform)`, and expose a diff.

## Recommendation (summary)

1. **Compute + ship fingerprints ONLY under the `--verify` family**
   (option a), and add one cheap new mode — **`--verify=fingerprint`** —
   that computes the fingerprint WITHOUT the 2× determinism re-run, so a
   per-platform CI matrix can afford to fingerprint on every scheduled
   run (`vx run --all --force --verify=fingerprint` ≈ 1× exec + a hash
   pass over just-written, page-cached output bytes). Plain runs stay
   byte-identical: no fingerprint code executes when `options.verify` is
   undefined.
2. **Payload:** additive-optional `TaskTelemetry.outputFp` — always a
   rolled-up `tree` digest + `fileCount`; the per-file map capped at 500
   entries with **deterministic truncation** (sort by key, keep first N)
   so two machines' truncated maps stay comparable; the cloud sink
   additionally enforces a 4 MiB per-run budget on the POST. No
   `TELEMETRY_SCHEMA_VERSION` bump (the `attempts`/`verify` precedent).
3. **Persistence:** a serve-side SQLite **sidecar** `fingerprints.db`
   per workspace (the LogStore pattern — its own `FP_SCHEMA_VERSION 1`
   gate, never core's Cache schema), PK `(hash, os, arch, tree)` so both
   cross-platform AND same-platform divergence accumulate naturally and
   re-delivery is idempotent. Platform identity = **os + arch**; `host`
   is a stored debugging detail, never part of identity. Age + byte
   pruning like logs.
4. **Diff surface:** `GET /v1/hermeticity?ws=` (keys with >1 distinct
   tree, diverging rels named, per-platform reports listed) + a
   Hermeticity card in the dashboard's Insights view. No CLI surface, no
   alerting/webhooks (owner-decision territory).
5. **Advisory by construction:** the serve observes completed runs; it
   never fails one. Divergence is a red flag to act on next run — fix the
   hermeticity bug, or declare the platform axis
   (`cache.inputs.runtime: ['uname -sm']`) so the keys legitimately split.

## Access pattern

- **Producer:** a per-platform CI matrix (the same matrix that builds
  release binaries) runs `vx run --all --force --verify=fingerprint`
  nightly or per-merge. `--force` matters: with a shared remote cache and
  plain reads, the SECOND platform cache-hits and never executes — which
  is exactly the poisoning scenario, so it never produces a fingerprint.
  Only `--force` (reads off, writes on) makes every platform execute and
  report. Teams already running `--force --verify` nightly (the Phase-1
  recipe) get cross-machine data with zero extra cost — the fingerprint
  rides the verify run they already pay for.
- **Transport:** the fingerprint rides the `RunSummaryRecord` the
  `cloud()` sink already POSTs to `/v1/ingest` — **no new client POST,
  no new endpoint on the write path.**
- **Consumer:** the serve extracts fingerprints during ingest (a few
  rows per run); the dashboard reads `/v1/hermeticity` on the Insights
  page (rare, human-paced). Everything is small: one row per
  `(key, platform, tree)`, ≤ ~40 KB of file map per row at the cap.

## Decisions

### 1. When fingerprints are computed + shipped — verify-family only

**Chosen: (a) only under `--verify*`, plus the new cheap
`--verify=fingerprint` mode.**

The plain-run zero-cost invariant is a hard rule, and option (b)
— fingerprint on every cacheable save — fails it even in its best form.
I checked the piggyback honestly: `Cache.save → packArtifact` does read
every output byte to build the tar, and xxh3 CPU on those bytes is
nearly free (~GB/s). But:

- It changes the **cache module's contract** (a leaf module) to return
  per-file digests up through `save()`, rippling into `LayeredCache`,
  `packArtifactBytes`, and the outcome plumbing — permanent surface for
  a feature only a connected serve with a multi-platform matrix
  consumes.
- The per-file map must still be built, capped, and JSON-shipped —
  every cloud-connected user's summary POST grows on every cold run,
  forever, for data that is useless without a second platform reporting
  the same key.
- The dense data does not even help: with a shared remote cache the
  second platform HITS, so density comes from `--force` recipes anyway —
  which are verify runs by definition. The "every save" data would be
  mostly single-platform rows.

The real cost problem with pure option (a) is different: the Phase-1
recipe is 2× exec per platform. That is why `--verify=fingerprint`
exists — same opt-in gate, no re-run, cost ≈ one xxh3 pass over output
bytes that were just written (page-cache warm). It makes per-merge
per-platform fingerprinting affordable, which is where the diff gets its
statistical power.

**Rejected:** (b) every-save piggyback (above); (c) a standalone
`--fingerprint` flag (needless second surface — it IS a verification
mode, and the existing `--verify=<what>` grammar, run gates, and wire
threading all apply verbatim).

**Mode matrix** (fingerprint = computed + shipped for executed,
cacheable, output-declaring tasks):

| Mode                        | determinism re-run | inputs sandbox | fingerprint |
| --------------------------- | ------------------ | -------------- | ----------- |
| `--verify` / `=determinism` | yes                | no             | **yes**     |
| `--verify=inputs`           | no                 | yes            | no          |
| `--verify=all`              | yes                | yes            | **yes**     |
| `--verify=fingerprint`      | no                 | no             | **yes**     |

`=inputs` stays fingerprint-free: each mode does exactly what its name
says (explicit over magical); `=all` is the everything mode. A
fingerprint under determinism modes is fp1 itself — literally zero extra
work (the map already exists at `execute-task.ts:544`); only the roll-up

- cap fold is new.

Fingerprints come **only from executed tasks**. A cache hit's on-disk
bytes are the producer's bytes — fingerprinting them would attribute
another machine's output to this platform and actively corrupt the diff.
Hits under fingerprint mode carry no verdict and no fingerprint.

### 2. Payload shape + caps

New structural type (declared in `src/graph/scheduler.ts` beside
`VerifyVerdict` — graph can't import orchestrator; same pattern), on
`TaskOutcome.outputFp?` and additive-optional on `TaskTelemetry`:

```ts
/** Content fingerprint of a task's output tree, computed under a
 *  `--verify*` mode on the executed (miss) path. Never hashed into any
 *  key; pure telemetry side-channel for the cross-machine diff. */
export interface OutputFingerprint {
  /** Roll-up: xxh3hex over the sorted (key, hash) pairs, folded as
   *  `key \0 hash \n` (\0 boundaries — the v18 lesson). Always present;
   *  divergence DETECTION never depends on the per-file map. */
  tree: string
  /** Total files in the tree (pre-truncation). */
  fileCount: number
  /** Per-file map as sorted [outputKey, xxh3hex] pairs, capped at
   *  FP_MAX_FILES (500). Deterministic truncation — sorted by key,
   *  first N — so two machines' truncated maps cover the same subset
   *  and partial diffs still name real rels. */
  files?: ReadonlyArray<readonly [string, string]>
  /** Set when `files` was truncated to the cap (or dropped by the
   *  sink's run budget). */
  truncated?: boolean
}
```

Output keys are the artifact-namespace keys `outputRefs` already
produces (project-relative rels; `workspace-outputs/<rel>` for workspace
outputs) — machine-independent and collision-free by construction.

**Cap layers (the bounded-storage law, mirroring task-logs):**

| Layer          | Cap                                                                                                   | Where                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Per task       | `files` ≤ 500 entries (`FP_MAX_FILES`)                                                                | core, `foldFingerprint()`                                    |
| Per run (POST) | 4 MiB of serialized `files` across tasks; past budget, later tasks ship tree-only (`truncated: true`) | `CloudIngestSink.flush()` — cloud-side, keeps core stateless |
| Serve          | re-truncate to 500 entries regardless of claim; 32 MiB content-length cap on `POST /v1/ingest` (413)  | `FpStore.ingest` / serve route                               |

At the cap, one task's map is ~40 KB (≈80 bytes/entry). A tree-only
report still DETECTS divergence (trees differ); it just degrades naming
to "diverged (file list truncated — >500 outputs)".

**Additive rule verified:** every existing `TaskTelemetry` consumer maps
fields explicitly — `IngestStore.ingest` builds `RunRecord`s field by
field (unknown fields drop), the otel sink reads named attributes, the
GHA summary reads named fields. A plain run's records are byte-identical
(field absent). **`TELEMETRY_SCHEMA_VERSION` stays 2** — the exact
`attempts` / `verify` precedent.

**Rejected:** putting the map inside `VerifyVerdict` (the verdict is the
local proof and renders in the terminal; the fingerprint is a wire
payload — different lifecycles); a `Record<string, string>` map (sorted
pair array makes the deterministic order explicit); shipping stdout
fingerprints (Phase 1 already decided outputs-only — stdout is cosmetic
and timestamp-ridden).

### 3. Serve persistence — sidecar `fingerprints.db`

**Chosen: the LogStore pattern.** A per-workspace SQLite sidecar
`<ingestDir>/<workspaceId>/fingerprints.db` with its own
`FP_SCHEMA_VERSION = 1` gate (drop + recreate on mismatch, loud warn).
NOT a table in core's Cache schema: a core `SCHEMA_VERSION` bump wipes
every user's local `cache.db` for a cloud-only feature — the exact
rationale documented at the top of `log-store.ts`. The ingest store's
per-workspace `Cache` is core-schema by construction, so the sidecar is
the only additive-safe home.

```sql
CREATE TABLE IF NOT EXISTS output_fp (
  hash        TEXT    NOT NULL,          -- cache key (TaskTelemetry.hash)
  os          TEXT    NOT NULL,          -- platform identity axis 1
  arch        TEXT    NOT NULL,          -- platform identity axis 2
  tree        TEXT    NOT NULL,          -- roll-up digest
  file_count  INTEGER NOT NULL,
  files       BLOB,                      -- JSON pairs, zstd ≥ 4 KiB; NULL when tree-only
  truncated   INTEGER NOT NULL DEFAULT 0,
  task_id     TEXT    NOT NULL,          -- provenance: project#task
  run_id      TEXT    NOT NULL,          -- provenance: producing run
  host        TEXT,                      -- debugging detail, NEVER identity
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (hash, os, arch, tree)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS output_fp_created ON output_fp(created_at);
```

**Why `tree` is in the PK:** `INSERT OR IGNORE` gives idempotent
re-delivery for free, a deterministic task costs exactly one row per
platform forever, AND a task that reports two different trees on the
SAME platform across runs accumulates both rows — surfacing
same-platform run-to-run nondeterminism (the Phase-1 signal, observed in
the wild without the 2× re-run) as a bonus. A `(hash, os, arch)` PK
would need first-vs-last-writer policy and lose that signal.

**Platform identity = os + arch.** That is the axis a shared remote
cache actually spans and the axis remediation acts on (`uname -sm`).
`host` distinguishes two same-platform CI runners for debugging but must
not fragment the diff. Finer axes (glibc, toolchain versions) are
deliberately out: if they matter for a task, that is precisely a
`cache.inputs.runtime` declaration the user should make.

**Ingest path:** `IngestStore.ingest(summary)` already walks
`summary.tasks`; after the invocation-header idempotency gate passes,
extract every task with `hash !== undefined && outputFp !== undefined`
into `FpStore.ingest(rows)` in one transaction. No new POST, no new
client wire. (The PK makes even a bypassed gate harmless.)

**Retention:** age horizon `VX_CLOUD_FP_RETENTION_DAYS` (default 90 —
divergence is slow-moving; nightly recipes need a long window to pair
platforms) + byte ceiling `VX_CLOUD_FP_MAX_BYTES` (default 128 MiB),
pruned opportunistically, throttled 5 min — LogStore's exact mechanics,
with `now` injectable for tests.

**Rejected:** core-schema table (wipe blast radius, above); keying by
host (identity fragmentation); a serve-side compare against `/v8`
artifact bytes (tar embeds seconds-resolution mtimes + entry order — two
identical trees produce different artifact bytes; also the /v8 store's
immutable 409 on re-PUT means the second platform's bytes never even
arrive).

### 4. The diff surface

**Endpoint:** `GET /v1/hermeticity?ws=<id>&limit=<n>` (default 50, max
500). Bearer-gated, workspace-scoped via the standard `?ws=` resolution
(this data is per-workspace by construction). Divergence is computed at
READ time — no write-time diffing, no stored alert state:

```
SELECT hash FROM output_fp GROUP BY hash HAVING COUNT(DISTINCT tree) > 1
ORDER BY MAX(created_at) DESC LIMIT ?
```

then per divergent hash, load its rows and name the diverging rels by
pairwise-diffing the stored file maps across distinct trees (the union
of keys on which any two reports disagree — core's `diffOutputTrees`,
exported from the façade so the implementation exists once).

```jsonc
// GET /v1/hermeticity?ws=…  → 200
{
  "divergent": [
    {
      "hash": "9f3ac2…",
      "taskId": "@scope/bundler#build",
      "crossPlatform": true,           // false ⇒ same-platform run-to-run divergence
      "changed": ["dist/app.js", "dist/meta.json"],
      "changedComplete": true,         // false when any report was tree-only/truncated
      "reports": [
        { "os": "linux",  "arch": "x64",   "tree": "ab12…", "runId": "…", "host": "ci-7",  "at": 1751… },
        { "os": "darwin", "arch": "arm64", "tree": "cd34…", "runId": "…", "host": "mac-2", "at": 1751… }
      ]
    }
  ],
  "keysTracked": 1342,
  "reportCount": 2811
}
```

**Dashboard:** a **Hermeticity card on `/insights`**
(cloud-data-model-2026-07 §9-10 — Insights is exactly where cross-entity
analytics land, and §1 already promised "flagged hermeticity verdicts").
Headline: divergent-key count (green zero-state: "N keys fingerprinted
across M platforms — no divergence"). Rows: task → platforms
(`linux-x64 ⇄ darwin-arm64` or `nondeterministic (same platform)`) →
diverging rels (truncated `+N more`) → last seen; rows link to
`/tasks/:id` and the producing `/runs/:id` (the entity drill-down
contract). `fetchHermeticity()` treats an older serve's 404 as `null` →
honest empty state (the `fetchArtifacts` precedent — no `/v1/meta`
capability bit needed).

Remediation guidance rendered with the card and in docs: a divergent key
means EITHER a hermeticity bug to fix (absolute paths, timestamps,
hashmap ordering) OR a legitimately platform-dependent task whose key
SHOULD split per platform — declare it:
`cache.inputs.runtime: ['uname -sm']`.

**No CLI surface now.** A `vx`-side reader would need a connected-serve
query path that doesn't exist for any other analytics (the dashboard/MCP
own reads). An MCP tool over the same query is a natural later add;
skip it here. **No alerting/webhooks** — triggers are the cloud
data-model's Phase-4 owner decision; this design never reverses that.

**Rejected:** a per-hash detail endpoint (`/v1/hermeticity/:hash`) — the
list rows already carry the changed rels + report provenance; add it
only when a real UI need appears. Serve-side write-refusal for divergent
keys (blocking `/v8` PUTs) — enforcement territory, first-writer already
wrote, and it would make telemetry behavior-changing (violates
observe-only).

### 5. What the verdict means downstream — advisory, honestly

Divergence detection is **retroactive**. The serve observes summaries
from completed runs; both runs already exited green and (with `--force`)
one of them already wrote the shared artifact. There is **no new
run-failing path**: `run.ts`'s `ok` predicate is untouched, no exit code
changes, telemetry stays observe-only by construction. The value is the
NAME — the exact task, key, platforms, and rels — turning "our mac
builds are weird sometimes" into a one-line config fix or a real
hermeticity bug report. A future enforcement story (e.g. the serve
refusing to serve a known-divergent key cross-platform) would be a cache
capability, not telemetry, and is out of scope.

## Concrete spec — core changes

- `RunOptions.verify` widens to
  `{ determinism: boolean; inputs: boolean; fingerprint: boolean; allow: ReadonlySet<string> }`;
  every existing mode sets `fingerprint` per the matrix; the parser adds
  `--verify=fingerprint` (all four `--verify` forms + the new one keep
  parser tests). The existing no-write-axis guard in `run.ts` already
  fires for any `options.verify !== undefined` — fingerprint mode needs
  cache writes for the same reason (fp is computed in the save block)
  and inherits the guard with a still-accurate message.
- `execute-task.ts`: the fp1 gate at the save block becomes
  `args.verify?.fingerprint` (fp1 already conditional there); after the
  verify/verdict block, attach
  `outputFp: foldFingerprint(verifyFp1)` to the outcome when computed.
  The determinism re-run gate stays `args.verify?.determinism` —
  fingerprint mode never re-runs, never touches the restore path.
  Fingerprint-only hits get **no** verdict (the `not-verified` stamp
  stays gated on `determinism || inputs`).
- `verify.ts`: pure `foldFingerprint(fp: Map<string,string>, cap = 500): OutputFingerprint`
  — sort keys, fold `key\0hash\n` into the tree digest over ALL entries,
  emit first-`cap` pairs + `truncated`.
- `run.ts`: project `outputFp` into `summaryTasks` (one line, beside
  `verify`); a fingerprint-only run prints one honest status line after
  the summary (`Verify: fingerprinted N task output trees (cross-machine
diff via a connected serve)`) since `formatVerifySection` is
  verdict-driven and would print nothing.
- `telemetry.ts`: `TaskTelemetry.outputFp?: OutputFingerprint` +
  the `task.end` projection line.
- `protocol.ts`: both mappers carry `fingerprint` on `RunRequest.verify`
  (additive-optional; an old serve ignores it — a delegated
  `=fingerprint` run against an old serve degrades to a harmless no-op
  verify, documented). No envelope/protocol version bump (the
  `retries`/`timeout`/`memory` precedent). `--verify` continues to
  REFUSE distribution (2026-07-07 decision) — unchanged, and doubly
  right here since distributed runs don't ingest summaries at all yet.
- `src/index.ts`: export `OutputFingerprint` (type) + `diffOutputTrees`
  (pure fn, for the serve's rel-naming) — export-only widening, boundary
  snapshot updated.

## Invariants

| Invariant                  | Status       | How                                                                                                                     |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `CACHE_VERSION`            | unchanged    | fp never folds into any key; artifact bytes untouched; a `--verify=fingerprint` run cache-hits a plain entry (pinned)   |
| Core `SCHEMA_VERSION`      | unchanged    | nothing persisted core-side; the store is a cloud sidecar                                                               |
| `TELEMETRY_SCHEMA_VERSION` | 2, unchanged | additive-optional field, absent on plain runs; all consumers map fields explicitly                                      |
| Plain-run cost             | zero         | every new code path gates on `options.verify`; plain summary/records byte-identical (pinned)                            |
| Provider-neutral core      | held         | core ships data through the neutral `TelemetrySink` contract; only the cloud plugin/serve consume; no core→cloud import |
| Run wire                   | no bump      | additive `fingerprint` on `RunRequest.verify`                                                                           |
| `DIST_PROTOCOL_VERSION`    | untouched    | verify family still refuses distribution                                                                                |
| Observe-only telemetry     | held         | serve diffs retroactively; no run-failing path, no behavior feedback                                                    |

## Test plan

**Core** (`tests/verify.test.ts` additions + parser/wire suites):

1. Parser: `--verify=fingerprint` accepted → `{determinism:false, inputs:false, fingerprint:true}`; all other forms set `fingerprint` per the matrix; bad value error message names the new mode.
2. `foldFingerprint` units: tree digest stable across insertion order; `\0` boundary (key `a\0b` vs shifted split can't alias); cap truncation deterministic (same first-N for permuted input); `fileCount` pre-truncation; empty map.
3. e2e `--verify` (determinism): executed task's summary `TaskTelemetry.outputFp` present with correct rels (via a `telemetrySinks` hook — the `attempts`-test pattern); tree matches an independently computed fold.
4. e2e `--verify=fingerprint`: task executes ONCE (pin via an exec-counter file — proves no re-run), fp attached, NO verdict, run green, status line printed.
5. e2e plain run: `outputFp` absent everywhere; summary byte-shape unchanged.
6. Key stability: warm `--verify=fingerprint` run cache-hits a plain run's entry; the hit carries no fp.
7. Truncation e2e: task with > cap outputs → `truncated: true`, `files.length === 500`, `fileCount` honest.
8. Wire: `RunRequest.verify.fingerprint` round-trips both mappers.

**Cloud** (`packages/cloud/tests/fp-store.test.ts` + serve/plugin suites):

9. FpStore gate: fresh create; version mismatch drops + warns.
10. Idempotent ingest (PK); same tree re-report adds nothing; different tree same platform adds a row.
11. Divergence query: two platforms, different trees → row with `changed` naming the rel, `crossPlatform: true`; same trees → empty; same-platform two trees → `crossPlatform: false`.
12. Tree-only report (files NULL) → detected, `changedComplete: false`.
13. Serve re-truncation: a wire map claiming 10k entries stored at 500.
14. Retention: age prune + byte ceiling (injected `now`).
15. Serve e2e: POST `/v1/ingest` with an fp-bearing summary → `GET /v1/hermeticity` returns it; bearer 401; unknown `?ws=` 404; fp-free (old) summary ingests fine and the endpoint returns empty; `/v1/ingest` 413 over the new cap.
16. Sink budget: fp maps beyond 4 MiB stripped to tree-only in the POSTed body; small runs untouched byte-for-byte.

**UI:** Hermeticity card renders divergent rows with entity links;
older-serve 404 → empty state; browser-verified per the Phase-2 ritual.

## File touch list

| File                                           | Change                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `src/graph/scheduler.ts`                       | `OutputFingerprint` (structural) + `TaskOutcome.outputFp?` |
| `src/orchestrator/verify.ts`                   | `foldFingerprint()`                                        |
| `src/orchestrator/execute-task.ts`             | fp gate → `verify.fingerprint`; attach `outputFp`          |
| `src/orchestrator/options.ts`                  | `RunOptions.verify.fingerprint`                            |
| `src/orchestrator/run.ts`                      | summary projection + fingerprint-only status line          |
| `src/orchestrator/telemetry.ts`                | `TaskTelemetry.outputFp?` + projection                     |
| `src/orchestrator/protocol.ts`                 | both mappers                                               |
| `src/cli/run.ts`, `src/cli/help.ts`            | `--verify=fingerprint`                                     |
| `src/index.ts` (+ boundary snapshot)           | export `OutputFingerprint`, `diffOutputTrees`              |
| `packages/cloud/src/fp-store.ts`               | NEW — sidecar store + divergence query                     |
| `packages/cloud/src/ingest-store.ts`           | extract fps on ingest; hermeticity accessor                |
| `packages/cloud/src/plugin.ts`                 | sink per-run fp budget                                     |
| `packages/cloud/src/cli/serve.ts`              | `GET /v1/hermeticity`; `/v1/ingest` 32 MiB cap             |
| `packages/cloud/ui`                            | `api.ts fetchHermeticity` + Insights card                  |
| `docs/cli.md`, `guides/ci.md`, dashboard guide | `=fingerprint` + the per-platform matrix recipe            |
| `docs/design/cache-correctness-2026-07.md`     | Phase-4 line points here                                   |

## Phasing (each slice independently shippable)

1. **Slice A — core.** Fingerprint compute/attach under all fp modes +
   `--verify=fingerprint` + telemetry/wire/exports. Ships alone: the
   data flows to ANY telemetry sink (an otel consumer could already
   diff externally). Tests 1–8.
2. **Slice B — serve.** `FpStore` + ingest extraction + `/v1/hermeticity`
   - sink budget + ingest cap. Tests 9–16.
3. **Slice C — UI.** Insights Hermeticity card. Browser-verified.
4. **Slice D — docs.** CI recipe (`--force --verify=fingerprint`
   per-platform matrix), remediation guidance, cli.md rows.

## What's out of scope

- **Alerting/webhooks/PR checks on divergence** — cloud Phase-4 owner
  territory; the surface is pull-only (endpoint + card).
- **Enforcement** (failing runs, refusing cache writes/reads for
  divergent keys) — telemetry is observe-only; a future cache-side story
  if ever wanted.
- **Fingerprinting cache hits or plain runs** — hits attribute another
  machine's bytes; plain runs are the zero-cost invariant.
- **stdout fingerprints** — Phase-1 decision stands.
- **Finer platform axes** (glibc/toolchain versions) — that is what
  `cache.inputs.runtime` declarations are for; os+arch is the honest
  shared-cache axis.
- **Auto-input inference / auto-remediation** — the card names the
  divergence; the user declares the fix. Owner-rejected non-goals stay
  rejected.
- **Distributed-run fingerprints** — distributed runs don't ingest
  summaries at all yet (task-logs-2026-07's documented Phase-2
  prerequisite); verify already refuses distribution.

## Open questions

- **Retention defaults** (90 days / 128 MiB) — sized for a nightly
  per-platform matrix pairing within the window; revisit with real data.
- **Should `=inputs` also fingerprint?** Kept off for mode clarity; the
  cost of flipping it later is one gate line — wait for a real ask.
- **Same-platform divergence labeling** — surfaced in the same card as
  `crossPlatform: false`; if it proves noisy (flaky-adjacent), split it
  into the flaky card instead.
- **MCP tool** over the hermeticity query — natural later add alongside
  the existing serve MCP tools; not in these slices.

## Why this is the right move

- **It closes the only gap Phase 1 provably cannot see** — a per-machine
  deterministic, platform-dependent task poisoning a shared remote cache
  first-writer-wins — with the exact task, key, platforms, and rels
  named. No competitor observes this at all.
- **Every piece already exists**: the fingerprint primitive (fp1,
  raw-bytes by the BUG-1 fix — which incidentally made it
  machine-independent), platform context on `RunContextRecord`, the
  summary POST, the per-workspace ingest layout, the sidecar-db pattern,
  and the Insights surface. This design is composition, not invention.
- **Every invariant holds by construction**: no version bumps anywhere,
  zero plain-run cost, provider-neutral core, observe-only telemetry.
- **The cheap mode makes the data real**: `--verify=fingerprint` at
  ~1× exec turns the cross-machine diff from a nightly-2×-luxury into a
  per-merge habit.
