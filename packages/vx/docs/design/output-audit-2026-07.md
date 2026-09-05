# Adversarial audit — vx terminal output layer

Scope: `src/orchestrator/{logger,framed-output,status-line,summary,tally,colors,run-report,run-artifacts}.ts`
Contract: `docs/cli.md` §"Output flows", §`--output-logs`, §"Run artifacts".
Method: real CLI (`bun src/bin.ts run …`) against temp fixtures under `/tmp/oa`.
READ-ONLY on `src/` — nothing fixed.

Status: COMPLETE and CLOSED. All nine findings are fixed across two waves (see the
2026-07-27 decision-log entries). The refuted list below is the durable half: it
exists so the next audit does not re-tread this ground, and it CORRECTS a standing
residual (the corruption axis is terminal WIDTH, not height).

Two findings were sharper than written here, and the fixes record why. F10 has
THREE unbounded accumulators, not two — `fragment` is the smallest, but bounding
the other two makes it the dominant one, so the `\r`-vs-`\n` framing in both this
report and the older residual is a distraction. F4 is fixed only for
`--output-logs none`, the one mode whose contract guarantees the output is
discarded; the warm-cache-hit half is NOT the logger's cost and remains open,
measured and explained in the decision log.

---

## F1 — MEDIUM. `--report=markdown` counts GROUP tasks; the terminal summary and `--summarize` do not. Three surfaces describing one run, two agree, one lies.

`run-report.ts:tally()` has no group filter. It cannot have one: it consumes
`OutcomeView` (`events.ts:projectOutcome`), which drops `node`, so
`isGroupTask` is unreachable from there. `executeGroupTask` returns
`status:'success', durationMs:0`, so every group node is counted as a
successful task AND gets its own table row claiming `success | miss | 0ms`.

The function's own docstring asserts the opposite:

> Mirrors the terminal summary's `tallyOutcomes` partition (success counts
> hits; `aborted` is no work and so joins no bucket and no total)

### Repro (executed)

Fixture `packages/c/vx.config.mjs`:

```js
export default {
  tasks: {
    grp: { dependsOn: ['real'] },                       // group — no exec
    real: { exec: { command: "echo 'C real'" }, cache: { … } },
  },
}
```

```
$ cd /tmp/oa/w1 && rm -rf .vx
$ NO_COLOR=1 bun /home/user/vx/src/bin.ts run grp --all --report=markdown
```

Observed — terminal summary and markdown report disagree in the same stdout:

```
 ⏺︎     6ms success miss   @t/c#real

─ vx 0.0.0 ───────────────────────────────────────────────────
  tasks     ▰▰▰▰…▰▰
            1 success · 1 total          <-- terminal: 1
  cache     ▰▰▰▰…▰▰
            1 miss
  info      4 workers · local cache
  time      32ms · max 6ms · avg 6ms · min 6ms
## vx run — passed

**2 tasks** · 2 success · 0 failed · 0 cached · 6ms total   <-- report: 2

| Task | Status | Cache | Duration |
| --- | --- | --- | --- |
| @t/c#real | success | miss | 6ms |
| @t/c#grp | success | miss | 0ms |     <-- a group node, rendered as work
```

Control — `--summarize` on the same run agrees with the terminal, not the report:

```
$ bun …/bin.ts run grp --all --summarize=/tmp/oa/s1.json
$ jq '.tasks|length, .summary.total' /tmp/oa/s1.json   →  1, 1
```

### Consequence

`--report=markdown` is the surface documented for
`vx run ci --report=markdown >> "$GITHUB_STEP_SUMMARY"` — the most-read
artifact of a CI failure. On any workspace that uses group tasks (this repo's
own `ci` / `lint` / `build` are groups) the PR step summary over-reports the
task count and lists organizational nodes as executed work with a fabricated
`miss` cache state.

### Note on provenance

The 2026-07-27 telemetry wave fixed exactly this class for `--summarize`
("`--summarize` was internally inconsistent (`tasks.length` 3 vs
`summary.total` 2)") and repinned a test that had encoded it. `run-report.ts`
was not swept in that wave and still carries the defect — plus the docstring
claiming parity.

---

## F2 — HIGH. The live status region corrupts the terminal whenever ANY of its lines is wider than the terminal. Residue grows linearly with run duration.

`status-line.ts:91`

```ts
const eraseSeq = (): string => (shownHeight > 1 ? `\r\x1b[${shownHeight - 1}A\x1b[J` : CLEAR)
```

`shownHeight` is `current.length` — the count of **logical** lines
(`draw()`, line 100). The terminal lays those out as **physical** rows, wrapping
any line wider than the viewport. So when `k` region lines wrap, the cursor-up
moves `k` rows too few, `ESC[J` erases from inside the previous region, and the
top `k` physical rows survive **every** redraw. `clearStatus()` uses the same
short erase, so the residue is still there when the final summary prints.

Two independent, ordinary triggers:

- **Terminal narrower than 62 columns.** The summary section is a fixed
  62 visible columns (`2 indent + 8 label + 2 gap + 50 BAR_WIDTH`; the gradient
  rule is 62 too), so the rule + all three bar rows wrap. 62 cols is a normal
  vertical split.
- **A task id long enough to overflow the worker row, at ANY width.** Worker row
  = `1+glyph+1+TIME_COL(7)+1+STATUS_COL(7)+1+CACHE_COL(6)+1 = 26` + `len(id)`, and
  the id is deliberately never truncated ("name is the last column"). A 78-char
  scoped id overflows the classic 80-column default.

### Repro A (executed) — real pty, 61 vs 62 columns

Harness: `/tmp/oa/pty_run.py` opens a real pty, sets `TIOCSWINSZ`, runs the real
CLI, and renders captured bytes through a minimal VT (printable / `\n` / `\r` /
`CSI nA` / `CSI 2K` / `CSI J`, autowrap on).

Fixture: one package, `slow: { exec: { command: "sleep 1.2" } }`.

```
$ python3 pty_run.py <W> 40 /tmp/oa/w3 bun /home/user/vx/src/bin.ts run slow --all
```

Stale `running` rows left on the final screen:

| width | stale rows                               |
| ----- | ---------------------------------------- |
| 100   | 0 (control — clean, exactly one summary) |
| 63    | 0                                        |
| 62    | 0                                        |
| 61    | **5**                                    |

The threshold lands exactly on the 62-column summary width.

Screen at 60 cols (excerpt) — the region never erased itself:

```
     701ms running        @acme/service#slow
           idle
           idle
     801ms running        @acme/service#slow
           idle
           idle
     903ms running        @acme/service#slow
           idle
           idle
     1.00s running        @acme/service#slow
           idle
           idle
 ⏺︎   1.20s success miss   @acme/service#slow
           idle
           idle
           idle
─ vx 0.0.0 ─────────────────────────────────────────────────
──
  projects  ▰▰▰▰…▰▰
▰▰
```

### Repro B (executed) — CLASSIC 80-COLUMN DEFAULT, long ids

Fixture: two packages `@acme/platform-infrastructure-shared-utils-{1,2}`, task
`typecheck-and-bundle-everything` (78-char id), both `sleep 1.2`, run
concurrently.

```
$ python3 pty_run.py 80 40 /tmp/oa/w5 bun …/bin.ts run typecheck-and-bundle-everything --all
```

Observed — ten stale, mid-id-truncated rows before the real output:

```
     200ms running        @acme/platform-infrastructure-shared-utils-1#typecheck

     300ms running        @acme/platform-infrastructure-shared-utils-1#typecheck

     401ms running        @acme/platform-infrastructure-shared-utils-1#typecheck
… (10 total) …
 ⏺︎   1.20s success miss   @acme/platform-infrastructure-shared-utils-1#typechec
k-and-bundle-everything
```

**Residue grows with run length** (one ticker redraw per 100 ms):

| task duration | stale `running` rows |
| ------------- | -------------------- |
| 1.2 s         | 10                   |
| 4 s           | **39**               |

≈10 rows/second, so a 60-second build leaves ~600 junk rows and scrolls the real
task output off screen.

### Byte-level proof (emulator-independent)

Parsing the captured pty bytes from Repro B and comparing each region draw's
physical row count at W=80 to the `ESC[nA` the _next_ erase uses:

```
terminal width = 80
  erase ESC[nA  cursor-up rows   physical rows drawn  short-by
       ESC[14A              15                    17  2 row(s) left behind   (logical lines=15)
       ESC[14A              15                    17  2 row(s) left behind   (logical lines=15)
       ESC[14A              15                    17  2 row(s) left behind   (logical lines=15)
       ESC[14A              15                    17  2 row(s) left behind   (logical lines=15)

erases that moved up FEWER rows than the region physically occupied: 42
```

Every single redraw is short by exactly the number of wrapped lines. This
confirms the mechanism without relying on my VT emulator at all.

### Consequence

On a sub-62-column terminal, or with any task id long enough to overflow the
worker row at the user's width, `vx run` progressively fills the scrollback with
truncated duplicate status rows and the residue is still on screen under the
final summary. Nothing in the writer or the logger reads the terminal width —
`process.stdout.columns` appears nowhere in `src/`.

### Status of the named residual

CLAUDE.md (2026-07-26) records this as unconfirmed: _"at concurrency ≥10 the
status region is 23 lines … while `eraseSeq()` emits a fixed cursor-up with NO
terminal-height check … the arithmetic is confirmed but the consequence is NOT —
it needs a real TTY of controlled height, which this container has none of."_

A real TTY **is** obtainable here (`python3 -m pty` + `TIOCSWINSZ`). The
consequence is now confirmed — but for terminal **WIDTH**, not height. Height is
a separate question, examined below (F3).

---

## F3 — REFUTED (with probe). A status region TALLER than the terminal does not corrupt.

The CLAUDE.md residual guessed height was the hazard. It is not: when the region
exceeds the viewport, `ESC[<n>A` **clamps** at row 0, `ESC[J` then clears the whole
visible screen, and the redraw repaints it. No residue accumulates.

### Probe (executed)

Fixture: 10 packages × `echo MARKER-$i-DONE; sleep 1.5`, `--concurrency 10`
(region = 1 blank + 10 worker rows + ~14 summary lines ≈ 26 lines), width fixed at
120 so wrapping cannot confound.

```
$ python3 pty_run.py 120 <ROWS> /tmp/oa/w6 bun …/bin.ts run slow --all --concurrency 10 --output-logs full
```

| rows | stale `running` rows | MARKER lines on final screen | MARKER lines in raw byte stream |
| ---- | -------------------- | ---------------------------- | ------------------------------- |
| 40   | 0                    | 4                            | 20                              |
| 15   | 0                    | 0                            | 20                              |
| 8    | 0                    | 0                            | 20                              |

Every MARKER line is present in the byte stream at every height — nothing is lost,
it scrolls into the terminal's scrollback. The only degradation is that the top of
the region (the worker rows — the part the region exists to show) is never visible
when it doesn't fit, and completed-task lines are cleared from the visible screen.

**Conclusion: the residual as written ("region taller than terminal") is not a
defect. The real defect is region lines WIDER than the terminal (F2).** Worth
correcting in CLAUDE.md so the next audit doesn't chase height again.

---

## F4 — MEDIUM. The logger buffers every byte of every task's output in memory even in modes that are contractually guaranteed to discard it. Unbounded and linear in task output.

`logger.ts` `taskStdout`/`taskStderr` push into `stdoutBuffers`/`stderrBuffers`
unconditionally; the view mode is consulted only in `taskComplete`, which first
calls `takeChunks` (materialising the full join) and _then_, for `none`, does
`return`. Nothing is streamed to disk, nothing is capped. `docs/cli.md` defines
`none` as "no per-task output at all" and `errors-only` as "only failed tasks
print" — for those tasks the buffer is pure waste.

(The `PERSISTENT_TAIL_CHARS` 64 KiB bound added in the 2026-07-26 wave applies
**only** to a persistent task's post-ready chunks. The ordinary per-task buffer
has no bound.)

### Repro (executed) — peak RSS of the vx process vs task stdout volume

Harness `/tmp/oa/peakrss.py` polls `/proc/<pid>/status` `VmHWM` of the spawned
`bun` process. Task shape: `awk` printing N × 200-byte lines. All runs
`--output-logs none`.

| task stdout      | vx peak RSS |
| ---------------- | ----------- |
| 0.2 MB (control) | **70 MiB**  |
| 50 MB            | 180 MiB     |
| 100 MB           | 304 MiB     |
| 200 MB           | 524 MiB     |
| 400 MB           | **852 MiB** |

≈2 MiB of process RSS retained per 1 MB of task stdout (chunk array + the
single-allocation `join('')` at flush), with no ceiling. Concurrency compounds it
— 4 × 100 MB tasks: 469 MiB at `--concurrency 1` vs **655 MiB** at
`--concurrency 4`.

### The sharpest case: a CACHE HIT pays it too

`execute-task.ts:869` replays stored stdout through the logger
(`if (hit.stdout) log.taskStdout(node, hit.stdout)`), so a warm hit reads the
stored output out of SQLite, buffers it, and discards it.

Fixture: cacheable task with 50 MB of stdout, `--output-logs none`.

```
COLD (executes)      : peak_rss=473 MiB
WARM cache hit       : peak_rss=267 MiB
WARM cache hit again : peak_rss=291 MiB
control (quiet task) : peak_rss= 70 MiB
```

A cache hit — the fast path — costs ~4× baseline memory to materialise output that
the selected view mode guarantees will never be printed.

### Consequence

A single chatty task (a verbose bundler, a test runner with per-assertion output,
a `set -x` script) can push `vx run` into hundreds of MB or OOM on a constrained
CI runner, and choosing `--output-logs none` — the obvious mitigation — does not
help at all.

---

## F5 — MEDIUM-HIGH. `--report=markdown` reports the time the cache SPENT as the time it SAVED. Off by 500× on a real fixture, and it is the report's headline claim.

`run-report.ts`:

```ts
/** Wall-clock ms summed over cache hits — the work the cache skipped. */
savedMs: number
…
case 'cache-hit':
case 'cache-hit-remote':
  t.savedMs += o.durationMs
…
if (t.savedMs > 0) parts.push(`${fmtDuration(t.savedMs)} saved`)
```

But a cache hit's `durationMs` is the **restore cost**, not the stored exec time
(`execute-task.ts:883`):

```ts
durationMs: Math.round(performance.now() - cacheOpStart),
```

`framed-output.ts:474-477` asserts the opposite in a comment, so the belief is
baked into the code base:

> Duration is always shown. For cache hits it's the _original_ exec time the
> entry was stored with (set by execute-task), not the ~0ms replay cost.

That comment is false.

### Repro (executed)

Fixture: one cacheable task, `sleep 2 && echo built`.

```
===== COLD RUN (2s of real work) =====
**1 task** · 1 success · 0 failed · 0 cached · 2.01s total
| @t/s#build | success | miss | 2.01s |

===== WARM RUN (cache hit) =====
**1 task** · 1 success · 0 failed · 1 cached · 0ms total · 4ms saved
| @t/s#build | success | up-to-date | 4ms |
```

The cache saved **2.01 s**. The report says **"4ms saved"**.

The stored duration was available the whole time — it is on the `CacheEntry` the
restore already holds (`restoreHit(… hit: CacheEntry …)`), and it is correct in
the DB:

```
$ sqlite: SELECT hash, task, duration_ms FROM entries
{"hash":"8a0f2274dfc9b2ec","task":"build","duration_ms":2006}
```

### Consequence

The `$GITHUB_STEP_SUMMARY` line for every warm CI run understates the cache's
value by whatever ratio exec-time:restore-time happens to be (500× here). It
always understates, so it undersells rather than oversells — but it is a false
statement about the run, on the one number a reader of that report cares about.
The per-task `Duration` column has the same problem: a 2 s task renders as `4ms`.

The same restore-vs-stored ambiguity reaches the terminal frame footer
(`└─ @t/s#build ── (4ms) up-to-date`) and `--summarize`'s per-task `durationMs`,
where it is at least not labelled "saved". Whether the frame _should_ show stored
exec time is a design call (the comment says yes, the code says no); the report's
`savedMs` is wrong under either reading.

---

## F6 — LOW. GitHub Actions workflow commands are emitted unescaped: a task name containing a newline breaks the `::error` annotation, and task output containing `::endgroup::` closes vx's group early.

`logger.ts` (full mode + `gha`) interpolates raw values into workflow commands:

```ts
emitBlock(`::error title=${node.id}::failed (exit ${outcome.exitCode})\n${block}`)
…
emitBlock(`::group::${node.id} (${outcomeWord(outcome)} …)\n` + `${block}::endgroup::\n`)
```

GitHub requires `%0A` / `%0D` / `%25` encoding inside annotation properties, and
`::stop-commands::` fencing around untrusted body text. Neither is done.

### Repro A (executed) — newline in a task name

`packages/g/vx.config.mjs`: `{ "bad\nname::x": { exec: { command: "echo hi && exit 2" } } }`

```
$ CI=1 GITHUB_ACTIONS=1 bun …/bin.ts run $'bad\nname::x' --all
::error title=@t/g#bad
name::x::failed (exit 2)
┌─ @t/g#bad
name::x > failed (exit 2)
…
REAL EXIT=1
```

The annotation is truncated at the newline; the remainder leaks into the log body
as text. (`grep -c '::error'` on the captured output = 1 line, cut mid-title.)

### Repro B (executed) — task output containing workflow commands

Task: `printf '::endgroup::\n::error title=HIJACK::pwned\nreal output\n'`

```
::group::@t/g#evil (success 5ms)
┌─ @t/g#evil > success
…
├─ STDOUT ─────────────────────────────
::endgroup::                       <-- closes vx's group early
::error title=HIJACK::pwned        <-- becomes a real GHA annotation
real output
└─ @t/g#evil ── (5ms) success
::endgroup::                       <-- now unmatched
```

The rest of the block renders outside its group and a fabricated annotation is
attributed to the workflow.

### Consequence

Cosmetic/log-integrity only — no count is wrong and the exit code is right.
Reachable without malice by any task that legitimately prints GHA-command-shaped
text (a test asserting on annotation formatting, a nested tool that emits its own
workflow commands).

Worth noting as an **inconsistency**: `run-report.ts` already carries a `cell()`
escaper written for exactly this class, with the rationale _"Task names are
arbitrary TS object keys and the loader accepts `|` and newlines"_. The GHA path
has the same exposure and no equivalent defence.

---

## F7 — MEDIUM-HIGH. `--summarize` renders a run that EXITED 1 as a completely green artifact, with no run-level status field and the offending task erased.

`run-artifacts.ts:40`:

```ts
const counted = args.outcomes.filter((o) => !isGroupTask(o.node) && o.status !== 'aborted')
```

`aborted` is dropped from **both** `tasks[]` and `summary`, and the payload has no
`ok` / `exitCode` / `aborted` field at all. So an aborted task leaves zero trace in
the one artifact documented as machine-readable.

### Repro (executed)

Fixture: `@t/a#t` = `echo working; kill -TERM $$` (child self-SIGTERMs → `aborted`,
no dependents), `@t/ok#t` = `echo fine`.

```
$ bun …/bin.ts run t --all --summarize=/tmp/oa/abort2.json --report=markdown
REAL EXIT=1
```

Three surfaces, three different stories:

**terminal** — green meters, but the Aborted section names it (honest):

```
  tasks     ▰▰▰▰…▰▰
            1 success · 1 total
  cache     ▰▰▰▰…▰▰
            1 miss
  …
  Aborted:  1 task killed by a shutdown signal — not counted above
    ✗ @t/a#t — exit 143, nothing cached
```

**`--report=markdown`** — correct:

```
## vx run — failed
**1 task** · 1 success · 0 failed · 0 cached · 1 aborted · 5ms total
| @t/a#t | aborted | — | 5ms |
```

**`--profile`** — correct, the event is present with `cat=aborted`:

```
@t/a#t | cat= aborted | dur_us= 6742 | tid= 1
```

**`--summarize`** — a lie:

```
tasks:   ['@t/ok#t:success']
summary: {"successful":1,"failed":0,"skipped":0,…,"total":1}
run-level status field present? False
```

### Consequence

A CI job that gates on the `--summarize` JSON (the documented purpose of the flag)
reads `failed: 0`, a fully populated `tasks[]` with only successes, and no error
indicator — for a run vx exited **1** on. This is exactly the "green-reading
summary over a red run" class, in the surface where it is least recoverable
(a human at least sees the terminal's Aborted section; a parser sees nothing).

The related-but-weaker case where the aborted task HAS a dependent leaves
`skipped: 1` as an indirect hint, but still `failed: 0` and still no trace of the
aborted task.

### Provenance note

The 2026-07-27 telemetry wave fixed `--summarize`'s _internal_ inconsistency
(`tasks.length` 3 vs `summary.total` 2) by filtering `tasks[]` down to match
`summary`. That closed the internal disagreement and, in the same move, removed
the only remaining evidence of the aborted task from the artifact.

---

## F8 — LOW. `docs/cli.md`'s per-outcome visibility table disagrees with the code in three cells.

The table (`docs/cli.md` §"Output flows"):

| Outcome    | focused (requested task)    | CI / `full` |
| ---------- | --------------------------- | ----------- |
| up-to-date | one-liner (nothing to show) | one-liner   |
| skipped    | **frame**                   | **frame**   |

and the prose: _"…with two requested tasks … up-to-date/skipped get a one-liner"_.

### Repro (executed)

**(a) focused + requested + skipped → one-liner, doc says frame**

```
$ cd packages/b && bun …/bin.ts run boom     # dep @t/a#boom fails
 ◼︎     4ms failed  miss   @t/a#boom
 ⊘         skipped        @t/b#boom          <-- one-liner
```

**(b) `full` + skipped → one-liner, doc says frame**

```
$ bun …/bin.ts run boom --all --output-logs full
…
 ⊘         skipped        @t/b#boom          <-- one-liner
```

**(c) focused + requested + up-to-date → FRAME, doc says one-liner**

```
$ bun …/bin.ts run quiet          # warm
┌─ @t/u#quiet > $ true
└─ @t/u#quiet ── (4ms) up-to-date
```

**(d) focused + TWO requested + up-to-date → FRAME, doc prose says one-liner**

```
$ bun …/bin.ts run quiet talky    # both warm
┌─ @t/u#quiet > up-to-date • 87993c79

$ true

└─ @t/u#quiet ── (5ms) up-to-date
```

**(e)** the `full` row for up-to-date is also imprecise: an up-to-date hit _with_
stored stdout gets a frame, only a quiet one gets a one-liner —

```
$ bun …/bin.ts run talky --output-logs full
┌─ @t/u#talky > up-to-date • b371e660
├─ STDOUT ─────────────────────
replayed-stdout-here
└─ @t/u#talky ── (4ms) up-to-date

$ bun …/bin.ts run quiet --output-logs full
 ►     4ms success fresh  @t/u#quiet
```

The doc already spells this nuance out for the `restored-*` row ("frame, or
one-liner if quiet") but not for `up-to-date`, which follows the identical code
path (`isHit && stdout empty`).

### Consequence

Documentation-only; no count or exit code is affected. Recorded because this repo
treats a doc/code disagreement as a finding in its own right and has repeatedly
pinned reference tables to the code that produces them.

---

## F9 — MEDIUM. The documented `$GITHUB_STEP_SUMMARY` recipe writes the ENTIRE run log into the step summary, not the report. Every logger surface shares vx's stdout.

`docs/cli.md:736` and the header of `run-report.ts` both recommend:

```
vx run ci --report=markdown >> "$GITHUB_STEP_SUMMARY"
```

`cli/run.ts:582` states the intent:

> Goes to stdout (NOT the status logger) so it stays **machine-clean** for
> `vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY`.

But the status logger writes to stdout too — `run.ts:150`
`defaultLogger(colors, resolveOutputView(options))` takes the default
`out: StatusStream = process.stdout`, and `createOutputWriter` passes everything
through to it. So redirecting stdout captures frames, meters, GHA workflow
commands _and_ the report. The report is machine-clean; the redirect target is not.

### Repro (executed)

```
$ CI=1 GITHUB_ACTIONS=1 bun …/bin.ts run grp --all --report=markdown \
    >> /tmp/oa/step_summary.md 2>/dev/null
REAL EXIT=0
```

`step_summary.md` (the thing GitHub renders as GFM) contains, in order:

```
::group::@t/c#real (success 6ms)          <-- workflow command, inert in a summary
┌─ @t/c#real > success
$ echo 'C real'
├─ STDOUT ────────────────────────────────
C real
└─ @t/c#real ── (6ms) success
::endgroup::

─ vx 0.0.0 ───────────────────────────────
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 affected · 3 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰…
            1 success · 1 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰…
            1 miss
  info      4 workers · local cache
  time      31ms · max 6ms · avg 6ms · min 6ms
## vx run — passed                         <-- the actual report starts HERE
…
```

Note `2>/dev/null` was in effect — nothing went to stderr. Task stderr is on
stdout too (verified separately: the fixture's `A-STDERR` text appears on stdout
with stderr discarded).

### Consequence

Anyone following the documented recipe gets a PR step summary whose first screen
is a wall of box-drawing frames and 50-cell meter bars. GFM merges consecutive
non-blank lines into paragraphs, so the frames render as run-together text and
`::group::` appears as literal content; the real table is buried at the bottom.
The larger the run, the worse it gets.

(Colour is not the problem — `detectColors` correctly reports `enabled:false`
on a redirected stdout, so no ANSI leaks.)

---

## F10 — VERIFIED, with a correction to how the residual is stated. Pre-ready persistent-task buffering is unbounded, and the `\r` nuance is NOT the dominant term.

CLAUDE.md (2026-07-26) records:

> `consumeChunks` trims `fragment` only at `lastIndexOf('\n')`, so `\r`-only
> progress-bar output never trims — **288,910 chars in 2.5 s** with a
> never-matching `readyWhen` … unbounded only when a never-matching `readyWhen`
> has no timeout

### Probe (executed)

Fixture: persistent task, `readyWhen: "NEVER-MATCHES-THIS-TOKEN"`, **no**
`exec.timeout`, emitting 100-byte records as fast as `awk` can. vx killed after
6 s; peak RSS sampled from `/proc/<pid>/status` `VmHWM`.

```
== \r-only output ==
peak_rss=507 MiB   trace(s,MiB)=[(0,0),(1,279),(2,348),(3,373),(4,474),(5,503)]

== \n-terminated output ==
peak_rss=679 MiB   trace(s,MiB)=[(0,0),(1,261),(2,338),(3,431),(4,550),(5,614)]
```

Growth is unbounded and roughly linear — ~100 MiB/s in both shapes.

### The correction

The **newline-terminated** case grows _faster_ (679 vs 507 MiB). So `fragment`
(the readyWhen matcher's buffer, which the residual blames) is the _smaller_
term. The dominant accumulators are the ones that grow regardless of line
endings:

1. `runner.ts` `bufferedStdout += chunk` / `bufferedStderr += chunk`, gated only
   on `readyAt === undefined` — the whole pre-ready log.
2. **In scope for this audit:** `logger.ts` `pushChunk(stdoutBuffers, …)`.
   `persistentTails` — the only bounded path (`PERSISTENT_TAIL_CHARS`, 64 KiB) —
   is registered in `taskComplete`, i.e. **at ready**. A task that never becomes
   ready never reaches `taskComplete`, so the 64 KiB bound never engages and its
   output accumulates in the ordinary unbounded per-task buffer (see F4).

So a never-ready persistent task accumulates its output **twice**, in two
separate unbounded buffers, and the documented mitigation (the tail cap) applies
to neither.

> **As shipped, 2026-07-27 (later wave).** Accumulator (1) is GONE, not merely
> bounded: `bufferedStdout()` / `bufferedStderr()` had zero consumers anywhere
> but `tests/runner.test.ts`, so the pre-ready tails behind them were deleted
> along with the getters. The logger's tail — accumulator (2), now registered at
> `taskStart` — is the single remaining holder, which is why `util/tail.ts`'s
> "both sides accumulate" rationale no longer applies.

The residual's own parenthetical already says the docstring claim is _"true
post-ready, false pre-ready"_ — this measurement confirms that and shows the `\r`
framing is a red herring.

---

## Consolidated cross-surface comparison (one mixed run)

Fixture: 6 projects declaring task `t` — a failure (`exit 7`), a dependent that
skips, a self-SIGTERM (aborted), a warm cacheable task, a group + its inner task,
and a plain success. Run once warm:

```
$ bun …/bin.ts run t --all --summarize=mix.json --report=markdown
REAL EXIT=1
```

|         | terminal summary         | `--summarize`       | `--report=markdown`           |
| ------- | ------------------------ | ------------------- | ----------------------------- |
| total   | **5**                    | **5**               | **6**                         |
| success | **3**                    | **3**               | **4**                         |
| failed  | 1                        | 1                   | 1                             |
| skipped | 1                        | 1                   | 1                             |
| cached  | 1 (`up-to-date`)         | 1                   | 1                             |
| aborted | named in its own section | **absent entirely** | 1                             |
| "saved" | —                        | —                   | `4ms` (stored exec was 11 ms) |

Terminal and `--summarize` agree exactly — they share `tallyOutcomes`, so **they
cannot disagree** (refuted as a risk, see R2). `--report` is the outlier on both
`total` and `success` because it counts the group node `@t/g#t`, which it also
renders as a row:

```
| @t/g#t | success | miss | 0ms |
```

This is F1 (group counting) and F5 (`saved`) visible in a single run.

---

# Ranked summary

| #   | Sev      | Finding                                                          | User-visible consequence (one sentence)                                                                                                                                                                                                |
| --- | -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2  | **HIGH** | Live region erases by logical-line count, not physical rows      | On a terminal narrower than 62 cols, or with any task id long enough to overflow a worker row at the user's width (78 chars at the classic 80), `vx run` fills the scrollback with truncated duplicate status rows at ~10 rows/second. |
| F7  | MED-HIGH | `--summarize` drops `aborted` and has no run-level status        | A CI job gating on the documented machine-readable artifact reads `failed: 0` and a fully green `tasks[]` for a run vx exited **1** on.                                                                                                |
| F5  | MED-HIGH | `--report`'s `savedMs` sums restore time, not stored exec time   | The PR step summary says "4ms saved" for a cache hit that skipped 2.01 s of work — the tool's headline value, understated 500×.                                                                                                        |
| F1  | MEDIUM   | `--report=markdown` counts group tasks                           | The CI step summary over-reports task count (6 vs 5) and lists organizational group nodes as executed work with a fabricated `miss` cache state.                                                                                       |
| F9  | MEDIUM   | All logger output shares stdout with `--report`                  | The documented `>> "$GITHUB_STEP_SUMMARY"` recipe writes the whole run log — frames, meter bars, `::group::` commands — into the step summary above the real table.                                                                    |
| F4  | MEDIUM   | Per-task output buffered unbounded in every view mode            | One chatty task pushes vx to hundreds of MB (400 MB stdout → 852 MiB RSS); `--output-logs none`, the obvious mitigation, does not help, and even a cache hit pays it.                                                                  |
| F10 | MEDIUM   | Pre-ready persistent output accumulates in two unbounded buffers | A persistent task whose `readyWhen` never matches grows vx's heap ~100 MiB/s with no cap (the 64 KiB tail bound only engages _after_ ready).                                                                                           |
| F6  | LOW      | GHA workflow commands emitted unescaped                          | A newline in a task name truncates the `::error` annotation; task output containing `::endgroup::` closes vx's group early.                                                                                                            |
| F8  | LOW      | `docs/cli.md` visibility table wrong in 3 cells                  | Doc says "frame" where the code emits a one-liner (skipped) and "one-liner" where it emits a frame (up-to-date).                                                                                                                       |

---

# Probed and REFUTED (with the probe)

These were suspected and are NOT defects. Recorded so the next audit doesn't
re-tread them.

**R1 — "Status region taller than the terminal corrupts the display."**
_(the standing CLAUDE.md residual)_ — **Refuted.** `ESC[<n>A` clamps at row 0, so
an over-tall region simply repaints the whole screen. Probe: 10 packages ×
`--concurrency 10` (26-line region) at 120×{40,15,8}; zero stale rows at every
height, and all 20 MARKER lines present in the byte stream at every height. See F3.
The real defect is region **width**, not height.

**R2 — "`tally.ts` is shared by two surfaces; they might disagree."**
**Refuted.** `summary.ts` calls `tallyOutcomes(outcomes)`; `run-artifacts.ts`
calls `tallyOutcomes(counted)` where `counted` pre-applies the _same_
group/aborted filter `tallyOutcomes` applies internally — so the pre-filter is
idempotent. Probe: the mixed run above, terminal legend `1 failed · 3 success ·
1 skipped · 5 total` vs JSON `{"successful":3,"failed":1,"skipped":1,"total":5}` —
identical. (`--report` has its _own_ private tally and does disagree — that is F1,
a different code path.)

**R3 — "`tally.ts` tests `restored === true` while `logger.ts` tests
`restored === false`; an `undefined` would be bucketed opposite ways."**
**Refuted as reachable.** `restoreHit` (`execute-task.ts:878`) is the sole
producer of both cache-hit statuses and always assigns a boolean
(`const restored = !skipRestore && anyOutputs`). `wire-render.ts` copies it
conditionally but it is never absent. Latent inconsistency only — worth a comment,
not a fix.

**R4 — "Flow/CI detection might let an explicit `--output-logs` be overridden."**
**Refuted.** Executed matrix:

| env        | flags                       | first line of output                        |
| ---------- | --------------------------- | ------------------------------------------- |
| `CI=1`     | —                           | `┌─ …#talky > up-to-date • b371e660` (full) |
| `CI=0`     | —                           | `┌─ …#talky > $ echo …` (focused)           |
| `CI=false` | —                           | focused                                     |
| `CI=true`  | —                           | full                                        |
| `CI=1`     | `--output-logs none`        | _(empty)_                                   |
| `CI=1`     | `--output-logs errors-only` | _(empty)_                                   |
| _(none)_   | `--output-logs full`        | full                                        |

Explicit override always wins; `CI=0`/`CI=false` correctly don't count.

**R5 — "A streamed chunk with no trailing newline glues onto the frame close."**
**Refuted.** `streamMidLine` handles it. Probe: `printf 'NO-TRAILING-NEWLINE'`
focused —

```
┌─ @t/x#nonl > $ printf 'NO-TRAILING-NEWLINE'
NO-TRAILING-NEWLINE
└─ @t/x#nonl ── (4ms) success
```

**R6 — "Control characters / ANSI in task output break the frame."**
**Refuted.** Probes emitting `ESC[31m`, `\r`, `\t`, BEL, NUL, `ESC[5A`, `ESC[2J`
all keep the frame structure intact (`┌─` … `├─ STDOUT` … `└─`); content passes
through verbatim. A task that emits `ESC[2J` can still clear the user's screen,
but that is inherent to streaming a child's output and is not a formatter defect.

**R7 — "Concurrent writers can interleave with the status region."**
**Refuted.** `grep -rn "process.stdout.write\|console.log" src/orchestrator/` →
**zero hits**; every orchestrator surface goes through `log.status` → the writer,
which is the single serialization point. The four direct `process.stdout.write`
calls in `cli/run.ts` are all post-run (plan mode, `--report`, `printSummary`) or
short-circuit paths.

**R8 — "`--output-logs none` could hide a failure entirely."**
**Refuted.** Probe on the failing fixture: no per-task output, but the summary
still prints `1 failed · 1 skipped · 2 total` and `REAL EXIT=1`. Matches the
documented contract ("the end-of-run summary always prints").

**R9 — "`runStart.startedAtMs` is accepted and then ignored, so the live clock
drifts from the final summary."** **Refuted as observable.** `logger.ts:353` does
`startedAtMs = Date.now()` and never reads `info.startedAtMs`. Measured drift on a
real pty run: live samples `… 1110, 1210, 1220` ms, final `1220` ms — **0 ms**.
The parameter is dead, not wrong. (Could become observable if expensive setup ever
lands between `endedAtMsAtStart` and `log.runStart`.)

**R10 — "With NO_COLOR the meters are unreadable."** **Refuted as a defect** — the
bars do collapse to indistinguishable `▰` runs, but the legend beneath carries
every number, which is the documented design ("NO_COLOR renders plain ▰ runs with
the legends carrying the data").

**R11 — "A mistyped task name could go unreported."** **Refuted.**
`vx run doesnotexist` → `No projects declare task(s): doesnotexist.` exit 1; the
multi-task form `vx run quiet doesnotexist` errors identically.

---

# Open questions (not defects)

1. **An aborted task's captured output is discarded in every view.**
   `taskComplete` drains the buffers and returns before any rendering. The
   Aborted section names the task and exit code but shows nothing it wrote. For
   the interactive Ctrl-C path this is right (the run is tearing down); for the
   external-`kill`/self-terminating path — the only one that reaches the summary —
   a user debugging gets the task's id and nothing else. Whether to surface it is
   a design call, not a bug.

2. **The live region's `total` counts tasks the final summary won't.**
   `runStart` receives `taskCount` (all non-group graph nodes) while `done` only
   increments for non-aborted completions, so a run with an aborted task shows a
   permanently-unfillable gray remainder in the live meters. Invisible in short
   runs because `runEnd` kills the region; potentially confusing in a long one.

3. **Should a cache hit's `durationMs` be the restore cost or the stored exec
   time?** The code says restore; `framed-output.ts:474-477` says stored exec.
   Both readings are defensible for the frame footer — but `run-report.ts`'s
   `savedMs` is wrong under either (F5), and `--summarize` consumers have no way
   to know which they are getting. Picking one and stating it in `docs/cli.md`
   would close F5 and the comment drift together.
