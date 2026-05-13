# `vx run --tui` — interactive full-screen dashboard

> **Status:** spec. Not implemented. Architect pass next; design doc
> + implementation phases follow.

## Vision

Today `vx run` emits Turbo-style framed blocks: one block per task,
serial in stdout order, summary at the bottom. Great for CI logs;
flat for live development.

`--tui` opt-in turns the same orchestrator into an **interactive,
full-screen dashboard** that surfaces every detail of the run as it
happens. Live task list with status icons, focusable per-task log
pane, running sparkline charts (throughput / cache hit rate / CPU),
remote-cache request stream, Gantt-style timeline, keyboard
navigation. The goal: opencode / k9s / lazygit level — the kind of
TUI a developer leaves running while they work.

## Goals

- **One screen, every detail.** Status of every task, live, no
  scrolling required for the common monorepo size (up to ~100 tasks).
- **Drill in without re-running.** Select any task → see its live or
  finished output in a focused pane.
- **Live charts.** Sparkline of tasks-completed-per-second, cache hit
  rate, CPU/RSS aggregates. Remote-cache request volume + latency.
- **Gantt timeline.** Visualize the parallel timeline as it happens —
  spot serialization bottlenecks live.
- **Keyboard-first.** Mouse-optional. Every action has a key.
- **Graceful fallback.** Non-TTY, `NO_COLOR=1`, or `vx run --tui` in CI
  → falls back to the existing framed-block logger. No surprises.
- **Zero impact on the orchestrator's hot path.** Rendering is on a
  dedicated tick; event ingest is decoupled.

## Non-goals (v1)

- Mouse support. Keyboard is the contract; mouse can come later.
- Persistent across runs (a "vx ui" daemon). The TUI lives for the
  duration of a single `vx run`. A separate `vx ui` historical-runs
  browser is a future workstream.
- Editing config from inside the TUI.
- Re-run / kill / pause controls. Out of v1 — implement
  observation cleanly first, control comes next.
- Network charts of CI agents (this is a single-host TUI).
- Cross-platform terminal feature parity beyond what `tput` / common
  TTYs expose.

## Visual layout

Default layout, 80×24 minimum, scales up:

```
┌─ vx 0.0.0 — workspace: @vzn/vx ─ run 01HKQ3WT… ─── 00:00:14 ─── concurrency: 8 ┐
│                                                                                │
│ TASKS                              │ STATS                       CACHE         │
│ ┌──────────────────────────────┐   │ ┌─────────────────────┐    ┌────────────┐ │
│ │ ✓ @vzn/vx#format-check  4ms  │   │  Done       12 / 42    │    │ local   8  │ │
│ │ ✓ @vzn/vx#lint          7ms  │   │  Running     6         │    │ remote  2  │ │
│ │ ✓ pkg-a#build           2.1s │   │  Cached      8         │    │ miss   18  │ │
│ │ ⏵ pkg-b#build  ★        1.4s │   │  Failed      0         │    │ hit %  44  │ │
│ │ ⏵ pkg-c#build           0.9s │   │                        │    └────────────┘ │
│ │ ⏵ pkg-d#test            0.3s │   │  Throughput            │                   │
│ │ ⏵ pkg-e#test            0.3s │   │  ▁▂▃▅▆▇█▇▆▅▃ 2.1/s    │   REMOTE CACHE    │
│ │ ⏵ pkg-f#test            0.1s │   │                        │  ┌──────────────┐ │
│ │ ○ pkg-g#test                 │   │  CPU                   │  │  GET   142   │ │
│ │ ○ pkg-h#test                 │   │  ▂▃▅▇█▇▅▃▂▁ 38%       │  │  PUT     8   │ │
│ │ ○ pkg-i#release              │   │                        │  │  ↓ 4.2 MB    │ │
│ │ ○ @vzn/vx#ci                 │   │  Peak RSS  324 MB      │  │  ↑ 1.1 MB    │ │
│ └──────────────────────────────┘   │ └─────────────────────┘    │  p50 12ms    │ │
│                                    │                             │  p99 47ms    │ │
│ TIMELINE                           │  LOG ▸ pkg-b#build          └──────────────┘ │
│ ┌──────────────────────────────┐   │ ┌──────────────────────────────────────────┐ │
│ │ format ███                   │   │ │ tsc --build packages/pkg-b               │ │
│ │ lint   ████                  │   │ │ src/index.ts(42,3): error TS2304: ...   │ │
│ │ build  ████████████████      │   │ │ src/index.ts(48,7): error TS2304: ...   │ │
│ │ test       ████████          │   │ │ Found 2 errors. Watching for changes... │ │
│ │ ci          █████████████    │   │ │                                          │ │
│ └──────────────────────────────┘   │ └──────────────────────────────────────────┘ │
│                                                                                  │
│ ▣▣▣▣▣▣▣▣▣▣▣▣░░░░░░░░░░░░░░░░░░  12 / 42  ●●●  ETA 00:00:21                      │
└──────────────────────────────────────────────────────────────────────────────────┘
 [q] quit  [tab] focus  [↑↓] task  [enter] log  [/] filter  [g] graph  [?] help
```

Status icons:

- `○` waiting (deps not yet ready)
- `⏵` running
- `✓` succeeded (executed)
- `⊙` cache hit local
- `⊚` cache hit remote
- `✗` failed
- `⊘` skipped (upstream failed)
- `★` focused

## Panels

### Header

`vx <version> — workspace: <name> ─ run <ULID> ─ <elapsed> ─ concurrency: <N>`

Always visible. ULID short-form (8 chars). Elapsed updates every second.

### Tasks panel (left)

Vertical list of every task in the graph, in topological order (deps
above dependents). Each row:

```
<icon> <project>#<task>  <elapsed-or-status>
```

- Sorted: running first, then waiting (by topo order), then completed
  (most recent first). Or strictly topo with a colored-status column.
  v1 decision: strictly topo (predictable; users know where to look).
- One row per task; long task names truncated with ellipsis.
- Selected row gets a `★` indicator + reverse-video highlight.
- Scrollable if it overflows.

Per-task accent color by status (cyan = running, green = cached,
gray = waiting, red = failed, yellow = skipped).

### Stats panel (top right)

Live counters + sparklines:

- **Done / total.** Updates as tasks complete.
- **Running.** Current in-flight count.
- **Cached.** Sum of cache-hit + cache-hit-remote.
- **Failed.** Bold red when > 0.
- **Throughput.** Sparkline of tasks-completed-per-second over the
  last 60 samples (1Hz sample rate). Use Unicode block characters
  (`▁▂▃▄▅▆▇█`) — 8-level resolution per column.
- **CPU.** Sum of `cpuMs / wallclock_ms` across currently-running
  tasks; expressed as a percentage of CPU capacity. Sparkline of
  the last 60 samples.
- **Peak RSS.** Sum of `peakRssBytes` across the run (max across all
  completed tasks).

### Cache panel (right)

Compact summary box:

```
local    8
remote   2
miss    18
hit %   44
```

Hit % = (local + remote) / total-finished-cached-eligible tasks.

### Remote cache panel (right, below)

Visible only when `VX_REMOTE_CACHE_URL` is set:

```
GET  142
PUT    8
↓ 4.2 MB
↑ 1.1 MB
p50 12ms
p99 47ms
```

Per-second sparkline of GET+PUT volume could be added in v2.

### Timeline panel (bottom left)

Gantt-style horizontal bars, one row per project (or per task with
zoom-out). Each bar:

- X-axis: time, from run start (0) to current wallclock (right edge).
- Width: proportional to task duration.
- Start position: proportional to task start time.
- Filled block (`█`) when running or completed; faded (`░`) when
  scheduled but not yet started.
- Color: same status accents as the task list.

Auto-scales to fit the panel. For runs with >20 projects, collapses
to "top-N-by-duration" with an indicator that more are hidden.

### Log panel (bottom right)

Live stdout + stderr for the **focused** task. Lines as they arrive.
Auto-scroll to bottom unless the user has scrolled up.

Header: `LOG ▸ <project>#<task>  <status>  (<elapsed>)`

When focus changes, the buffer for the new task is displayed — all
buffers are retained for the duration of the run (capped at ~10k
lines per task; oldest lines elided with `…N more lines elided…`
marker).

### Progress bar (bottom)

```
▣▣▣▣▣▣▣▣▣▣▣▣░░░░░░░░░░░░░░░░░░  12 / 42  ●●●  ETA 00:00:21
```

- Filled blocks = completed; empty = remaining.
- Spinner (`●` rotating) when at least one task is running.
- ETA: simple linear projection from current throughput. Shown only
  when N ≥ 5 tasks have completed and throughput > 0.

### Status bar / keymap

Bottom row, dim:

```
[q] quit  [tab] focus  [↑↓] task  [enter] log  [/] filter  [g] graph  [?] help
```

Context-sensitive: when log panel is focused, shows `[esc] back
[pgup/pgdn] scroll` instead.

## Interactions (keymap v1)

| Key            | Action                                                          |
| -------------- | --------------------------------------------------------------- |
| `q` / `Ctrl+C` | Quit. SIGINT propagates; orchestrator drains; TUI tears down.   |
| `Tab`          | Cycle focus: Tasks → Log → (Stats overview if implemented).     |
| `↑` / `↓`      | Move selection in the task list (or scroll log when log-focused). |
| `Enter`        | Pin the selected task into the log panel.                       |
| `Esc`          | Return focus to the task list.                                  |
| `/`            | Open filter input; filters task list by substring match.        |
| `g`            | Toggle graph view (full-screen Gantt).                          |
| `?`            | Open help overlay.                                              |
| `pgup`/`pgdn`  | Scroll the focused panel (log or task list).                    |

Out of scope v1: re-run (`r`), kill (`x`), pause (`p`), expand task
to multi-pane diff vs cached output.

## Data model

The TUI subscribes to a typed event stream from the orchestrator.
Events:

```ts
type TuiEvent =
  | { kind: 'runStart'; runId: string; nodes: TaskNode[]; concurrency: number; remoteCacheEnabled: boolean }
  | { kind: 'taskStart'; taskId: string; startNs: bigint }
  | { kind: 'taskStdout'; taskId: string; chunk: string }
  | { kind: 'taskStderr'; taskId: string; chunk: string }
  | { kind: 'taskComplete'; taskId: string; outcome: TaskOutcome }
  | { kind: 'remoteCache'; op: 'GET' | 'PUT' | 'HEAD'; hash: string; bytes?: number; latencyMs: number; ok: boolean }
  | { kind: 'runEnd'; ok: boolean; outcomes: TaskOutcome[]; totalMs: number }
```

The TUI maintains:

- **Task state map** — by task id, with status, start/end ns, hash,
  cpuMs, peakRssBytes, buffered stdout/stderr.
- **Sparkline buffers** — 60-sample ring buffers for throughput,
  CPU%, remote-cache request rate.
- **Remote-cache stats** — running counts + latency histogram.
- **Focus + filter state** — UI-only.

## Architecture

### Library choice

**Ink** ([https://github.com/vadimdemedes/ink](https://github.com/vadimdemedes/ink))
— React for terminals. Mature, used by GitHub CLI / Vercel CLI /
opencode-class tooling. Works in Bun (treats Bun like Node).

Why not roll our own:

- We'd reimplement layout, focus, keyboard, escape-sequence
  handling, alternate-screen buffer management. All of that is solved
  in Ink.
- Ink's reconciler keeps re-renders cheap and predictable.
- Bundle size impact: Ink + react + react-reconciler ≈ ~200 KB in
  the compiled Bun binary. Acceptable.

Why not blessed / blessed-contrib:

- Older, less maintained.
- Manual layout via box coordinates; harder to compose.
- We'd still want a React-like state model on top.

Why not terminal-kit:

- Heavyweight, more imperative.

If the bundle-size cost or react dep is unacceptable, the fallback
is a hand-rolled minimal renderer using `tty.WriteStream` directly +
a small layout primitive. ~1–2 weeks of additional implementation.
**Recommendation: Ink for v1.**

### Module layout

New `src/tui/` directory:

```
src/tui/
├── tui.ts                  # entry: createTui(events): { run, dispose }
├── App.tsx                 # root Ink component
├── components/
│   ├── Header.tsx
│   ├── TaskList.tsx
│   ├── Stats.tsx           # counters + sparklines
│   ├── Cache.tsx
│   ├── RemoteCache.tsx
│   ├── Timeline.tsx
│   ├── LogPane.tsx
│   ├── ProgressBar.tsx
│   ├── StatusBar.tsx
│   └── HelpOverlay.tsx
├── primitives/
│   ├── Sparkline.tsx       # Unicode-block rendering
│   ├── StatusIcon.tsx
│   └── colors.ts           # palette shared with framed-output
├── state/
│   ├── store.ts            # reducer + selectors over TuiEvent
│   └── selectors.ts
└── input.ts                # keymap → action dispatch
```

### Integration with the orchestrator

The current `Logger` interface has 4 methods (`status`,
`taskStdout`, `taskStderr`, `taskComplete`). It's already a clean
seam, but it doesn't cover everything the TUI wants (`runStart`,
`taskStart`, `remoteCache` events).

**Option A** — grow `Logger` to a fuller event surface. Risk:
breaking the programmatic-embedder contract. Default logger gains
no-op handlers for the new methods.

**Option B** — introduce a new `Observer` slot in `RunOptions`
alongside `log`. The TUI consumes `Observer`; the existing `Logger`
keeps line semantics. The default logger and the TUI both subscribe.

**Recommendation: Option B**. Cleaner separation, smaller blast
radius on the public surface. New types:

```ts
export interface Observer {
  runStart(ev: RunStartEvent): void
  taskStart(ev: TaskStartEvent): void
  taskComplete(ev: TaskCompleteEvent): void
  remoteCache(ev: RemoteCacheEvent): void
  runEnd(ev: RunEndEvent): void
}

interface RunOptions {
  // ... existing fields
  log?: Logger
  observer?: Observer
}
```

Existing `log.taskStdout` / `log.taskStderr` continue to carry
streamed chunks; the TUI subscribes to both interfaces.

`LayeredCache` emits `remoteCache` events via a callback option
(`onRemoteRequest`) that the orchestrator wires when constructing
the TUI.

### Activation

CLI flag: `--tui`. Auto-defaults to `--tui` when:

- stdin AND stdout are TTYs, AND
- `NO_COLOR` is unset, AND
- `CI` is unset, AND
- no `--log` / custom logger is configured programmatically, AND
- `--dry` / `--graph` are not set (those skip execution; TUI is
  meaningless), AND
- terminal is at least 80×24 (smaller → fallback).

Explicit `--no-tui` always wins; `--tui` always wins over
auto-detect when the terminal supports it.

When the TUI activates, the framed-block logger is replaced; when it
falls back, the framed-block logger runs as today.

### Lifecycle

1. **Init.** Enter alternate-screen buffer (`\x1b[?1049h`), hide
   cursor, set raw stdin, install signal handlers.
2. **Subscribe.** Construct an Ink app rooted at `<App />`; pass the
   event stream + initial state.
3. **Render loop.** Ink batches re-renders via React reconciler; we
   throttle to ≤30Hz via a 33ms render-debounce in the store reducer.
4. **Tear down.** On `q` / SIGINT / runEnd:
   a. Stop the render loop.
   b. Exit alternate-screen buffer (`\x1b[?1049l`), show cursor,
      restore stdin mode.
   c. Print the standard end-of-run summary (`formatRunSummary`)
      to stdout so the user sees the same totals they'd get from
      the framed-block logger — and so the buffer-up of CI logs is
      consistent.
   d. Return the run's exit code.

### Performance

- **Render rate cap: 30Hz.** Re-renders are batched; the store's
  reducer marks dirty regions, but actual paint happens on the next
  tick. Burst stdout from a chatty task can't paint 1000 times per
  second.
- **Log buffer bound: 10k lines per task.** When exceeded, oldest
  lines are elided with a `…<N> more lines elided…` marker. Total
  RAM cap ≈ ~5–10 MB across a 100-task run.
- **Sparkline ring buffers: 60 samples × 8 series ≈ 480 bytes.** Free.
- **Event ingest decoupled from render.** The store writes to its
  internal state synchronously; React renders on its own clock.
- **No re-flow on every keystroke.** Filter input is local state;
  only the filtered list re-renders.

The hot path of the orchestrator (graph walk + spawn) is unchanged.
The Observer is fire-and-forget; an Observer that throws shouldn't
fail the run.

## Fallback

Non-TUI environments fall back to the framed-block logger
unchanged. The fallback path is the default; the TUI is opt-in or
auto-promoted only when the conditions above are met.

When `--tui` is requested but the terminal doesn't support it:

- Print one line to stderr: `vx: TUI unavailable (<reason>) — falling
back to framed output.`
- Continue with the framed-block logger.

Reasons that disqualify the TUI:

- `!stdin.isTTY` or `!stdout.isTTY`
- `process.env.NO_COLOR` set
- `process.env.CI` set
- Terminal too small (< 80×24)
- Bun version < ?.? (raw-mode stdin issue, if any)

## Charts: design details

### Sparklines (Unicode block)

```
function sparkline(samples: number[], height = 8): string {
  const max = Math.max(...samples, 1)
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  return samples.map((v) => blocks[Math.round((v / max) * (blocks.length - 1))]).join('')
}
```

Used for: throughput, CPU%, RSS (max over time), remote-cache
request rate.

### Timeline (Gantt)

Each project is a row. Each task is a horizontal bar on its row,
positioned by `wallclockStartNs` and `wallclockEndNs` (or
`hrtime.bigint()` for running tasks).

The bar width is `min(remainingWidth, ((endNs - startNs) / totalNs)
* panelWidth)`. Filled `█`. Running tasks have an animated trailing
edge (a `▌` half-block that toggles every 500ms to suggest motion).

When a project has > 5 concurrent tasks within the visible window
(parallel tests in one package), the row is sub-divided. v1: single
row per project, overlapping tasks render as the deepest-status
(running > done > waiting).

### Progress bar (overall)

Standard pattern: `▣` (filled) and `░` (empty); count of filled =
`floor(done / total * width)`.

ETA: `floor((totalMs / done) * remaining)` once `done >= 5`. Above
that threshold it's stable enough to display.

## Help overlay

`?` shows a centered modal:

```
        vx — interactive terminal UI
        ──────────────────────────

  q, Ctrl+C    Quit
  Tab          Cycle focus between panels
  ↑ / ↓        Move selection / scroll
  Enter        Pin selected task's log
  Esc          Return focus to task list
  /            Filter tasks by name
  g            Toggle timeline-only view
  ?            Toggle this help

        Press any key to dismiss
```

## Testing

Visual-snapshot testing for Ink components is mature (`ink-testing-library`):

```ts
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'

it('renders the initial task list', () => {
  const { lastFrame } = render(<App initialState={...} />)
  expect(lastFrame()).toMatchSnapshot()
})
```

Coverage targets v1:

- Each component's rendered output for representative states.
- Keymap dispatch (input → action).
- Store reducer transitions for every event kind.
- Sparkline math (table-driven; pure function).
- Timeline layout math (pure function).
- Fallback decision matrix (every disqualifying env).
- Tear-down cleanup (alternate-screen exit, cursor restore).

## Rollout

### Phase 1 — observer + minimal TUI (v0)

- Introduce `Observer` interface in orchestrator.
- Wire emit points: runStart, taskStart, taskComplete, runEnd.
- Build `src/tui/` with Header, TaskList, LogPane, ProgressBar,
  StatusBar.
- Activate via `--tui`.

Deliverables: enough to replace the framed output for a single
running task. Not yet competitive with the framed block.

### Phase 2 — stats + timeline + remote-cache

- Stats panel (throughput, CPU, RSS, sparklines).
- Cache + remote-cache panels.
- Timeline panel.
- Filter (`/`).

### Phase 3 — polish

- Help overlay.
- Auto-promotion (TTY + NO_COLOR + CI checks).
- Graceful tear-down + standard summary printed after exit.
- Visual snapshot tests.

### Phase 4 — future (out of v1)

- Mouse support.
- Re-run / kill from the TUI (`r`, `x`).
- `vx ui` — historical runs browser sourced from `cache.db`.
- Pause / resume.

## Open questions for the architect

1. **Ink or hand-roll?** Ink is the recommendation; if the bundle
   weight or react dep is rejected, the design needs to provide the
   layout/focus/render primitives.
2. **Observer vs grown Logger?** I lean Observer for separation;
   open to the architect arguing for grown Logger.
3. **Auto-default behavior.** Should `--tui` default ON when the
   terminal supports it, or stay opt-in until the polish phase?
   Default ON gives the best first impression but risks confusion
   in mixed-tooling pipelines.
4. **Where do `--summarize` / `--profile` files write to?** Still on
   exit, after tear-down. Confirm.
5. **What's the contract for programmatic embedders** that pass a
   custom `log`? Currently they suppress colors. With TUI, they
   should suppress TUI too (force framed-block — or actually, force
   their custom logger).
6. **How do we handle resize?** Ink reflows on `process.stdout` resize
   events. Validate that the timeline + sparkline panels recompute.
7. **Bun compile + Ink.** Does `bun build --compile` work with the
   Ink + react + react-reconciler tree, or does it choke on dynamic
   requires? Needs a prototype.
