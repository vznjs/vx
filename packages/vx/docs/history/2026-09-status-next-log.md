# STATUS § Next — the log moved out on 2026-09-16

What the Next list of `docs/STATUS.md` carried that was a record, not a
handoff: the warm-run closing figures and refutations under Next 6, the
closed first-run follow-ups under Next 7, the improvement-loop candidates
under Next 8 with their measurements, and the session handoffs 14–14f.
Moved whole; nothing here is current state. Item numbers refer to the
improvement loop (STATUS and `2026-09-improvement-loop-*.md`).

## Next 6 — warm-run closing figures and refutations, 2026-09-03 → 09-10

The standing duty stays in STATUS; this is the record under it.

REFUTED 2026-09-10 (afternoon), recorded so nobody re-runs it: a
synchronous restore for small artifacts. The restore path makes
~8 `node:fs/promises` round trips per one-file artifact (exists,
read, realpath, mkdir, write, chmod, utimes, rename), and a
`restore: exists / rows / extract` span set (kept) showed the
extract as the whole cost; the sync form measured 2× faster ALONE
(sequential in-process restore of a 40-byte `dist/out.js`, median
1.25 → 0.62 ms against 0.52 for the bare syscalls) and 30% SLOWER
in the run (compiled binaries, three interleaved rounds on the
1,000-project bench: `warm, restore` 1,176 / 1,110 / 1,218 ms →
1,539 / 1,506 / 1,493), because four workers overlap their round
trips and a blocking one stalls the other three. The lead left:
`restore: rows` re-selects the output rows the batched probe
already loaded (21 ms per 1,000, ~2%); threading `hit.outputRows`
through needs a contract change for a row nobody sees.
Closing figures for 2026-09-10, evening (the same container,
`run.ts` medians of 5, after items 81–82): source form 100 projects
123 ms warm / 181 restore / 369 cold; 1,000 projects 240 / 1,163 /
2,519 — against the afternoon's 115 / 197 / 408 and 265 / 1,381 /
2,988: the restore row −16% and the cold row −16% at 1,000, which
is the restore lane and the save lane on the headline bench, and
the warm row within the box's jitter (nothing touched it).
Closing figures for 2026-09-10, afternoon (the same container,
`run.ts` medians of 5, after items 70–80): source form 100
projects 115 ms warm / 197 restore / 408 cold; 1,000 projects 265 /
1,381 / 2,988 — the 1,000 warm read high against the morning's
229, so it was settled as the A/B the box needs: main before this
session (264f01a) against the head, BOTH as compiled binaries
through `VX_BIN`, three interleaved rounds — warm no-restore
246 / 251 / 235 vs 250 / 212 / 201 ms, restore 1,510 / 1,297 /
1,186 vs 1,241 / 1,230 / 1,308, cold 3,423 / 3,128 / 3,432 vs
3,465 / 3,180 / 3,157. A tie or a win in every column; the lone
265 was the box. (Items 70, 71 and 77 moved surfaces this bench
does not exercise — a sandboxed gate, the first warm run after a
cold one, a plugin-bearing binary — and each carries its own A/B.)
Closing figures for 2026-09-10, morning (the same container, `run.ts`
medians of 5, after the three package moves and the CI work): 100
projects 118 ms warm / 182 restore / 394 cold; 1,000 projects 229 /
1,206 / 2,758. No core warm-path change landed today — the moves
ran nothing on `vx run` — and the figures sit on yesterday's within
the box's jitter.
Closing figures for 2026-09-09 on a noisy 4-core Linux container
(late, after the improvement loop's 25 items): head vs main
(c0b20ca), 1000 projects, both orders, min 296/304 and 302/295 ms,
20 reps 310/313 — within run-to-run jitter, no `VX_TIMING` stage
moved (loop item 25). Every warm-path step was A/B'd at its commit.
(not the owner's box — compare against 2026-09-04 only by ratio):
`run.ts` medians before the day's perf commit, 100 projects 109 ms
warm / 180 ms restore, 1000 projects 281 / 1337; the commit's A/B is
in the review entry. LEADS from the profile, not taken: (a) each
`vx.config.ts` is stat'ed twice on the warm path — `findConfigFile`
in discovery and again for its identity in the config load;
threading the discovery stat into `hashFiles` saves ~1,000 stats.
REFUTED on the cheaper half (2026-09-09): making discovery's stat
synchronous ties (interleaved, 8 reps: min 57.6 vs 62.5 ms, median
68 vs 67) because the async stats overlap the package.json reads.
TAKEN another way the same day: on Linux each async stat is a
thread-pool round trip and a `.mjs` config pays four of them per
project, so one readdir per project dir replaces them there (12 ms
against 43 at the last name, a tie at the first; the macOS stat loop
stays, measured the winner there on 2026-09-03). Discover projects
65–79 → 29–34 ms; whole process interleaved both orders, 10 reps:
min 318 → 304 and 328 → 292 ms, median 368 → 325 and 358 → 320;
(b) TAKEN 2026-09-09: the hit path's `output dirs` + `output stat`
are ~2 stats per task and inherent to the proof, but they were
thread-pool round trips; synchronous, the run graph stage halved
(review entry); (c) TAKEN 2026-09-09: `record history` was ~10 ms
on an empty table and 57–79 ms at 166k rows because of the
(project, task) index; dropped (review entry). Remaining on the
profile after both: discovery's async stat (42 ms native self time
at 1,000 projects, the one lead (a) above leaves), and the history
reader's slice scan for plugin users (~1 ms per 1,000 rows); after
the readdir change, discovery's remaining cost is the manifest reads
themselves. Closing figures for 2026-09-04 (load 5.7, best of 5): 1000
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

Closing figures for 2026-09-10, night (the same container, source
form, medians of 5, after items 83–90 — the lockfile plugins, CI on
vx tasks, the empty `build`, `@vzn/vx-infer`; none touched the hot
path): 100 projects 126 ms warm / 205 restore / 427 cold; 1,000
projects 244 / 1,006 / 2,567 — against the evening's 123 / 181 /
369 and 240 / 1,163 / 2,519: the 1,000-project restore row −14%
(the save-lane and restore-lane changes of the evening under a
quieter box), every other row within its own spread.

Closing figures for 2026-09-11, evening (the same container, source
form, medians of 5, after items 131–148 — the migrate merge, the Nx
mapper fixes, the real-repo benches and the watch arm instant; none
touched `vx run`): 100 projects 120 ms warm / 171 restore / 396 cold;
1,000 projects 247 / 870 / 2,810 — against the night's 126 / 205 /
427 and 244 / 1,006 / 2,567: the warm rows tie, the 1,000-project
restore row reads −14% and the cold row +9% with no commit on either
lane. Both moved together with the box: the cold reps climbed
monotonically through the run (2,639 → 3,171) while the restore reps
held (841–907), so the spread is the container's, not the diff's; an
A/B was not run because there is no candidate commit to put on the
other arm.

Closing figures for 2026-09-12, morning (the same container, source
form, medians of 5, after items 157–161 — the admit seam, the usage
on the artifact, the RSS unit, the cgroup budget and worker count;
three of them touch the hit path): 100 projects 87 ms warm / 127
restore / 280 cold; 1,000 projects 182 / 615 / 1,853 — against the
evening's 120 / 171 / 396 and 247 / 870 / 2,810, every row −26% to
−34%, which no diff of the day can claim. So the day HAS a candidate
this time and the A/B was run: compiled binaries, start-of-day main
(5972968) against main after item 161, interleaved on the
1,000-project bench, one workspace per arm — warm no-op 12 reps min
133 / med 139 vs 132 / 142 ms, `--force` 6 reps min 1789 / med 1846
vs 1773 / 1826: a tie inside the spread. The −26% is the box's
morning, not the code's; the figures above are the new baseline for
this container's quiet state, and the per-item A/Bs (157, 158)
stand.

## Next 7 — first-run DX follow-ups from the 2026-09-04 walkthrough

7. **First-run DX follow-ups (candidates, from the 2026-09-04
   walkthrough).** (a) DONE 2026-09-09: `--summarize` task rows carry
   `noCache: true` for a task with no `cache` block (present only when
   true; documented in `docs/cli.md` § --summarize). (b) DONE 2026-09-04: `init` no longer makes `lint` wait for `build`
   (`test` / `typecheck` still do, the Turbo starter's convention). (c) CLOSED 2026-09-10 (measured on the watch-loop harness, pinned in `tests/watch-loop.test.ts`): an uncached task that writes into its project costs exactly one extra execution per edit and nothing after the initial run — the task's write and a user's edit during the run are the same FS event, so without the task's write set the loop cannot drop one and keep the other; the price of an undeclared output is one cycle, the fix is to declare it. Was: watch still pays one redundant cycle on a task's first undeclared write (the bytes are unknown until seen);
   hashing what the cycle wrote before re-arming would zero it — only
   if a real workspace shows the cycle mattering. (d) DONE 2026-09-04: a filter set that matches nothing is one
   error line naming the patterns and the nearest project name.

## Next 8 — improvement-loop candidates of 2026-09-09, as recorded

8. **Improvement-loop candidates (2026-09-09, in order).** (a) DONE as
   item 16 (`orchestrator/miss-save.ts`, behind the differential pin;
   the hit path followed as item 63, `hit-restore.ts`). (b) DONE 2026-09-10: `vx cache prune --max-size 10` is refused
   with the unit it wanted (`10M, 10G`); `10B` still passes, and
   `parseSize` keeps its bare-bytes contract for the computed
   `--memory` budgets. The zero guard speaks first for every zero
   spelling, as its pins require. (c) Anything else that reads config
   files raw: only `vx lock` remains, on purpose (it freezes the
   file's own evaluation). Grep for `loadProjectConfig(` before
   adding a fourth consumer of the staged load. (d) `logger.ts` (716)
   and `framed-output.ts` (528) are the last large files; split only
   if a concern separates as cleanly as the three splits today did
   (assessed 2026-09-09: neither does — one renderer, one formatter).
   (e) Discovery is the largest fixed cost a warm run pays before any
   task: `listProjects` reads 19–28 ms for 1000 packages (2026-09-09,
   isolated). The manifest reads are 3–5 ms of it (async `Bun.file`
   wins over `readFileSync` 3.4 vs 6.3 ms, re-measured — the comment
   in workspace.ts stands); the rest is the member glob, the config
   probe and the loops. A memo keyed on each member directory's stat
   would skip the reads on a warm run, but a directory mtime does not
   move when a file INSIDE it is rewritten in place, so the key would
   have to be the manifest's own stat — one stat per package, which is
   most of the cost already. Do it only with a measured design.
   Measured 2026-09-10 on the pre-warmed 1,000-project copy, min of
   seven, all in flight: today's per-package I/O (readdir + manifest
   read + `JSON.parse`) is 8.6 ms; the memo's key (a stat of the
   directory — entries added or removed — and a stat of the manifest)
   is 3.3 ms async, 2.8 ms sync. But the memo must hand plugins and the
   package graph the whole manifest, so it stores the parsed JSON and
   parses it back — the `JSON.parse` share stays — and reads 1,000
   rows from SQLite (~1 ms). Net ≈ 3–4 ms of a 230 ms run for a second
   staleness surface (directory mtimes across platforms). REFUTED as
   not worth it; revisit only if discovery's share grows.
   (f) DONE 2026-09-10 as item 75: `--cache-dir` on `vx why`, `vx
last`, `vx info` and `vx cache prune`, through one parser and one
   resolver. Was: a `vx run` flag only, leaving the reading verbs on
   the default directory.
   (g) `vx why` names a plugin `key` part but shows its digests
   (`plugin tool/node-major a2d9… → e893…`), because `entry_inputs`
   rows reduce every value to a digest — right for env values, which
   can be secrets, but a plugin's own material (`node-major: 22`) is
   what its author wants to read. Assessed 2026-09-09: a new column
   means a SCHEMA_VERSION bump, and a bump DROPS every table — every
   user's cache and history — for a nicety; storing the raw value in
   the `hash` column for `plugin` rows needs no bump but persists
   whatever a plugin returned (a secret, if a plugin ever folds one).
   Neither is worth it today; revisit when a plugin's part is the
   thing people debug.
   (h) DONE as item 58 (the weighted deal). Was: shard balance
   (measured 2026-09-10, after item 45): `bun test
--shard` splits by file count, so shard 5 carries `output-memory`
   (a 4 s rate measurement that spawns RSS probes) plus `task-timeout`
   and runs 18 s wall while the others run 5–13 s — the critical path
   when the shards run in parallel. Giving the memory probe its own
   task (every shard adds it to `--path-ignore-patterns`; one task
   runs the file alone) would cut the path to ~13 s. Nine config
   edits and a CLAUDE.md line for ~5 s; do it when the next slow file
   lands in the same shard, not before. Refuted alongside: pre-bundling
   the CLI for the ~130 end-to-end spawns. One `bun bin.ts --version`
   costs 45–47 ms (bun's own start is 4 ms); a `bun build
--target=bun` bundle of the same entry costs 83–90 ms, slower, as
   the flag-less compile was in item 32, and the `--bytecode` form's
   ~17 ms gain would buy ~2 s of suite for a build step in every test
   run. The spawns stay on source.

## Next 14–14f — session handoffs after items 153, 130, 166, 170, 176, 183 and 189

Each was current for a day; 14g (after item 192) stayed in STATUS.

14. **Handoff after item 153 (2026-09-11, night).** PRs #302–#315
    carried the day: the adoption packages merged into
    `@vzn/vx-migrate` (`turbo()`, `turboCache()`, `nxCache()`, the
    CLI), `@vzn/vx-prune` gone, the Turbo build sets and wide sets
    benched, then the Nx round — query, strapi, novu, router, refine,
    five repos, every one on the repo's own worker count with the
    task sets proven identical by `--graph` against `--dry=json` —
    and what the round taught core and the mapper: `--mjs` output
    (145), one output path per cached task at migration time (146),
    run-commands' cwd and placeholders (147), the watch arm instant on
    the mtime clock (148), a workspace peer as an order edge unless it
    closes a cycle (149, the one core graph change of the day, A/B'd
    a tie), Nx 23's per-user cache pinned by the harness (150), a
    hidden output directory as its subtree glob (151), and the
    real-repo no-op profiled to its floors (153). Open: Next 16 above
    (overlapping outputs, with its rewrite catch), Next 1 and 2 as
    before. The box: four cores, a 13.3 GiB cgroup, no sandbox (the
    gate runs as `scratchpad/gate-manual.sh`), Node 22.22; a chain of
    benches survives a turn boundary only under `setsid` from a plain
    shell, and every `pkill -f` pattern must not appear in its own
    command line. Never end with "what next?".

14a. **Handoff after item 130 (2026-09-10, late night).** PR #293
merged the landing page's first delivery (a layer over the old
page); the owner asked for a full redesign, and PR #294 carries it
(item 125, the film) with the loop that followed: the `project`
stage's context names every package core discovered (126, the
Turbo plugin's second discovery gone, −12 ms per 1,000), one Turbo
mapping per run so a watch cycle sees a script edit (127),
`vx watch` on a `vx.workspace.*` edit (128), the mapping indexed by
name (129, a tie at the run level, recorded as one), and a package
added or removed under a running watch (130, the glob's directory
watched, the set re-armed). Every one is pinned with a
differential; the piecewise gate ran here (this container cannot
host the sandbox) and CI was green on every head it had run by
the time of writing. Method that paid tonight: read one arm of a
feature for the file it cannot see (the workspace config, the
package directory, a plugin's memo), probe it end to end in the
scratchpad, then pin. What is still no event under `vx watch`, by
choice and in the docs: a root `turbo.json` edit (no seam names a
plugin's root files — a second consumer makes it one), a package
added under a glob of another shape than `<dir>/*`, and the
watcher shape when a new package declares the first
`workspaceFiles` input. Refuted on the way: `vx why` and `vx show`
on a config-less package whose task a `project` plugin gave it —
`why` reads the run's history and explains the key with the
changed input, `show` lists the task as "from plugins" (probed in
the scratchpad, 2026-09-10; nothing to pin, the read verbs never
load the config `why` would need). Learned on PR #295's red:
`oxfmt --check <file>` passes what `oxfmt --check .` rejects (a
code span wrapped across an indented line), so the gate's format
check is the directory scan from the package, never a named file
(CLAUDE.md). Refuted 2026-09-11: shipping plugins prebuilt to
save the transpile on import — on the compiled binary the
`workspace config` stage reads 9–12 ms with no plugin and 12–14
with `turbo()` imported from source, ~2 ms for a build step in
every plugin package. Left: the zero-migration
stage's remaining 20 ms per 1,000 (the overlay probes, two clones
per fill, a re-validation per plugin) if a workspace that size
ever runs without configs. Never end with "what next?".

14b. **Handoff after item 166 (2026-09-12, morning).** PRs #320–#330
carried the resources arc end to end and the sweep it pointed at.
The owner's direction — "devs will not know what to put in
`exec.resources`", then "the concept of resources should be only in
history schedule, why should core know it" — became items 157–161:
core keeps one `admit` seam and no notion of resources;
`@vzn/vx-schedule-history` learns each task's reservation from what
its past executions used and packs it; the producing execution's
usage rides the artifact's sidecar so a fresh runner has a number on
its first hit; and two container limits the raw numbers hid are read
from the cgroup — the memory budget and the default worker count,
one walk in `util/cgroup.ts`. Dogfooding found the day's real
defect: every Linux peak RSS was recorded 1024× too big (Bun's
`maxRSS` is bytes; a pure-function pin had enshrined kilobytes),
which would have made every learned reservation run alone — the
unit is measured now, and so is the CPU one. Then the doctor
(`vx info`) grew `workers` and `memory` rows with their sources
(163), and the class "a second copy of the rule" was swept: one
`PLUGIN_HOOKS` list pinned against the type (164), the five hook
tables held to it (165), the docs' quoted version constants held to
the constants — one was already stale (166). Every warm-path change
was A/B'd on compiled binaries and read a tie; the day's whole diff
too, after the morning bench read −26% on every row (the box, not
the code — the new baseline is in Next 6). Open: Next 1, 2 and 16
as before, all gated; the launch checklist's owner steps. The box:
four cores, a 15.7 GiB machine under a 13.3 GiB leaf cgroup, no CPU
quota, no sandbox (the gate is `scratchpad/gate-manual.sh`); a
`pkill -f` pattern must not appear in its own command line; `oxfmt`
un-indents a STATUS list continuation when a code span wraps across
it, so keep each span on one line. Methods that paid: measure a
platform unit by producing a known quantity and reading it back;
probe the doctor and the guides after a seam change, since they are
the surfaces nothing reads; when a defect is a second copy, find the
third before pinning. Never end with "what next?".

14c. **Handoff after item 170 (2026-09-12, midday).** PRs #332–#335
carried the surfaces the resources arc had left unread. The doctor's
facts moved to `orchestrator/doctor.ts` and `vx mcp` answers them as
`getWorkspaceInfo` (167); `vx last` ends each executed row with what
it used, `45 MB · 0.9× cpu` (168); `@vzn/vx-schedule-history` adds
`vx history`, the reservation it packs per task over the budgets it
packs into (169). Dogfooding those found the day's real defect, the
second in the RSS unit's neighbourhood: Linux folds the forking
parent's RSS high-water mark into a child's `ru_maxrss` at exec, so a
task lighter than vx read vx's footprint — `true` at 44 MB through vx
against a 1.9 MB shell, 328 MB from a 300 MB parent — and on a large
workspace every light task would have reserved vx's own RSS; the
runner reports a peak only above its own mark now (170). CI reddened
once on the `Cache.key` scaling guard with nothing quadratic (34×
against 30 on the shared runner), and the guard compares equal work
per rep now, ≤ 3× where quadratic reads 10×. The `modules/plugins.md`
seam table had said `schedule` alone for the plugin since `admit`
landed — corrected with this entry; no pin, since a core test cannot
read the plugin packages. Open: Next 1, 2 and 16 as before, all
gated; the launch checklist's owner steps; a real-repo dogfood of
`vx history` waits for a repo with its dependencies installed (the
bench clones here are bare). Methods that paid today: a probe that
confirms a thesis becomes a test, and one that refutes the obvious
cause (CPU hogs did not move the ratio guard) is recorded before the
next guess; a child's rusage is the parent's until proven otherwise;
`pkill -f` and `pgrep -f` match their own shell — the rule is in
CLAUDE.md now. Never end with "what next?".

14d. **Handoff after item 176 (2026-09-15, night).** Two threads
closed since 14c. The releases: v0.0.19 and v0.0.20 each died one
step further into `npm publish` (a copy list naming a deleted
directory, then a Linux job without the sandbox runtime; items 172
and 174, landed by another session and reviewed here), and v0.0.21
completed the set — the registry holds `@vzn/vx` and the four
platform packages at 0.0.21. The resources arc's last question: the
real-repo dogfood on TanStack/router (173) read every surface right,
and Next 18's measurement on 92 builds settled the CPU axis — a
build's parallelism is a reading of contention, packing by the solo
reading cost 21%, so the plugin learns memory only and cores stay
declarable (176). The harness for that measurement found the day's
core defect on the way: Bun drops piped stdout on `process.exit`, and
every JSON verb was exposed until `bin.ts` learned to end stdout
first (175). Open: Next 1, 2 and 16 as before, all gated; the launch
checklist's owner steps. The box: unchanged (four cores, 13.3 GiB
leaf cgroup, no sandbox, the gate is `scratchpad/gate-manual.sh`);
the bench clones under the scratchpad are bare again, and installing
router costs 72 s and 2.1 GB when a real-repo probe needs it. Methods
that paid: a pin whose reader is too fast proves nothing — the
stdout pin's reader starts late on purpose, and the old path fails it
three of three; a measurement that ties on a narrow graph (173's
13-task A/B) says nothing about a wide one, so the wide one was run
before deciding; when a fix and a measurement share a harness, land
the fix on its own evidence and the measurement on its own. After
the handoff: item 181, a first-run walk that found three surfaces
reading wrong (watch's recorded command, why's hit line, info's run
count) — the cheap probe after an arc still pays. Never end
with "what next?".

14e. **Handoff after item 183 (2026-09-16, small hours).** Three
first-run walks on fresh scratch workspaces since 14d, each a
STATUS item: 181 (three surfaces reading wrong — watch's recorded
command, why's hit line, info's run count; PR #347), 182 (a cached
dependent of an uncached upstream misses twice, by design — pinned
with its gitignored control and said in caching.md, `vx why` and
the init TODO; PR #348) and 183 (the `vx info` sample is the verb's
output; PR #349). Open: Next 1, 2 and 16 as before, all gated; the
launch checklist's owner steps. The box: unchanged (four cores,
13.3 GiB leaf cgroup, no sandbox); the gate is
`scratchpad/gate-manual.sh`, which now defaults its output
directory to its own — one run wrote every step's output to `/`
because `S` was set but not exported. Methods that paid: the cheap
walk after an arc keeps paying (181 and 182 came from two of them);
the gate caught a pin my own `bunx oxfmt --check | tail -1` read
as clean — `oxfmt` prints its verdict BEFORE its `Finished` line,
so a tail of one line is always clean (the rule in CLAUDE.md now
says so). Never end with "what next?".

14f. **Handoff after item 189 (2026-09-16, small hours).** Six items
since 14e, PRs #351–#356, all from first-run walks that changed
persona each time: a typo'd verb is one line (184); the classes
behind the day's fixes grepped, a stale exit-form comment named
(185); the CI persona refuted nothing (186); the Turbo adopter's
preset header names the real tool (187); `vx lock` names the
projects it cannot freeze, from the unchanged-Turbo persona (188);
the Nx migration's cascade TODOs say what vx folds, never outputs
(189). Eight walks in all since 14d: seven fixes, one refutation.
`vx completions` read right for the three shells with the plugin
verbs in. Open: Next 1, 2 and 16 as before, all gated; the launch
checklist's owner steps. The box: unchanged (four cores, 13.3 GiB
leaf cgroup, no sandbox; the gate is `scratchpad/gate-manual.sh`
with `S` defaulting to its own directory). Methods that paid: a new
persona finds what a repeated one does not — the three adoption
surfaces (migrate from Turbo, run Turbo unchanged, migrate from Nx)
each gave one item after the core walks had gone quiet, so the next
probe should be a persona not yet walked (a plugin author on the
`commands` or `key` seam, a REAPI operator with the live services)
rather than a ninth core walk; every fix carried a differential pin
and a class grep, and the gate caught the one push made without
reading its exit. Never end with "what next?".

## In flight — the sandbox arc's closed items and the v0.0.18 release record

Moved out on 2026-09-16 with the rest of the record; In-flight 5 (macOS
violation reporting) and the launch checklist's owner steps stayed in
STATUS.

1. DONE 2026-09-09: `@vzn/vx-docs#build` on Linux CI, red since
   2026-09-05 with exit 1 and nothing on either stream. Not the
   telemetry EROFS recorded before (real, but not what exited), not the
   runner's Node. A diagnostic frame from CI (hooking `process.exit` and
   both rejection channels) said `Cannot find package 'yargs-parser'
from …/node_modules/astro/dist/cli/index.js` — astro's OWN
   dependency, unresolvable because the task's write grants under
   `node_modules` (`.astro/**`, `.vite/**`) made `punchWritePaths` bind
   node_modules' children one by one, and bwrap mounts a SYMLINKED child
   (every package in Bun's isolated layout) as the directory it points
   at, so astro sat in a plain directory with no `.bun/` siblings.
   astro's and vite's caches now live under `.astro/` (astro.config.mjs)
   and the grants follow; `punchWritePaths` warns, naming the grant,
   whenever a punch meets a symlinked entry. The build also runs under
   `bun --bun` (half the wall time; no dependency on the runner's Node)
   and the telemetry define stays.
2. DONE 2026-09-09, and the diagnosis was wrong: the four perf baselines
   did not fail from eight-way contention but from ptrace. The Linux
   sandbox wraps every task in `strace -f -e trace=openat`, and without
   `--seccomp-bpf` strace stops the tracee on EVERY syscall and filters
   in userspace, so a stat-heavy micro-benchmark ran 2.5–7× over
   budget. Reproduced outside the sandbox: plain `bun test` 24/24, the
   same four fail under strace, 24/24 again under `--seccomp-bpf`. The
   flag is on (strace ≥ 5.3; older gets the slow form), which also
   takes that tax off every other sandboxed task on Linux — the gate's
   `time 138s · max 89s` on the last run is the number to compare.
3. DONE 2026-09-10 (item 79): a sandboxed task exposes a port on Linux
   through `allow.localBinding: [port, …]` — a per-port socat pair over
   a unix socket in the sandbox tmpdir, the task's side in front of the
   command, the host's side released when the task exits. The arming
   went as this entry said (the unix-socket allowance from the run's
   union at `initSandbox`), and found the reason the first probe still
   died: on Linux the availability probe initializes SRT with an EMPTY
   config and `initialize()` returns early ever after, so the run's own
   call — the domain union included — never reached the runtime.
   `initSandbox` now hot-reloads the run's config (`updateConfig`).
   Was: macOS works and is properly gated; on Linux every sandboxed task
   gets `--unshare-net`, so nothing saw the port.
4. DONE 2026-09-09: persistent tasks run inside their `exec.sandbox`.
   `wrapSandboxedCommand` is the enforcement half of `runSandboxed` on
   its own and the persistent path spawns through it; the violation
   report stays one-shot only, since it reads the trace after exit and a
   server exits at teardown. `vx-docs`'s `dev` and `preview` blocks mean
   what they say now. Pinned in the unsafe suite: a sandboxed server that
   reads a workspace-root file sees the denial, the same server without
   the block reads it.

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

4. DONE tonight: the blog (item 115) with thirty posts for the
   announcement series (item 118), README and site numbers generated
   and checked, "Edit page" links that open the right file, LICENSE
   holder, SECURITY.md, CONTRIBUTING.md (item 116).

## Handoffs 14g–14i (moved 2026-09-16 with items 145–202)

14g. **Handoff after item 192 (2026-09-16, small hours).** Three
items since 14f: the plugin author's walk refuted nothing (190); the
agent's walk over the MCP wire gave `whyDidThisRerun` its default
run through a query the CLI now shares (191); and that PR's first CI
run exposed item 170's pin on a knife edge — a light child's
`ru_maxrss` equals the parent's mark by construction, the kernel's
RSS counters lag by pages, and an exact comparison flipped once in
twelve runs — so the floor has 4 MiB of slack now (192; the rule is
in CLAUDE.md). Ten walks since 14d: eight fixes, two refutations;
every persona this box can host has been walked once (the REAPI
operator with live services has not — no docker here). Open: Next
1, 2 and 16 as before, all gated; the launch checklist's owner
steps; no open issues. The box: unchanged. Methods that paid: read
a red CI job's own log before calling anything a flake — the failing
pin was in code the diff never touched, and it was still a real
knife edge, fixed with a differential pin rather than re-run; a
walk's refutation is written down (186, 190) so the next reader
changes angle. Never end with "what next?".

14i. **Handoff after item 202 (2026-09-16, early morning).** Five
items since 14h, three of them from walking the CI persona and the
maintainer through `.github/` rather than a scratch workspace: § In
flight cut to what is open (198); `--affected` in the two clone shapes
CI produces — a base that is HEAD itself is named, a depth-1 checkout
gets "a shallow clone?" instead of a `HEAD~1` nobody typed, and the
site's own recipe, which had the first shape on every push to main,
diffs against `github.event.before` now (199); the CI guide names
`@vzn/vx-github` (200); the release paragraph and the npm workflow's
header stopped claiming a token path the file lacks — 0.0.21 went
through the token-free workflow, so launch-checklist 1 is done bar
deleting a secret nothing reads (201); and the vx-cloud agent action,
a leftover of the removed product, is gone (202). The shard re-deal of
item 196 exposed a second deal-shaped edge on its third CI run
(`output-dirs`' 8,193-directory case against bun's 5 s default, bounded
by its work). Open: Next 1, 2 and 16 as before, all gated by their own
terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret,
the release cut, the site's address. No open issues. The box:
unchanged. Methods that paid: a persona's first REAL failure comes
from the environment it runs in (a single-branch clone, a depth-1
checkout), not from the verb's flags; read the CI job's own log before
calling a failure a flake, and read your own recipe with the same eyes;
a comment claiming behaviour the file lacks is a defect wherever it
sits, a STATUS line repeating it included. Never end with "what next?".

14h. **Handoff after item 197 (2026-09-16, small hours).** Five
items since 14g: the one dependency that had moved (193), this file
cut to a handoff again — loop items 105–144 and the Next list's
record to `docs/history/` (194, 195), 2,657 lines to about 1,300 —
and CI's wall time worked from its own job log: the core suite back
to the average shard (196: the watch-loop suite had grown to a shard
of its own; split three ways and re-weighed, the run 52 → 35 s here,
and the re-deal exposed an RSS pin that trusted the alphabet), then
the REAPI suite's 15 s wait pinned on the instance instead (197).
CI's three jobs, #362 → #364: lint·format·test 2:19 → 1:42, plugin
packages 1:18 → 0:51, core tests (macOS) 2:07 → 1:33. Next 6 duty,
this box, `run.ts` medians of 5 after the day's merges: 100 projects
112 ms warm / 158 restore / 380 cold; 1,000 projects 237 / 744 /
2,520 — the warm rows on 2026-09-10's (123 / 240), the restore row
at 1,000 well under it (1,163; the usage sidecar and the restore
lane since). No warm-path code moved today beyond item 192's compare.
Open: Next 1, 2 and 16 as before, all gated by their own
terms; no open issues; every persona this box can host has been
walked. The box: unchanged. Never end with "what next?".

## Handoffs 14j–14p (moved 2026-09-16 with items 203–242)

14j. **Handoff after item 208 (2026-09-16, morning).** Six items
since 14i, all from one persona taken one step further each time:
the root-in-a-container box, where the sandbox refuses to nest, got a
`sandbox` row in the doctor (203) and then an unprivileged user
(`probe`), which turned the docs' first remedy into a fact (204) and
the box into a host for the whole sandboxed gate — `vx run ci --all`
with the sandbox required, 44 of 44, the unsafe set 78 pass (205; the
session's manual gate runs the unsafe step that way now). Walking as
that user found the class the walk was for: three touches of a tree
the process may not write — the clean (206), the restore (207), and
the cache directory itself (208) — each an "internal error" before,
each a `UserError` naming the path and the remedy now, each pinned on
a 0o500 directory, skipped as root and proven both ways as `probe`.
Merged as #372–#375; 208 rides the next. Refuted on the way: a trial
write under WAL proves nothing about a read-only cache (208), and
`chmod 500 .vx` alone proves nothing either (207). Open: Next 1, 2
and 16 as before, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The box: a `probe` user, a copy of
bun at `/opt/probe-bin/bun`, `HOME=/tmp/probe-home`; the traps are
in 205 (bun's per-build `node` shim under `/tmp`, owned by whoever ran
first — remove root's before a non-root run). Methods that paid: a
persona is worth a second and third step, not one; grep the class of
a fix by walking it, not by reading (207 and 208 were not in the code
206 touched); a probe that passes for the wrong reason is caught by
running it without the fix (208's first two probes passed on the old
code too). Never end with "what next?".

14k. **Handoff after item 211 (2026-09-16, morning).** Three items
since 14j, the same walk carried to the tree's other refusals: the
readers open an unwritable cache read-only and go on (209, the
file-hash memo took the write axis it had ignored); a read-only
checkout with no cache yet, and the verbs that write the tree, print
one line naming the path instead of a stack — the file system's
refusal is a `UserError` at the CLI's top level and in the scheduler,
one rule for every write nobody wrapped (210); and a full disk, which
a 2 MiB tmpfs makes hostable here and on CI, is reported the same way
at the restore, and a run whose history cannot be written keeps its
verdict (211; `disk-full.test.ts` behind `VX_SMALL_DISK`, mounted by
CI's Linux job and the manual gate). Merged as #377–#378; 211 is
#379. Refuted or retired on the way: a doctor that prints partial
facts on an uncreatable cache directory (declined under 210 — its one
line is the diagnosis); the pin that made a record throw reject the
run (it asserts the line now). Next 6 closed the day at a tie (under
210). Open: Next 1, 2 and 16 as before, all gated by their own terms;
In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret, the
release cut, the site's address. No open issues. The box: as 14j,
plus `mount -t tmpfs` works here as root (the small disk). Methods
that paid: a persona's refusals come in kinds (permission, space) and
each kind has three sites (clean, restore, record) — walk the grid,
not the first cell; a claim in STATUS ("the readers keep working") is
a test to run before it is a sentence to keep (209 came from testing
208's last line); when a fix retires a pin, the pin's claim usually
survives in another shape (close still runs) — keep the claim, change
the shape. Never end with "what next?".

14l. **Handoff after item 214 (2026-09-16, mid-morning).** Three
items since 14k, each found by the machinery rather than a persona:
the prune verb was the last writer that opened the cache without
asking (212, #379); a gate stopped mid-run left the runtime's mux
sockets in `/tmp` and a recycled pid met `EADDRINUSE` — vx unlinks a
dead process's sockets under its own pid before the runtime listens
(213, #380); and the shard deal, weighed as root, had never counted
the cases that skip as root — re-weighed as the unprivileged user, the
deal predicts 11.2 s per shard and CI's Linux job fell 2:04 → 1:33
(214, #381), exposing on the way one more deal-shaped pin, fixed the
way 192 was. Refuted or left: partial artifacts (the orphan sweep
reaps them), the runtime's own temp directories, the MCP server's
and `vx watch`'s handling of a refusal (both right as they are), a
doctor that prints partial facts. Open: Next 1, 2 and 16 as before,
all gated by their own terms; In-flight 5 (macOS); the owner residue
— the `NPM_TOKEN` secret, the release cut, the site's address. No
open issues. The box: as 14k, plus the manual gate runs its shards
and its unsafe set as `probe`, mounts a 2 MiB tmpfs for the disk-full
suite, and clears stale `srt-mux-*.sock` first; `/tmp` swept of 6,537
leaked fixtures. Methods that paid: a gate's own failure is an item
(213); weights measured as the wrong user are a deal nobody dealt
(214); reproduce a deal-shaped pin in the shard's exact company, not
alone, and fix it there. Never end with "what next?".

14m. **Handoff after item 221 (2026-09-16, midday).** Seven items
since 14l. Two closed the concurrent-runs persona: the restore that
another run's clean interrupts is named, not a corrupt artifact (215,
#383), and two runs on one workspace take turns through a per-run
`mkdir` lock keyed on the resolved root (216, #384; Next 19 closed as
per-run, the per-task grain a refinement). One trim (217, #385:
145–202 and the 2026-09-10 records to history). Then a new persona — a
workspace under a path with a space, as `probe` — whose own probe
config found three traps the path did not: a literal sandbox write
grant on a not-yet-existing path is bound as a FILE, so `mkdir -p dist`
died with "File exists" and the file poisoned every later run — a
directory is spelled `dist/` now, vx sweeps the placeholders it made,
and the failure names the spelling (218, #386); `outputs: ['dist/**']`
was `unknown field "0"` — an array at any object level names the shape
and the spelling meant (219, #387); `vx info` counted a config that
does not load as zero tasks in silence — `configErrors` names it (220,
#387). Last, the persona after that one: a project inside a submodule
or embedded repository had an EMPTY slice of the workspace-wide
enumeration and a key that never moved — a stale hit under a green run;
an empty slice stores no partition now and the project's own git
enumerates it (221, rides the next PR). Refuted on the way: reading
gitlinks out of the listing (it is pathspec-scoped to the project dirs,
and a gitlink above a project never appears under its pathspec). Open:
Next 1, 2 and 16 as before, all gated by their own terms; In-flight 5
(macOS); the owner residue — the `NPM_TOKEN` secret, the release cut,
the site's address; `workspaceFiles` still stops at a nested repository
(`--affected` follows it since 222; recorded in `modules/git-inputs.md`). No open
issues. The box: as 14l; the persona probes live in
`/tmp/probe-home/probe-*.sh` and run as `probe`. Methods that paid: a
probe script's OWN mistakes are findings — three of the seven came from
the config I wrote wrong before the persona even ran (218–220); a stale
hit is found by editing every input and reading every output back,
never by the status line — "the key will not change" prints under a
green run, and a persona reading the exit code alone misses it (221);
when a listing is scoped, detect by what is absent from a slice, not
by what the scope would have to include. Never end with "what next?".

14n. **Handoff after item 225 (2026-09-16, afternoon).** Four items
since 14m, plus a measurement. The nested-repository persona closed:
`--affected` selects every project under a repository git reports
changed — the gitlink, or the untracked `dir/` (222, #389) — and the
rule reached the user docs (225, #392). Then the box's own litter:
a census of `/tmp` found 1,333 `vx-*` entries after the day's gates —
658 of them the run lock's directories, whose release was fired and
forgotten at close and lost the race with the CLI's exit every time
(223, #390: awaited now), the rest test fixtures without a cleanup
(224, #391: the plugin helper's per-process root carries its pid and
the next process sweeps the dead ones, the way the lock reclaims;
`bun test` fires neither `exit` nor `beforeExit`, measured). Recorded
without building: a task's captured output has no cap — 200 MB of
stdout is 620 MB of RSS on the miss and every hit and a 193 MB row —
an outlier's cost, Next 20 with the design. Refuted: an unignored
`node_modules` of 11k files (5 ms of a warm run); a git worktree, a
duplicate project name and a task-name typo all handled. Next 6: 5,000
projects at 687 ms warm, every stage 3.4–3.9× for 5× the projects,
nothing super-linear. Open: Next 1, 2, 16 and 20, all gated by their
own terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN`
secret, the release cut, the site's address; `workspaceFiles` stops at
a nested repository. No open issues. The box: as 14m; the census after
a full gate is the lock directories of runs the kill tests kill and the
plugin roots of the last shard processes, both reclaimed by the next.
Methods that paid: count what a day leaves behind — the census found a
bug in the day's own feature (223) that its pins could not, because a
pin lives in the process that the bug needs to exit; a chain that
greps a verdict swallows its exit — read the exit (twice today the
gate caught what the chain passed); a numbered Next entry goes at the
END of the list or the formatter renumbers it (third time). Never end
with "what next?".

14o. **Handoff after item 230 (2026-09-16, late afternoon).** Five
items since 14n. The site's introduction states vx's known limits
together (226, #394: launch checklist 6, done). The persistent path
got 218's placeholder sweep and the `dir/` line on a readiness failure
(227, #395). The shard deal was re-weighed after the day's suites —
four files sat at the median, the run-lock e2e among them — and the
local shards run 11.7–15.0 s again (228, #396). Next 20 closed: a
task's retained output is bounded to a head and a tail with the
dropped middle named — the hit 620 → 109 MB of RSS, the cache 193 → 17
MB on the 200 MB probe; the miss's 652 MB is the logger's frame
buffer, whole by contract, `--output-logs none` its remedy (229,
#397). That PR's macOS job found the run lock's last window: two runs
open the cache before either holds the lock, and the busy timeout was
set after the journal-mode pragma (230, rides #397). Probed and clean: `vx watch` on a submodule workspace re-runs
once on an edit inside it; a hidden sandbox runtime; the CI Linux job's
per-task table (its 39 s shard was contention with the 37 s docs build
on four workers, not the deal alone). Open: Next 1, 2 and 16, all
gated by their own terms; In-flight 5 (macOS); the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address;
`workspaceFiles` stops at a nested repository. The loop holds 27 items
(203–229): the record paragraph's forty is the trim's trigger. No open
issues. The box: as 14n. Methods that paid: when a bound fixes one
number and not another, name which retention the other is (229's miss
is the frame buffer, and saying so kept the item honest); a pin that
asserts the old design's cost (retention MUST grow) is the pin the new
design must reshape, not delete — its differential survives as "must
not cost the volume"; a chain that greps a verdict swallows its exit,
still. Never end with "what next?".

14p. **Handoff after item 236 (2026-09-16, evening).** Six items since
14o, all personas. A reader that leaves the pipe (`| head -1`) no
longer kills a green run: `bin.ts` listens for `error` on stdout and
stderr (231, #399). The symlinked-outputs contract held as documented
and its refusal now names a remedy the schema accepts (232, #400).
`vx upgrade` verifies the release API's SHA-256 before the rename and
refuses a binary npm owns (233, 234, #400–#401; proven live with a
scratch binary against v0.0.21); the README's install row says what
exists (235, #401). Last, `exec.timeout` and `retries` walked as a
persona found the runner's oldest residual: a task's grandchildren
survived every kill — every task is its own process group now, killed
as a group, and SIGHUP is handled (236, rides the next PR). Refuted or
clean on the way: every MCP tool and the read verbs during a run; a
task running `vx run` on its workspace; `--affected` on a depth-1
checkout; undeclared and declared env through a cached task; the
migration mappers' env. Open: Next 1, 2 and 16, all gated by their own
terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN`
secret, the release cut, the site's address (an install script waits
on it); `workspaceFiles` stops at a nested repository. The loop holds
34 items (203–236): the trim's trigger is forty. No open issues. The
box: as 14o. Methods that paid: a persona's second shape is where the
finding is (the timeout read right; its grandchild did not); a marker
pid must be the INNER shell's `$$` — single quotes — or the
differential passes on the old code for the wrong reason; Bun's
`detached: true` exists and is a session, so the terminal's SIGHUP
needs forwarding the moment you use it. Never end with "what next?".

## Handoffs 14q–14v (moved 2026-09-16 with items 243–281)

14q. **Handoff after item 240 (2026-09-16, night).** Four items since
14p. `vx watch` no longer re-runs on a git-ignored path and names a
file the cycle rewrites every run (237, #403 — its macOS job taught the
streak to read the path's mtime, its Linux job replaced the run-lock
e2e's head start with a marker). Three configuration personas (238,
#404): `vx info` names a broken config once, an empty workspace hears
about its globs, and two gate findings rode along — the plugin
helper's sweep skips a root it cannot remove, and a fixture with no
`node_modules` made Bun auto-install a missing import from the
registry, which became Next 21 and then item 239 (#405): a config's
bare import nothing provides is refused before evaluation. Its cost,
measured after the fact, was 130 ms per 1,000 cold configs; 240 took
it to a tie (one transpiler per loader, a textual pre-filter). Measured
and clean on the way: the renderer on a 200,000-line task, the
detached spawn of 236, every MCP tool during a run, a task's own env
variables (documented), watch with `--affected` (the same refusal as
run). Open: Next 1, 2 and 16, all gated by their own terms; In-flight
5 (macOS); the owner residue — the `NPM_TOKEN` secret, the release
cut, the site's address (an install script waits on it);
`workspaceFiles` stops at a nested repository. The loop holds 38 items
(203–240): the trim's trigger is forty. No open issues. The box: as
14p; a root-run local suite leaves plugin roots the `probe` shards
cannot remove — sweep `/tmp/vx-plugin-pkgs-*` as root before a gate.
Methods that paid: a cost measured after shipping is still a cost —
the A/B belongs in the item, not the handoff; a same-tree stub A/B
isolates one function's cost from every other difference between
arms; when medians and mins disagree, the spread is the finding, and
the micro-benchmark decides what the number can be. Never end with
"what next?".

14r. **Handoff after item 242 (2026-09-16, night).** Two items since
14q, one persona carried on (a minimal image): a machine without git
gets one line at every git site (241, #407), and one without `sh` sees
why its task failed, inside the frame (242) — the runner's
spawn-failure text had no reader, and `runner.md` claimed it did. The
gate on 241 found the restore-interruption test's deleter losing its
race under load (2 in 60; a synchronous sweep now, 0 in 60; recorded
under 215). Items 203–242 moved to
`docs/history/2026-09-improvement-loop-203-242.md` with handoffs
14j–14p to the next-log file; the loop starts again at 243. Open:
Next 1, 2 and 16, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The box: as 14p. Methods that paid: a
result field nothing reads is a claim, not a channel — find the
consumer before trusting the doc; a race test's other process must
strike inside the window by construction, never by polling; a
persona's next missing binary is the next item. Never end with "what
next?".

14s. **Handoff after item 252 (2026-09-16, late morning).** Ten items
since 14r, merged as #409–#415, from two lenses walked to their ends.
The minimal image: a temp directory that is missing or not writable
names TMPDIR in the sandbox verdict and the run-lock line, and a
socket path past `sun_path` is refused up front with the limit (243,
the darwin job taught the second shape); the `cache.inputs.runtime`
probe names the shell (244); the sandbox's three Linux dependencies
and the install (246 — the docs had named two); `vx upgrade` with no
route names the host (247); a root without `workspaces` beside
packages full of scripts names them and the glob to add (248). The
CI container was clean and is pinned end to end (249). The plugin
author: a malformed executor result (251) and a remote layer's wrong
shape (252) are named as the plugin's bug, never a TypeError or a
corrupt artifact. Housekeeping: the day's warm-path A/B, a tie (245);
oxfmt, oxlint and the sandbox runtime current, two REAPI majors left
(250). Open: Next 1, 2 and 16, all gated by their own terms; In-flight
5 (macOS); the owner residue — the `NPM_TOKEN` secret, the release
cut, the site's address. No open issues. The box: as 14p; a manual
`su probe` needs `PATH=/opt/probe-bin:$PATH` or the sandboxed server
task's `bun` is not found and the port-bridge tests fail for the
invocation, not the code (250). Methods that paid: a runtime's own
error text is a path and no knob — name the knob; a walk of one
persona's missing pieces (git, sh, tmp, deps, network, globs) finds
one item per piece, and each item's class is grepped in the same
commit; a probe that confirms a thesis becomes a pin with a control
that proves the pin can fail; a seam's resolved value is a boundary
like its factory's. Never end with "what next?".

14t. **Handoff after item 263 (2026-09-16, midday).** Eleven items
since 14s, merged as #416–#424. One persona walked to its end — the
reader of a failure — and the shard weights refreshed on the way
(253). The shell's own line on exit 127 and 126 names the word and
nothing about why: the PATH vx built (257), the file itself — missing,
a directory, no execute bit, a CRLF or missing `#!` interpreter, no
`#!` line (258; macOS's bash 3.2 names a bad interpreter itself and
exits 1, pinned per platform) — and above 128 the signal and its usual
sender, the OOM killer, a crash in native code, an abort, a closed
pipe (259). The second-day reader then: `vx last` (260), the GitHub
job summary (261, `exitSignal` on the façade by the rule
`escapeMarkdownCell` set) and one `failedLabel` for the frame footer,
the status line, the run report and the Actions annotation (262). The
day's warm-path A/B is a tie (263). Open: Next 1, 2 and 16, all gated
by their own terms; In-flight 5 (macOS); the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 21 items (243–263): the trim's trigger is
forty. The box: as 14p; `git cherry-pick` has no `-q`, and a chain
that assumed one stopped before its push (260) — check `git status`
after any chain that a usage line could break. Methods that paid: a
shell's exit code is three shells' conventions, not one — dash, bash 5
and bash 3.2 each got a probe before the pin; a line that names a
cause must read the evidence (the file, the runner's signal) or say
"or the command exited so itself"; a number rendered on four surfaces
is one function or it drifts; a differential's name filter must match
every pin it counts (a `-t` that matched one of two read as a broken
fix, 260). Never end with "what next?".

14u. **Handoff after item 270 (2026-09-16, afternoon).** Seven items
since 14t, merged as #425–#431, one class walked to its end: the
reason a task failed rides the outcome and every surface reads it.
First the docs that show what a reader sees: the plugins guide names
the façade's sink helpers in a type-checked block (264) and the CI
guide's job summary is the renderer's real output with a pin that
renders the same run (265; the guides' other two samples matched). Then
the reader of a skipped task: a Skipped footer section (266) and the
root blocker recorded on the outcome for the summarize row, the
telemetry record, the GitHub callout and the OTel span (267 — the OTel
losslessness tripwire refused the field until it was mapped, as it
should). Then every other reason the one `failedLabel` read as a bare
number: vx's own timeout (268), sandbox violations (269, where the
OTel guide had promised an attribute the plugin lacked), and a
persistent task that never became ready (270, a typed
`PersistentReadyError` and the child's real exit code). Each rides the
outcome as an additive telemetry field; the `runs` table carries none
of them, since a column is a `SCHEMA_VERSION` bump that resets every
local cache — the day one is worth it, they all go in together. Open:
Next 1, 2 and 16, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The loop holds 28 items (243–270): the
trim's trigger is forty. The box: as 14t; a Python edit script asserts
on anchors the formatter has since reflowed — every write after the
failing assertion is skipped while the earlier ones land, so check
`git status` and re-run from the failure (twice today). Methods that
paid: a claim in a guide ("the span carries X") is grepped in the
plugin before it is trusted; a made-up exit code (a skip's 1, a
never-ready 1) is a lie the label repeats on every surface — carry the
reason and the real code; the same one function on every surface is
what makes a class of fixes a class; a differential's guard reads
bun's summary line, not its per-test lines. Never end with "what
next?".

14v. **Handoff after item 275 (2026-09-16, early afternoon).** Five
items since 14u: 271 and 272 rode #431 with it, 273–275 merged as
#432–#434, and the reason class closed on its last three surfaces.
The `runs` table took the four reasons in one `SCHEMA_VERSION` bump,
`v26` → `v27` (273: `blocked_by`, `timed_out`, `sandbox_violations`,
`not_ready`; `vx last` ends a row with the reason, an agent's
`getRunHistory` row carries the fields with its exit code), the bump's
warm-path A/B is a tie (274; one workspace copy per arm, since arms on
different schemas reset a shared one), and the skipped row names its
blocker (275: `• blocked by lib#build` on the one-liner, `skipped
(blocked by …)` in the block and the report, `blockedBy` on the wire
outcome; the frame's old header claimed "upstream failed", false under
fail-fast, from a branch no logger path reached). Open: Next 1, 2 and
16, all gated by their own terms; In-flight 5 (macOS); the owner
residue — the `NPM_TOKEN` secret, the release cut, the site's address.
No open issues. The loop holds 33 items (243–275): the trim's trigger
is forty. The box: as 14u; a table cell one character wider than its
column is a format failure the scan names and `oxfmt --write` fixes —
never realign by hand; a differential's `-t` is a substring, and
`blocked` missed two pins named "blocker" (275) — count the pins the
run lists, not the filter's intent. Methods that paid: a label on a
branch no path reaches is still a claim, and its test the only reader
— grep the callers before trusting a surface; the day a column is
worth a schema bump, every column waiting goes in with it (273); a
type that carries every reason but one is where the wire consumer
loses it (`OutcomeView`, 275). Next: a second first-run walkthrough
(`vx init` → `run` → `why` → `last` → `info` on a fresh workspace, the
current binary), twelve days and 260 items after the first (item 9),
with the reason surfaces read as a newcomer would. Never end with
"what next?".

## Handoffs 14w–14y (moved 2026-09-16 with items 282–305)

14w. **Handoff after item 281 (2026-09-16, afternoon).** Six items
since 14v, merged as #436–#440: the second first-run walkthrough
found nothing to fix (276) and then read each page against the
renderer it describes — the broad-run sample (277), the frame
anatomy (278) and the status-line doc's phantom Failures zone (279)
had each drifted, and two byte-for-byte pins now hold the first two;
the reader at scale (a thousand projects, one leaf broken) found
`vx last` a thousand rows deep with the failure at the top (280,
hits fold past sixteen) and the Skipped section naming groups no
other counter counts (281). Open: Next 1, 2 and 16, all gated by
their own terms; In-flight 5 (macOS); the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 39 items (243–281): the trim's trigger is
forty, so the item after next moves 243 onward to history. The box:
as 14v; #440's first head went red in `test.bun.shard-4`, a shard
holding none of its files — the Actions API serves at most the last
five thousand log lines, which stop short of an early shard's
section, the blob host the full log lives on is denied by the
egress proxy, and the run uploads no artifacts, so a CI failure in
an early shard cannot be named from here; three local runs passed,
and with no re-run tool the one legitimate re-run was the push of
the next real change (281), after one comment on the PR saying so
— it came back green. A chain that ends in a subshell whose last
command is a grep passes whatever the scan said (the STATUS span
that wrapped in 280 was committed that way and amended); capture
`rc=$?` before the grep. Methods that paid: a page that describes
output is read against the renderer, not against memory (277–279);
a probe at scale asks what two packages cannot (280); the counter
every other surface excludes is the one to check in a new surface
(281). Next: the trim after the next item, then a persona not yet
walked — the inner loop, `vx watch` through a failing edit and the
fixing one, with the reason surfaces read as they cycle. Never end
with "what next?".

14x. **Handoff after item 287 (2026-09-16, mid-afternoon).** Six
items since 14w, merged as #442–#446 with #446 open: the watch
persona read right (282) and the loop was trimmed to history; the
READMEs' counts corrected and the hook count pinned across the project
boundary (283); every config block on the site compiled, three pages
fixed (284); the day's warm-path A/B a tie (285); the package READMEs
probed and their pin declined with the reason (286); and `--affected`
changed to include dependents (287) — the reference documented the
changed-only form with a rationale while two guides and the flag's
name promised dependents, so an adopter's gate never ran a dependent's
tests; a Decisions entry records the call and the parity table's `≠`
row is closed. Open: Next 1, 2 and 16, all gated by their own terms;
In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret, the
release cut, the site's address. No open issues. The loop holds six
items (282–287) after the trim. The box: as 14w; a Python edit script
that writes files before its last assertion leaves a half-done tree
when that assertion fails, and a chain gated on the scan and the tests
committed it (the trim, twice in one turn) — gate the chain on the
script's own exit and make every write idempotent; an item inserted at
the blank line after the last item lands BEFORE any item that follows
it, so a cut "to the next item" misses the one you just wrote — count
what the cut holds before writing the file; a type-checker pointed at
a directory holding a symlinked `node_modules` walks it until the
kernel kills it — name the files; the shard-4 flake of #440 has a name
now, `task-tree-kill`'s "a timeout reaps the grandchild", a 300 ms
window a loaded macOS runner outran (#445), two seconds since; a probe
whose negative case contains the positive's needle ("broken" holds
"ok") proves nothing — check the negative case before reading the
result. Methods that paid: the pages a newcomer copies from are
compiled, not read (284); a divergence a parity suite pins as
documented is still a divergence the guides may contradict — read the
guides against the suite, not the reference alone (287); a CI failure
you cannot name gets its name from the next occurrence — keep the
shard's file list. Next: the lockfile persona — a dependency bump under
`bun()`, `vx why` naming the claim and `--affected` following it — and
`vx init` on the walkthrough repo after 287, to read what the TODO says
about `--affected` now. Never end with "what next?".

14y. **Handoff after item 293 (2026-09-16, late afternoon).** Six
items since 14x: the lockfile persona read right (288, #447); the CI
guide's two sentences and CLAUDE.md's four rules (289); the
`--affected` "changed only" wording swept from six more surfaces and
the anchor sweep it started (290); every relative link a law, the
README's `../packages/vx-reapi` 404 (291); all thirteen hooks named
in the README's § 5 and CLAUDE.md, pinned (292); the overview page
read whole against source — four stale claims, two pins (293).
289–293 are #448, open. Open: Next 1, 2 and 16, all gated by their
own terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN`
secret, the release cut, the site's address. No open issues. The loop
holds twelve items (282–293). The box: as 14x; a separator you
printed (`echo ----`) reads as file content in the same scroll — a
pin built on it found no `---` in the file (293's first run); a
Markdown line that wraps onto "+ …" is a bullet to the formatter and
a one-item list on the site (the README's plugin sentence, live for
weeks); github-slugger keeps a flag's dashes, so a `--flag` heading's
id has three hyphens and a link with one misses silently; the site's
content directory is outside oxfmt's targets (`rc=2`, "no target
file") — its pages are never format-scanned, so a wrapped code span
there is on you. Methods that paid: when two claims in one page go
stale, read the page whole against source before moving on (290 and
292 → 293 found four more); a law found for one shape is widened to
its class the same day (anchors → every relative link, 291); the
build output on disk (`dist/`) is the oracle for what a link
resolves to, cheaper than a rebuild. Next: the two pages the overview
sends a ten-minute reader to, `comparison.md` § Where vx is ahead and
`architecture.md`, read the same way — every claim against source,
the numbers against benchmarks.md, the pins where a count or a list
lives in prose. Never end with "what next?".

## Handoffs 14z–14ad (moved 2026-09-16 with items 306–332)

14z. **Handoff after item 299 (2026-09-16, evening).** Six items
since 14y, the read-against-source series: architecture.md's nine
stale claims and six pins, comparison.md § Where vx is ahead found
true (294, #449); the telemetry page's version quote and the cloud's
2.6 MB of screenshots removed (295, #449); execution.md's nine and
two pins (296, #450); flows.md and patterns.md, the citations turned
from `file:line` to file + phrase and pinned (297, #451); caching.md's
schema block, five of ten tables missing, pinned to the source (298,
#451); schema.md's `plugins` bullet, ten of thirteen hooks and
backtick soup on the site, and history.ts's header (299, #452, open).
Open: Next 1, 2 and 16, all gated by their own terms; In-flight 5
(macOS); the owner residue — the `NPM_TOKEN` secret, the release cut,
the site's address. No open issues. The loop holds eighteen items
(282–299); the next trim moves 282–299 to history when 14z's
successor lands. The box: as 14y; quoting broken markup inside STATUS
breaks STATUS — an unbalanced backtick un-indents the item under the
formatter (299, first try; describe the breakage, never paste it); a
slash-separated list escapes a backtick grep, so a class grep names
the words too (296 found the dispatch list 294's grep missed); the
formatter's verdict names the file on the line above "Format issues
found" — a chain can read it and reformat that file (299); a comment
block above a `CREATE TABLE` stacks silently when a table is inserted
between them (cache.ts's `output_dirs` comment sat above
`config_closures`, 298). Methods that paid: a page is read in the
order a reader is sent to it (the overview's "Where to start" table),
whole, every claim against source, the numbers against
benchmarks.md; every list in prose with a source gets a pin the same
commit, and every pin its differential; a `file:line` citation is a
lie in waiting — cite the phrase and pin the phrase. Next: the last
reader pages the same way — cli.md against the help text and the
verbs' parsers (1,900 lines; the drift pins cover the samples, not the
flag tables), comparison.md's flag and schema maps against Turbo and
Nx's current docs, benchmarks.md's prose against its own tables — and
then the site's guides (running-tasks, remote-caching, sandboxing,
plugins) against source the same way. Never end with "what next?".

14aa. **Handoff after item 305 (2026-09-16, evening).** Six items
since 14z, the read-against-source series finished: cli.md's flag
table against the parser and `vx help` (four flags the help never
named, 300); benchmarks.md's two contradictory 46-package tables
(301); the site's seventeen guides in three passes (302–304: the
run-flags table's `--force` claim, `--graph` as text in three places,
the dev-server teardown, the env allowlist, the reapi "in time,
executor", and one wrong call, the "64 KB retry" that does exist,
corrected in 311); and the
introduction, migration and concept pages (305: a botched splice on
the front page, `admit` missing from the table, `nx affected` still
mapped to the changed-only filter). 300–301 went in #452, 302 in
#453, 303 in #454, 304 in #455, 305 in #456 (open). Open: Next 1, 2
and 16, all gated by their own terms; In-flight 5 (macOS); the owner
residue — the `NPM_TOKEN` secret, the release cut, the site's
address. No open issues. The loop holds twenty-four items (282–305);
the next trim moves 282–305 to history. The box: as 14z, and the
same lesson three times in one evening — an entry that quotes broken
markup, or lets a code span wrap onto a continuation line, breaks
STATUS under the formatter, and a chain that prints the scan's
verdict instead of gating on it commits the breakage (299, 304, 305:
describe the breakage in words, gate every chain on `rc`); oxlint
refuses a path with `..` — lint a sibling package's file from that
package's directory (305); a `--dry` sample that already matched
still earned its pin, and rendering it found the formatter's own
docblock wrong (302) — render the sample even when it looks right.
Methods that paid: the series' yield held to the last page (fifty-odd
stale claims over eleven items, a pin behind every list), and the
cheapest probe of a page is its own build output (`dist/`) or its
own formatter (`formatPlanText`, `renderJobSummary`), never a
re-read. Next: the trim (282–305 to history, the record paragraph
and the pointers); then Next 6's re-measure is due only when warm-
path code moves (none did this evening); then the design/ pages are
dated records and stay, but `docs/modules/*.md`'s "Public surface"
blocks are the one doc class this series never read against source
— a pin that each block's exported names exist in the module is the
same law as the inventory pins, forty pages wide. Never end with
"what next?".

14ab. **Handoff after item 312 (2026-09-16, evening).** Seven items
since 14aa: the trim (306: 282–305 and 14w–14y to history, STATUS
from 800-odd lines to 472); the module pages' "Public surface"
blocks as a law (307: four stale of 247 names, the pin maps each
page to its files through the index); comparison.md's flag map,
gap audit and running list (308–309: the retired
`--excludeDependencies`, `prune` and `migrate` still "in core", five
of thirteen hooks named); optimizations.md's citations (310: every
one module-qualified now, a bare basename refused); the one
correction of a correction (311: 304 struck the remote-execution
guide's upload retry as a Bun 1.3 leftover and it is live code — a
grep for `retry` that missed `retries`); and the three site pages the
series had never read (312: a hit glyph no source prints, `--graph`
"text or DOT", a divergence #446 had closed). 306–310 went in #456,
311 in #457, both merged; 312 is #458 (open). Open: Next 1, 2 and 16,
gated by their own terms; In-flight 5 (macOS); the owner residue —
the `NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 306–312. The box: a negative grep is a claim
about every spelling of the word (311; CLAUDE.md has the rule); an
edit script that fails to parse writes nothing, and the chain after
it read a clean tree as "differential fails: 0" — the script's exit
and the stash's "No stash entries found" were both in the output,
read the whole output before the verdict line (311); the repo root
is outside `lint.oxfmt`'s scan, so a wrapped code span in CLAUDE.md
sat unflagged until a root scan (311); a rendered sample is only
half the method — grep the source for the glyph a page shows, and a
glyph that appears in no source file is the finding (312). Methods
that paid: re-reading a correction against the source it corrected;
merging a green PR by API while the local gate runs on the next item
(the queue stays one deep at no cost); `git log -1` on a module page
against its source lists the pages whose module moved after the page
was last touched — the probe for the next item. Next: those module
pages, prose against source, starting where the gap is widest
(plan-format, run-report, events, cli-cache, inputs, scheduler,
prepare, summary, cli-help); then Next 6's re-measure only when
warm-path code moves (none did today); the blog posts are dated
records and stay. Never end with "what next?".

14ac. **Handoff after item 319 (2026-09-16, evening).** Seven items
since 14ab, one method: `git log -1` on each module page against its
source lists the pages whose module moved after the page, and 313–319
read them three at a time, widest gap first — plan-format, run-report,
events; cli-cache, inputs, scheduler; task-hash, prepare, metrics;
cli-help, summary, cli-run; filter, env, deferred-outputs; migration,
remote-prefetch, history; run-context, telemetry-host, config-cache.
Twenty-one pages, forty-odd stale claims (a fallback file walker and
an `ignore` library that no longer exist, a hard-coded cache dir the
verb resolves, a `TaskOutcome` block with half its fields, samples no
formatter prints, a spawn the code avoids), and the law that came out
of it: `tests/module-shape-drift.test.ts` holds a page's interface
blocks to the source's top-level fields (twenty-six shapes), and a
quoted constant or regex to the source (the always-ignored globs, the
env allowlist, both size parsers, the CI matrix, the impurity list
parsed from `IMPURE_RE` itself, the history window). 313 went in
#459, 314 #460, 315 #461, 316 #462, 317 #463, all merged; 318 is #464
(open) and 319 stacks on it. Open: Next 1, 2 and 16, gated by their
own terms; In-flight 5 (macOS); the owner residue — the `NPM_TOKEN`
secret, the release cut, the site's address. No open issues. The loop
holds 306–319. The box: the shape law's own parser was wrong twice in
one item (318: `//` stripped before `/*` ate a docblock's close, the
reverse let a `/*` inside a line comment open a phantom block — take
whichever opener comes first), and a two-field interface tripped its
"more than two" guard (319) — a law's own helpers earn the same
differential as the claims; an edit script whose assertion fails
mid-way has already written every earlier substitution (319: the
remainder went in a second script — the first script cannot re-run,
its early asserts now fail on their own work); a read started beside
`git checkout -B` saw a missing file (318: run reads after the restart
returns, never in the same turn); the formatter un-indented a code
span wrapped across a numbered list's continuation line (318,
remote-prefetch) — the STATUS rule holds for every page. Methods that
paid: the gap probe as a queue (seven items with no search); render
the sample even when it matches (316: the footer matched, and is
pinned); a page with no surface block is the cheapest find of all.
Next: the gap list's tail — placement, hit-restore, miss-save,
options, lockfile, plugin-commands, admission, sandbox-request,
git-inputs, upgrade, cli-watch, util-errors, logger (one to four
commits each); then the pages the probe cannot see — a page written
stale under a module that has not moved since stays stale, so the
remaining forty by oldest page first; then Next 6's re-measure only
when warm-path code moves (none did today). Never end with "what
next?".

14ad. **Handoff after item 326 (2026-09-16, night).** Seven items
since 14ac. The gap probe's queue ran out at 323 (320–323: placement,
hit-restore, miss-save; options, lockfile, plugin-commands; admission,
sandbox-request, git-inputs; upgrade, cli-watch, util-errors, logger)
and the oldest-page queue began (324–326: cli-format, colors,
dependency-spec; download-policy, local-shortcircuit, nested-dirs;
plan, tally, upstream). Twenty-two more pages; the finds of the day:
a persistent task the page said is pinned local and the code does not
place at all, a `RunOptions` block naming twelve fields of
twenty-nine, a planner the page said bumps `accessed_at` with a
`cache.get` it does not call, a status line described as one line
where the code renders a region, a "single `git rev-parse` spawn" the
code avoids, a fallback walker that no longer exists, an O(n²) walk
replaced by a sort. `tests/module-shape-drift.test.ts` holds seventy
shapes, six constants and regexes, three rendered samples and one
parser's error set. 320 went in #466, 321 #467, 322 #468, 323 #469,
324 #470, all merged; 325 is #471 (open) and 326 stacks on it. Open:
Next 1, 2 and 16, gated by their own terms; In-flight 5 (macOS); the
owner residue — the `NPM_TOKEN` secret, the release cut, the site's
address. No open issues. The loop holds 306–326; the next trim moves
306–326 to history. The box: an item whose pins are all controls
(324) is still an item — the finds were prose under a module that has
not moved, and a page written stale stays stale, which is why the
oldest-page queue exists; the shape law's parser needed a `readonly`
prefix (322) and a one-field guard (321) — the same lesson as 14ac's,
a law's helpers earn the differential; the module page repeated a
false claim the site had already been corrected on (326: `--dry`'s
`accessed_at` bump, pinned right on the site in 302 and wrong on
plan.md until now) — a corrected claim is a grep across every page.
Methods that paid: three pages per item with the shape law absorbing
each page's interfaces, so a read costs its prose and nothing else;
`git log -1 --format=%cs` per page as the second queue. Next: the
oldest-page queue continues — util-hash, util-ulid, version (09-05);
bin, chained-cache, config, fingerprint, lockfile-claim,
task-log-buffer, util-edit-distance, util-num, util-paths,
util-settle, util-tail (09-10); package-graph, projects, timing
(09-11); config-schema, index, plugin, plugin-host, plugins,
util-cgroup (09-12) — then the 09-16 pages the day's own items wrote
are current by construction; then the trim; then Next 6's re-measure
only when warm-path code moves (none did today). Never end with "what
next?".

14ae. **Handoff after item 332 (2026-09-16, late night).** Six items
since 14ad, and the oldest-page queue is exhausted: 327 (util-hash,
util-ulid, version), 328 (bin, chained-cache, config), 329
(fingerprint, lockfile-claim, task-log-buffer), 330 (the five util
pages), 331 (package-graph, projects, timing), 332 (config-schema,
index, plugin, plugin-host, plugins, util-cgroup). Every module page
under `docs/modules/` has now been read against its source once in
this series (306–332), and the 09-16 pages the day's own items wrote
are current by construction. The finds of this stretch: a façade page
that described the surface of a month ago (thirty names gone, twenty
missing), a transitive closure described as the DFS a 2026-09-09
profile replaced, a timing page naming a third of its labels, a host
page with a `vx init` hint the host no longer raises, an every-export
pin that reads the file (`config.ts`, `projects.ts`, `plugin-host.ts`,
`index.ts` by column) and a tests list pinned to a suite's `it` names.
`tests/module-shape-drift.test.ts` holds seventy-three shapes, its
constants, samples, error sets, export lists, the timing labels and
the façade. 326 went in #472, 327 #473, 328 #474, 329 #475, 330 #476,
all merged; 331 is #477 (open) and 332 stacks on it. Open: Next 1, 2
and 16, gated by their own terms; In-flight 5 (macOS); the owner
residue — the `NPM_TOKEN` secret, the release cut, the site's address.
No open issues. The loop holds 306–332; the next trim moves them to
history. The box: the pages that drifted furthest were the ones that
describe a LIST the code owns (exports, labels, tests, hooks) — a list
in prose is a snapshot, and the pin is what makes it a mirror; a page
that reads true (plugin, plugins, four of five util pages) is still
read, since the series' worth is the coverage, not the find count.
Methods that paid: the same three-pages-per-item cadence; deriving a
list pin from the source's own regularity (`mark('…')`, `it('…')`,
`export {…} from`) rather than from the page. Next: the trim (306–332
to `docs/history/`, this handoff's summary in their place); then the
site pages under `packages/vx-docs/src/content/docs/` by the same
oldest-page queue, guides first (each already has sample pins from
297–305, so the read is prose); then Next 6's re-measure only when
warm-path code moves (none did today). Never end with "what next?".

14af. **Handoff after item 383 (2026-09-19, evening).** Eleven items
since 14ae, and the arc has a single shape: a claim is pinned on ONE
copy and the second copy drifts. 373 paid the trim 14ae called for;
374 was a test racing the clock it asserted about, found by that
trim's own CI. Then the site pages, three per item, by last-touch
order: 375 otel-bridge / running-tasks / environment-variables, 376
trusting-the-cache / remote-execution / why-vx-is-fast, 377 mcp /
sandboxing / caching, 378 ci / remote-caching / workspace-config, 379
tasks / dev-tasks / extensibility, 380 lockfiles / plugins /
how-vx-works, 381 task-dependencies + the three top-level pages, 382
the two migrate pages. 383 started the CONTRACT pages under
`packages/vx/docs`: README, patterns, comparison.
The finds, in one line each: a dead `timeoutMs` option (375); a
promise `vx why` made in three places and proved in none (376); a
header calling six tools four and a 144-line file ~100 (377); a
four-rung precedence ladder printed with three (378); a stage table
two hooks short and a `description` sold as inert (379); a
paragraph two keys short (380); the SAME stage table wrong on a third
page my own 379 pin had not greped for (381); a migration table
missing `extends` (382); a benchmark table attributed to the wrong
workspace and a headline quoting a superseded wave (383).
The method that paid, and it sharpened twice: pin a list the CODE
owns, and DISCOVER the pages rather than listing them (381), because
a listed pin holds only the copies someone remembered. Twice a pin's
own selector was the bug — `about N lines` missed `~100` (377), and a
whole-page key search let one paragraph cover for another's omission
(380) — so run the differential that MATTERS, not the one that is
easy. And a pin should hold the claim the page makes, not the shape
another page made it in (382).
Next: the nine remaining contract pages by the same queue
(`comparison.md` is only spot-read — 595 lines, and its gap lists are
the most drift-prone prose in the repo), then the blog's 31 posts.
The loop holds 353–383, thirty-one entries; the trim convention
(item 373) moves a prefix to history at forty. Open: Next 1, 2 and
16, gated by their own terms; Next 6 parked until a run-path change;
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. Never end with "what next?".

## Handoff 14ag (moved 2026-09-20 with item 400)

14ag. **Handoff after item 394 (2026-09-19, night).** Eleven items
since 14af, and the arc kept exactly one shape: a claim is pinned on ONE
copy and a second copy drifts. 384 the `packages/…` citation pin; 385
caching.md's key fold, two steps inverted against the seed chain; 386
schema.md pinned for what the loader ACCEPTS, not only what it refuses;
387 cli.md, a list item the formatter swallowed and a `planRun` whose
return type the façade withheld; 388 execution.md and flows.md — a bulk
git populate described with a flag it deliberately does not pass, a
`cache.key` list missing `pluginParts`, and an up-to-date check dated to
the second where the code compares milliseconds; 389 `Bun.Archive` named
a hard dependency in CLAUDE.md, architecture.md and a test comment when
no `src/` file calls it; 390 two parity rows citing suites that say
nothing about their claim; 391 benchmarks.md, right everywhere and
pinned nowhere; 392 the module surface law in the direction nothing
held, 38 names; 393 comparison.md, a deleted seam and a backslash
written as a forward slash. 394 is this trim.
Three things this stretch taught, beyond the shape. First, the
CONTRACT page is usually right and the SUMMARY drifts: caching.md,
config-cache.md and modules/ held while CLAUDE.md, architecture.md,
comparison.md and the summaries moved — so read the page that is
quoted, not the page that quotes. Second, a one-directional pin is
half a pin: 386 and 392 are the same defect (what is REFUSED was held,
what is ACCEPTED was not; what a page DECLARES was held, what a module
EXPORTS was not), and both were found by asking what the existing law
does not say. Third, a pin's selector is the fragile part and it failed
SIX more times here — `millisecond` contains `second` (388), a heading
map keyed by basename collided `docs/cli.md` with `docs/modules/cli.md`
(390), a backtick-only scan missed every fenced block and a
comment-blind one counted comments as consumers (392) — every one
caught by RUNNING the check, never by reading it. A floor assertion
(392's 150 crossing names) is what turns "found nothing" into a
failure instead of a pass.
Open: Next 1, 2 and 16, gated by their own terms; Next 6 parked — 374
through 393 changed docs, tests and comments only, so there is no
run-path delta to A/B and an A/B has no arms; the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The container's baseline is 23 failing tests and ten failing
tasks, with shard 9 intermittently making it eleven by dying on a
SIGILL that names no test; the clean-tree control is what settles that,
not the streak (388 called it deterministic on two sightings and 389's
gate refuted that).
Next: the blog's 31 posts under `packages/vx-docs/src/content/docs/blog/`
by last-touch order, three per item — they are the least-pinned prose
left and they quote figures the contract pages own. Then
`docs/modules/`'s "What it does NOT do" sections, which are negative
claims nothing checks. Never end with "what next?".
