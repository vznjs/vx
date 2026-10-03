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
   path is measured (`packages/vx-bench/`), and a slower core is a regression even if
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

Process: gate (`bun packages/vx/src/bin.ts run ci --all`), push a
branch, open a PR, merge it on green (owner, 2026-09-10). Small, focused
commits.

## Shipped — the record

The review arc (2026-09-02 → 09-09) and improvement-loop items 1–64,
with the bench numbers behind them, moved whole to
`docs/history/2026-09-review-arc.md` on 2026-09-10, items 65–104 to
`docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, and
items 105–144 to `docs/history/2026-09-improvement-loop-105-144.md` on
2026-09-16 (with the Next list's record to
`docs/history/2026-09-status-next-log.md` the same night), and items
145–202 to `docs/history/2026-09-improvement-loop-145-202.md` later
that day (the 2026-09-10 measurement paragraphs to the 65–104 file, and
handoffs 14g–14i to the next-log file), and items 203–242 to
`docs/history/2026-09-improvement-loop-203-242.md` that night (handoffs
14j–14p to the next-log file), and items 243–281 to
`docs/history/2026-09-improvement-loop-243-281.md` that afternoon
(handoffs 14q–14v to the next-log file), and items 282–305 to
`docs/history/2026-09-improvement-loop-282-305.md` that evening
(handoffs 14w–14y to the next-log file), and items 306–332 to
`docs/history/2026-09-improvement-loop-306-332.md` late that night
(handoffs 14z–14ad to the next-log file), and items 333–352 to
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, and
items 353–372 to
`docs/history/2026-09-improvement-loop-353-372.md` that night
(handoffs 14ae–14af to the next-log file), and items 373–392 to
`docs/history/2026-09-improvement-loop-373-392.md` on 2026-09-20
(handoff 14aj to the next-log file), and items 393–412 to
`docs/history/2026-09-improvement-loop-393-412.md` later that day
(handoff 14am to the next-log file), and items 413–432 to
`docs/history/2026-09-improvement-loop-413-432.md` on 2026-09-20
(handoff 14an to the next-log file), and items 433–452 to
`docs/history/2026-09-improvement-loop-433-452.md` on 2026-09-20
(handoffs 14ao–14ap to the next-log file), and items 453–572 to six
files of twenty, `docs/history/2026-09-improvement-loop-453-472.md`
through `-553-572.md`, on 2026-09-22 (item 573), and items 573–591 to
`docs/history/2026-09-improvement-loop-573-591.md` later that day
(handoffs 14aq–14au to the next-log file, item 592), and items 592–611
to `docs/history/2026-09-improvement-loop-592-611.md` on 2026-09-23
(handoffs 14av–14ax to the next-log file, item 612), and items 612–631
to `docs/history/2026-09-improvement-loop-612-631.md` that afternoon
(handoffs 14ay–14ba to the next-log file, item 632), and items 632–654
to `docs/history/2026-09-improvement-loop-632-654.md` that night
(entries 14bb–14bv to the next-log file, item 677), and items 719–743
to `docs/history/2026-09-improvement-loop-719-743.md` on 2026-09-25
(item 764), and items 744–778 to
`docs/history/2026-09-improvement-loop-744-778.md` that afternoon
(item 785), and items 779–819 to
`docs/history/2026-09-improvement-loop-779-819.md` that night (item
826), and items 820–852 to
`docs/history/2026-09-improvement-loop-820-852.md` on 2026-09-26 (item
859), and items 853–892 to
`docs/history/2026-09-improvement-loop-853-892.md` that evening (item
893), and items 893–932 to
`docs/history/2026-09-improvement-loop-893-932.md` that night (item
934), and items 933–972 to
`docs/history/2026-09-improvement-loop-933-972.md` on 2026-09-27 (item
974), and items 973–1012 to
`docs/history/2026-09-improvement-loop-973-1012.md` that afternoon (item
1041), and items 1013–1052 (with the parallel sessions' own 1017 and 1018) to `docs/history/2026-09-improvement-loop-1013-1052.md` that
evening (item 1064), and items 1053–1092 to
`docs/history/2026-09-improvement-loop-1053-1092.md` that night (item
1093), so
this file stays the handoff
and not the log; numbering continues from there. Keep
it that way: when the loop below passes forty items, move the oldest
batch there in one commit, and move a Next entry's record the same way
once it is closed.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

1093. DONE (2026-09-27, STATUS only). The loop passed forty items since
      the last trim (item 1064): items 1053–1092 moved whole to
      `docs/history/2026-09-improvement-loop-1053-1092.md`, a prefix as
      item 373 set the rule.

1094. DONE (2026-09-27, restore review, low). A hit blocked by a
      directory standing where the entry holds a file (`rm dist/out.js;
mkdir dist/out.js`) failed with "a path the output globs do not
      cover", yet `dist/**` covers it. The clean removes the files the
      globs select and the directories that removal emptied, and an empty
      directory where a file goes is neither. The refusal itself stays:
      it fails closed (item 427). Its message now says what the clean
      leaves, both cases named.
      - Row: `artifact-roundtrip.test.ts` › "names a STRAY on disk as
        such" pins the new sentence, red without the change.

1095. SUPERSEDED (2026-09-27) by E-1 (`docs/history/ws-e.md`), which
      landed first: a cut `vx upgrade` transfer, or a release document
      that is not JSON, is one line naming the host, with nothing
      replaced.

1096. DONE (2026-09-27, upgrade review #2; STATUS, a comment and
      upgrade.md). `upgrade.ts`'s header and upgrade.md said the digest
      makes "a swapped asset" a refusal. It cannot: the digest comes from
      the same release API as the download URL, and GitHub recomputes it
      when an asset is uploaded, so whoever can replace the asset (a
      leaked token, a compromised account) publishes its matching digest
      with it. It catches a cut or corrupted transfer, and a swap in the
      moment between the API read and the download. Both now say so, and
      that no signature is checked. A signed release (minisign, cosign,
      GitHub attestations against a key in the binary) would close it; it
      is not built.

1097. DONE (2026-09-27, upgrade review #3 and #4). `replaceBinary`
      chmodded the new binary 0755 and wrote it fresh, so a 0750
      group-only install came back world-executable and owned by whoever
      ran the upgrade. It now keeps the old mode, adds execute wherever
      read is granted, and keeps the owner as root. And a new binary this
      machine could not start (a CPU below the build's target, a `noexec`
      mount) printed `installed (version check failed)` and exited 0 with
      the old binary gone. The swap now keeps a hard link to the previous
      binary; the rename stays the one atomic step. `upgradeCmd` asks the
      new one for `--version`, and a failure renames the previous one
      back, says so, and exits 1. upgrade.md and cli.md say so.
      - Rows: `upgrade.test.ts` › "keeps the replaced binary's mode"
        (0750 stays 0750) and "puts the previous binary back when the new
        one does not start, and leaves nothing". The second asserts the
        new bytes were what it asked about, the old ones are back, the
        directory holds only `vx`, and a control where the binary starts
        keeps the new bytes and no spare name. Both are red without the
        change; the executable-bit row still holds.

1098. DONE (2026-09-27, upgrade review, the smaller points). `vx
upgrade` on the latest version re-downloaded and replaced the
      binary with itself, printing `X → latest`. It now reads the
      release's tag (`ReleaseAsset.tag`, `isThisVersion`) and says
      `already at X` without a download. `vx upgrade v1 v2` installed
      `v1` and ignored `v2`; a second tag is now refused. A spent GitHub
      rate limit (403 or 429 with `x-ratelimit-remaining: 0`) read as
      `could not read the release (403)`; it is now named, with the reset
      time. cli.md and upgrade.md say so. The review's last point, the
      npm hint shown to a hand-installed binary on a failed rename, stays
      as is: the rename failure says "check permissions" first.
      - Rows: `upgrade.test.ts` › `isThisVersion` (with or without the
        `v`; another version and a longer one as controls), "names
        GitHub's rate limit, and a plain 403 stays plain", and "refuses a
        second tag instead of ignoring it" (on a runtime copy, item 779).
        `releaseAsset`'s row now reads the tag back.

1099. DONE (2026-09-27, scheduler review #4). `exec.command: '   '` or
      `'\n'` passed the schema's `command.length === 0` check and ran as a
      shell no-op: `1 success`, exit 0, and a cache entry. Only `''` was
      refused. The check now trims, with the same message.
      - Row: `config-schema-refusals.test.ts` › "an empty command in any
        spelling" (four blank spellings), red without the change. The
        control is `' true '`.

1100. DONE (2026-09-27, scheduler review #1). A task whose child died of
      SIGINT or SIGTERM was `aborted` even when the run was not stopping,
      as with a `kill` from a supervisor or another shell. So it was not
      retried (`retries: 2` ran it once), its output was hidden (no frame,
      no recap), the footer left it out, and `--continue=never` never
      tripped: fail-fast keys on `failed`. The child-signal half of item
      962's test is gone; the run stopping is what makes an abort. A
      terminal's Ctrl-C reaches the child and vx together, and the child's
      exit can be seen before vx's handler runs, so a signal death yields
      one event-loop turn for a pending handler before it is judged. The
      signal suites passed 3 of 3 with the change, and the one row that
      failed once under load passed 10 of 10 both with and without it.
      execution.md says so.
      - Rows: `aborted-outcome.test.ts` › "a task killed by a signal vx
        did not send is a failure": three attempts, the output shown,
        `failed (exit 143, 128 + SIGTERM)`, and `later` never runs under
        `--continue=never`. It is red without the change. The row that
        pins the Aborted section had a task that killed only itself; it
        now stops the run itself (`kill -TERM $PPID`, after `fine`),
        12 of 12 green.

1101. DONE (2026-09-27, scheduler review #2). A retried task's outcome
      carried the last attempt's duration only (`result.durationMs`), so
      the footer read `time 837ms · max 407ms` over one task, the
      `--summarize` row said 4 ms beside its own 12.8 ms span, and a
      timeout retried once showed `(342ms)` for about 700 ms spent.
      `TaskOutcome.durationMs` promises what this run spent. The outcome
      (and an aborted attempt's) now sums every attempt. A saved entry
      keeps the attempt that produced it, the cost a hit saves.
      - Row: `retries.test.ts` › "a retried task's duration is every
        attempt's": two 300 ms attempts, at least 580. It is red without
        the change (341).

1102. DONE (2026-09-27, the scheduler review's labels). A
      dependency-only server killed by a signal before the run stopped
      it printed `vx: a#dev exited with code SIGTERM before the run
stopped it`: the raw `code`, a signal name. A kept-alive server
      killed the same way printed `code 143`. The first now prints the
      signal's exit code too. schema.md still said a server that crashed
      after ready keeps `success`; since item 1071 it is `failed`, and it
      says so.
      - Row: `keep-alive.test.ts` › "a dependency-only server killed by a
        signal is named by its exit code", red without the change.

1103. DONE (2026-09-27, scheduler review #3). cli.md says
      `--concurrency 1` "serializes both" the exec and restore lanes, and
      the scheduler said it "stays serial". But the restore lane had its
      own counter set to 1, so an 80 MB restore ran from 22 to 346 ms
      inside another task's execution (25 to 536). At concurrency 1 the
      two lanes now share the one slot (`execRoom`, `restoreRoom`),
      including the exec-queue scan gate. Above 1 they stay independent,
      as the bench chose.
      - Row: `scheduler.test.ts` › "at concurrency 1 an execution and a
        restore never overlap" (peak in-flight 1), red without the
        change. The control, concurrency 2, still overlaps.

## In flight

**The parallel plan (2026-09-27, `docs/design/plan-2026-09-27.md`).**
Ten workstreams (A cache and keys, B sandbox and exec, C scheduler and
run lifecycle, D workspace and config, E CLI, F remote and telemetry
plugins, G adoption, H the 1.0 contract, I performance, J docs accuracy),
one session each, one coordinator. While it runs, a stream's merged items
are recorded in `docs/history/ws-<id>.md` as `<ID>-<n>`, not in the
numbered list below, so parallel PRs never collide on a number; the
coordinator folds them into this file. Streams K to O were added
later (K README and site, L security findings, M CI reliability, N adoption
paths, O Windows, stopped: Windows is WSL, and its workflow and native
code paths went 2026-10-02); each stream's record and leads are
its own `docs/history/ws-<id>.md`, fifteen files by 2026-10-01. Every
green commit on `main` releases (`ci.yml` finishes `main`'s run and drops
only queued ones; `auto-release.yml` releases any commit the last tag is
behind): v0.0.299 by 2026-10-01. Since 2026-09-30 one worker session
at a time (W12, W13, …) takes a queue from the coordinator and records
its items in the stream file of their area (adoption in `ws-g.md`) or
its own `ws-W<n>.md`.

**Positioning (owner, 2026-10-02; `docs/history/ws-r.md`).** vx is the
fastest task runner, shown by the native-config benchmark with every
competitor cell as `(vx N% faster|slower)`. Never say vx works in, runs
or speeds up a Turbo or Nx repo: `@vzn/vx-migrate` / `vx init` is a
temporary start toward native config. The real-repo rows measured
`turbo()` / `nx()` and are off the README and site; they need a rerun
on migrated native config before they are quoted again.

**The gate's runtime (settled 2026-09-21, item 572; plan F4).** A gate
under Bun 1.4.2 is the only gate: the 2026-09-19 container shipped
1.3.11, below `engines.bun: >=1.4`, and every "flapper" of that arc — the
shard-9 SIGILL (3 of 24 reps on 1.3.11, 0 of 24 on 1.4.2), the three
recorded failing tests, the inert symlink tripwires that scored three
containment guards as survivors — was the version. `bun upgrade` is
refused there; the release asset
`github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip`
downloads through the proxy and the gate with it first on PATH is 44 of
44 green. A shard failure under 1.4.2 is the diff's. The diagnosis of
the 23-test baseline as it stood on 1.3.11 is in
`docs/history/2026-09-status-next-log.md` § "In flight as it stood
2026-09-22"; the `ci` task refusing a Bun below the floor is plan F4.

**The sandbox arc (2026-09-05) is closed.** Its four Linux items closed
by 2026-09-10 (`docs/history/2026-09-status-next-log.md`); the fifth,
macOS violation reporting being lossy under load, is a recorded decision
since item 586 (Decisions below), not an open item.

**Releases.** Every green merge to main releases itself (item 1018,
`auto-release.yml`). The first two ran on 2026-09-27: v0.0.22 (74814d28)
and v0.0.23 (f7096cea) were tagged, released with generated notes, their
four binaries attached by the dispatched `release.yml`, and `@vzn/vx`
with its four platform packages published by the dispatched `npm.yml`.
That `npm.yml` run is still red at its first plugin: `@vzn/vx-github`
answers the OIDC publish with `E404 Not Found - PUT`, because none of
the seven plugin names has ever been published and a trusted publisher
cannot be bound to a name that does not exist. OWNER ACTION, once:
publish each plugin by hand from an owner's npm account and add its
trusted publisher (`docs/cli.md` § Releasing names the steps); every
auto-release after that publishes all twelve. v0.0.21 is on npm, the
four platform packages with it
(2026-09-15, handoff 14d in the history file), published through
`npm.yml`, which reads no secret and sets no token — its publish is the
OIDC exchange or nothing — so the trusted publishers on npmjs.com are in
place. The v0.0.18 record (the token's `E401`, the held packages, the dry
run of the token-free workflow) moved to the history file with the
items above.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. DONE by 2026-09-15 (0.0.21 published through the token-free
   `npm.yml`, so the trusted publishers exist). OWNER residue: delete
   the `NPM_TOKEN` repository secret if it still exists — nothing reads
   it. Documented in `docs/cli.md` § Releasing.
2. OWNER: cut the release — the notes are drafted in
   `docs/history/release-0.1.0-notes.md` (item 581); a GitHub release with the tag is the whole
   process (`release.yml` builds and signs the binaries, `npm.yml`
   publishes with provenance). Pick the version the articles will name;
   `0.1.0` says "first real release" where 0.0.19 says "another nightly".
   The release notes are the changelog — there is no CHANGELOG file, and
   GitHub's generated notes from merged PR titles are accurate since
   every merge is one titled PR.
3. OWNER: the site's address — it deploys to
   https://vznjs.github.io/vx/ on every push to main (`docs.yml`). A
   custom domain is a DNS record plus `SITE_URL` / `BASE_PATH` env in
   that workflow (`astro.config.mjs` reads both); every internal link is
   base-relative, so nothing else moves.
4. DONE 2026-09-10: the blog and its thirty posts, README and site
   numbers, LICENSE holder, SECURITY.md, CONTRIBUTING.md (items 115,
   116, 118).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. DONE 2026-09-16 as item 226: the site's introduction has a
   "Known limits" section — Bun ≥ 1.4 for source installs (the binary
   needs nothing); Linux sandboxing needs `bubblewrap`, `socat` and
   `ripgrep` (the third named 2026-09-16, item 246) and cannot run as
   root inside a container; Windows is WSL; macOS
   violation reporting is lossy under load (In-flight 5);
   a task's replayed output is its first and last 8 MiB (229); a project
   inside a submodule is enumerated by its own repository (221). An
   article links it.

## Next (ordered)

0. DONE 2026-09-10 as item 87 (history) — core has no `build`; dependants stop compiling the release binaries.
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
2. DONE 2026-09-23 as item 662 (entry 14bj) — the remote seam streams: `get` resolves `Blob | Response`, `put` takes a file-backed `Blob`, every first-party layer moved in the same commit.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. CI wall time is the other number this duty carries
   (plan I2): 2:23–3:16 per push run on main over 2026-09-21's eleven,
   all three jobs; a run past six minutes is the signal to fold the
   heaviest witness files onto a shared fixture. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 960 (2026-09-27, the day's items 927–959, a tie at 1,000 projects; 885 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000. PARKED for
   the 2026-09-19 arc (items 341–362): it changed docs, comments and
   tests only, so there is no run-path delta to A/B, and the arc ran on
   a shared 4-core container whose own baseline fails 23 tests for
   environmental reasons — an absolute figure from it is not comparable
   to the table above, and an A/B has no arms. Re-measure on the first
   run-path change. REFRESHED 2026-09-20 (item 420): this container, at
   1,000 projects, reads warm 271 ms / restore 1 031 / cold 3 147, and at
   5,000 warm 807 / restore 3 931 / cold 14 181 — the dev box's figures
   below are a DIFFERENT MACHINE and only the 1k→5k scaling (×2.98 warm
   here against ×2.97 there) compares. The harness's warm arm spreads
   ±13 % on identical code. UNPARKED 2026-09-20 (item 404), with the
   container's own noise floor measured first: interleaved min-of-7, one workspace
   copy per arm pre-warmed by that arm, 1,000 projects warm all-hit —
   the A/B read 232.1 ms before against 218.9 ms after, and the A/A
   CONTROL (the same arm against both copies) read 246.4 against
   259.0. A 12.6 ms spread between identical code is the same size as
   the 13.2 ms "difference", so this box resolves nothing below about
   6 % even at min-of-7. Absolute figures here, for the record and not
   for the table: 1,000 projects warm 194–204 ms total
   (`bun packages/vx-bench/run.ts 300 3`: no-cache 987 ms, warm
   172 ms, warm-restore 329 ms). Any future claim on this container
   needs an A/A control beside it. 2026-09-22 (item 580), the sweep week
   (items 342–572, PRs #488–#681) as one arm: base 164.7 ms, head
   167.8 ms warm min-of-15 at 1,000 projects, A/A 170.1 against 169.2 —
   a tie. Item 588 (the additive hit path, every task's): main 173.5
   against head 170.5, A/A 168.3 against 164.2 — a tie. The COLD path
   has its own number since 2026-09-23 (item 615): 1,000 projects,
   `.vx` removed, 2,938–3,420 ms before against 2,680–2,997 after, the
   `load configs` stage 507–607 → 207–272; a cold arm is five reps with
   the cache removed before each, no A/A needed at that size. 2026-09-24 (items
   690–702, the day's run-path changes being the key fold's move to
   `key-fold.ts`, one config worker per repeat round and the JSON-data
   walk): base 39294a8d against head, compiled binaries, 1,000 projects
   warm, interleaved, n=25 — medians 266.5 ms before and 266.4 after,
   mins 245.1 and 230.8; A/A 270.4 against 264.8 (mins 238.5, 238.1).
   A tie; a first n=15 pass read the mins the other way round (225.9
   before, 251.8 after) with the same tied medians, which is the box's
   min-of-N noise, not a cost.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) `vx lock` reads config files raw on purpose,
   and the doctor, the selector and watch fall back to a raw per-file
   read only when the staged load throws (five call sites by
   2026-09-16, each read and confirmed against a `turbo()` workspace:
   `vx info` counts the plugin's tasks) — grep for `loadProjectConfig(`
   before adding a consumer that is not a fallback; (d) was "`logger.ts` and
   `framed-output.ts` are the last large files" — by 2026-09-16 they are
   699 and 518 lines and the largest are `cache/cache.ts` 1,583,
   `cli/watch.ts` 1,121, `orchestrator/run.ts` 1,040 and
   `exec/sandbox-runtime.ts` 1,034, each one concern (the split of
   cache.ts is item 8's), so the note is closed; (e) REFUTED: a discovery memo keyed on directory and
   manifest stats saves ≈ 3–4 ms of a 230 ms run for a second staleness
   surface — revisit only if discovery's share grows; (g) `vx why` shows
   a plugin `key` part's digests, not its material, because a raw
   column is a `SCHEMA_VERSION` bump or a persisted secret — revisit
   when a plugin's part is the thing people debug.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. The handoffs after items 153, 130, 166, 170, 176, 183, 189, 192,
    197, 202, 208, 211, 214, 221, 225, 230, 236, 240, 242, 252, 263,
    270, 275, 281, 287, 293, 299, 305, 312, 319, 326, 332, 383 and
    394, 400, 403, 409, 412, 419, 426, 432, 441 and 452 (14–14ap) are
    in `docs/history/2026-09-status-next-log.md`; items 453–572 are in
    `docs/history/2026-09-improvement-loop-453-472.md` through
    `-553-572.md`; items 573–591 are in
    `docs/history/2026-09-improvement-loop-573-591.md`, 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md`, 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md`, 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md`, 719–743 in
    `docs/history/2026-09-improvement-loop-719-743.md` (entries
    14aq–14di and loop item 677 in the next-log file), 744–778 in
    `docs/history/2026-09-improvement-loop-744-778.md`, 779–819 in
    `docs/history/2026-09-improvement-loop-779-819.md`, 820–852 in
    `docs/history/2026-09-improvement-loop-820-852.md`, 853–892 in
    `docs/history/2026-09-improvement-loop-853-892.md`, 893–932 in
    `docs/history/2026-09-improvement-loop-893-932.md`, 933–972 in
    `docs/history/2026-09-improvement-loop-933-972.md`, 973–1012 in
    `docs/history/2026-09-improvement-loop-973-1012.md` and 1013–1052 in
    `docs/history/2026-09-improvement-loop-1013-1052.md`. The loop above
    is the record since 1053 (14dj in the next-log file); 14dk is below,
    and the next entry written here is 14dl.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dk. **Handoff after item 727 (2026-09-24, midday).** Since 14dj the
site was redone as one story and read on a phone: the Guide of ten
chapters on one toy monorepo, Docs and Reference around it, internals
out of the sidebar, one look, build-time pictures (721); the old Learn
pages retired with redirects (722); the widgets restyled and cut (723);
every picture, the cover, the graph explorer (724) and the scheduler's
charts (725) given a phone form, held by the diagram kit's laws, and
code blocks wrapped. Core alongside: a sandboxed task no longer reads
its own package through its self-link (720, `CACHE_VERSION` v30), nor a
linked sibling its key does not cover (726, v31, the Decisions entry on
narrowing core's grant), and a task downstream of a persistent task has
one key on both paths (727). WHAT STANDS: 14dj is in the next-log file
(§ Handoff 14dj); the loop holds 719–729. OWNER, unchanged: the site's read
(Next 16), cut 0.1.0 (the tag, then delete `NPM_TOKEN`), the scope list (roadmap 2.4), the soak length. NEXT: the owner's read of the short site (Next 16); the trim when the loop reaches twenty items; the warm-path A/B on the next run-path change (Next 6). Never end with "what
next?".

16. **The site, short (owner, 2026-09-24, after 728).** Shipped as item
    729 (`design/site-short-2026-09.md`). Left: the owner's read.
17. DONE as item 744 — **Turbo 2.11 won warm at 476 packages on the Linux box (item 735).**
    Two one-rep runs read Turbo at 255 and 303 ms against vx's 334 and
    376 (restore: 436 and 446 against 524 and 478). Measure it min-of-N
    with interleaved arms, find where vx's warm path spends it at that
    size, and fix it or say so on the site. The 3,270-task run on the
    same box reads the same way: Turbo 496 ms warm against vx's 678.
18. **Re-run the site's benchmark with the fixed harness (item 735).**
    The landing's Nx numbers (34m 44s cold, 3,270 tasks, macOS) come
    from the harness that gave Nx npm; npm was two thirds of Nx's cold
    run at that size on the Linux box. OWNER: re-run `compare.ts 100 11
1` on the macOS machine and `update-site.ts`, or take the Linux run
    in `benchmarks.md` for the site. The Linux run of this exact shape
    (`compare.ts 100 11 1`, 2026-09-25, item 758) has vx leading every
    column; its generated `RESULTS.md` / `results.json` were not
    committed over the macOS run the site reads.
19. DONE as item 751 — **A sandboxed task's `kill 0` killed the
    sandbox (Linux, found in 736).** The command runs in a session of
    its own inside the sandbox.
20. DONE as item 752 — **A cancelled sandboxed task got no TERM grace
    (Linux, found in 751).** SIGINT and SIGTERM reach the command's
    group through fd 3; SIGKILL stays the group's.
21. **The rest of the 476-package warm profile (item 753).** In order
    of measured saving, each on a patched copy (interleaved, stage
    mins): scheduler priorities over the exec tier only (DONE as item
    754); one multi-row insert for the run's history rows (REFUTED
    2026-09-25: 40-row INSERTs made 85 rows three statements, and a warm
    476-package run's `record history` stayed 8.2 → 8.6 ms at min, wall
    174.3 → 176.6, N=21; the 5 ms the profile saw was skipping the
    rows, and binding 21 columns a row is the cost, not the statement
    count); `node:readline/promises` imported only by
    the picker (REFUTED 2026-09-25: two compiled binaries, one importing
    it beside the other node: modules vx loads, differ by 0.27 ms at min
    and 0.1 at median, 41 interleaved; the 2.5 ms was the source run's
    transpile under the profiler); `git rev-parse` in the enumeration
    as an async spawn beside the others (REFUTED 2026-09-25: as a fourth
    spawn in the `Promise.all`, two interleaved passes of 21 read min
    168.7 → 171.8 and 165.5 → 183.8 ms; the sync spawn's block overlaps
    git's own run, which is the enumeration's wall anyway);
    the group hash computed once instead of in the stable-key pass and
    again at execute; and `resolveFiles`' memo checked before it builds
    its key (both declined in item 756). The large lever, persisting
    last run's stable keys, is designed and DEFERRED (item 756).
    (`vx-bench/strace-vx.ts` counting git's worker threads as vx: fixed
    in item 755.) DONE through items 753–756.
22. DONE as item 771 — **`baseAllowWrite` had one value (item 770).** Core sends `[]` on
    every sandboxed request, so the field on `ExecuteSandbox` and
    `SandboxedRunArgs` is a knob no producer turns; an executor plugin
    reading it learns nothing. Remove it from the seam and let the
    runtime's own write set be `allow.write` alone. Three runtime rows
    pass it as a direct write grant (two of them macOS `sandbox-exec`
    rows, which this box cannot run) and move to `allow.write` in the
    same change, proven on the darwin CI job.
23. **Two signal rows went red once each, root cause unproven
    (2026-09-25).** (a) `watch-signals.test.ts` › "SIGINT during the
    initial run reaches its task as SIGINT", on the macOS job of #878.
    The recap cut the assertion, it passed on the same code in #879, and
    it passed 49 of 49 Linux repetitions. Its twin in `signal-handling.test.ts` failed
    the same way on the macOS job of #929 with the assertion in the log:
    `got.txt` missing, the shell SIGKILLed at the 200 ms grace before
    its trap ran. Both rows now pass a 5 s grace (items 852, 853). That
    (a) was the same cause is likely, not proven. (b) `signal-handling.test.ts`
    › "at the moment vx exits on a signal every task process is gone and
    its pipes are closed", in a full local gate. On SIGINT one task pid
    was alive at vx's exit; the shard passed 4 of 4 alone and a gate
    re-run passed. Under the sandbox `procfsIsOwn()` is false, so the
    test's `isAlive` counts a zombie, and `slow`'s `sleep 30 &` starts
    with SIGINT ignored and dies only to the SIGKILL. An orphan zombie
    that init has not reaped yet is the leading suspect, not a proven
    one. One fact since: until item 849 every vx that file
    spawned ran on the 2 s default grace, not the 200 ms it set
    (`Bun.spawn` without `env` passes the startup environment), so the
    failure was seen at 2 s. Both rows now print what they saw on a mismatch (item 804); the
    next failure names the process and what vx said, and this entry
    closes on that evidence. Item 864: 60 sandboxed runs of (b) (30 idle,
    30 beside six CPU burners) were clean, and (b) now also says, for
    each process alive at the exit, whether it was gone within 3 s (a
    zombie awaiting its reaper) or still alive (a leak). vx releases every
    group before it exits, so its guard kills nothing there to blur the
    two. (b) CLOSED as item 1078 on that evidence: the one failure since
    read `child: … (procfs is another pid namespace's), gone within
21 ms` — a zombie, not a leak. (a) stays open for a macOS failure:
    on Linux both files ran 25 of 25 clean beside six CPU burners
    (Bun 1.4.2, 2026-10-02).
24. DONE 2026-09-27 (fifth hit, CI on #1083, the same docs build after it
    had finished): an attempt whose last stderr line is strace's own and
    whose exit is non-zero is run once more, with a line saying why
    (`runSandboxed`, `sandbox-tracer-retry.unsafe.test.ts`: a fake strace
    first on PATH fails its first call; red without the retry, and a task
    failing on its own is run once). The history below stands. —
    **strace's own ptrace error ended a sandboxed task (2026-09-26,
    CI on #972).** `@vzn/vx#test.bun.shard-9` exited 1 on the Linux job
    with no failed row. Its output stopped before bun test's summary,
    and its last line was strace's own error:
    `ptrace(PTRACE_LISTEN,pid:…,sig:0): Input/output error`.
    A traced task's exit code is strace's, and strace is bwrap's
    parent, so an internal strace failure is the task's failure.
    `PTRACE_LISTEN` is issued for a tracee in group-stop; no row of that
    shard sends a stop signal, so what stopped a tracee is unproven. The
    same head passed the shard in the local gate and on macOS. Candidate
    fix, to measure first: `strace -D` makes the traced command vx's own
    child (its exit code, and bwrap's `--die-with-parent` on vx), with
    strace a detached grandchild. Probed (item 903's commit): with
    `-D` the log was whole when read at the command's exit (200 of
    200). But no row tells the two apart: a SIGKILL of strace ends the
    task either way (strace starts its tracee to die with it), and a
    SIGTERM leaves the task running either way. What strace does on its
    own `PTRACE_LISTEN` error is the one path that differs, and nothing
    here reaches it, so `-D` is not shipped without a failing row.
    Second hit (CI on #978): shard 9 again, in the same place — right
    after `output-memory.test.ts` › "an opted-down stream does not grow
    with the volume the child writes", where the next rows start four
    `awk` floods at once and SIGKILL each. That file alone under the
    same strace flags, bare, was clean 6 of 6, and the shard itself
    through vx's sandbox (bwrap under strace, as CI runs it) was clean
    5 of 5 on this box: the trigger is the CI runner's, not reproduced.
    Third hit (CI on #997), the same place; item 925 moved the file to
    the unsandboxed suite. Fourth hit (CI on #1075, 2026-09-27):
    `@vzn/vx-docs#build`, no shard and no flood, so the trigger was not
    that file. The build had finished (its last lines were Pagefind's
    index and astro's closing warning) when strace printed the error and
    the task exited 1: the work was done and the verdict was strace's.
    Still unreproduced here; the fix wants a row that reaches strace's
    own failure before it ships.
25. **A key-only task for `nx()`'s `nx-input:<name>` twins (item 910).**
    A twin runs `true` so that its key, the project's `^` input, folds
    into its dependants. At 300 projects the 598 twins cost 97 ms of a
    159 ms warm run. A task kind that is a key and nothing else (no
    spawn on a miss, no history row, not printed) would take most of it
    back. Measure the twins' share first: is it the key, the lookup or
    the row? Measured (item 931, stage mins over 9 interleaved CLI runs,
    the same workspace without `^` inputs as the control): the twins add
    about 120 ms. `load configs` +46, `classify + probe` +45,
    `run graph` +15, `build graph` +9, `record history` +4. A key-only
    kind saves the run and the row, about 19 ms. The rest is what every
    task costs to load and key, so the lever is per-task cost in those
    two stages, not a new kind. Item 932 took 23 ms of the load share
    back: a guard that stopped holding after the first round. CLOSED as
    G-76 (2026-09-30): at 300 projects the 293 twins add ~39 ms warm
    (stage mins, N=7), spread across keying, the run and the row; no
    site takes more than ~2.5 ms, so no kind or memo buys it back.

26. DONE as item 1075 — `nx()` keys its graph snapshot on the worktree's git state; an added import re-exports.

27. DONE as item 1070 — `nx()` keeps an output path as written; a bare literal keeps the directory short-circuit.

## Decisions (this arc)

- **Rust rewrite: stay (2026-09-29).** Assessed and prototyped on Bun
  1.4.2 (`docs/design/rust-feasibility-2026-09.md`): Rust starts in
  3.3 ms against the compiled vx's 19 ms, but it is only 1.2× faster on
  key derivation, and a warm 150-project run would drop only from 101
  to ~75–85 ms, and only while no JS runs. Configs and plugins bring a
  JS engine back. The port is ~100–160 person-weeks and reopens the
  stale-hit class. The lead it found is TS-side: ~13 ms of
  module-graph startup on every invocation.
- **Persisted stable keys: deferred (item 756).** Designed and
  prototyped (`docs/design/persisted-stable-keys-2026-09.md`): 13–21 ms
  of a 476-package warm run, exact-repeat runs only, and any input the
  digest misses is a stale hit on every run. Not built while vx leads the
  warm column; revisit on a measured warm-no-op loss or an agent-loop
  workload, and land only through that doc's gate.
- **Once per run (owner, 2026-09-24, item 732).** Within a run nothing
  outside vx changes the files it reads; what vx learns once (a read, a
  stat, a PATH lookup, a spawn's answer) it reuses, and only vx's own
  writes or its tasks' runs invalidate a fact. A repeat that stays has a
  measured reason in a comment and in the strace laws that pin it.
- **Tools resolve on vx's own PATH (item 732).** The task's PATH decides
  what its command runs, never which shell parses it.
- **What a cached task may write undeclared (item 750).** Its own
  inputs, in place (a formatter), and nothing else: its key names those,
  so a reader folding it is covered. A root-project task may rewrite the
  lockfile; the run watches for it. An `inputs.runtime` answer is the
  environment, asked once per run and never re-checked: a task that
  changes it is out of contract, and a file another task writes is
  declared as an input instead.
- **Every project's lockfile key folds the root importer (item 733).**
  What the root declares is reachable from every task.
- **A plugin verb's owner is its package (2026-10-03).** Plugins of two
  packages on one verb are refused; plugins of one package share it and
  the first declared runs (`@vzn/vx-lockfile`'s `prune`).

- **Declaring `cache` may narrow core's own grant, never widen one
  (owner-delegated, 2026-09-24, item 726).** The user's `sandbox.allow`
  still derives nothing from `cache` (2026-09-05). Core's implicit
  `node_modules` link grant is bounded by the key for a task that
  declares `cache`: a linked workspace package is granted only when the
  key folds a task of it, because an unkeyed read is exactly the stale
  hit the sandbox exists to rule out. A task with no `cache` keeps the
  whole grant, having no key to be stale. The coverage is per package,
  not per file (an edge to `ui#source` also admits `ui/README.md`), the
  same limit a grant wider than a task's own inputs already has.

- **macOS violation reporting is lossy under load, and stays so
  (2026-09-22, item 586).** The store is fed by the unified log, which
  drops records under pressure; the settle window that halved the loss
  cost 300 ms per clean sandboxed task and went 2026-09-05 (owner); no
  unprivileged channel reports a denial the child survived. Enforcement
  is unaffected and the Known limits page says so. Not an open item.
- **`--affected` includes dependents (2026-09-16).** The sugar is
  `--filter '...[<base>]'`: the changed projects and everything that
  depends on them, the superset a CI gate needs and what the guides
  promised; `--filter '[<base>]'` is the changed-only form for "test
  what I touched". Item 287.
- **Resources are the schedule plugin's (owner, 2026-09-12).** Core
  gates on the worker count and asks the `admit` stage for anything
  finer; it holds no per-task cores or megabytes, no config field for
  them, no budget flag. What a task needs is learned from what it used
  (`@vzn/vx-schedule-history`), or declared to that plugin. Item 157.
- **No first-party technology plugins (owner, 2026-09-10).** A plugin
  that gives packages tasks from a framework's config (`vite()`,
  `next()`, …) is the community's to write on the `project` stage; core
  names no tool, and this repo ships no such plugin. `turbo()` in
  `@vzn/vx-migrate` is an adoption plugin, not a technology plugin, and stays.
- **Windows is WSL (owner, 2026-09-10).** vx spawns POSIX shell and ships
  linux / darwin binaries; a Windows developer runs it under WSL, and the
  docs say so instead of listing Windows as a gap.
- **One core per process (2026-09-10).** The running `vx` serves its
  own façade to every `@vzn/vx` import it evaluates. A plugin package
  never carries its own copy of core into a run; the host decides the
  runtime, as any host does. Item 77.
- **The façade names only what has a consumer (2026-09-10).** An
  export written for a consumer that no longer exists is a promise
  nobody collects and a surface nobody may change; item 78 took 41
  of them off. Core keeps every function behind its module contract;
  a new consumer widens the façade deliberately, with the pin.
- **No seam without a consumer (2026-09-10).** The `CASBackend` /
  `Digest` substrate left core after three months with zero callers
  (item 74). A content-addressed view of the artifacts directory comes
  back when a plugin needs it, shaped by that plugin's use — not
  before. The same rule retired `recordRun` / `recordRuns` from the
  layer contract (item 72).
- **Merge your own PR once it is green (owner, 2026-09-10, "Merge
  whenever you own the project").** The session's PR flow stays
  (branch, PR, CI), but a green, mergeable PR no longer waits for the
  owner's word; the next PR starts from the merged main.
- **A plugin's name is its package name; no overrides (owner,
  2026-09-10).** `definePlugin(import.meta, hooks)` reads it and stamps
  it; the workspace loader refuses anything else. Item 69.
- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is WSL (owner, 2026-10-02), not a gap.
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
