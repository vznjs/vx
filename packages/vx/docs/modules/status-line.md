# `orchestrator/status-line.ts` — dynamic worker region

The live status display for interactive runs. **Not a TUI**: a
region redrawn in place with cursor-up + clear-line escapes — no
alternate screen, no cursor addressing beyond that.

## OutputWriter

`createOutputWriter(stream, opts)` is the serialization point for
**all** logger stdout. Inert (pure passthrough) on non-TTY streams and
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
- `write(chunk)` — any ordinary content — erases the region first
  (single line: `ESC[2K\r`; taller: `\r ESC[nA ESC[J`), writes the
  content, then redraws. The region can never interleave with task
  output. The erase always uses the height of the **previous** draw;
  the new draw establishes the new height, so the region may grow and
  shrink freely (pins arriving).
- A chunk ending mid-line (focused streaming) holds redraws until a
  newline restores column 0.
- `clearStatus()` is permanent (run end).

Off a TTY, `coalesce: true` holds writes and hands them to the stream
once per turn of the event loop (`setImmediate`), in order; `settle()`
hands over what is held and writes straight through from then on. A
warm 476-package run wrote each of its 952 task lines as its own
syscall; coalesced, the warm run's wall went 184.0 → 167.8 ms (min of
15, interleaved compiled binaries, item 753). Only `run()`'s own
terminal logger asks for it (a caller reading a stream right after a
write still sees it), and it settles in `runEnd`, before the summary
prints below the held lines, and again in `run()`'s `finally` for a
throw that never reached `runEnd`: nothing is held when the verb
returns and `bin.ts` lets the loop drain. A TTY is never coalesced; its region redraws already serialise
the writes.

## formatStatusRegion

A blank separator line, a pinned zone, one row per worker slot, then
the live summary section.

The pinned zone (owner: "always pinned until exit"):

- **Persistent** — a `▸` row (no elapsed, `running`, the id) for every
  ready persistent task (its outcome lands at ready while the child keeps running; the
  orchestrator SIGTERMs persistent children when the graph finishes,
  so runEnd is the honest end). Pins keep identity-colored ids —
  status colors only on glyph + outcome.

A failure is not pinned: it is logged the moment it happens as a
permanent row in the stream (`formatFailureLine`: red `◼`, the exec
time, `failed`, `miss` / `no-cache`, the id — the exit code and the
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
  rows never shift.
- More running tasks than rows queue for a freed row and surface as
  a `… +k more running` line under the rows.
- A worker row leads with the ticking elapsed time (no glyph), then
  `running` and the id. Ids are identity-colored (`paintIdParts`):
  project hue hashed stably from the project name, task in fixed pink —
  never status colors. The id is the last column and is never
  truncated.

Below the rows, the live summary section: the same section
(`formatSummarySection`) the final footer prints, filling in as the run
proceeds, so the live numbers and the final summary can never
disagree.

## Lifecycle

`defaultLogger` drives it through the optional `runStart` /
`taskStart` / `taskComplete` / `runEnd` hooks. A 100 ms unref'd ticker
advances the elapsed times between events (there is no spinner). Focused flow:
the region lives only while dependency nodes run and is killed
permanently when a requested node starts streaming.
