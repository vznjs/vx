# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped in this arc

A digest, newest last; the commits carry the detail. Numbers are the
1000-project bench (`bench/run.ts`, warm, whole process, best of 5)
unless a shape is named; "interleaved A/B" means arms alternated against
an immutable `git worktree` of the previous commit.

**Scope reset (2026-09-02).** Compact `CLAUDE.md`; removed
`@vzn/vx-agents`, predictive scheduling, the mcp-only queries, the
decision-log archive, `docs/progress/` and the removed products' design
docs. `bench/` fixed for the `packages/vx` layout.

**Perf waves, warm run 400 → ~172 ms at 1000 projects** (100 projects
105 → 74–79 ms):

- W1: unscoped runs start git before configs load; config-eval cache
  for provably-pure configs (`config_evals`). 400 → 270 ms.
- W2: `VX_TIMING=1` stage table; one worktree walk (`ls-files -s -v` +
  `status --porcelain -uall`, 4 spawns not 5); `.git/HEAD` read directly
  (−10 ms); discovery via readdir not glob (25 → 2 ms); code-unit sort
  (−28 ms ICU). 270 → 242 ms. REFUTED: sync fs on the hit path (40 ms
  slower under concurrency); one `bun build --target=bun` bundle (start
  25 → 36 ms).
- W3: `CacheLayer.getMany?` + `CacheEntry.outputRows`; memoised globs.
  2000-task `run test --all` 328 → 311 ms.
- W4: `vx info` reports git's fsmonitor/untracked-cache; the eval key
  folds `VERSION` (a stored evaluation must not outlive its validator).
- W5: the classify pass runs for flat graphs too (one batched `getMany`).
  100 tasks 84 → 78 ms, 1000 → 249 → 237. REFUTED: fsmonitor at 100
  projects; lazy-loading modules (`--version` is 13 ms of module load).
- W6: `output_dirs` — the output glob walk left the warm hit (0.36 ms/hit,
  365 ms CPU); directory mtimes prove the set. 224 → 204 ms, run graph
  98 → 18 ms. Racy-clean rule `OUTPUT_DIRS_RACY_MS` = 50 (Linux coarse
  timestamps; a racy snapshot is dropped whole).
- W7: git starts right after `findWorkspaceRoot`: 195 → 172 ms (−12%).
- Unread `runs_hash` index dropped: 1000 inserts 11.5 → 3.9 ms. Eval
  lookups one `IN` query per round (3.6 → 0.7 ms). Discovery stats the
  config names (9.6 → 6.3 ms). Warm config load keys from stat
  identities via ordered closures (`config_closures`,
  `CONFIG_EVAL_VERSION` 2): load configs 27 → 20 ms in-process.
- REFUTED as leads: fsmonitor (57.6 vs 59.1 ms), git's untracked cache,
  `status -unormal` (a clean matrix reads equal; the 18.8 ms was a
  probe's residue in the index — clear it with
  `update-index --no-untracked-cache`), the `getMany` artifact stats
  (2.7 ms), lookahead scheduling. The git walk is git's fixed cost.
- Floors and the stage table live under Next § 5.

**Pipeline v2.** Stages `config` / `project` / `graph` (in-place edits,
re-validated, zero cost undeclared); `commands` (plugin verbs, core
wins, `vx help` lists them; a verb resolving a non-integer fails
naming the plugin); `key` (material folded as `plugin` components, no
`CACHE_VERSION` bump) and `schedule` (weights over the baseline); the
predictive mode returned as `@vzn/vx/plugins/schedule-history`. The
`eventSink` seam is gone. `@vzn/vx-mcp` is back as a plugin on
`commands` (no SDK; a streaming decoder per session after a split-`é`
bug). README, site intro and the extensibility guide reframed on the
stage table.

**Distribution and the binary.** Bun 1.4.0 compiled binaries are
SIGKILLed on this macOS until `codesign -s - --force` (release and CI
re-sign). The binary resolves packages by directory convention only, so
root shims `packages/*/index.ts` + `plugins/<name>/index.ts` exist and
are pinned. The npm manifest exported only `"."` and the darwin platform
binaries were unsigned — both fixed in `npm.yml`; the version stamp
targeted the wrong manifest (every release would have said `0.0.0`) —
all stamp steps hit `packages/vx/package.json` and assert `--version`.
The npm launcher is pinned through `node`. `isUserError` classifies by
name across the binary's second copy of core (the copy itself, ~12 ms,
stays parked — see Next § 3, incl. the refuted resolve-hook route).

**Cache container, streamed (waves 9–10, 2026-09-03).** vx's own
streaming tar reader and writer (`src/cache/tar-stream.ts`) replaced
`Bun.Archive` on every side. Restore: one staging extractor (write
beside the target, rename after the WHOLE archive is read and the
index's outputs are present; abort unlinks temps and prunes only empty
directories). 150 MiB incompressible artifact, fresh process: restore
peak +644 → +49–60 MiB (same wall); save +705 → +241–269 MiB (160 →
~200 ms, the streamed compressor is ~2.4× per byte); ingest +448 → +318
MiB with the compressed bytes live. Artifacts ≤ 4 MiB compressed pack
and decode in one call (stream setup ~35 µs each; tiny-artifact A/B
inside noise). A sizeless zstd frame is decoded under the running 2 GiB
count instead of refused; the `trusted` flag went. Reader pins: pax
`path`/`size`, GNU `L`, base-256 sizes, checksums, truncation, strict
octal, ustar split at its exact limits (against libarchive and the
system `tar`), a poisoned trailing entry writing nothing, a concurrent
writer's file surviving abort, a cut compressed stream refused with no
temp. No `CACHE_VERSION` bump: same layout, readable either way. One
defect found by the audit rotation the same evening: a name over 100
bytes made of multibyte characters (a 141-byte Japanese path is
enough) threw "name too long for ustar" instead of writing its pax
record, because the header name under pax was sliced by characters;
it is the first 100 bytes now, pinned against vx and libarchive, and
the pin fails without the fix. Memory claim measured to its edge: vx
holds one chunk (a single 400 MiB entry restores at +30 MiB, the same
as 150 MiB), while 200 × 2 MiB entries read +90–180 MiB of per-entry
garbage the collector paces — identical configurations differed by
90 MiB run to run, so no code change is justified; the docs now say
"holds one chunk", not "bounded by a chunk". The in-flight write bound
and the buffering threshold were both varied and changed nothing. The
darwin CI job's compiled-binary step now declares an output, deletes
it and asserts the cached run restores it, so the container is
exercised through the binary on every push, not only locally.
Measurement traps recorded: a Blob source is not bounded; a one-process
memory probe with a large buffer live reads GC pacing (+315 vs +30 MiB
in a fresh process); piped oxlint prints one line per finding.

**Headline benchmark and site.** The landing page is the 1,090-package /
3,270-task shape again, with cold, warm, restore and CPU rows: vx 3m 46s
/ 510 ms / 777 ms / 34.6 s; Turbo 2.10.12 5m 13s / 760 ms / 1.17 s /
73 s; Nx 23.2.0 34m 44s / 3.59 s / 4.15 s / 114 min. Baseline is the
theoretical best case (cold = critical-path-first list schedule of the
exact DAG on 10 workers, 3m 38s, `bench/ideal.ts` with pins; the other
rows 0); bars are proportional with an outlier clipped past 10×.
`bench/update-site.ts` generates rows, tiles, note and
`benchmarks.md` from `results.json`; `site-check` gates drift.
`RUNNERS=vx` re-measures one runner in ~6 min; `BASELINE_ONLY=1` the
floors. Re-measured after waves 6–7, 9 and 10: no regression.

**`vx init` and first-run DX.** `migrate-scripts` maps `package.json`
scripts to tasks (pre/post hooks folded in npm order, `<pm> run x`
becomes a group, `build` gets a TODO showing the cache block to add —
until 2026-09-04 it got a block with EMPTY outputs, which is a cached
no-op, not an uncached task: the init walkthrough deleted `dist` and
the next run reported both builds `up-to-date` and rebuilt nothing;
pinned as a differential in the init suite). Same walkthrough, same day: a root with no
`vx.workspace.*` fails with `run \`vx init\``ahead of the plugin
snippet (a file that declares nothing keeps the plain error); a task
with no`cache`block reads`no-cache`on its row, in the legend and
in the report instead of`miss`(the column is eight wide; the Tally
and`--summarize`payloads are unchanged);`vx rnu`says`Did you mean
run?`. And `vx watch`on that fresh workspace re-ran forever: with no
declared outputs the build's own write to`dist/`was an event, and
each cycle wrote it again — watch now drops an event for a file whose
bytes did not change since it last hashed it (one redundant cycle, then
quiet; the e2e pin read 7 re-runs in 1.5 s without it).`init`on a workspace with no scripts writes the workspace file
and prints an example config and the next command; generated configs
carry`import type { ProjectConfig }`+`satisfies`(erased at runtime);
an unresolved config import is a`UserError`naming the file and, for`@vzn/vx`, the install command; a typo says `Did you mean build?`,
and a qualified one is hinted as a runnable spec on either half
(`ap#build`, `app#buidl`→`app#build`).
`vx watch` ignores a task's own declared outputs (one cycle per edit)
and proves each watcher delivers before saying "watching"
(`.vx-watch-probe`, re-written on a backoff; the e2e flake is NOT
proven closed — see Next § 4). The cache dir writes its own
`.gitignore`. Replayed and found working as documented: every verb,
the policy flags, a failing task, a persistent task, `--affected`, the
plugin author's first plugin from the guide (which gained § Testing
your plugin), the same first run through the compiled binary, and
`vx migrate`on a scratch Turborepo (negated outputs and the
persistent task get exact TODOs,`env`passes through, global inputs
become`vx-preset.ts`) and on a scratch Nx graph (named inputs expand,
`{workspaceRoot}` outputs map, chained commands join) — where the
common executors (`@nx/vite:\*`, `@nx/vitest:test`, `@nx/jest:jest`,
`@nx/eslint:lint`, `@nx/js:tsc`) now become their CLI under a TODO
naming the executor instead of an exit-1 placeholder; pinned with the
unknown-executor control, fails without the table. A mistyped flag
names the documented one within two edits (`--concurency`→`did you
mean --concurrency?`), the candidates read from the help text's
sections marked for the verb so no second list drifts and no other
verb's flag is ever suggested (`--older-tha`under`run`gets no hint;
found by probing);`editDistance`lives in`util/`. And the plugins
guide's promise that its code is real is pinned:
`tests/docs-snippets.test.ts`type-checks every block against the
façade (13 of 14; the contract sketch is skipped by rule). The other
six guides'`ts` blocks are prose excerpts by design — object
fragments without a wrapper — and stay unchecked.

**Audits with pins (each mutation fails exactly its pin).** Config-eval
purity gate closed against `\u0070rocess`, `global`/`self` aliases and
`Temporal` (`configEvalKey` refuses backslashes in code); `getMany`
parity with `get` (read gate, deleted artifact, LRU touch); the shard
dealer and an empty shard refused; sixteen dead `export`s and ten
test-only barrel names removed; comparison.md re-verified against Turbo
2.10.12 / Nx 23.2.0; two orphan site pages found and the sidebar
coverage pinned; generated site pages self-describe. The core suite
runs as four shards (`bun test --shard=<i>/4` since 2026-09-05; the
descriptor tripwire test is kept for the day Bun fixes the ~2 pins per
import that make one process hit the macOS cap).

**Stale-claim sweep (2026-09-03, evening).** Six live docs described
a removed seam or a rejected approach as current: the fork map and the
execute-task and inputs module docs offered auto-input inference (a
rejected approach) as a plan; prepare.md offered `globalInputs` /
`globalEnv` and a telemetry handle; the module index, plugin.md,
plugin-host.md, orchestrator.md and the architecture walkthrough still
described the `eventSink` seam removed in pipeline v2. All corrected
to what exists; the grep for the class (`EventSink`, `inference`,
`globalInputs`, `predictive`, `dashboard`) is clean outside history.
The same evening: the dispatcher module doc was rebuilt from the verb
switch (it listed `mcp` as core, kept a service-package redirect row,
omitted `init`/`why`/`last`/`prune`, linked four module docs that do
not exist); four docs still named the removed service package's
coordinator (façade list, module index, scheduler, dispatcher); the
why-vx-is-fast page said vx has no config-eval cache and quoted June
numbers; the key-derivation list and the caching guide gained the
`key` stage's plugin material; the pipeline design doc's `commands`
shape was wrong; and three "upstream hash" phrasings now say input
key, never outputs.

**Stale-hit class, caught by CI on a docs-only commit (2026-09-03
evening).** The stat memo behind `Cache.hashFile` (mtime, size, ctime,
inode, all floored to ms) reused a digest after a rewrite that landed
in the same millisecond as the stat it had recorded — mtime restored,
same size, same inode, same ctime to the ms — the racy-clean class
git's index solves and the directory snapshot got in the morning. A
file changed within `FILE_HASH_RACY_MS` (50) of the stat is now hashed
but not memoised; pinned (a fresh file leaves no `file_hashes` row, an
aged one does; fails without the fix). The warm path never meets the
window. The pin first assumed the write and the hash land within the
window and failed under the loaded gate; it now retries until an
attempt provably lands inside it, measured from the file's own ctime.

**Red mains, each explained and pinned:** RED MAIN 638281d (2026-09-03,
mine): a pin's import never landed and the gate failed lint and a
shard, but the commit was chained after a gate piped through `grep`,
whose exit status is grep's — the rule CLAUDE.md states; fixed in the
next commit with the gate's own exit tested, and the memory carries it. an ms-mtime precondition
sampled the clock (stamped now); a 400-round guard past the 5 s
timeout under four shards (30 s + cost hint); Linux racy-clean (the
50 ms window); a darwin-only timing assumption in an e2e pin; a version
assertion written against `cd` (both jobs name the manifest from
`$GITHUB_WORKSPACE`). The macOS sandbox reporting-loss residual (~2%
under load) gates its reporting pins on `VX_REQUIRE_SANDBOX`. And one
gate that failed on every shard was the BOX (load 70–97, `diagnosticd`
pegged): HEAD failed identically; CI was the arbiter and the full gate
passed once the load fell.

- **The runtime bump to `@anthropic-ai/sandbox-runtime` 0.0.75 (owner,
  e924276) reds ubuntu; fixed 2026-09-04.** Six Linux cases failed with
  exit 1 and an empty stderr — every task that SUCCEEDS. Reproduced in
  a privileged OrbStack container (`oven/bun` + bwrap/socat/strace/rg,
  as a non-root user; the suite is the CI signature exactly). Cause:
  0.0.75 feeds SRT's violation store on Linux from its new seccomp
  helper's write observer, judged against the GLOBAL `allowWrite` from
  `initialize` (empty; the per-task list is in `customConfig`, which
  the monitor never sees), so a task's write to its own declared output
  arrived as `deny openat <output>` and fail-on-violation turned exit 0
  into 1. vx reads the store on macOS only now; Linux detection stays
  the strace pass. 28 pass / 1 darwin skip / 0 fail in the container.
  Second finding, same bump: as ROOT in a container the helper cannot
  create its nested user namespace under `--cap-drop ALL`
  (`write /proc/self/uid_map: EPERM`; a non-root user can), and the
  old probe's bare `bwrap … /bin/true` passed anyway. The Linux probe
  now runs ONE sandboxed `true` through SRT's own wrapper and refuses
  up front naming the fix (non-root, or `enableWeakerNestedSandbox` on
  every sandboxed task — `run()` probes the weaker mode only when all
  opt in); a Linux pin says available ⇒ a sandboxed `true` exits 0. The
  suite's `expectOk` prints `<task> <status> exit=<code>` and the
  collected output on failure, so the next red names itself.
- **A read grant on a directory shadows a write bind inside it, on
  Linux only (2026-09-04).** Granting the project directory as a read
  prefix (the "express the declaration, not vx's enumeration of it"
  change) made every write to a declared output fail with `Read-only
file system` under bwrap whenever the workspace root is denied, which
  is always. Reproduced minimally in a container: `read=[project]`
  fails, `read=[project/src]` passes, same command, same everything
  else. macOS never saw it because seatbelt rules are precedence-based
  rather than mounts, which is why it passed the local gate and failed
  CI. The grant existed to make `--verify=inputs` work on this repo's
  build and has no consumer now that verify is gone, so it is REVERTED
  rather than patched. If a `sandbox: {}` task ever needs to LIST a
  directory it declared, this is the problem to solve, and the fix
  belongs in mount ordering (deepest bind last), not in the allow
  lists.

- **`--verify` is gone (owner, 2026-09-04).** All of it: the
  determinism proof, the input-completeness proof, the cross-machine
  fingerprint feed, `--verify-allow`, the verdict vocabulary and the
  telemetry fields. The input half could only work by ENCLOSING a task
  in the OS sandbox, which means guessing right about everything a task
  might legitimately do — three separate fixes today and it still broke
  the docs-site build. Watch-only observation would not have that
  problem, but the runtime cannot do it: no dry-run, no report-only, no
  audit mode, and its violation model is denial-based. macOS has no
  usable alternative either (`sandbox-exec` has no trace flag here, the
  `(trace)` directive emits nothing, and everything else needs root or
  an entitlement). Determinism and fingerprint needed no sandbox, but
  the owner's call was to remove the feature whole rather than keep a
  flag that means part of what it says. Users get isolation by
  declaring `sandbox` on a task instead. Removed: 174 lines of
  orchestrator code, an 861-line suite, two design documents, the CLI
  flags, the scheduler's verdict types, and the verify prose across the
  docs and site guides. What survives is the sandbox itself, plus
  today's three fixes to it, which `sandbox: {}` still needs.
  NOTE: dated design documents still mention `--verify` as history;
  they are records of decisions, not current documentation.

- **`vx <verb> --help` works (2026-09-04).** It did not, for any verb:
  the first thing a user types answered `unknown flag: --help` and
  exited 1. Core verbs now print the reference and exit 0; args past a
  `--` still belong to the task, and plugin verbs still own their own.
  Pinned across every verb in the dispatcher. Every argument error now
  ends with `(see \`vx <verb> --help\`)`— there was nowhere to send a
user before — and`bin.ts`no longer prints`vx: vx why: …`, since it
owns the `vx: ` prefix and six messages already named the tool.
- **`vx migrate` walkthroughs, both sources (2026-09-04).** Turbo:
  clean on a realistic `turbo.json` — global fields become the
  imported `vx-preset.ts`, `dist/**` outputs and `env` survive, the
  root task `//#format` is reported as unmigratable, and the warm run
  is all up-to-date. Nx: correct from the resolved graph, but a
  dev-server executor became an ORDINARY task, so `vx run serve` would
  wait forever for an exit that never comes — while the turbo path
  (`persistent: true`) and the scripts path (the task name) both got it
  right. One rule now in `migrate-persistent.ts`, imported by all
  three: a known executor is authoritative about lifetime, anything
  else falls back to the name. Pinned differentially.
- **`@vzn/vx-turbo-cache` and `@vzn/vx-nx-cache` (owner's ask,
  2026-09-04).** Two zero-dependency `cache` plugins over the seam
  recipe, each against the OFFICIAL self-hosted API read from its spec:
  Turbo's `/v8/artifacts` (Bearer, `teamId`/`slug`, HEAD/GET/PUT, the
  batch POST for `hasMany`, `x-artifact-duration`, and the v2 artifact
  signature — HMAC-SHA256 over length-prefixed prefix/hash/team/body,
  base64 in `x-artifact-tag`, key ≥ 32 bytes raw, transcribed from
  `signature_authentication.rs`) and Nx's `/v1/cache/{hash}` (GET/PUT,
  Bearer, 404 miss, 409 = immutable record = done, 401/403). Nothing on
  by default: declared explicitly, options over the tools' own env
  vars, decline when unconfigured; a refused token warns once and turns
  the layer off. Each suite drives a strict in-memory server for its
  spec and a full `vx run` round trip (miss → upload → local wipe →
  `cache-hit-remote`): 8 + 6 tests. The wire is theirs; the artifacts
  are vx's. NOTE for the owner: no plugin package is on npm yet — the
  publish workflow ships core and the four platform packages only.
- **CI's Bun is pinned to 1.4.0 (2026-09-04).** The runners installed
  `latest` and Bun 1.4.1 landed under the fix above, breaking three
  things in one run: the darwin-x64 cross-compile in the site build
  (`bun-darwin-x64-v1.4.1 is not available for download` — 1.4.1's
  target binaries were not published yet), the descriptor tripwire on
  macOS (1.4.1 measured exactly 0 pins for 40 imports — the leak is
  fixed; the pin now reads both sides of the boundary and the isolate
  hint can go once the minimum Bun is 1.4.1), and the ubuntu job's
  diagnostic `bun -e` step, which prints the probe's verdict and waits
  for exit — the probe now initializes SRT on Linux, whose sockets kept
  the process alive to the 10-minute timeout (step exits explicitly;
  the probe's doc says so). Pinned in `ci.yml`, `docs.yml`, `npm.yml`;
  bump deliberately, with the gate.

**The sandbox becomes one capability interface (2026-09-05).** `sandbox`
moved under `exec` and stopped mirroring SRT's config: `allow` / `deny` /
`ignore` share one shape (`read`, `write`, `network`, `systemInfo`,
`unixSockets`, `localBinding`, `machLookup`, `pty`, `gitConfig`), and vx
translates it per platform. Every task in all eight projects now declares
one, with a single documented exception (below).

- **Cache no longer feeds the sandbox.** `cache.inputs` says what
  INVALIDATES a task, `allow` says what it may TOUCH; deriving one from
  the other widened the sandbox silently in one direction and forced
  paths through the cache key in the other. The only grant core still
  makes is dependencies — `node_modules` plus the real path of every
  workspace package symlinked there, so no project names a sibling to
  import what its `package.json` already depends on.
- **Enforce at the workspace root, report inside the project.** A task
  never leaves its project; being stopped at that wall is not a finding
  (every process walks `/` down to its cwd). Only denials on the
  project's own files are reported — those are the ones that make a
  cache key wrong.
- **Three visibility bugs, one report.** The live/focused frame never
  rendered the section (`violationSection` is now shared with the
  buffered renderer, unique lines verbatim, red header); the macOS
  settle window was removed (owner call — it cost 300 ms on EVERY clean
  sandboxed task against 26 ms for one that reports, and the store is
  lossy either way); `localBinding` / `unixSockets` / `machLookup` /
  `systemInfo` never reached the profile at all — SRT 0.0.75 reads the
  first three off `initialize()`'s config, never the per-call one, and
  has no field for the fourth. vx now appends the SBPL rules to the END
  of the seatbelt profile, the only position where last-match-wins puts
  a rule of ours above SRT's.
- **macOS cannot nest, proven.** An inner `sandbox-exec` with
  `(allow default)` still dies `sandbox_apply: Operation not permitted`
  (exit 71). `@vzn/vx#test.bun.shard-*` is therefore the one task in the
  repo with no sandbox block — its suite spawns sandboxes. Pinned by a
  test so the day macOS or SRT lifts it, the gate says so.
- **Globs in grants, per platform.** macOS passes the pattern into the
  policy (matches files created during the run); Linux expands it at task
  start, because a grant there is a mount. `<d>/**` and `<d>/**/*`
  collapse to `<d>` on both — without that, `read: ['**/*']` could not
  list its own cwd. A read grant that is an ANCESTOR of a write grant is
  punched into its children on Linux, where bwrap's ro-bind would
  otherwise shadow the write.
- **`network` domain lists were never enforced either, and cannot be
  per-task.** SRT runs ONE filtering proxy per run and checks every
  request against `initialize()`'s allowlist, so a per-task list silently
  allowed nothing (`vx run build` on a cold CI runner could not download
  its cross-compile target: `Network error … check your proxy settings`).
  `run()` now arms the proxy with the union of every domain any sandboxed
  task declared. Per-task enforcement survives where it counts: a task
  that declares none is never handed the proxy's port.
- **The report filters were seatbelt-only.** They parsed
  `deny(1) <op> <path>` and nothing else, so on Linux every strace-shaped
  denial skipped both the project scope and `ignore` — CI reported the
  workspace-root `package.json` as a finding and two tests failed for the
  same reason. Producers now describe their own records (`target`,
  `path`, which `ignore` lists apply) and `reportableViolations` is one
  exported, platform-free function with tests driving both shapes.
- **A `~` write grant created a literal `~` directory in the project.**
  Write grants are pre-created because bwrap cannot bind a path that does
  not exist, but only the ones the project owns; absolute and `~` grants
  are the user's own. Differential test.
- **Two configs were wrong and are fixed.** `lint.oxfmt.fix` carried a
  build task's grants (`write: ['dist/vx-darwin-arm64']`) and could not
  rewrite a single file; the prune install test staged into the host's
  TMPDIR and cached under HOME, and is now hermetic inside the subset it
  emits.

**Every project under `packages/`, and every task sandboxed (2026-09-05).**
`bench/`, `apps/docs/` and `docs/` were top-level trees that code lived in
and no project owned; they are `packages/vx-bench`, `packages/vx-docs` and
`packages/vx/docs` now, `scripts/build-npm.ts` moved under
`packages/vx/scripts`, and `workspaces` is just `packages/*`. 33 exec
tasks across 9 projects declare `exec.sandbox`; `@vzn/vx#test.bun.unsafe`
is the only one that does not, and it is named for the reason.

- **A permission is the last resort, not the first.** Four suites failed
  sandboxed and three needed no grant at all: the remote-cache stub and
  the upgrade downloader bound localhost ports, and now use an in-process
  `Request → Response` handler and a stubbed `fetch`; the doc-drift and
  boundary tests read the workspace, and follow their subject
  (`packages/vx/docs`) or move to the unsafe suite; the `cli -h` test ran
  `run()` against this repo and wrote `.vx/cache`, and now builds a
  throwaway workspace. Only `machLookup: ['com.apple.FSEvents']` was
  granted, by the owner, after the alternative shipped.
- **`vx watch` polls when the OS will not talk.** `fs.watch` on macOS is
  FSEvents; inside a sandbox without that mach-lookup the call SUCCEEDS
  and never fires — measured, 0 events recursive and 0 plain against 3
  and 2 for the same writes outside, while `watchFile` polling delivered
  in both. The loop already probed for delivery; a failed probe now swaps
  in `pollWatcher` instead of only warning, and `VX_WATCH_POLL=1` forces
  it. Network mounts and container binds fail the same way.
- **macOS cannot nest a sandbox, so `probeSandbox` says so.** An inner
  `sandbox-exec` with `(allow default)` still dies `sandbox_apply:
  Operation not permitted` (exit 71). The probe answered `available:
  true` inside a sandbox, which is how a suite that exercises the sandbox
  came to fail sixteen ways at once. `tests/*.unsafe.test.ts` is that
  suite plus the cross-project law; the shards exclude it with
  `--path-ignore-patterns` and `test.bun.unsafe` runs it.
- **Exposing a port from a sandboxed task: macOS yes, Linux not yet.**
  Measured — a sandboxed server on macOS is reachable from a DIFFERENT
  sandboxed task (200), and refused when that consumer has no
  `localBinding`. On Linux every sandboxed task gets its own netns
  (`--unshare-net` whenever a network config exists, which vx always
  sends), so nothing sees the port. Opening the netns works but costs
  full egress; the narrow answer is a per-port unix-socket bridge, which
  is blocked today because SRT reads `allowUnixSockets` off the config
  given to `initialize()` and never the per-call one. Unfinished.
- **Two bugs the move surfaced.** `${REPOSITORY}` interpolated an object,
  so every published platform README link, `homepage` and `bugs` URL said
  `[object Object]` — `scripts/` had never been under a tsconfig. And a
  LayeredCache test asserted a background upload had started after a
  fixed 20 ms, which a loaded gate does not respect; it waits on the
  condition now.

## In flight

- **v0.0.18 is fully on npm; one owner step remains before the next
  release.** npm released the two held packages about ninety minutes
  after the publish: all five serve 0.0.18 as `latest` (2026-09-04
  00:20Z). `npm.yml` now publishes with trusted publishing only — no
  token read anywhere, `--provenance` explicit, the npm ≥ 11.5.1 +
  sigstore guard on both jobs, `permissions: {}` at the top, every
  action in `npm.yml` and `release.yml` pinned to a commit SHA, and the
  object-form `repository` npm was rewriting. OWNER STEP before the next
  release: on npmjs.com add the GitHub Actions trusted publisher (owner
  `vznjs`, repo `vx`, workflow `npm.yml`, no environment) to each of the
  five packages, then delete the `NPM_TOKEN` secret (it is no longer
  read; npm restricts it — v0.0.17's `E401`, v0.0.18's hold). The
  build half is PROVEN: a `workflow_dispatch` dry run of the new
  workflow (run 33812502741, 2026-09-04) succeeded on both jobs — pinned
  actions resolve, the npm ≥ 11.5.1 guard passes on macOS and ubuntu,
  all five packages build and assemble at the stamped version, and
  only the two publish steps were skipped, as `dry_run` intends. The
  auth half is proven by the next release. Documented in
  `docs/cli.md` § Releasing.

## Next (ordered)

1. **The live REAPI suites are green again (2026-09-04); the
   whole-graph run stays optional.** With OrbStack's docker back, the
   rehosted `vx-nativelink:bun-node` image on
   `tests/helpers/nativelink-exec.json5` ran all ten `@vzn/vx-reapi`
   files one process each with both endpoints set: 121 pass, 0 fail —
   the wire-level execution suite (15), the cache suite (16) and the
   `execute: true` composition proof (2) included, so the barrel
   narrowing and the by-name error classification (2026-09-03) changed
   nothing live. Not done: `vx run ci --all` of THIS repo at a worker —
   it needs a workspace that wires `reapi({ execute: true })` (none is
   checked in) and filesystem stores (the memory stores evict under a
   `node_modules` install, per the helper notes). An exercise, not a
   gap; do it when a worker-side change needs it.
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started. Assessed 2026-09-04: the win is gated by the PLUGIN
   side — `@vzn/vx-reapi`'s wire zstd-compresses the whole body in
   memory and retries a wedged upload from it, so a core-side Blob alone
   measures nothing; streaming needs a two-pass digest and a chunked
   compressed upload through the adaptive-downgrade path. Do it when a
   real workspace uploads > 100 MiB artifacts, not before.
3. **Zero-migration adoption as a plugin (candidate, owner's call).**
   The Vite-shaped ecosystem lever: `plugins: [turbo()]` in a Turbo
   repo (or `nx()`) and `vx run build --all` works against `turbo.json`
   - `package.json` scripts with no generated files — a trial that
     commits nothing. The `project` stage is the right seam, and the
     mapping already exists in `migrate-turbo.ts` / `migrate-nx.ts`, but
     ONE seam gap blocks it: `prepareRun` loads only packages that have a
     config file (`prepare.ts`, the `configPath` filter), so the stage
     never visits a config-less package. Widening: when any plugin
     declares `project`, a package without a config is loaded as
     `{ tasks: {} }` for the stage to fill (zero cost otherwise — the
     filter stays when no plugin declares it). Then a `@vzn/vx-turbo`
     package reusing the mapper's IR without the preset splices, ~150
     lines, with the migrate suite's fixtures as its tests. Not built:
     `vx migrate` is one command and a second source of task truth is a
     maintenance surface; decide with the owner.
4. **The shipped binary's second core.** A compiled `vx` loading a
   `vx.workspace.ts` that imports `@vzn/vx` pulls a second copy of core
   from `node_modules` (~12 ms) on every run — and makes a binary user
   install the package at all. REFUTED 2026-09-03 as a runtime fix: a
   `Bun.plugin` `onResolve` hook registered by the binary never fires
   for a bare specifier imported by a dynamically imported user file
   (Bun 1.4.0, probed in plain `bun` with a `.ts` and a `.mjs` user
   file), so the binary cannot serve its bundled core to the workspace
   file that way. The user-visible half is
   closed (`isUserError` classifies by name across copies); what remains
   is the cost and the duplicate module state — and the cost is NOT
   measurable as an A/B from a workspace file (2026-09-03): a workspace
   importing plugins by absolute source path also loads source, since the
   binary cannot expose its bundled core to a workspace import, so both
   arms read equal (77 vs 74–81 ms at 100 projects). REFUTED as a
   runtime-plugin fix (Bun 1.4.0's `Bun.plugin` hooks never fire for
   bare specifiers or `.ts`); options left are rewriting the config
   source before import or a Bun fix. Parked.
5. **The watch e2e flake** — if `re-runs the task after a file change,
then exits on SIGINT` times out again, keep that run's stdout: the
   presence of `re-running...` separates a lost event from a slow
   re-run (see the 2026-09-03 watch entry).
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap. Closing figures for 2026-09-04 (load 5.7, best of 5): 1000
   projects 159 ms warm / 538 ms with restore, 100 projects 66 ms /
   104 ms — the sandbox and CI work touched nothing the warm path
   runs. Closing figures
   for 2026-09-03, after wave 6 and the discovery change, best of 5:
   1000 projects 193 ms (table says 204, measured before discovery
   changed), 100 projects 81 ms, on a box that had run the gate all day.
   Floors on the 1000-project bench (in-process, 2026-09-03): discover
   20 ms, load configs 21–23, git enumeration 21–47 exposed (the walk's
   own noise), classify + probe 23, run graph 19–21, record history
   11; total 151–184. What is left is the git walk (~60 ms, exposed by
   whatever it fails to overlap), 1,000 task hashes (11 ms), 1,000 file
   and directory stats (18 ms), 1,000 manifest reads (10 ms) and the
   batched inserts (4 ms after `runs_hash` went). The next real win is
   structural (not needing a walk), not another stage shave; fsmonitor,
   untracked cache and `-unormal` are refuted (see Shipped).
   COLD floors (same bench, cache wiped, `VX_TIMING=1` — the miss path
   carries spans since 2026-09-03): 2.06 s wall for 1,000 `echo` tasks at
   concurrency 10, i.e. ~20 ms per task-slot: execute 13.8 ms, save 3.6,
   resolve outputs 1.4, clean 0.6, task hash 0.01; cold config load 340
   ms (1,000 evaluations, no eval cache yet). Of the 13.8, the shell IS
   the floor on macOS: bare `sh -c 'echo built'` costs 9.2 ms per slot
   at 10 concurrent against 2.5 for `/bin/echo` spawned directly
   (stable over three rounds; `runCommand` adds 0.2 over the bare
   spawn). LEAD, not taken: spawning a shell-free command (`tsc -b`,
   `vitest run`) directly would save ~7 ms per task-slot on macOS and
   ~0 on Linux (dash starts in ~1 ms), against the principle that the
   shell is the API — PATH order, builtins, `command not found` → 127,
   scripts without a shebang all have to read identically. The headline
   shape's tasks use `&&`, so its rows would not move. Decide with the
   owner. The save's 3.8 ms splits (spans `save: *`): pack 1.25, write
   temp 0.63, rename 0.55, scan 0.46, index tx 0.17. Two trims measured
   as not worth their code (< 1 ms per task together, ~0.15% of the
   cold row): a synchronous compress for tiny buffers, and indexing a
   locally built artifact from its plan instead of re-scanning it.
   `vx watch` start on the same bench: the initial run plus a sweep of
   all 1,000 configs (repeat loads through the worker) — the sweep is
   35 ms, no visible pause.

7. **First-run DX follow-ups (candidates, from the 2026-09-04
   walkthrough).** (a) `--summarize` task rows carry no cache word: a
   consumer computing a hit rate cannot exclude uncached tasks; adding
   `noCache: true` is additive but the payload is documented — decide,
   then add with `docs/cli.md` § --summarize. (b) DONE 2026-09-04: `init` no longer makes `lint` wait for `build`
   (`test` / `typecheck` still do, the Turbo starter's convention). (c) watch still pays one redundant cycle on a
   task's first undeclared write (the bytes are unknown until seen);
   hashing what the cycle wrote before re-arming would zero it — only
   if a real workspace shows the cycle mattering. (d) DONE 2026-09-04: a filter set that matches nothing is one
   error line naming the patterns and the nearest project name.

## Decisions (this arc)

- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is the only must no plugin can supply; parked.
  Full table in `docs/comparison.md` § Gap audit 2026-09-04.
- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
