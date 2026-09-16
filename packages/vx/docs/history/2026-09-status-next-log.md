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
