# How Claude Code does its TUI

> Notes from reverse-engineering `@anthropic-ai/claude-code` v2.1.42's
> bundled `cli.js` (~7,500 LOC after minification). Answers the
> question "their TUI is great — what are they doing?".

## TL;DR

Claude Code is **not built on Ink directly**. They use
[`react-reconciler`](https://www.npmjs.com/package/react-reconciler)
(the same primitive Ink uses) with **their own custom cell-buffer
renderer**. They wrote it because Ink's renderer wasn't enough.

This matches **Option A** from `docs/design/tui-rebuild.md` —
hand-rolled cell buffer. The Claude Code team chose it for the same
reasons our OpenTUI experience has been bad: existing libs are leaky.

## The architecture, in pieces I could identify

### React Reconciler

Confirmed by `Reconciler(` calls and `useInput`, `useApp`,
`useFocus`, `measureElement`, `render` being the Ink-style API. They
present an Ink-compatible component API but bypass Ink's renderer.

### Custom cell-buffer renderer

A `class Tb1` (minified) holds the renderer state:

```
options
log
terminal
scheduleRender
isUnmounted
isPaused
container
rootNode
renderer
stylePool        ← object pool for styles
charPool         ← object pool for cells
hyperlinkPool    ← object pool for OSC-8 hyperlinks
exitPromise
restoreConsole
unsubscribeTTYHandlers
terminalColumns
terminalRows
currentN…        ← currentNode? for the reconciler
```

The object pools eliminate per-frame GC churn — every cell is
recycled.

### Op-list intermediate representation

Their `vOA` function (visible in the bundle) accepts an array of
render ops and **collapses adjacent ones**:

| Op type                     | Collapse rule                  |
| --------------------------- | ------------------------------ |
| `stdout`                    | skip when `content === ''`     |
| `cursorMove`                | sum consecutive moves into one |
| `cursorTo`                  | last write wins                |
| `style` / `styleStr`        | last write wins                |
| `hyperlink`                 | dedupe when uri matches        |
| `cursorShow` + `cursorHide` | cancel each other              |
| `clear`                     | skip when `count === 0`        |

This is why their rendering is buttery — they emit the _minimum_
byte sequence to update the screen.

### Synchronous stdout writes

```
import { writeSync as Nb1 } from "fs"
```

They use `fs.writeSync(1, …)` not `process.stdout.write(…)`. The
sync variant guarantees the bytes hit the terminal before the next
JS event loop tick — no buffer-then-flush async race.

### Screen state shape

`Xo(rows, cols, …)` initializes:

```ts
{
  screen: BS1(0, 0, rows, cols, …),   // 2D cell buffer
  viewport: { width: cols, height: rows },
  cursor: { x: 0, y: 0, visible: true },
}
```

### Other signals visible in the bundle

- `frameRate`, `throttle`, `debounce` — explicit rate-limiting paths.
- `alternateScreen` — they enter/leave alt-screen explicitly.
- `node:tty` for raw mode + mouse capture + resize events.
- KITTY / GHOSTTY / ITERM2 graphics protocols handled via OSC escapes
  for inline images, progress bars in the title bar, notifications.

## What I'd take from this

For our task-runner TUI (much narrower scope than CC), we don't need
the full stack. We need:

1. **A 2D cell buffer** with style + content per cell.
2. **An op-list compositor** that turns a target buffer into a
   minimum sequence of ANSI bytes vs. the previous frame.
3. **`fs.writeSync(1, bytes)`** for the actual emit. No
   `process.stdout.write`.
4. **A React-Reconciler-style adapter** OR a simpler Solid-style
   adapter that builds the buffer from a component tree.

That's basically Turbo's ratatui + a custom Bun-friendly backend.

## Why our OpenTUI experiments failed

OpenTUI has all the right pieces (cell buffer in Zig, FFI to JS, a
React/Solid binding) but the painter has bugs we kept hitting:

- Cells outside a re-rendered widget don't always get cleared
  (ghosting).
- Absolute-positioned overlays don't always sit above flex siblings
  without explicit `zIndex` (and even with it, ordering is fragile).
- Async layout passes mean the painter can run while React/Solid is
  still mutating the tree.

Claude Code dodged this entire class of problem by owning the
painter themselves. They give up the OpenTUI native renderer's
theoretical speed; they gain correctness and control.

## Realistic options for us, revisited

After seeing CC:

1. **Stay on OpenTUI/Solid** — current state. Has been laggy and
   buggy. Probably "trash" forever unless OpenTUI matures.
2. **Switch to Ink** — battle-tested React-on-terminal. CC went
   beyond Ink, but for our scope (task list + log pane) Ink should
   be fine. ~1-2 days to swap.
3. **Hand-roll like Claude Code** — own the cell buffer + ANSI op
   list + sync writes. ~2 weeks. Highest correctness ceiling.
4. **Drop the TUI entirely** — invest in a great non-TUI output
   instead. Turbo's framed-block output is already very good; we
   could add a sticky progress bar at the bottom of the
   terminal-output via the BasicSpinner pattern, no alt-screen.

If you want "Claude Code level" eventually, the path is 3. If you
want "stops being trash this week", the path is 2 (Ink) or 4 (no
TUI, just better non-TUI).
