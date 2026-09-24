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

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

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
(entries 14bb–14bv to the next-log file, item 677), so
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

677.  DONE (2026-09-23, the trim after the sweep arc closed). Items
      632–654 moved to `docs/history/2026-09-improvement-loop-632-654.md`
      and entries 14bb–14bv to the next-log file in this commit. What
      that loop was: the 628 method (delete each gate in turn against
      the whole suite; a survivor gets a row, red with its line gone)
      carried from `close()` through the run's end, the runner, the save
      and restore paths, the short-circuit, both halves of
      `LayeredCache`, the scheduler, the task graph, the resolvers, git,
      the selectors, placement, the plugin host, and — by three
      implementer sessions in parallel — the sandbox, the config loader
      and the telemetry host (652–654). Sweeps stop being the default
      loop here (roadmap milestone 0 is closed). Next trim when the
      entries below reach twenty.

## In flight

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

**Releases.** v0.0.21 is on npm, the four platform packages with it
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
   item 285 (2026-09-16, a tie; 274 was the one before), and the
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
   the cache removed before each, no A/A needed at that size.

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
    `docs/history/2026-09-improvement-loop-612-631.md` and 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md` (entries
    14aq–14bv in the next-log file). The loop above is the record since
    677; 14bw and 14bx are items 675 and 676, 14by is below, and the
    next entry written here is 14bz.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14bw. **Item 675 (roadmap W0, 2026-09-23): the site has a Learn section
and one way to ship a widget.** The sidebar opens with Learn: eight
pages under `learn/` (W1–W7 and the W12 glossary), each a stub that
says what it will teach, the reader outcome from the plan's list, and
"Status: planned". The island pattern is `Demo.astro` plus a plain
custom element in `src/components/demos/<name>.ts`, loaded only where a
page holds one, with no UI framework. The default slot is the
no-JavaScript render and must teach on its own. The first widget is on
the W1 stub: the toy monorepo's build graph (`ui`, `api`, `app`) as
inline SVG. Selecting a package lights up the package and everything
that depends on it, and an `aria-live` region says the same. Without
JavaScript the same SVG carries a caption that says what depends on
what and what each change affects. `tests/demo-islands.test.ts` reads
the built page and fails without the SVG, the caption, or the loader
(red three ways, green after restore). It needs `dist/`, so the site's
`test` task now depends on `build`. Pages that hold a widget are
`.mdx`; the site-wide laws that walk `.md` (the config snippets, the
doc-class pins, the samples) do not read them yet.

14bx. **Item 676 (roadmap W9 spike, 2026-09-23): the planner runs in a
browser bundle and plans what the CLI plans. Verdict: feasible, with
changes.** Core's own source is bundled unchanged with
`Bun.build({ target: 'browser' })`: discovery, the staged config load,
the task graph, the fingerprint, `plan()` with the real key fold, and
the scheduler. The shim is about 10 KB: a pure-TS xxh3, a glob matcher,
an in-memory file system, `process.env`, and a rewrite of the `Bun` and
`process` globals.

The bundle is 126,846 B raw and 43,085 B gzip. About 48 KB of that is
the local store, kept only by borrowing `Cache.prototype.key`; without
the borrow it measures 76,519 B / 27,408 B. On the fixture, against
`vx run build ci --all --dry=json` (five projects, 8 tasks), keys,
statuses, deps, priorities and dispatch order are identical in three
scenarios: committed, env change, uncommitted edit. The host's Bun and
`node:fs` were trapped and never reached, the negative control differs
on exactly the five tasks `API_URL` reaches, and two shim mutations were
each caught. A plan takes 2.3 ms on the fixture and 68 ms on 1,102
files.

xxh3: the pure-TS port and hash-wasm are each byte-identical on 1,000
random inputs and 200 key-shaped seed chains. A surprise: **Bun 1.4.2's
`xxHash3` uses only the low 32 bits of its seed** (`seed-probe.ts`), so
every step of the key chain carries 32 bits. That was proposal P4; the
stale hit it allows was reproduced and fixed as item 682 (14cd).

Glob: no library matches `Bun.Glob`. The shim differs on 0 of 315
realistic pairs and on 219 of 500,000 adversarial task-glob pairs;
picomatch differs on 1,503. Being exact needs a port of Bun's own
matcher.

W9 needs P1 (lift the key fold out of `Cache`), the exact glob port,
in-page config evaluation, and an unsandboxed parity task. Estimate: six
to eight agent days for W9 alone. Note:
`design/playground-spike-2026-09.md`; code:
`packages/vx-bench/playground-spike/`.

14by. **Handoff after item 677 (2026-09-23, near midnight).** Since 14bb
the arc turned from sweeping to shipping toward 1.0: the roadmap
(`design/roadmap-1.0.md`, 655), the plugins published with the release
(656), run-time cache eviction (`cacheRetention`, 658), the streaming
remote seam (662), every open parity row closed (659, 661, 664–667,
669, 670), task-glob brackets literal with `CACHE_VERSION` v28 (667),
the first-run notice for a cache-format bump (671), the 1.0 versioning
contract (`design/versioning-1.0.md`, 672), the 0.1.0 notes through
672 (673), the site-redo plan (674), and the last three sweeps merged
from implementer sessions (652 with one fix: a traced `~` path is the
cwd's, not HOME's; 653; 654). WHAT STANDS: the loop holds 677 alone;
632–654 are in `docs/history/2026-09-improvement-loop-632-654.md`,
14bb–14bv in the next-log file. Roadmap milestones 0 and 1 are done
but for the owner's steps; 2 waits on the scope confirmation (2.4) and
a box with `node_modules` for the real-repo re-measure (2.5); 3 has its
policy written and waits on the soak and the tag. W0 landed as item
675 (14bw, above). IN FLIGHT: 14bx is item 676 (the W9 spike: the
planner in the browser, keys checked against the CLI), from a local
implementer. OWNER, unchanged: cut 0.1.0
(the seven trusted publishers, the tag, then delete `NPM_TOKEN`), the
site's address, the scope list, the soak length. NEXT, in order: land
676; widen the site-wide laws that walk `.md` to `.mdx` (14bw), so W1's
config blocks are type-checked; then track W in the plan's order (W1, W2, W4, W5/W6, W3,
W7, W9 on the spike's verdict, W10/W11, W12, W8 last). Never end with
"what next?".

14bz. **Item 678 (2026-09-23): two guards the 653 sweep found implied
are gone.** The filter-name check skipped `'*'` and `'^*'` by name,
but their task half is `*`, which the wildcard skip after it takes
anyway; the arms are deleted, with a comment. And `loadDefaultExport`
gave `vx lock` a random import bust so a repeat load would not replay
an evaluation made under earlier env values, but a project config
reaches that import only on its first load in the process (a repeat
re-evaluates in a worker, `loadedConfigs`), so nothing is ever cached
under the URL; the bust, its parameter and its comment are gone, and
the comment now names the worker route. Both were survivors the
implementer drove (#772): deleting either reddened nothing, and the
bust beside the repeat routing reddened the same seven rows the
routing alone does. Loader, lock and schema suites green (215 rows).

14ca. **Item 679 (2026-09-23): a negated absolute path in
`inputs.files` is refused.** `cache.inputs.files` refused `/x` but took
`!/x`, which subtracts nothing from project-relative globs, so it sat
in a config as a silent no-op; `workspaceFiles` already refused both
spellings. The inputs check now refuses it with the absolute-path
message, after the directory-itself check so a bare `!/` keeps its
more precise one. The row is red with the guard gone; a relative
negation is its control. Found by the 653 implementer, not a sweep
survivor. A config that carried one now fails to load, where before
it ran with the line ignored.

14cb. **Item 680 (2026-09-23): the site-wide laws read `.mdx`.** W0 made
a page that holds a widget `.mdx`, and four laws walked `.md` only, so
such a page was invisible to them: the site's `config-snippets.test.ts`
(every config block type-checks), `doc-class-pins.unsafe.test.ts` (six
walkers: `handAuthoredDocs` and the five class pins with their own walk,
the blog-table one included), `site-samples.unsafe.test.ts`
(`handAuthoredSitePages`), and `doc-references.unsafe.test.ts` (the
guides' core paths, and every relative link, whose target resolver
also had no `.mdx` candidate: a link to the W1 page read as missing).
Each now matches `/\.mdx?$/`. Proven with twelve probes, one per walker,
each appended to the W1 page or a new `.mdx` beside the guides and blog,
then restored: with the old laws P1–P10 passed (blind), and both links
to the `.mdx` page (P11 with an anchor it lacks, P12 with none) failed
as missing; with the new ones P1–P11 fail, each message naming the
`.mdx` page or the bad anchor, and P12 passes (the control). No law is meaningless on MDX: the fences, headings and links
these laws read are the same syntax there. Two walkers stay `.md` on
purpose: `sidebar-coverage.test.ts`'s imported set and the safe
`doc-references.test.ts` read what `import-docs.ts` generates from
`packages/vx/docs`, which is Markdown only.

14cc. **Item 681 (roadmap W1, 2026-09-24): the first Learn page teaches.**
`learn/what-is-task-orchestration.mdx` explains a task, a dependency,
the task graph and why `npm run` or a shell script stops scaling
(ordering, parallelism, rerunning only what changed, caching as a
preview of W2) in tool-neutral terms, then how vx does it (a config
block, now type-checked by item 680's widened law, with links to the
schema, CLI, scheduler and caching pages, and the cost of explicit
inputs), then one sentence each for Turborepo, Nx and Bazel with a link
to their docs, then a checkpoint whose answer is in a `<details>`. Two
Mermaid diagrams (the package graph, and `^build` and `build` applied to
`ui`). The W0 widget grew into the graph explorer and took its place
(`GraphExplorer.astro` + `graph-explorer.ts`; `AffectedGraph` is gone,
because one page carries one widget). The toy monorepo is four packages
(`utils`; `ui` and `api` use it; `app` uses both) with `build` and `test`
each. The shared model in `demos/model/toy-monorepo.ts` derives the
eight tasks, the waves, the affected packages, the tasks `--affected`
selects, the upstream tasks the cache restores, and the order sentence.
Without JavaScript: the SVG in four wave rows, a caption that states the
waves, and a table that gives, per changed package, what runs, what is
needed first from the cache, and the order. With JavaScript: package
buttons (a node click also works; Escape and Clear reset), lit / dashed /
faded tasks, the selected table row, and a live region with the run and
its order. Checked in Chromium at 1440 and 390 px, with JavaScript on and
off; the table stacks per row under 40rem. `tests/demo-islands.test.ts`
has 13 rows: the model against hand-written sets (edges, waves, each
change's affected, rerun and needed sets, the order), the built page
against those sets and against the model, the caption, the hidden
controls, the checkpoint answer, and the loader. Twelve mutations (model
rules, the Astro render, the MDX answer, the element's name) turned
every row red at least once and green after restore. Two first-draft
mutations were no-ops and survived for that reason: dropping the first
task's edges (it has none) and removing a second mention of a task. They
were replaced with mutations that change what the rows read. The site's
`test` task declares the model as an input, because the test imports it.
The competitor links could not be fetched from the implementer's box; the
coordinator checked each claim and URL against the tools' own docs
sources (vercel/turborepo, nrwl/nx, bazelbuild/bazel, 2026-09-24) and
moved three Nx links to its current `/docs/` paths.

14cd. **Item 682 (2026-09-24): the cache key carries 64 bits of state.**
The W9 spike (item 676) measured that Bun's xxHash3 reads only the low
32 bits of its seed, and every cache key, the workspace fingerprint,
the config-eval key and the lockfile digests are seed-chained folds. A
bare chain therefore carried 32 bits of state: two input sets whose
running digests share their low halves merge at the next step, a stale
hit at about 2^-32 per step. Reproduced before the fix: 2^17 real
`Cache.key` calls varying one env value held a collision, found in 0.08
s by a birthday search. `xxh3` now feeds the seed forward
(`xxHash3(part, seed) ^ seed`): states that share a low half keep their
high-half difference through every later step, and a seed of 0 changes
nothing, so single-shot digests (file OIDs aside, every content hash)
keep their values. `lockfile-claim.ts` folds through it, and the four
vx-lockfile parsers pass the global digest as data rather than as a
seed. Rows (`tests/hash-chain.test.ts`, one per parser in vx-lockfile):
the platform's 32-bit seed read is pinned, so an upgrade that changes
it goes red; a birthday-found pair of states sharing a low half stays
apart after a common tail; 2^17 keys over one env value are all
distinct; and two lockfile globals sharing a low half part the digests.
Every collision row is red without the fix (2 core, 4 plugin).
`CACHE_VERSION` v29: the old keys were wrong, not their bytes, so the
fix alone self-heals, but every entry misses once and the bump makes
the first run say so. Cost: `Cache.key` over 3,000 parts 405.8 → 412.2
µs (min of 9, interleaved), about 2 ns a step. Also refused on reading:
making `assertKnownFields` refuse non-objects itself (653's proposal):
every caller already checks its own level and 653 holds each, so the
guard would be unreachable.

14ce. **Item 683 (roadmap W12, 2026-09-24): the glossary.** `learn/glossary.md`
defines seventeen terms once, without reference to a tool (workspace,
project, task, task dependency, task graph, project graph, affected,
inputs, outputs, cache key, hit/miss/stale hit, remote cache,
hermeticity and sandboxing, remote execution, persistent task, critical
path, seam and plugin), then gives the name vx, Turborepo, Nx and Bazel
use, each linked to that tool's documentation. Every name was checked
against the tools' own doc sources on 2026-09-24 (shallow clones of
vercel/turborepo, nrwl/nx and bazelbuild/bazel; their sites are not
reachable from this box), and the check changed three claims a guess
would have made: Nx has task sandboxing (an Nx Cloud add-on on a
dedicated cluster), its term for a stale hit is "false cache hit", and
its long-running tasks are `continuous`, not `persistent`. A dash means
the tool's docs have no term, not that the tool cannot do the thing.
Pages linking their terms into it is W1–W7's job as each is written.

14cf. **Item 684 (roadmap W2, 2026-09-24): the caching page teaches, and
its key calculator is held to real vx runs.** `learn/caching.mdx`
replaces the stub under the same slug. It teaches content addressing;
what goes into a key (the task, the files, the config with its list of
inputs, env, upstream keys, tool versions); why a key folds upstream
input keys and not outputs (the other way waits for outputs and needs
them deterministic; this way reruns everything above a no-op edit); the
cascade, as the page's one Mermaid diagram; what a stale hit is (an
input no key sees, or a collision); and local versus remote. Then how vx
does it (declared inputs, git blob ids, env by name in two lists, the
seeded fold and item 682's state width, with its numbers), how
Turborepo, Nx and Bazel do it, when their default is the better pick,
and a checkpoint. Every competitor claim was checked against a shallow
clone of that tool's doc source on 2026-09-24, and the check found two
things a guess would have missed: Turborepo's docs now have a
`dependencyOutputs` input mode that hashes a dependency's outputs, at
the price of a key unknown until run time; and Nx reaches upstream
through the dependencies' input files (`^production`), not their keys.

The widget is `KeyCalculator.astro` and `key-calculator.ts` over
`demos/model/toy-monorepo.ts`, extended, not forked: what each task
reads (its `src/index.ts`; a build also its `tsconfig.json`, and
`api#build` also `API_URL`), a state of edited and undeclared inputs,
and `toyRun`, which folds each key from the declared inputs, their
values and the upstream keys, and tracks what the cache replays. An
output that differs from a run with no cache is stale, on a hit or on a
miss built over a stale upstream. Without JavaScript the widget is four
tables (edit `utils`, edit `app`, change `API_URL`, and the stale hit:
stop declaring `utils/tsconfig.json`, run, edit it). Each gives every
task's key before and after, whether it moved (own input or upstream
key), and hit, runs or stale hit, with a sentence that says the same.
With JavaScript the tables hide and the element shows toggle buttons
(`aria-pressed`) for each edit, each declaration and `API_URL`, a
replay button per table, Start over, a live table and a polite live
region. The page and the figure caption call it a model: its keys are
digests it computes, cut to seven hex digits, not xxHash3.

The model is held to core by `tests/key-model-core.test.ts`. It writes
the toy workspace from the model (each file holds the model's value,
each command reads exactly the model's read set, each config declares
what the state declares), commits it to git, and drives `run()` from
`@vzn/vx`. At every step it compares the keys that moved, the hits and
the stale outputs (bytes that differ from the same state run with the
cache off in a second workspace) with the model's. It replays a
14-step sequence that uses every control (the cascade, an undo that
hits an old entry, the stale hit, a miss on a stale upstream, the heal,
`passThrough` without `inputs.env`), and each of the four tables from
a fresh cache. It runs in the sandboxed `test` task (five rows, about
six seconds). That task now declares `packages/vx/src/**` as
`workspaceFiles`, so a change to core's key derivation reruns it.

Proofs, each red and then green after the reverse edit. Model: the key
drops upstream keys (11 rows red); the key sees undeclared reads (7);
the cache forgets older entries (2: the undo row and the parity row); a
miss builds on the fresh upstream output (only the parity row went red,
so a hand-written row for it was added and went red with it); nothing
is ever stale (7); a moved key always blames the upstream (8; the parity
test cannot see why a key moved, so the hand-written rows hold that);
a scenario dropped (3). Core, with the model untouched: env values left
out of the key (the sequence row and the env table's row); upstream
keys left out (4 parity rows); file contents left out (3, the app
table's row among them). Page: a table row dropped, the caption
sentence dropped, the controls not hidden, the figure caption without
"A model", a wrong task in the checkpoint answer, the element renamed:
each reddened its own row. 21 new rows, 16 in `demo-islands.test.ts`
and 5 in `key-model-core.test.ts`; the site suite is 43 green. No
browser on this box: the element was driven in happy-dom from the
scratchpad (not a dependency), and its layout has not been seen.

14cg. **Item 685 (roadmap W4, 2026-09-24): the scheduling page, with vx's
own scheduling code running in the browser.** `learn/scheduling.mdx`
teaches workers and why N of them are not N times faster, the critical
path and the lower bound (the larger of the chain and the work over the
workers), why the order of ready tasks matters, the four priorities, a
task with no history (item 669's numbers, from `schedule-policy.md`),
and the restore tier beside the exec tier. Then how vx does it (a
`vx.workspace.ts` block the config law type-checks), one sentence each
for Turborepo, Nx and Bazel from their docs (none documents how a local
run orders ready tasks; Nx's source does, and is linked as source), a
Mermaid graph with the critical path marked, and a checkpoint. The graph
is W1's monorepo plus a lint per package and a 10-second `docs#build`
that nothing waits on: 48 s of work, a 24 s critical path, and on two
workers core's order ends at 27 s where learned durations reach 24.

The simulator is not a model. `demos/model/scheduler-sim.ts` hands every
schedule to `vx-bench/schedule-policy.ts`, which ranks with core's
`computeReverseDepCount` and `mergePriorities` and the plugin's
`criticalPathPriorities`. Bundling those needed no shim: they moved,
unchanged, into files that import only types (`graph/priorities.ts`,
`vx-schedule-history/src/critical-path.ts`; the scheduler and the plugin
re-import them), because `scheduler.ts` pulls `util/`, whose modules read
`Bun` and `process` at load. The site defines `import.meta.main` false,
so the bench's report drops out. The island is one 9,618 B chunk (4,018
B gzip) that imports nothing and holds no `Bun`, `process`, `node:` or
`bun:`. `simulate` now returns `spans`, held to the real `runGraph`'s
start times by the bench's replay row (red with every start shifted 1
ms). Without JavaScript: two Gantt charts (core's order and learned
durations, two workers), the bound, a finish table for one to four
workers under every policy, the task table, and a static table of the
no-history cases. With it: workers, a policy per chart, a duration and a
"no history" box per task, Reset, and a live region. Checked in Chromium
at 1280 and 390 px (the charts scroll sideways below 34rem), light and
dark, JavaScript on and off.

`tests/demo-islands.test.ts` gained 11 rows: the model against
schedules traced by hand, the finish and no-history tables, the model
against the bench's `simulate` on three bench shapes (the row that keeps
the two one code), the built charts and their text alternative, render
against model, the tables, the hidden controls, the Mermaid graph
against the model's tasks and edges, the ranking the prose walks
through, the checkpoint, and the loader with no platform in the chunk.
Twenty mutations, each rebuilt and run: the lane rule, the model
dropping the history mask, the bench's tie-break, core counting direct
dependents, the plugin dropping the chain, the static worker count, the
bound, the critical-path class, the text alternative, the no-history
table, the task table, two hidden controls, two diagram edits, the
checkpoint number, the `define`, the element's name, the bench importing
`scheduler.ts`, and a prose count. Each turned a row red and passed
after restore. Direct dependents first survived every schedule row (on
this graph they rank the same way), so the ranking row was added and
now fails. The site's `build`, `test` and `dev` tasks grant
`../vx-bench/schedule-policy.ts` and key on the three sim sources; a
sandboxed `vx run @vzn/vx-docs#test` without the grant fails the build
with `UNRESOLVED_IMPORT`. Also corrected: the glossary's vx line for
critical path (core ranks by tasks waiting; the plugin by critical path)
and its Nx and Bazel dashes (both docs use the term), and the plugin
README's "remaining critical path by edge count" for core's baseline.

14ch. **Item 686 (roadmap W5, W6, 2026-09-24): the architecture and
extending pages teach the plugin API.** `learn/architecture.mdx` explains
a pipeline with seams in general terms, then vx's stages, the local
floor, "no defaults", "seam over special case", what the design buys
(remote execution, Turbo's and Nx's cache wires, telemetry, verbs,
adoption, all without forking core) and what it costs, then one verified
sentence each for Turborepo, Nx and Bazel, then a checkpoint. Its widget
is the pipeline explorer (`PipelineExplorer.astro` + `pipeline-explorer.ts`):
a strip of the thirteen hooks, a section per hook with its declaration
READ FROM `VxPlugin`'s source at build time, its first-party plugins and
an example plugin from `src/examples/stages/<hook>.ts`, a table of what
core does and what a plugin decides, and a Mermaid flowchart generated
from the same model. Without JavaScript: the strip is anchor links, all
thirteen sections show, the table and the strip carry the pipeline (the
Mermaid source is text until its script runs). With it: the links become
toggle buttons (`aria-pressed`, Space and Enter, Escape shows all), one
section at a time, the row marked, a live region; it opens on `config`.
`learn/extending.mdx` has five worked plugins, each a real file under
`packages/vx-docs/src/examples/` shown from the file beside the strip
with its stage lit (`PluginExample.astro`, the explorer's strip in
static mode, so a hook added to core reaches every example's diagram): a
one-line telemetry summary, a remote cache over a toy HTTP store, a
`cache-size` verb, a schedule weight for one task, and `turbo()` in two
lines. One model, `demos/model/pipeline.ts`, drives all of it.
`tests/learn-architecture.test.ts` (36 rows): the model equals
`PLUGIN_HOOKS` both ways and in order; the declaration reader against
all thirteen declarations written out by hand; the first-party column
against what every first-party factory returns when called (both ways,
so a plugin that starts filling a stage turns it red); every example
and the model type-check with oxlint in a temp dir; each stage example
fills its stage and each worked example exactly its stages; the built
pages against the model (strip, sections, links, table, hidden controls,
Mermaid, caption, checkpoints, loader). 26 product mutations plus one
per parameterized row (13 stage rows, 5 worked rows) each turned a row
red and every row was red at least once; green after restore. Among
them: a hook added to core's `PLUGIN_HOOKS`, a hook dropped from or
added to the model, a planted type error in an example, in the model
and in the `turbo()` call. To call the factories the site now links
`@vzn/vx-lockfile`, `-mcp`, `-migrate`, `-otel` and `-reapi` as
devDependencies (the README says why), and its `test` task declares the
reads and makes core's and the plugins' `src/**` inputs; `build` reads
`plugin.ts` and keys on it. Checked in Chromium at 1440 and 390 px with
JavaScript on and off: no horizontal overflow. The competitor sentences
were checked against shallow clones of vercel/turborepo, nrwl/nx and
bazelbuild/bazel on 2026-09-24. Found on the way: `setup` runs after
the planning stages (and after `cache` is resolved), not before `config`
as a first draft of the diagram said, and `VxPlugin.setup`'s own comment
("before any capability is consulted") overstates it for `cache`; left
for core. Both Mermaid pages log a `pageerror Object` in Chromium, W1's
too; not from this item.

14ci. **Item 687 (2026-09-24): a plugin's suite re-keys on core's
source.** Every package that imports `@vzn/vx` reads core's source,
since core has no build, but core's `build` was an empty group whose key
never moved. So a dependant's `test` and `lint.oxlint`, which fold
`install` and through it `^build`, kept their keys across a core edit,
and a warm local cache (`vx run ci --all` on a developer box; CI keeps
no cache between runs) replayed a plugin's pass over a core change that
broke it. Reproduced: `@vzn/vx-github#test` kept key `c1bee330…` after
an edit to `src/util/hash.ts`. Core's `build` now depends on a no-op
`source` task whose inputs are `src/**`, `index.ts` and `tsconfig.json`,
so every dependant's install folds that key; the same edit moves the
test's key and restoring the file restores it. Held by
`core-source-key.unsafe.test.ts`: every dependant's `test` and
`lint.oxlint` reach `@vzn/vx#source` in the dry-run graph (red with
`build` back to no deps). The class is every package consumed as source, not
core alone: the site imports vx-github and vx-schedule-history, and the
bench vx-schedule-history, and no plugin had a `build` at all. Every
plugin package now has `build` (`^build` and its own `source`, keyed by
`src/**`), and the law checks every workspace dependency edge: each
dependant's `test` and `lint.oxlint` reach `<dep>#source` (red, naming
the three missing edges, with vx-schedule-history's `source` edge
removed). Found by the W2 implementer, who had patched only the site's
test with `workspaceFiles: ['packages/vx/src/**']`; that second copy of
the rule is removed, the cascade covers it.

14cj. **Item 688 (roadmap W3, 2026-09-24): the correctness page, and a
stale-hit demo held to vx.** `learn/correctness.mdx` replaces the stub
under the same slug. It teaches the stale hit as the worst failure (a
green run, wrong bytes); declared inputs against the two ways of
inferring them (a broad default, a trace), with a table of what each can
miss, whether the key is known before the run, and what reruns; why vx
refuses inference; the sandbox as the check that turns a declared list
into a proof, as a Mermaid diagram; what vx does when the sandbox cannot
start (the run stops with `sandbox not available:`, the task never runs
unsandboxed); the costs and blind spots (two lists to write, a grant
wider than the inputs, environment variables, `node_modules`, Linux and
macOS only, a lossy macOS log, no report for a persistent task); how vx
does it, with a type-checked config; one paragraph each for Turborepo,
Nx and Bazel; and a checkpoint. Competitor claims come from the doc
clones of 2026-09-24: Turborepo's default inputs and `globalDependencies`
(`reference/configuration.mdx`, `crafting-your-repository/caching.mdx`;
no page mentions a sandbox or hermeticity), Nx's default inputs, inferred
tasks and Cloud-only task sandboxing with Warning and Strict modes
(`concepts/how-caching-works.mdoc`, `concepts/mental-model.mdoc`,
`features/CI Features/sandboxing.mdoc`), Bazel's sandboxing and its
macOS cost (`reference/glossary.mdx`) and "enable strict sandboxing"
(`basics/hermeticity.mdx`). The clone does not say whether Bazel
sandboxes by default, so the page does not either.

The widget is `StaleHit.astro` and `stale-hit.ts` over
`demos/model/stale-hit.ts` (it reuses the toy model's digest, now
exported). `web#build` runs `mkdir -p dist && cat src/index.ts
banner.txt > dist/out.txt` and declares `src/**`. Five steps: first run
(miss), edit `src/index.ts` (key moves, miss), edit `banner.txt` (key
stays, stale hit), turn on `exec.sandbox` with the same list as its
grant (the sandbox block is config, so the key moves and the run fails
with the report), declare `banner.txt` (key moves, miss, right output).
Four toggles let the reader go on from any step, which the checkpoint
uses: sandbox off (miss), then undeclare (the key is step 3's again, and
the entry step 2 stored is replayed stale). Without JavaScript: a table
of the five runs (key, verdict, `dist/out.txt`, what a run with no cache
writes), a sentence per run, and the frame vx prints at step 4. The
first draft's command had no `mkdir -p dist`; the real-vx row failed on
it, because only the sandbox's write grant creates `dist/`.

Proof, in `packages/vx-docs/tests/learn-correctness.test.ts` (19 rows):
the model against a hand-written truth per step and for the checkpoint;
the page's config snippet evaluates to the config the model keys on;
the model against vx, one workspace written from the model and run with
the cache and a second without (moved keys, hits, stale bytes), where
the two sandboxed steps are asked of `planRun` (key and cache status),
because the site's `test` task is itself sandboxed and a sandbox cannot
start inside one; the step 4 frame equals `formatTaskBlock` over the line
`parseStraceViolations` writes for a synthetic strace line (imported from
core's source, as vx-bench does); and the built page (the table, the
sentences, both copies of the report, hidden controls, the caption that
calls keys and path illustrative, the checkpoint, and the element's chunk
reached from the page's scripts with no `Bun.`, `process.` or `node:` in
it). The half the site cannot run is a new core row,
`sandbox-runtime.unsafe.test.ts` "learn/correctness's stale-hit demo, run
for real": a live sandboxed run fails with exactly the one line
`openat(banner.txt) = -1 ENOENT  [<project>/banner.txt]` and cat's
stderr (matched loosely: the logger trims each chunk, and the gate once
saw the message split after `cat:`), and declaring the file makes the
same task pass. The page now names the three sandbox binaries, so
`site-samples.unsafe.test.ts` lists it among the pages held to naming
all three.

Mutations, each red then green after the reverse edit. Model: the key
ignores config (5 rows: step 4, checkpoint, vx parity, page render, page
checkpoint); the key folds the undeclared file (5); the cache forgets
old entries (5); the sandbox never denies (3; the vx row stays green by
design, since vx is only planned there, and the core row holds it); the
config drops its sandbox block (6); the printed snippet names other
inputs (1). Core, with the model untouched: the key strips `exec.sandbox`
(the vx parity row); the violation line loses a space (the report row,
and the live core row); the frame's section rule is one dash longer (the
report row). The live row's control with `banner.txt` left out of the
grant (red: the run fails). Page, each with a rebuild: a table row
dropped (2), the controls not hidden, the caption without "A model", the
checkpoint answer saying "hits", the element renamed, the element calling
`process.cwd()` and `Bun.hash`, the static report's duration changed,
the stale sentence softened: each reddened its own row. One mutation
was a no-op and is recorded as such: `typeof process ... process.env`
survived because Vite rewrites `process.env` to `{}`, so the built chunk
never held `process.`; `process.cwd()` replaced it. Checked in Chromium
at 1280 and 390 px, JavaScript on and off: no horizontal page overflow,
the table stacks per step under 40rem, the report scrolls inside its own
box. Every page with a Mermaid diagram (this one, `learn/caching`, the
sandboxing guide) logs one uncaught non-Error `Object` on load; it
predates this item and is not chased here.

14ck. **Item 689 (roadmap W7, 2026-09-24): the choosing page names the
design choices and what each costs.** `learn/choosing.mdx` replaces the
stub under the same slug. It teaches that a checkmark hides the choice
behind it (default, inferred or declared inputs; whether anything checks
the key), then shows the twelve choices in a matrix: how inputs are found,
what checks the key, the configuration language, how the runner is
extended, the runtime, which languages it builds, the remote cache wire,
running tasks on other machines, which ready task starts first, state
between runs, coming from another tool, and maturity. Each has, per tool,
what it chose, what that buys, what it costs and its sources, and a
"choose another tool if" row that never names vx. Then vx's costs in
plain words (Bun only, pre-alpha with 0.1.0 not cut and the plugins
unpublished, explicit inputs are work, a small ecosystem, nothing
distributed ships, no first-party cloud), when Turborepo, Nx or Bazel is
the better pick, and a checkpoint. One model, `demos/model/choosing.ts`,
drives the matrix (`ChoosingMatrix.astro` + `choosing-matrix.ts`), the
diagram (`ChoiceMap.astro`, a static SVG placing each tool on inputs ×
what checks the key) and the checkpoint (`ChoosingCheckpoint.astro`,
whose answer is `evaluate` on its two needs: only Bazel meets "a stable
release" and "undeclared inputs caught on our own machines"). Without
JavaScript: a table of nine needs × tools with each reason, and the full
choices table. With it: a box per need, Clear, the choices filtered to
the ones that decide the ticked needs, each deciding choice saying why,
its tools marked, and a live region naming what rules each tool out.
Checked in Chromium at 1280 and 390 px, JavaScript on and off, no
horizontal overflow and no page errors. `tests/learn-choosing.test.ts`
(15 rows): every cell filled and sourced; other tools' links only to
turborepo.com, nx.dev or bazel.build; vx's links to a built page and
anchor or to a test file holding the named row; the needs and the filter
against hand-written truth (including two needs deciding one choice);
the built tables, links, hidden controls, diagram positions, cost bullets
and checkpoint; every time figure on the page verbatim in benchmarks.md;
the element's chunk reachable with no platform in it. The site's `test`
task grants and keys the seven linked vx test files by name. Twenty
mutations, each rebuilt where it touched the page and run: an empty
cell, an Nx link off nx.dev, an other-tool row naming vx, a renamed and
a moved test link, a need ruling in one more tool, the empty filter, the
favours rule (some for every), the ruled-out rule inverted, a dropped
cell, site links without the base, controls shown, need cells inverted,
Bazel moved on the diagram, a one-need checkpoint, a figure benchmarks.md
lacks, the element renamed, a cost bullet dropped, a turborepo.dev link,
a missing anchor. Each turned a row red, every row was red at least
once, and all fifteen passed after restore. Every claim about another tool
was checked in its docs source (vercel/turborepo efd2a5b, nrwl/nx
54e5264, bazelbuild/bazel ad2d5c1, 2026-09-24). The check corrected five
rows of `comparison.md` in place: Turborepo keys each package on the
lockfile changes that affect it (not the whole file), has experimental
native Go, Cargo and uv workspaces (not "no" for non-JS projects), and
no longer uses its daemon for `turbo run`; the Nx daemon is on by
default locally, not always on; Nx's plugins infer tasks and add graph
data, generators, migrations and executors, first-party for Gradle, Maven
and .NET (Rust is community). Found, not fixed: `benchmarks.md`'s
2026-09-03 head-to-head says Turbo's daemon answers "what changed"
without a walk, but Turbo 2.10 no longer uses its daemon for `turbo run`;
and Turborepo's own docs link to turborepo.dev, while this site links
turborepo.com.

14cl. **Item 690 (2026-09-24): three claims corrected, one held by a
row.** `VxPlugin.setup` said it runs "before any capability is
consulted". It does not: `prepareRun` has already run the config,
project, cache, graph, key and schedule stages, and a plan (`--dry`,
`planRun`) never calls it. It runs before the executors, the telemetry
sinks, admission and the first task. The comment now says so, and so do
the four site copies (introduction, extensibility, the plugin guide's
type sketch, the pipeline blog post). `plugin-e2e.test.ts` holds the
order: one plugin fills ten hooks and records each call, and a run's
sequence is asserted exactly, `config` to `task:start`, with a plan's
lacking `setup` (red with the `setup` call removed). Second, Nx's
"no history first" is its LAST tie-break, not a rule over the queue:
`sortScheduledTasks` sorts by tasks waiting, then by projects
depending, and only among tasks equal on both starts one with no
recorded time first (read in Nx's source at 54e5264).
`schedule-policy.md` and the bench's header said Nx runs such a task
before every task with one; the scheduling page said "among equals"
and skipped the middle key. All three say it now, and the bench's
`unknown-first` is named the stronger rule it is; its verdict stands.
Third, CLAUDE.md gains the rule item 682 taught: measure what a
platform primitive consumes, not only what it returns.

14cm. **Item 691 (roadmap W9, P1, 2026-09-24): the key fold leaves
`Cache`.** `src/cache/key-fold.ts` holds `foldKey(input, hashFile,
relOf)`, the whole of what `Cache.key` computed, and `CACHE_VERSION`,
its first part; `Cache.key` delegates, passing its hasher and its
`relFor` memo. The file imports only `util/` and a type, so the
playground bundles the fold without the local store: the spike's
`entry.ts` drops its `Object.create(Cache.prototype)` borrow for
`foldKey`, its bundle is 78,465 B raw and 27,972 B gzip (126,846 and
43,085 as spiked), and `compare.ts` still finds keys, priorities and
dispatch order equal to `vx run --dry=json` on every scenario.
Behaviour-neutral by a golden row recorded BEFORE the move
(`tests/key-fold.test.ts`): every `CacheKeyInput` field set, lists out
of order, one file from the caller's map and one from disk; the digest
and the thirteen captured components stay exactly those, and `foldKey`
called with no `Cache` gives the same digest while asking its hasher
only for the unmapped file. Three source-reading pins (the caching
page's fold order, the plugin-before-inputs class pin, the blog's
twelve parts and ten kinds) now read `key-fold.ts`; the module page,
`caching.md`, `optimizations.md`, `flows.md` and the bump skill name
it. Warm path: `Cache.key` over 3,000 mapped files, min of 5 runs of
15×100, 0.708 ms per key before and 0.674 after (interleaved, before
arm from a worktree). No `CACHE_VERSION` bump: no key moved.

14cn. **Item 692 (roadmap W9, 2026-09-24): the playground's glob matcher
is Bun's.** `playground-spike/shim/glob.ts` was RegExp rules measured
against Bun; it is now a line-for-line TS port of the matcher
`Bun.Glob.prototype.match` calls. In Bun 1.4.2 that is Rust, not the
Zig the spike expected: `bun_glob::r#match` in `src/glob/matcher.rs`
(tag `bun-v1.4.2`, commit `744846f8`, MIT; its header credits
glob-match's author, the source of the shared quirks). The port walks
UTF-8 bytes as the Rust does, with the same backtracking, brace stack
(depth 10), 10,000-branch budget and escape table (`\b` is a
backspace). The fuzz, 500,000 pairs per domain, before → after: task
globs × git paths 219 → 0, task × any string 154 → 0, Bun's alphabet ×
git paths 1,469 → 0, Bun's alphabet × any string 3,090 → 0; at five
times the size, 0 in all four. The bundle grew from 78,465 to 81,370
bytes raw (27,972 to 28,666 gzip), measured on top of P1 (item 691). The generator moved to
`glob-fuzz.ts`, shared by `glob-equiv.ts` (now exit 1 on any
difference, sized by `GLOB_FUZZ_N`) and `tests/glob-port.test.ts`,
which runs the four domains at the table's seed and size in about 1.5 s
(each domain row carries a 60 s budget: the first one pays for all four,
and CI's loaded runner took 6.9 s against bun's 5 s default, reproduced
here with four copies on one core)
and pins hand rows for the adversarial shapes, the brace limits and
escapes. Differential: the old shim reddens the four domains with the
table's exact counts and 14 hand rows; in the port, the backtrack bound
`<=` made `<` differs 9,324–14,071 per domain, the upstream "FIXME"
special case removed reddens two domains and two rows, and the trailing
`/**` collapse removed reddens all four. `@vzn/vx-bench#test` now keys
on `playground-spike/**/*.ts`, which it imports.

14co. **Item 693 (2026-09-24): the site's code is format-checked.** No
task checked `packages/vx-docs`: the root `.oxfmtrc.json` ignored the
whole package (item 50's choice, made for its Markdown, where oxfmt
rewrites prose code fragments and moves spaces into inline code), and
unlike every other package it had no `lint.oxfmt`. Six code files had
drifted (`astro.config.mjs`, `import-docs.ts`, the scheduler model,
both stylesheets, `demo-islands.test.ts`); both W3 and W7 implementers
found it. The package now has its own `.oxfmtrc.json` (the repo's
options, ignoring `.md`, `.mdx` and `.astro/`), a sandboxed
`lint.oxfmt` like the others', and its `ci` depends on it. The six files
are formatted. Red with an unformatted line appended to a widget model,
green after the reverse edit. Recorded from the same reports, not fixed
here: `KeyCalculator.astro` reads `var(--sl-font-mono)`, which Starlight
never defines, so the caching widget's keys render proportional (fixed
in item 696); every
page with a Mermaid diagram logs one uncaught non-Error object in
Chromium (fixed in item 697); and `benchmarks.md`'s 2026-09-03 head-to-head credits Turbo's
daemon with answering "what changed", which Turbo 2.10+ no longer uses
for `turbo run` (check which Turbo version that row measured before
editing it).

14cp. **Item 694 (2026-09-24): a repeat-load round costs one config
worker, as documented.** `vx watch` (and any second load in one process)
re-evaluates a config in a Worker so its imports are read fresh, and the
module page promised one Worker per round. The real round is one
`loadProjectConfigs` call, which awaits each evaluation in turn, so the
in-flight count reached zero after every config and the Worker was
retired and re-created: 5 repeat configs, 5 Workers. The row meant to hold
the promise drove three concurrent single-file calls instead, whose
sharing depended on their file reads landing before the first evaluation
settled; a loaded gate shard counted 7 where 6 was expected, which is how
this was found. `beginEvalRound()` in `config-eval.ts` holds the round
open for the whole call (still lazy, so a round that evaluates nothing
starts no Worker). The row now drives `loadProjectConfigs`: exactly one
Worker for three repeat configs and one more for the next round. Red with
the round neutralised (7 for 5) and with its end dropped (the second
round reuses the registry, 1 for 2). A repeat round of 50 configs, min of
5, interleaved, before arm from a worktree: 148 ms before, 10.5 ms after.
The module page's claim that `prepareRun` loads with `Promise.all` was
wrong and is corrected.

14cr. **Item 696 (2026-09-24): the site's monospace falls back to
Starlight's.** `--sl-font-mono` is a property a site may set; Starlight
defines only `--sl-font-system-mono` and reads the other through a
fallback. `KeyCalculator.astro` and `Head.astro` read it bare, so the
caching widget's keys (and the head's code) rendered in the inherited
proportional font. Both now carry the fallback the stale-hit widget
already used. `tests/starlight-vars.test.ts` holds the class: every
`var(--sl-…)` in the site's source names a property Starlight's own
stylesheets define (read from its `dist/style/`, so the set follows the
installed version), or carries a fallback. Red with the two fixes
reverted, naming both files; a control row checks the definitions were
read (`--sl-font-system-mono` in, `--sl-font-mono` out).

14cs. **Item 697 (2026-09-24): every diagram renders, and none throws.**
Two defects behind the console error the W3 implementer saw. First, a
race: `Head.astro` rendered on load and again from its theme observer,
which Starlight trips as it sets `data-theme` at startup, and two
`mermaid.run` calls over the same blocks tore each other's DOM down, so
every page with a diagram threw mermaid's non-Error `{ str, hash }`
("Cannot read properties of null (reading 'firstChild')") while the
second render still drew the diagrams. Renders now run one at a time,
and a failed one is reported as `[vx] a diagram did not render: …`
instead of thrown. Second, a real break: the extensibility guide's
pipeline named a node `graph`, a mermaid keyword, so that page showed
mermaid's error graphic instead of the diagram; the node is `grph` now.
Driven in Chromium over the built site, all 14 pages with diagrams:
before, every page threw (the guide twice, the second its parse
error); after, none, 24 of 24
diagrams drawn, no error graphic. The race fix has no committed row (the
site suite runs no browser); the keyword class does:
`tests/mermaid-ids.test.ts` reads every flowchart the build shipped,
hand-written and widget-generated, and requires that no node id is one
of the flowchart grammar's keywords. Red with `graph` restored, naming
`guides/extensibility`; a control row checks the id reader on a known
source.

16. **The site teaches (owner, 2026-09-23; roadmap track W).** Redo the
    site so it explains task orchestration before it sells vx: a Learn
    section with one diagram and one interactive element per page
    (a graph explorer, a key calculator, the scheduler simulator in the
    browser, a pipeline explorer, worked plugins), and a choosing page
    that states what each design choice costs. Plan and order:
    `design/site-teaches-2026-09.md`. The bar is monorepo.tools, "1000×"
    better on education: mechanisms instead of checkmarks, the real
    planner running in the browser (W9), labs where the reader breaks a
    build (W10), checkpoints (W11) and a glossary (W12). W0, the
    skeleton and the island pattern, is DONE (item 675, entry 14bw).
    W1, the first real Learn page and the graph explorer, is DONE (item
    681, entry 14cc), and so is W12, the glossary (item 683, entry 14ce).
    W2, caching and the key calculator, is DONE (item 684, entry 14cf).
    W4, the scheduling page and the scheduler simulator on vx's own
    ranking code, is DONE (item 685, entry 14cg). W5 and W6, the
    architecture page with its pipeline explorer and the worked plugins,
    are DONE (item 686, entry 14ch). W3, the correctness page and its
    stale-hit demo, is DONE (item 688, entry 14cj). W7, the choosing page and its
    matrix, is DONE (item 689, entry 14ck). W9, the playground, has started: its first core
    change, P1, is DONE (item 691, entry 14cm), and its three open
    questions are decided in `design/playground-spike-2026-09.md` § W9
    decisions (parity rows in core's unsafe suite, `vx.config.mjs`
    evaluated in a Worker, a Bun-built bundle from a vx task). The exact
    glob port (item 692) is in flight; the bundle, its task and the
    parity rows follow.

## Decisions (this arc)

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
