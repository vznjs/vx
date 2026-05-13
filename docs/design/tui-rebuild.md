# TUI rebuild — learning from Turbo

> **Status:** proposal. Sole purpose: decide the next move on the TUI
> after the existing OpenTUI implementation was rejected as "trash".

## What Turbo actually does

Source: `crates/turborepo-ui/src/tui` in the turborepo monorepo
(~5,600 lines of Rust). Key files:

| File | Role |
|---|---|
| `app.rs` | App struct, run loop, `view()`, lifecycle |
| `event.rs` | Tagged-union `Event` enum (43 variants) |
| `handle.rs` | `TuiSender` / `AppReceiver` — mpsc channel pair |
| `term_output.rs` | **Per-task vt100 parser + scrollback** |
| `pane.rs` | Terminal pane widget (wraps `tui_term::PseudoTerminal`) |
| `table.rs` | Task list widget (`ratatui::Table`) |
| `popup.rs` | Centered help-popup Rect + widget |
| `search.rs`, `input.rs`, `scroll.rs`, `clipboard.rs`, … | Inputs, scroll math, OS clipboard |

### Architecture in five facts

1. **Stack:** `ratatui` (immediate-mode TUI) + `crossterm` (raw
   terminal + mouse + alt-screen) + `tui_term` + `turborepo-vt100`
   (PTY emulator widget). **No React. No reconciler. No flexbox.**
   The renderer recomputes a cell buffer every frame and the backend
   diffs it against the last sent frame at the byte level.

2. **One mpsc channel.** Events from the orchestrator (StartTask,
   TaskOutput, EndTask, Status) and from stdin (Up, Down, Search,
   Scroll, Resize) flow through a single `Event` enum into one
   `update(app, event)` function. There's no React render tree — the
   App is a plain struct, and `view(app, frame)` paints it.

3. **Per-task pseudo-terminal.** This is the secret. Each task's
   stdout is fed into a `vt100::Parser`. The parser maintains a
   screen buffer with cursor position, scrollback, ANSI colors,
   carriage-return rewrites, `\x1b[2K` clear-line, etc. When you
   select a task, the pane just renders its parser's current screen.
   Build tools that overprint (`npm install` progress bars, esbuild
   spinners, `\r`-based reflows) **work natively** — the vt100
   parser interprets them like a real terminal would.

4. **Lazy alt-screen.** The TUI **does not enter the alternate
   screen** until the first cache-miss event arrives. If everything
   is a cache hit, no TUI is ever shown. This avoids the "TUI flashes
   for 50 ms then disappears" UX my current implementation has.

5. **Persist-on-exit.** When the TUI tears down, every task's screen
   buffer is flushed to stdout as a framed block (matching the
   non-TUI output today). The TUI is a window onto the run, not a
   replacement for the framed output — it dies and leaves the
   framed-block log behind.

### The lifecycle, end-to-end

```
   orchestrator                          tui
   ─────────────                        ─────
   spawn TuiSender + AppReceiver  ──►   create App struct (no terminal yet)
                                         spawn 3ms tick interval
   StartTask("a")                  ──►   move "a" planned → running
   TaskOutput("a", bytes)          ──►   feed bytes to vt100 parser for "a"
   Status("a", "running", Miss)    ──►   ← first miss triggers `startup()`:
                                            enter alt-screen
                                            enable raw mode + mouse
                                            terminal.draw(|f| view(app, f))
   (keystroke from stdin)           ──►   input.rs decodes → Event::Down
                                         update(app, Down) advances selection
                                         draw next frame at FRAMERATE cap
   …
   EndTask("a", Success)            ──►   move "a" running → finished
   Stop(callback)                   ──►   cleanup(): leave alt-screen,
                                         persist each task's vt100 buffer
                                         to stdout, drop callback to signal
                                         the orchestrator it's safe to exit
```

### Layout

Two flex regions. That's it.

```
┌───────────────────┬────────────────────────────────────────────────┐
│  ▶ task-a         │ ┌─ task-a > running ─────────────────────────┐│
│    task-b         │ │ vite v5.2.0  dev server running at:        ││
│  ✓ task-c         │ │   ➜  Local:   http://localhost:5173/        ││
│  ⊙ task-d (cache) │ │   ➜  press h to show help                   ││
│                   │ │                                             ││
│ Tasks (/ search)  │ │                                             ││
│                   │ │                                             ││
│ ↑↓ Select         │ │ u/d - Scroll  U/D - Page  t/b - Jump        ││
│ m  More binds     │ └─────────────────────────────────────────────┘│
└───────────────────┴────────────────────────────────────────────────┘
```

`m` opens a centered modal popup with the full keymap.

`/` opens a search overlay that filters the task list (dim non-matches).

No tabs. No multi-view. No sparklines. No critical-path widget. No
parallel-% gauge. **Just the actual logs of the tasks, with the task
list to pick which one you're looking at.**

## Why our current TUI is trash

I built the wrong thing. Sources of failure, in priority order:

1. **Wrong primitive.** I'm passing chunks to `state.logLines` as
   newline-split strings. Anything with `\r`, ANSI cursor escapes,
   or `\x1b[2K` line-clears renders as garbage. Turbo feeds bytes to
   a vt100 parser; the parser does the right thing. **I would never
   get this right without a vt100 emulator** — that's the entire
   point of `xterm-headless` / `vt100`.

2. **Wrong rendering model.** React + Yoga + OpenTUI's reconciler is
   three layers of indirection between "compute the screen" and "send
   bytes to stdout." Each layer has bugs. The ghosting
   ("paralel"/"125%"), the overlays-bleeding, the cramped layout —
   all caused by OpenTUI not clearing cells correctly on diff. Turbo
   recomputes the entire frame every paint; the backend handles
   diffs.

3. **Wrong scope.** The design doc grew to 5 views, overlays,
   sparklines, critical-path DP, history aggregates. Turbo ships one
   screen and a help popup. That's it.

4. **OpenTUI is young.** v0.2.8 was published days before I used it.
   It has bugs (the painter ghosting is one; the keyboard `sequence`
   field type wasn't typed correctly; `position="absolute"` was
   underdocumented). Building production UX on a young lib while we
   also need to ship is fighting two battles.

## Three options

### Option A — Hand-roll, match Turbo's architecture exactly

**~1,800–2,500 LOC of TS.** No React, no Yoga, no OpenTUI.

Stack:
- **Raw `process.stdout`** for ANSI output.
- **`xterm-headless`** for per-task pseudo-terminal buffers
  (xterm.js's headless mode — the same VT parser VSCode and Hyper
  use; battle-tested, MIT, 0 deps).
- **Hand-rolled cell buffer + diff** for the chrome around the task
  list. Same trick ratatui uses internally — keep a 2D char/style
  grid, compute the new grid every paint, emit ANSI for cells that
  changed.
- **Keypress + resize handling** via the built-in Node `tty`
  module's readline + `process.stdout.on('resize')`.

Files we'd write:

```
src/tui/
├── renderer/
│   ├── buffer.ts        # Cell { char, fg, bg, attr } + 2D grid + diff
│   ├── ansi.ts          # encode style → SGR, position → CUP
│   ├── input.ts         # raw-mode keypress decoder (incl. mouse if we want)
│   └── screen.ts        # alt-screen lifecycle + signal handlers
├── widgets/
│   ├── task-table.ts    # left sidebar, sort by status, spinner
│   ├── terminal-pane.ts # wraps xterm-headless instance for selected task
│   └── popup.ts         # centered modal helper
├── state/
│   ├── store.ts         # plain mutable struct (no reducer)
│   └── events.ts        # tagged-union Event + dispatch()
├── tui.ts               # entry: spawn input thread, run loop
└── observer-bridge.ts   # adapter: orchestrator Observer → Event channel
```

Wins:
- Matches the only known-good architecture (Turbo's).
- No third-party UI lib to fight with.
- xterm-headless gives us correct behavior for `npm install`
  progress bars, esbuild spinners, etc.
- Easy to test (renderer just dumps cell buffers as strings).

Costs:
- 2–3 weeks of implementation work to match Turbo's polish.
- We own the cell-buffer + ANSI primitives forever.
- Resize, mouse, scroll regions, search overlay all need explicit
  implementation.

### Option B — Keep OpenTUI but cut scope to Turbo's

**~600 LOC of deletes + ~400 LOC of swaps.**

Delete:
- `src/tui/views/*.tsx` (Graph, Workers, Bottlenecks, Queue).
- 1-5 view switching in `App.tsx`.
- `src/tui/state/critical-path.ts`, all `selectFoo` selectors that
  feed views I'd delete.
- `StatsPanel`, the throughput/parallel sparkline tracking, the
  `completedSinceTick`/`remoteOpsSinceTick` counters.

Swap:
- `LogPane`'s line-buffered string array → `xterm-headless` instance
  per task. The pane reads `term.buffer.active.getLine(...)`.
- `App.tsx` becomes a single layout: TaskList (left) + TerminalPane
  (right) + StatusBar (bottom). No view switch. No multi-pane.

Wins:
- Fastest to working state (~2–3 days).
- Reuses Phase 1+2A Observer + reducer + state — those parts are
  good.
- xterm-headless still buys us correct VT handling for the log pane.

Costs:
- Still on OpenTUI; the painter bugs may keep biting. (We'd find out
  whether they were our usage or the lib itself.)
- The "stark-level god" framing of the original design is gone — we
  ship the simpler Turbo-shaped thing.

### Option C — Switch React backend to Ink, then cut scope like B

**~600 LOC of swap.**

Ink (`ink` on npm) is the production-grade React-on-terminal lib —
used by GitHub CLI, Vercel CLI, AWS Amplify, etc. v6 dropped the
yoga.wasm dep that broke `bun build --compile` (we don't compile
anyway, so even v5 works).

Wins:
- Battle-tested; the OpenTUI bugs we hit don't exist in Ink.
- Identical mental model (React component tree).
- Components are portable — same code, different shim.

Costs:
- Same xterm-headless integration work as B.
- We still write the per-task pty wiring ourselves (Ink doesn't ship
  a pty pane).
- We don't learn from Turbo's hand-rolled architecture — we'd just be
  swapping one React-on-terminal lib for another.

## Recommendation

**Option A.** Six reasons:

1. The current TUI's biggest UX problem is "I can't see what my build
   tool is actually doing because the output is mangled." That's
   100% the vt100-parser-missing problem. Both A and B fix it via
   xterm-headless; only A fixes the painter problem too.
2. The OpenTUI painter bugs aren't "I held it wrong" — they're real,
   visible, and the lib is too young to know if upstream will fix
   them on our timescale.
3. A is the only option that matches the proven architecture (Turbo,
   lazygit, fzf, btop — all hand-rolled cell buffers, immediate-mode).
4. The total LOC we'd own is comparable to what we have now
   (`src/tui/` is currently ~1,400 LOC; A would replace it with
   ~1,800–2,500). We don't ship 5× more code by going hand-rolled.
5. We retain Phase 1's Observer + Phase 2A's reducer + selectors
   (the orchestrator-side stuff). Nothing there changes for A.
6. xterm-headless is the well-trodden path — same lib VSCode uses
   for its integrated terminal. We're not pioneering.

If you want the fastest "stops being trash" path, take B — that gets
us to a usable Turbo-shaped TUI on top of OpenTUI in a few days. If
the painter problems persist, we'd cut over to A later anyway.

## What I'd actually do next (whichever option you pick)

1. **Delete the multi-view scope from current TUI** (Graph, Workers,
   Bottlenecks, Queue, StatsPanel, sparklines, critical-path,
   AutoExit countdown). Stay on Phase 2B level: task list + log pane.
2. **Add `xterm-headless` per task**, feeding `taskStdout` /
   `taskStderr` bytes (we'd need to also expose raw bytes from the
   orchestrator's Observer event, not the current `chunk: string`
   form — small breaking change to `ObserverEvent`).
3. **Adopt lazy alt-screen** — don't `enterAlternateScreen` until the
   first `cacheProbe.status === 'miss'` event. Cached-only runs
   never show the TUI.
4. **Persist-on-exit:** at teardown, dump each task's xterm-headless
   buffer as a framed block. The TUI is a window; the framed-output
   path stays the canonical record.
5. **Then** decide A vs B based on whether OpenTUI's painter
   misbehaves with the simpler layout.

## Open questions for you

1. **A, B, or C?** I lean A; happy to start with B if you want
   faster results.
2. **Should we delete the existing TUI entirely** in the first PR of
   the rebuild, or keep it behind `--tui-legacy` so you can compare?
3. **Persistent-task TUI support:** Turbo has none (their model is
   tasks-that-end). Our `vx run` supports dev-server-style persistent
   tasks. Do we render those in the task list the same way (running
   forever, no completion icon)?
