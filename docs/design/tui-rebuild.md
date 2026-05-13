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

## How opencode does it (and why theirs works while ours doesn't)

Opencode (`sst/opencode`, the team that *builds* OpenTUI) uses the
same renderer but with completely different bindings. Reading their
TUI (`packages/opencode/src/cli/cmd/tui`):

1. **They use `@opentui/solid`, not `@opentui/react`.** SolidJS has
   fine-grained reactivity, no VDOM, no reconciler. The renderable
   tree mutates imperatively when signals change. There's no React
   reconciler racing the OpenTUI painter — which is what's been
   causing our ghosting / overlay-bleed problems.

2. **Overlays are full-viewport absolute backdrops with `zIndex`,
   not centered popup boxes.** Their `Dialog`:

   ```tsx
   <box
     position="absolute" zIndex={3000}
     left={0} top={0}
     width={dimensions().width} height={dimensions().height}
     alignItems="center"
     paddingTop={dimensions().height / 4}
     backgroundColor={RGBA.fromInts(0, 0, 0, 150)}   // translucent fill
   >
     <box backgroundColor={theme.backgroundPanel} width={60}>
       {children}                                     // the actual popup
     </box>
   </box>
   ```

   Two things I never did:
   - `zIndex={3000}` — explicit layer ordering. Without it, OpenTUI
     doesn't reliably stack absolute-positioned children above flex
     siblings.
   - **Translucent full-screen backdrop**. They use a child box that
     fills the entire viewport with `rgba(0,0,0,150)` (~60% alpha
     dim), then center the actual popup inside via flex. My overlays
     were just a small popup box at calculated coordinates — the
     cells outside the popup never got repainted, which is why text
     bled through.

3. **They use `@opentui/keymap` for input.** A dedicated package
   with named bindings, priorities, contexts. They never write
   `useKeyboard(...)` handlers directly. Each component registers
   bindings declaratively; the manager dispatches.

4. **Solid contexts everywhere** (ThemeProvider, RouteProvider,
   DialogProvider, etc.). The state isn't a single reducer — each
   subsystem owns a context. Components subscribe via signals.

5. **Stack is `@opentui/core` + `@opentui/solid` + `@opentui/keymap`
   + `opentui-spinner`.** Plus their own UI primitives (`Dialog`,
   `Toast`, `DialogSelect`, etc.). No xterm-headless in their TUI
   — but opencode doesn't render multi-task build output, so they
   don't need a vt100 emulator. We do.

The TL;DR: **opencode runs on OpenTUI just fine because they use
Solid, not React, and use the right layering primitives**. Their
TUI is "amazing" not because they replaced OpenTUI; because they
use it the way the maintainers intended.

## Why our current TUI is trash

I built the wrong thing. Sources of failure, in priority order:

1. **Wrong primitive for log output.** I'm passing chunks to
   `state.logLines` as newline-split strings. Anything with `\r`,
   ANSI cursor escapes, or `\x1b[2K` line-clears renders as garbage.
   Turbo feeds bytes to a vt100 parser; the parser does the right
   thing. **I would never get this right without a vt100 emulator**
   — that's the entire point of `xterm-headless` / `vt100`.
   Opencode doesn't have this problem because they don't pipe
   build-tool output.

2. **Wrong React binding.** Using `@opentui/react` puts the React
   reconciler between component renders and OpenTUI's painter. The
   reconciler doesn't know about the painter's cell buffer; the
   painter doesn't know which props are "settled" yet. The ghosting
   ("paralel"/"125%"), the overlay-bleed-through, the cramped
   layout — these manifest because the reconciler decides to skip
   re-rendering a sibling while the painter still has its old cells
   written. **Opencode uses Solid and these bugs don't exist.**

3. **Missing layering primitives.** No `zIndex`, no full-viewport
   backdrop. Overlays were small popups at coordinates; the cells
   around them never got cleared.

4. **Wrong scope.** The design doc grew to 5 views, overlays,
   sparklines, critical-path DP, history aggregates. Turbo ships one
   screen and a help popup. That's it.

5. **OpenTUI is young.** v0.2.8 was published days before I used it.
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

### Option D — Switch to `@opentui/solid` + match opencode's patterns

**~1,000 LOC delete + ~1,500 LOC swap.**

This is option B retargeted at the binding that actually works.

Stack:
- `@opentui/core` (kept; the renderer is fine)
- `@opentui/solid` ← swap from `@opentui/react`
- `@opentui/keymap` ← new; replaces our `useKeyboard` handlers
- `opentui-spinner` ← optional; nice spinner widget
- `xterm-headless` ← for per-task log panes (the vt100 emulator we
  need; opencode doesn't have this but they don't render build
  output either)
- `solid-js` (~25 KB gzipped) ← replaces `react` + `@types/react`

Steps:
1. Delete `@opentui/react`, `react`, `@types/react`. Install
   `@opentui/solid`, `@opentui/keymap`, `solid-js`, `xterm-headless`.
2. tsconfig: `"jsx": "preserve"`, `"jsxImportSource": "solid-js"`.
3. Drop the 5-view scope (Graph, Workers, Bottlenecks, Queue), drop
   sparklines, drop critical-path widget. Keep: TaskList + LogPane +
   StatusBar + Help dialog.
4. Rewrite components in Solid: `function App()` returning JSX,
   `createSignal` / `createMemo` for state, `createEffect` for side
   effects. No reducer — small Solid stores in contexts.
5. Wire `xterm-headless` per task. `taskStdout` bytes go to the
   parser; LogPane reads the parser's screen buffer rows directly.
6. Use the opencode Dialog pattern for overlays: full-viewport
   `position="absolute"` `zIndex={3000}` translucent backdrop, popup
   centered inside via flex.
7. Replace our keyboard handler with `@opentui/keymap` bindings
   registered per component context.
8. Keep the orchestrator-side Observer + scheduler slots + history
   table (Phase 1) — those are clean.

Wins:
- **Uses the OpenTUI maintainers' own recommended binding.** No
  React reconciler bugs.
- **Proven in production** — opencode's TUI runs on this stack
  daily.
- xterm-headless gives us correct VT handling for build output.
- Faster than A (~1 week vs 2–3) because we're not writing a cell
  buffer.

Costs:
- Team has to learn Solid (≈ 1 hour for anyone fluent in React;
  it's a simpler model).
- Solid + OpenTUI ecosystem is smaller than React's — fewer
  copy-paste examples on the web.
- We don't escape OpenTUI's growing-pains risk — if `@opentui/core`
  ships a regression, we're affected (but opencode would also break,
  so the maintainers have strong incentive to fix fast).

## Recommendation

**Option D.** Five reasons:

1. **opencode proves it works.** Their entire TUI runs on
   `@opentui/solid` + `@opentui/keymap`, and you said it's
   "amazing." The maintainers eat their own dog food on Solid, not
   on React. Following their lead is the cheap risk-free move.
2. **The React-binding bugs evaporate.** No reconciler → no
   reconciler-vs-painter race. The ghosting and overlay-bleed I've
   been fighting are React-binding-specific.
3. **xterm-headless still solves the log-output problem.** Same
   `vt100`-emulator story as A and B; we get correct rendering of
   build-tool output regardless of which Solid binding we use.
4. **Fastest plausible path to a working TUI we're not embarrassed
   by** — ~1 week. A is 2–3 weeks. B keeps the React-binding bugs.
5. **We keep all the orchestrator-side work.** Phase 1's Observer +
   scheduler slots + history table aren't touched.

If the React-painter mismatch turns out NOT to be the real cause of
our bugs after the Solid swap, we still have option A in our back
pocket. Option D is the "minimum bet that's most likely to work";
A is the "guaranteed-correct rewrite at higher cost."

If you want the fastest "stops being trash" path, **D is now the
right answer** — option B was my pre-opencode-research guess; D
supersedes it.

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

1. **A, B, C, or D?** After studying opencode I lean **D**. A is
   only worth doing if D's Solid swap doesn't actually fix our
   problems.
2. **Should we delete the existing TUI entirely** in the first PR of
   the rebuild, or keep it behind `--tui-legacy` so you can compare?
3. **Persistent-task TUI support:** Turbo has none (their model is
   tasks-that-end). Our `vx run` supports dev-server-style persistent
   tasks. Do we render those in the task list the same way (running
   forever, no completion icon)?
