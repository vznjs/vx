# `src/report/` — the run event stream and terminal output

## `src/report/logger.ts` — pluggable logging surface

### Purpose

Provide a small `Logger` interface that the orchestrator + scheduler
call through, and a `defaultLogger()` implementation that applies the
flow-aware output policy (focused / broad / full) on top of the
framed-block renderer. Programmatic embedders can pass their own
`Logger` to capture machine-readable output.

### Public surface

```ts
export interface Logger {
  status(line: string): void // header / summary / status lines
  warn?(line: string): void // a warning; the default logger writes it to stderr, a logger without it gets it through status
  taskStdout(node: TaskNode, chunk: string): void // streamed stdout chunk
  taskStderr(node: TaskNode, chunk: string): void // streamed stderr chunk
  taskComplete(node: TaskNode, outcome: TaskOutcome): void // flush block
  // Optional lifecycle hooks — drive the default logger's live status
  // region; custom loggers may omit them.
  runStart?(info: {
    total: number
    concurrency?: number // one worker row per slot
    requestedCount?: number
    context?: RunContext // the live summary section's context
    startedAtMs?: number
  }): void
  taskStart?(node: TaskNode): void
  runEnd?(): void // the graph is done; vx's closing steps follow
  stepStart?(id: string): void // one of vx's own steps (`vx:keys`) began; never a task
  stepEnd?(id: string, info: { durationMs: number; ok: boolean }): void
  runDone?(): void // the run's work is done; the footer follows
  runStop?(): void // the run was stopped (a signal, an abort); idempotent
}

export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean // GitHub Actions: fence task text; in full mode, ::group:: blocks
  ci?: boolean // truthy CI env — suppresses the status line
}

export function resolveOutputView(
  options: {
    outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
    flow?: 'focused' | 'broad'
  },
  env?: Record<string, string | undefined>,
): OutputView

// What run() builds when no logger is passed.
export interface DefaultLogger extends Logger {
  settle(): void // hand over coalesced output; write straight through from now on
  readonly showsSteps: boolean // only where the live region draws; else run() times no step
  forecast(graph: () => Forecast, load: () => Promise<Forecast | undefined>): void // `graph` (no history) at the first free row; `load` only if the live region is still up 1 s in
  holdStatus(): () => void // no live region until the release: a secret prompt waits on the terminal
}

export function defaultLogger(
  colors?: ColorSupport,
  view?: OutputView, // default { mode: 'full' }
  out?: StatusStream, // default process.stdout
  // forwardArgs: the args after `--`, shown on a requested task's `$` line
  opts?: {
    forceFloorMs?: number
    coalesce?: boolean
    tty?: boolean
    env?: Record<string, string | undefined> // names the terminal for OSC 9 / 9;4 / 8; default process.env
    forwardArgs?: readonly string[]
    err?: StatusStream // where warnings go; default process.stderr
  },
): DefaultLogger

// log.warn, or log.status for a logger without it
export function warnOf(log: Logger): (line: string) => void

// forecast.ts: the live ETA from history p50s (none: the graph alone,
// what is blocked and by what, no ETA); the later of the longest
// unfinished chain and the unfinished work spread over the workers. The
// same pass lists `blocked`: up to one task per worker that an unfinished
// dependency holds back, ranked as the scheduler ranks
// (the run's dependents count, read back with the graph), each `by` the running task its
// longest chain waits on, else that dependency; `blockedBy`, per running
// task, the tasks not started that depend on it directly. A running task
// past its p50 costs zero: an ETA of zero with tasks running is the region's
// `+Ns over`, counted from when it reached zero. A pass reads only what
// the last one left unfinished: called again with the same `finished`
// set, that set has only grown (the logger's does); another set starts over.
export interface BlockedTask {
  id: string
  by: string
}
export function createForecast(
  nodes: ReadonlyMap<string, TaskNode>,
  p50s: ReadonlyMap<string, number>,
  concurrency: number,
  rank?: ReadonlyMap<string, number>, // the scheduler's baseline and each row's `blocks`; `computeReverseDepCount(nodes)` by default
): Forecast
```

### View resolution (priority order)

1. Explicit `--output-logs` → that mode.
2. Truthy `CI` env (`CI=0` and `CI=false`, in any case, excluded) → `full`.
3. CLI-detected flow (`RunOptions.flow`) → `focused` or `broad`.
4. Nothing (programmatic callers) → `full`.

`gha: true` is attached whenever `GITHUB_ACTIONS` is truthy, whatever
the mode; `ci: true` whenever `CI` is truthy.

### Default logger behavior by mode

- **`full`** — frames for executed work / failures,
  one-liners for skips and quiet cache hits, frames for hits with replayed
  stdout. With `gha`, non-failed blocks are wrapped in
  `::group::<id> (<outcome word> <duration>)` … `::endgroup::`;
  failed blocks stay ungrouped and are preceded by
  `::error title=<id>::failed (exit N)` (`failedLabel`: above 128 the
  signal is named, `failed (exit 137, 128 + SIGKILL)`; a timeout its
  reason, `failed (timed out, exit 143)`; a persistent task that never
  became ready, `never ready: …`; a sandboxed task its violation count).
- **`focused`** — requested non-group nodes stream stdout/stderr raw
  and live (cache-hit replay included); a quiet hit prints a full
  frame; a skipped requested task prints the skipped one-liner
  with its blocker (`• blocked by lib#build`). Dependency-pulled
  nodes are silent on success/hit and fully framed on failure.
- **`broad`** — executed tasks print one
  `success miss … <id>` row (`no-cache` for a task no cache
  answered for, `ranNoCache`); failures get full frames;
  hits / up-to-date / skipped are silent (buffers dropped).
- **`errors-only`** — only failed tasks print.
- **`hash-only`** — one line per task with its key, no output.
- **`none`** — no per-task output.

A task handed the terminal (`exec.interactive`, with `defaultLogger`'s
`tty` option, which `run()` sets from `RunOptions.tty`) writes to it
directly. Its start removes the status region for the rest of the run
and settles the coalesced writes; in `full`, `focused` and `broad` a
live frame opens before it and closes after, and what vx says about it
(a timeout, a shell verdict) streams inside.

A buffered frame masks the task's secrets in each stream's whole text
(`maskStreams`), as the stored log does: the live mask let a value the
task wrote in two pieces through as two clean chunks. A hit's replay
was masked whole already. A frame of 1 Mi characters or more is written
in pieces (`head`, the block, `tail`), never copied into one string: a
100 MB log's frame took vx from 408 MB to 1.19 GB, and 577 MB with
this and the writer's slicing (`report.md`).

`status()` lines (header, summary) always print. Group tasks never
print in any mode. A ready persistent task the run keeps (`vx run dev`)
is held to a bounded tail until `runEnd`, which flushes it before the
summary; from there its output streams below the summary a line at a
time under its id (`app#dev │ …`), fenced on Actions, and not at all
under `errors-only`, `hash-only` or `none` (#2054). A line that redraws
itself (`\r`, `CSI 2K`, `CSI 1G`) prints as its last redraw, so the id
prefix stays on screen.

### Status region

The default logger owns a `createOutputWriter` from `status-line.ts`
wrapping its output stream. Enabled only when the stream is a TTY and
`view.ci` is not set. The optional `runStart` / `taskStart` / `runEnd` /
`stepStart` / `stepEnd` / `runDone`
hooks (wired by `run()`) drive a live region at the bottom
(`formatStatusRegion`): a blank line separating it from the completed
list above; one row per ready persistent task (`▸`, `running`, the id,
no elapsed); one row per worker slot that has been busy — the ticking
elapsed time leads, then `running` and the full id, a task keeping its
slot for its whole life so names never jump, a slot whose task ended
holding its place dim, and a row after them for each task running
beyond the slots; then the live
summary section, the same meters the final footer prints, filling in
as the run proceeds so the region becomes the summary when the run
ends. A failure logs a permanent one-liner the moment it lands
(`formatFailureLine`) and the full frame replays at `runEnd`. The
region is rewritten in place, throttled with forced redraws on task
events, and built (forecast pass, summary, rows) only when the writer
draws it, from the state then. At `runEnd` (the graph is done) its worker rows go and it
keeps the footer and vx's own step rows (`tail`) until `runDone`, just
before the final footer prints, removes it for good. A stop
(`runStop`) keeps the region: running rows read `aborting` with their
timers, blocked rows and the forecast go, each task that exits lists as
an `aborted` (or `not run`) row (a list view frames an `aborted` task's
output with the deferred failures), and the live footer counts them, so a
slow stop never shows a blank screen (2026-10-17); the first
requested-task start in focused mode removes it too. A step
(`stepStart` / `stepEnd`, ids `<owner>:<step>`) shows as a row below
the worker rows once it has run `STEP_SHOWN_MS` (150 ms), bounded by
no worker slot, and ends as a list row (`formatStepLine`), `internal`
in the cache column; a step can draw the region before `runStart`,
with no footer. No step touches a counter. Only a step the run waits
on is one: a background step (`vx:prefetch`) never reaches the logger
and is kept for `vx last` (2026-10-16). `showsSteps` is true only
where the region can draw, and `run()` times no step otherwise (2026-10-15;
`tests/run-tail.test.ts`, `tests/steps.test.ts`). Every ordinary write
clears it first, writes, then redraws, so it never interleaves with content.

### Programmatic logger

A custom logger receives plain-text bodies (the orchestrator passes
`{ enabled: false }` for colors). Useful for:

- **JSON-line emission** — push each task's stdout/stderr to a
  structured pipeline.
- **OTLP / observability sink** — wrap each call to emit a span.
- **Silent test runner** — return functions that buffer to arrays
  the test inspects.

`run()` never calls a `Logger` directly: it emits `RunEvent`s through
the run event bus (`events.ts`), and the logger is the default
subscriber (`terminalSubscriber`). Other surfaces subscribe the same
way (`RunOptions.bus`, a plugin's `setup`).

### Tests

`tests/output-flow.test.ts` — flow detection, view resolution, the
per-mode visibility matrix, GHA grouping, and flow e2e through the
CLI. `tests/status-line.test.ts` — writer serialization, throttling,
permanent clear, and the logger's lifecycle integration.
`tests/framed-output.test.ts` tests the format functions directly;
`tests/orchestrator.test.ts` covers the custom-logger path.

### Replacing this module

Implement `Logger` and pass it via `RunOptions.log`. The four
required method names are wired by reference; the lifecycle hooks are
optional. To add new event types, extend the interface and the
orchestrator simultaneously.

## `report/status-line.ts` — dynamic worker region

The live status display for interactive runs. **Not a TUI**: a
region redrawn in place with cursor-up + clear-line escapes — no
alternate screen, no cursor addressing beyond that.

### OutputWriter

`createOutputWriter(stream, opts)` is the serialization point for
**all** logger stdout. Inert (pure passthrough) on non-TTY streams, under `TERM=dumb`, and
when disabled (CI). When active:

- `setRegion(lines)` / `setStatus(line)` replace the display; unforced
  redraws are throttled (`minRedrawMs`, default 100 ms), task
  start/finish events force.
- Forced redraws coalesce behind `forceFloorMs` (default 30 ms, 0
  disables): a forced set within the floor marks the content dirty
  and schedules ONE trailing draw (unref'd; canceled by any draw and
  by `clearStatus`) for floor expiry, so the final state always
  lands. First draw after idle is immediate. Measured: 6,540 forced
  redraws ≈ 6.7 MB of ANSI on a 3,270-task warm run → ~20 KB.
- `setRegion` also takes a function that builds the lines; it is
  called when the region is next drawn, once, and its lines are kept
  for the redraws writes cause. The logger passes one, so the events a
  floor coalesces build nothing: 200 warm hits on a terminal, run
  graph 62 → 9 ms (min of 30).
- `write(chunk)` — any ordinary content — lands with the next frame
  (the same `forceFloorMs` floor): the frame erases the region
  (single line: `ESC[2K\r`; taller: `\r ESC[nA ESC[J`), writes all the
  content since the last frame, then redraws, as ONE write. The region
  can never interleave with task output. A frame whose region bytes
  match what is shown writes nothing. 2,000 tasks on a terminal:
  866 → 290 ms CPU, 8.6 → 1.1 MB, 6,057 → 165 writes. A timer holding
  content keeps the process open until it lands; `clearStatus`,
  `hold` and `writeTo` hand pending content over first. The erase always uses the height of the **previous** draw;
  the new draw establishes the new height, so the region may grow and
  shrink freely (pins arriving).
- `writeTo(target, chunk)` does the same for another stream on the
  same terminal (the logger's warnings on stderr): the region on this
  stream is erased first and redrawn after; off a TTY it hands over
  any coalesced output first, so the order holds.
- A region taller than the terminal (`stream.rows`, read per draw)
  is cut to its leading lines that fit in one row less, counting
  wrapped rows. Cursor-up stops at the top of the screen, so rows in
  the scrollback were out of reach and every redraw stacked a new
  block (VS Code's short panel, 2026-10-14).
- A chunk ending mid-line (focused streaming) holds redraws until a
  newline restores column 0.
- `clearStatus()` is permanent (run end).
- `hold()` erases the region and draws none until its release (a
  secret prompt on the terminal); the release draws the latest state.

Off a TTY, `coalesce: true` holds writes and hands them to the stream
once per turn of the event loop (`setImmediate`), or as soon as 64 KiB
are held, in order (a warm run replays its hits in one turn, so the
turn's end held every hit's log), and at most once per `coalesceMs`
(default 25 ms; 0 is once per turn): a write inside the floor waits for
it on a timer. A restore settles its hits over hundreds of turns, and a
write per turn cost the 9,603-task restore ~100 ms of its main thread on
ext4 (2026-11-07). `settle()` hands over what is held at once, clears
the timer, and writes straight through from then on. A write of 64 KiB
or more goes as it is, after what is held, and anything handed to the
stream goes in slices of at most 1 Mi characters: a stream encodes a
string whole, and joined with what was held, or encoded at once, a
100 MB frame was copied twice more. A
warm 476-package run wrote each of its 952 task lines as its own
syscall; coalesced, the warm run's wall went 184.0 → 167.8 ms (min of
15, interleaved compiled binaries, item 753). Only `run()`'s own
terminal logger asks for it (a caller reading a stream right after a
write still sees it), and it settles in `runEnd`, before the summary
prints below the held lines, and again in `run()`'s `finally` for a
throw that never reached `runEnd`: nothing is held when the verb
returns and `bin.ts` lets the loop drain. A TTY is never coalesced; its region redraws already serialise
the writes.

### formatStatusRegion

A blank separator line, a pinned zone, one row per worker slot, then
the live summary section.

The pinned zone (owner: "always pinned until exit"):

- **Persistent** — a `running` row (no elapsed, `—` cache, the id) for every
  ready persistent task (its outcome lands at ready while the child keeps running; the
  orchestrator SIGTERMs persistent children when the graph finishes,
  so runEnd is the honest end). Pins keep identity-colored ids —
  status colors only on the status word.

A failure is not pinned: it is logged the moment it happens as a
permanent row in the stream (`formatFailureLine`: `failed` in red,
`miss` / `no-cache`, or `—` for a hit whose restore failed, the exec time, the id — the exit code and the
output live in the frame, which replays at runEnd above the summary,
`failedLabel` in its header and footer). The region held a Failures
zone once; the permanent row replaced it, and this page kept
describing the zone until 2026-09-16.

Slot rules (the point of the design — the display derives from the
**stable worker set**, not the churning task set):

- Sized `min(concurrency, 10)` at runStart; the footer's `info` row
  states the pool (`C workers`).
- A task takes the lowest free row and **stays there for its whole
  life**; idle rows hold their place dimmed, so the height and the
  rows never shift. An idle row holds a blocked task (`blocked`, the id,
  `by <running task>`; `blocked`, by row) from the forecast's list,
  which the graph alone gives from the first free row; history adds
  only timings. The logger keeps each row's
  task until it starts, in that row, or leaves the list, and drops a row
  with nothing left to hold, the rows below closing up.
- `stopping: true` (a stop): running rows read `aborting` in the warn
  tone with their timers and no expected time; empty and blocked rows
  are left out.
- A task its executor holds for a machine (`TaskExecutor.running` is
  `null`) has no row; the tasks line counts it `scheduled`. Its row and
  clock start at the first frame a machine runs it. The tasks line also
  counts what runs now (`running`), each with its own bar segment.
- A task running beyond the slots gets its own row after them until a
  slot frees. A region taller than the terminal keeps its summary whole
  and folds the rows that do not fit into one (`+8 more`); only a summary
  taller than the terminal is cut, at its foot.
- A worker row is on the results list's grid (cli.md, "The running
  list"): `running` in yellow, `miss` or `no-cache`, its usual
  duration from history (`~5.2s`, dim; `usual`, `—` for a task it never
  timed or with no `usual` to ask), the ticking elapsed time, its tree's average cores since it started and peak memory
  so far (`usage`, a `LiveUsage` of `{ cores, rssBytes }` from
  orchestrator/live-usage.ts, which looks only once the region asks),
  `blocks`, the worker (`where`, else `local`), the mark slot (a yellow
  `◆` on the critical path) and the id. Ids are identity-colored (`paintIdParts`):
  each half in a hue hashed stably from its own name (`identityHue`),
  the `#` dim — never status colors. The id is the last column and is never
  truncated.

Below the rows, the live summary section: the same section
(`formatSummarySection`) the final footer prints, filling in as the run
proceeds, so the live numbers and the final summary can never
disagree.

### Lifecycle

`defaultLogger` drives it through the optional `runStart` /
`taskStart` / `taskComplete` / `runEnd` hooks. A 100 ms unref'd ticker
advances the elapsed times between events (there is no spinner). Focused flow:
the region lives only while dependency nodes run and is killed
permanently when a requested node starts streaming.

## `src/report/framed-output.ts` — Turbo-style framed blocks

### Purpose

Format the per-task framed output block and the two compact one-liners
(quiet cache hit, broad-mode executed). Pure functions; the logger
calls them at the right moments.

There is no top-of-run header. The run banner — version, the
affected-projects bar, worker pool, cache mode — lives in the
**footer** (`summary.ts`'s `RunContext`), printed once at the end
where the eye lands. See `docs/modules/report.md`.

### Public surface

```ts
export interface OutputChunk {
  text: string
  err: boolean // stderr: its lines render red when colour is on
}

export interface TaskBlockBody {
  output?: readonly OutputChunk[] // in the order written, under `├─ OUTPUT ──…`
  droppedStdout?: number // chars a bounded (persistent) capture dropped from the head
  droppedStderr?: number
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: TaskBlockBody,
  colors?: ColorSupport,
  forceCommand?: boolean, // `$ cmd` even on a hit: a focused requested task's frame
  forwardArgs?: readonly string[], // the args after `--`, on a requested task's `$` line
  links?: boolean, // the terminal opens OSC 8: a failed task's file paths link to the file
): string

// `success local … <id>` — quiet cache hit
export function formatTaskHitLine(node, outcome, colors?, onPath?, blocks?): string

// `success miss … <id>` — broad-mode executed task
export function formatTaskExecutedLine(node, outcome, colors?, onPath?, blocks?, usualMs?): string
// ` flaky - failed N× before · N attempts`, dim — on a flaky task's row and
// frame footer; '' when the run did not prove it flaky (`outcome.attempts.flaky`)
export function flakyNote(outcome, colors?): string
// `skipped — … <id> • blocked by <id>` (or `• needs linux-x64,
// this is darwin-arm64`, its `exec.platforms`) — a skip never ran
export function formatTaskSkippedLine(
  node,
  colors?,
  skip?: { blockedBy?; otherPlatform? },
  blocks?,
): string
// `aborted — … <time> … <id>` — killed by a shutdown signal;
// `not run — … <id>` — the stop reached it before it ran
export function formatTaskAbortedLine(node, outcome, colors?, blocks?): string
// the grid they all share, no glyph: `<status> <cache> <usual> <time> <cpu> <mem>
// <outputs> <blocks> <worker> <mark> <id>`, the status at column 12 in its outcome's colour;
// every empty cell shows `—`, and the mark is a yellow `◆` on the critical path
export function formatTaskRow(
  ms,
  status,
  statusColor,
  cache,
  cacheColor,
  paintedId,
  colors?,
  cells?: RowCells, // { usual?, cpu?, memBytes?, outputBytes?, blocks?, worker?, critical? }
): string
// the headers: `status cache ±usual time cpu mem outputs blocks worker task`,
// the live list's `usual` where the results list has `±usual`
export function formatListHeader(colors?): string
// the results list under its header, as a Block: the run's Tasks panel body and `vx last`'s
export function taskList(rows: ((colors) => string)[]): ui.Block
// a row history kept (`RecordedRow`: status, cache hit, time, cpu, mem, outputs, blocks,
// placement; a cached failure with no cache hit recorded is a failed restore),
// drawn as the run drew it, `note` dim after the id, `±usual` against `usualMs` (history's now)
export function formatRecordedRow(r: RecordedRow, colors?, note?, usualMs?): string
// `--dry`'s list: a `PlannedRow` per task (words, usual, worker); its `head` (the running
// header) rides the section's title line
export function planList(rows: PlannedRow[]): ui.Block
// a usual time: `~5.2s`, `~42s`, `~2m 05s`
export function formatExpected(ms): string
// a size as the grid's mem and outputs cells print it: `512B`, `48KB`, `3.6MB`, `1.2GB`
export function formatSize(bytes): string
export function formatRunningHeader(colors?): string
// the grid's header, on the Tasks title line past the gutter
// `±usual`: the distance from `usualMs`, `—` for null, blank for undefined (the row then shows `—`)
export function usualCell(ms, usualMs, colors?): { text; painted }
// the `usual` cell of a task history never timed
export function unknownUsual(colors?): { text; painted }
// `project#task` halves in identity hues, hashed from `hueSource`
export function paintIdParts(hueSource, projectText, taskText, colors, opts?): string

// Focused mode's live frame around a streamed task
export function formatFrameOpen(node, colors?, forwardArgs?): string // `┌─ <id> > $ <cmd>`
export function formatFrameClose(node, outcome, colors?): string
// A held persistent task's output since ready; '' for an empty body
export function formatPersistentTailBlock(
  node,
  outcome,
  body,
  dropped?,
  colors?,
  forwardArgs?,
): string
export function formatPersistentList(nodes, colors?): string[] // `▸ <id> running` rows
```

### Task block shape

```
┌─ @vzn/vx#lint > success

$ oxlint --type-aware --type-check

├─ OUTPUT ────────────────────────────────────────────────────

Found 0 warnings and 0 errors.

└─ @vzn/vx#lint ── (327ms) success
```

The block format is:

- **Top line:** `┌─ <task-id> > <status header>`
- **`$ <command>` line:** executed tasks only (success and failed),
  dim, between blank lines, with no section label (the owner cut it);
  a requested task's line carries the args after `--`, shell-quoted and
  placed as `withForwardArgs` placed them in what ran (X-41);
  cache hits replay stored output and skip it, skips never ran
- **`├─ OUTPUT ──…` section:** present only when the output is
  non-empty after trim; both streams in the order vx read them, a
  stderr line red when colour is on (as the task wrote it when it
  coloured the line itself, or when colour is off); a blank line above and below
  the content, and a head-dropped notice when the capture was bounded.
  A persistent task's tail after ready (`formatPersistentTailBlock`)
  keeps `STDOUT (since ready)` / `STDERR (since ready)` apart, since
  its two bounded tails hold no order
- **`├─ SANDBOX VIOLATIONS (n)` section:** when present — unique
  lines, verbatim, with the header in error red. `n` counts denials,
  not vx's own `vx:` notes; a section holding only notes is headed
  `SANDBOX`. The buffered renderer
  and the live frame share one builder, so a focused run shows it too
- **Bottom line:** `└─ <task-id> ── (<duration>) <status tag>`

Corners and rules render dim, section labels bold in their state
colour; ids keep identity coloring.
Content lines are **raw** — no `│` border, no indent — so terminal
wrapping never collides with frame glyphs and copy/paste is clean
(owner feedback, 2026-06). The logger blank-line-delimits blocks on
both sides (the formatter stays pure — no trailing blank inside the
returned string beyond the final newline).

Group tasks (no `exec`) render empty string — they aren't real tasks.

### Outcome vocabulary + colors

One vocabulary across every surface (one-liners, frames, summary,
verbose table): `success` / `restored-local` / `restored-remote` /
`up-to-date` / `failed` / `skipped` (`outcomeWord`, `events.ts`).

| Status                            | Header                                                                                                                                                                                                                                       | Footer tag            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `success`                         | dim `success`                                                                                                                                                                                                                                | dim `success`         |
| `cache-hit` (restored)            | green `restored-local • <hash>`                                                                                                                                                                                                              | dim `restored-local`  |
| `cache-hit-remote` (restored)     | cyan `restored-remote • <hash>`                                                                                                                                                                                                              | dim `restored-remote` |
| either hit with `restored: false` | green `up-to-date • <hash>`                                                                                                                                                                                                                  | dim `up-to-date`      |
| `failed`                          | bold red `failed (exit N)`, `failedLabel` (+ `, 128 + SIGKILL` above 128; a timeout reads `failed (timed out, exit 143)`; a persistent task that never became ready reads `never ready: …`; a sandboxed task's violations are counted after) | same                  |
| `skipped`                         | yellow `skipped (blocked by <id>)`, `skippedLabel`; bare `skipped` for a fail-fast skip                                                                                                                                                      | same                  |

Duration formats: `<1s` → `Nms`, ≥1s → `N.NNs`.

### Tests

`tests/framed-output.test.ts`:

- Block shape per status (cache-hit, success, failed, skipped, remote,
  up-to-date, sandbox violations).
- Group task elision.
- Color on/off (assertions strip ANSI when colors off).

## `src/report/summary.ts` — end-of-run summary lines

### Purpose

Format the closing footer block — this is the run's **only** banner.
The top-of-run header was removed; the run context (version, requested
tasks, project/task/worker counts, cache mode, projects-in-run bar) now
rides the footer above the result meters, printed once at the end where
the eye lands. Always printed after a `vx run` invocation completes
(success or failure). Counts only real tasks — group nodes are filtered
upstream by `orchestrator.run` before this function is called.

### Public surface

```ts
export interface SummaryStats {
  failed: number
  successful: number
  skipped: number
  aborted?: number // killed by a shutdown signal (final summary only); not in `total`
  notRun?: number // reached by the stop before they ran (final summary only); not in `total`
  running?: number // live: running now (not in the final summary)
  scheduled?: number // live: handed to an executor whose machine has not begun them
  blocked?: number // live: not started because a dependency has not finished
  total: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  saved?: number // ran here and saved: the legend's `↑`
  notSaved?: number // ran here with `cache: true`, succeeded, saved nothing (outputs left remote are not counted)
  miss: number
  noCache?: number // a task no cache answered for (`ranNoCache`) never consulted one
  restoreFailed?: number // failed hits whose restore threw: in no cache count, red on the bar
  left?: number // still to run: the live section's gray remainder; 0 in the final summary
  spread: { maxMs: number; minMs: number; sumMs: number; count: number } | null // the time row's per-task spread
  held?: { count: number; sumMs: number } // what an `admit` policy held, summed
  etaMs?: number // live section only: the forecast of what is left (`~3s left` on the time row)
  overMs?: number // live section only: how long the run has gone past that forecast (`+3s over`)
  emptyGroups?: readonly string[] // a run of command-less groups: their names, after `0 tasks`
  buckets?: ReadonlyMap<string, TaskBucket> // each finished task's cache bucket by its key and id; only with a remote
}

// The cache bar segment a finished task fills before its remote traffic is weighed.
export type CacheBucket =
  'miss' | 'noCache' | 'upToDate' | 'restoredLocal' | 'restoredRemote' | 'saved'
// A finished task's own bucket; none for a group, a skip, an abort or a failed restore.
export function cacheBucketOf(o: TaskOutcome): CacheBucket | undefined

export interface RunContext {
  version: string
  packageCount: number // projects with a task to run → the bar's "in run" half
  runId?: string | undefined // the whole id `vx last` takes (info row)
  executorRows?: () => readonly (readonly [string, ui.Inline])[] // executors' footer rows
  whereRunning?: (taskId: string) => string | null | undefined // a running task's executor
  usage?: (taskId: string) => { cores: number; rssBytes: number } | undefined // a running row's live cpu and mem
  blocks?: () => ReadonlyMap<string, number> // each task's downstream count: the rows' `blocks`
  usual?: (taskId: string) => number | undefined // a task's p50 from history, read once on first ask: the rows' `usual`
  concurrency?: number // worker-pool size (info row)
  remoteCacheEnabled: boolean
  cacheScope?: string | undefined // the run's scope (info row: `scope vznjs/vx:feat-x`)
  cache?: {
    local: boolean
    localWrite: boolean
    remote: boolean
    traffic: {
      readonly inFlight: number // uploads queued or running
      readonly keys: ReadonlyMap<string, { uploading: number; failures: readonly string[] }>
    } // `Cache.traffic`, a live ref: each key's uploads and remote failures
    downloads?: { readonly bytes: number } // `Cache.downloads`: what the remote hits pulled
    uploads?: { readonly bytes: number } // `Cache.uploads`: what the landed uploads pushed
    notDownloaded: () => number
  } // the layers the run used: the legend's `local 1✓ 1∅ 2↓ 1↑ · remote 3↓ 12 MB 4↑ 2.1 MB 2✗ 1⇡`
  workspaceProjectCount?: number // total projects → the bar's denominator
  warnings?: () => readonly string[] // the run's warnings → the footer's `warn` row
}

// The footer section from counted stats — the live status region renders it as the run proceeds.
export function formatSummarySection(
  stats: SummaryStats,
  totalMs: number,
  colors?: ColorSupport,
  context?: RunContext,
): string[]

export function formatRunSummary(
  outcomes: readonly TaskOutcome[],
  totalMs: number,
  colors?: ColorSupport,
  context?: RunContext,
): string[]

// The `--verbosity 1` table (RunHandoff.summaryTable): one row per real task, groups left out.
export function formatOutcomeTable(
  outcomes: readonly TaskOutcome[],
  colors?: ColorSupport,
): string[]

export function neverStarted(o: TaskOutcome): boolean
```

Nothing prints below the footer (2026-10-06): a task's own facts
ride its row. A skip is a row naming its blocker
(`formatTaskSkippedLine`), a flaky task a dim note on its row and frame
(`flakyNote`, framed-output.md). An aborted task is a row too
(`formatTaskAbortedLine`), and the tasks legend counts it in the
total, each state its own bar segment: `2 success · 1 aborted · 1 not
run · 4 total` (2026-10-14; history and telemetry still record only
the tasks that ran). A total is always the last word on its line.
`aborted` is killed by a shutdown
signal; `not run` is reached by the stop before it ran. `neverStarted`
tells them apart: an aborted outcome with no `timing.startNs`, which
only a started task carries.

`formatRunSummary` returns an array of lines (caller writes one per
`log.status`). Two leading blank lines are included so the summary stands
apart from the task list above it. The live status region renders the
same section with the same context, filling in as the run proceeds, so
it becomes the final footer. When `context` is omitted the title line
names no vx and the `projects` / `info` rows are skipped.

### Format

```
  Summary                                                                                                       vx 0.0.0
  projects  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱
            1 in run · 2 total
  tasks     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            4 success · 4 total
  cache     ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰
            local 4↑

  info      10 workers · local cache · run 01a14941-c8cf-7a3e-9b51-2f06d4e8c713
  time      248ms · max 239ms · avg 215ms · min 190ms
```

Labels pad to 8 in the 12-column gutter the title sits in, bars start at
column 12 and span 50 cells; the title line is underlined to the terminal's
edge (120 columns off a terminal), the vx version flush right. `projects` (the projects in the run vs the workspace total) leads the meter stack;
`tasks` and `cache` follow, the tasks legend carrying a dim `N total`.
An executor's own rows (`TaskExecutor.footer`, such as `@vzn/vx-dte`'s
`agents`) come next, live and at the end, under a blank line; with them
the `info` row names no worker pool. A blank line separates the meters
from the `info` row (worker pool +
cache mode: the layers the run's policy uses, `local + remote cache`,
`local cache`, `remote cache` or `no cache`; `admit held N tasks · Ns` when a policy held any — a
sum, said as one — and `run <id>`, the run's whole id as
`vx last <id>` takes it, live from the run's start; the footer of a run
a signal stopped names none, as such a run records nothing) and the `time` row: the wall time, the live
forecast (`~3s left`), then the dim `max / avg / min` spread over
executed tasks. The footer never says a fact twice (2026-10-14):
no `result` row (it only repeated the tasks, cache and time rows), a
skipped count on the tasks legend alone (skips still ride the cache
bar), and a spread value equal to one already on the row is left out,
so one executed task, or tasks that all took the same time, show no
spread. `projects` and `info` only
render when a `RunContext` is passed (the live region and the final
footer both pass one). The block above is
`formatRunSummary` on four successes of 239, 190, 215 and 216 ms with
that context, pinned in `tests/summary.test.ts`.

#### The cache bar: one segment per state, each task once

With a `RunContext.cache`, the cache bar has a segment per legend state
and each task fills one (2026-10-15), in bar order: miss (ran, saved
nothing; red), `∅` no cache (dim), `✓` fresh (green), local `↓` and
`↑` (local blue), remote `↓` and `↑` (remote dark blue), `⇡` uploading
(cyan), `✗` a remote read or write failed (red), a hit whose restore
failed (red, no legend count: it is a failure, not a miss or a hit),
skipped (yellow), and the live gray remainder. A task counts under its strongest state:
`✗`, then `⇡`, then remote `↑`, then local `↑`, then its own (`↓`,
`✓`, `∅` or miss). The task's own bucket is `cacheBucketOf`; its remote
state is its key's entry in `traffic.keys` (failures, then uploads
running, then one landed), which moves it. A failure that turned its
remote off (the layer's `off`) lands on no key: it is the run's. A task still running is
counted once it ends. The legend's numbers are the segments', each in
its segment's colour, number and glyph alike; the `local` and `remote`
words are dim (2026-10-15).
A state that shares a colour gets no new one: `↓` and `↑` of a layer
are its colour. Under `NO_COLOR` the glyphs carry the meaning. An empty
segment paints nothing. With no run context, the plain legend's
buckets stand (`3 miss · 1 no-cache · …`; a saved task is a miss there).

`⇡` is live only: the final footer prints after the run's drain, when
none is running. A run that ends with uploads still running keeps the
region, footer only, until `traffic.inFlight` reaches 0 (the logger's
`draining`, logger.md); the drain the run already does is the wait.

Colors:

- `successful` is green.
- `failed` is bold red (only shown when N > 0).
- `skipped` is yellow (only shown when N > 0).

Duration:

- `<1s` → `Nms`
- ≥1s → `N.NNs`

### Tests

`tests/summary.test.ts`:

- Mixed-status row (success + failed + skipped + cache).
- All-success rendering.
- Empty outcomes (zero-task summary).
- Stacked state meters (50 cells, fewer on a terminal narrower than the 62-column footer so bars and rule fit its width; largest-remainder allocation, every non-zero bucket gets >= 1 cell): tasks bar = failed/success/skipped, cache bar = a segment per legend state (`the bar has a segment per state, each legend count painted in its colour`); color-coded legends below each bar.
- The cache legend per layer: each task once, `✗` over `⇡` over `↑`, a task still running not counted (`the cache legend reads per layer`).
- Gradient wordmark rule (violet -> pink across the dashes).
- Failed task ids are never listed — the count lives in the legend
  (the frames above carry the names; a run can fail hundreds).
- The run context folds into the footer (version on the rule, the
  info row, the projects bar); no context keeps a bare `vx` rule.
- Aborted and not-run tasks: counted in the tasks total, each its own
  bar segment, a group in neither; a total is last on its line; their rows
  (`formatTaskAbortedLine`) byte for byte.
- Time row: blank line above, total, then the dim 'max / avg / min' spread (executed tasks only; a repeated value left out).
- No value or count appears twice in a footer (`the footer never repeats a value or a count`).
- Duration formatting (sub-second vs second+).
- A flaky task's note: exact text for a pass that failed before, a
  failure that passed before, a retry with and without history; none
  for a task the run did not prove flaky; the row it rides, dim.

## `src/report/tally.ts` — outcome tally

### Purpose

The per-run counts the end-of-run footer (`summary.ts:formatRunSummary`)
is built from, group tasks excluded.

### Public surface

```ts
export interface Tally {
  successful: number
  failed: number
  skipped: number
  cachedLocal: number // every local hit
  restoredLocal: number // …that wrote the tree
  restoredRemote: number
  upToDate: number // a hit of either layer that found the tree current
  cachedRemote: number
  aborted: number // outside `total`: the task never ran
  /** Group tasks are excluded from `total`. */
  total: number
}
export function tallyOutcomes(outcomes: readonly TaskOutcome[]): Tally
```

### Rules

- **Group tasks** (`isGroupTask(node)` true) are skipped — they aren't
  real work; counting them in "N total" would mislead the user.
- **`aborted`** → +aborted, and NOT +total: a task a shutdown signal
  took down never ran.
- **`success`** → +successful.
- **`cache-hit`** → +successful, +cachedLocal, then +restoredLocal when
  it wrote the tree or +upToDate when the tree was already current.
- **`cache-hit-remote`** → +successful, +cachedRemote, then
  +restoredRemote or +upToDate the same way.
- **`failed`** → +failed.
- **`skipped`** → +skipped.

The implementation is intentionally simple — one fold, one counter
record. Adding a new outcome status means adding one branch here and
every consumer stays in sync.

### Why this lives in `orchestrator/` and not `graph/`

`TaskOutcome` (and the scheduler that produces it) live in `graph/`,
but the tally is a presentation-layer concern — the footer consumes it. Keeping it under `orchestrator/` keeps the
graph layer scheduler-only.

### Tests

`tests/tally.test.ts` pins the bucket rules; `tests/summary.test.ts`
(formatRunSummary) exercises every status branch + group-task
exclusion.

## `src/report/events.ts` — run event bus + wire contract

### Purpose

`run()` never calls a `Logger` directly: every `log.X(...)` emits a
`RunEvent` through `busLogger` onto an in-process bus; the terminal
renderer is just the always-on subscriber. An embedder attaches as
another subscriber with no orchestrator change. A bus handed in through `RunOptions.bus` keeps
the embedder's subscribers across runs; what each run adds to it, the
run removes on its way out (`orchestrator.md`).

### Public surface

- `createEventBus(): EventBus` — synchronous, order-preserving fan-out
  (`emit(event)`, `subscribe(subscriber)` returning a disposer); its
  subscribers are `RunEventSubscriber`s, `(event: RunEvent) => void`.
- `busLogger(bus)` — `Logger`-shaped facade that emits events. Its
  `warn` is a `run:status` with `warn: true`, which `terminalSubscriber`
  hands to the sink's `warn` (stderr in the default logger).
- `step:start` / `step:end` carry one of vx's own steps (`vx:uploads`,
  `<plugin>:setup`), emitted only where something renders them; `run:end`
  is the graph's end and `run:done` the run's, just before the footer;
  `run:stop` says the run was stopped (once), so the region marks its rows.
  No step is a task: no outcome, history row or telemetry record holds one.
- `terminalSubscriber(sink)` — drives a concrete renderer.
- `WireEvent` + `toWireEvent` — the SERIALIZABLE projection (task ids
  instead of node back-refs; bigint ns as decimal strings), and
  `wireForwarder(send)`, the subscriber that pushes every event through
  it. Exported for an embedder that carries a run across a process
  boundary; nothing in core consumes it (the telemetry records in
  `telemetry.ts` are a separate projection).
- `TaskView` / `OutcomeView` with `projectNode` / `projectOutcome` — the
  wire's task and outcome shapes; `RunStartInfo` is the run's.
- `Measure` — a plugin's measure (`ctx.measure`), the `task:measure`
  event: `{ id, def, durationMs, cores? }`, timed as a task is.
- The outcome vocabulary, one copy for every surface: `outcomeWord`
  (`success` / `restored-local` / `restored-remote` / `up-to-date` /
  `failed` / `skipped` / `aborted`), `outcomeLabel` (the word with a failure's
  reason or a skip's blocker; `failed (cache restore failed)` for a hit
  whose restore threw, `OutcomeView.restoreFailed`, which has no exit;
  `failed (cache key not derived)` for a task whose key threw,
  `isKeyFailed(outcome)`, which is not on the wire; `failed (cache save
failed)` / `failed (output clean failed)` for a miss whose save or clean
  vx refused, `outputsFailedOf(outcome)`, which `projectOutcome` copies
  onto the view), `failedLabel`, `skippedReason`, and
  `ranNoCache` (a task no cache answered for: no
  `cache: true`, or `TaskOutcome.cache.off` — `no-cache`, never a miss;
  `--dry`'s plan asks it too). The frame footer and
  the terminal summary read these.

### Invariants

- Fan-out is synchronous, so terminal output is byte-identical to the
  pre-bus direct-call era.
- An emit reaches the subscribers there were when it began: one that
  unsubscribes during it does not take the event from the next (an
  embedder's `off()` on `run:end` did, from the terminal renderer;
  C-77), and one added during it hears the next event.
- Raw `TaskOutcome`s are NOT serializable (bigint + graph back-refs);
  anything crossing a process boundary goes through `toWireEvent`.
