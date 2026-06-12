# `orchestrator/status-line.ts` — dynamic worker region

The live status display for interactive runs. **Not a TUI**: a
fixed-height region redrawn in place with cursor-up + clear-line
escapes — no alternate screen, no cursor addressing beyond that.

## OutputWriter

`createOutputWriter(stream, opts)` is the serialization point for
**all** logger stdout. Inert (pure passthrough) on non-TTY streams and
when disabled (CI). When active:

- `setRegion(lines)` / `setStatus(line)` replace the display; unforced
  redraws are throttled (`minRedrawMs`, default 100 ms), task
  start/finish events force.
- `write(chunk)` — any ordinary content — erases the region first
  (single line: `ESC[2K\r`; taller: `\r ESC[nA ESC[J`), writes the
  content, then redraws. The region can never interleave with task
  output.
- A chunk ending mid-line (focused streaming) holds redraws until a
  newline restores column 0.
- `clearStatus()` is permanent (run end).

## formatStatusRegion

One row per worker slot plus a stats line. Slot rules (the point of
the design — the display derives from the **stable worker set**, not
the churning task set):

- Sized `min(concurrency, 10)` at runStart; the run header states the
  pool (`(N tasks, C workers)`).
- A task takes the lowest free row and **stays there for its whole
  life**; idle rows hold their place dimmed, so the height and the
  rows never shift.
- More running tasks than rows queue for a freed row and surface as
  `+k more` on the stats line.
- Ids are identity-colored (`paintIdParts`): project hue hashed
  stably from the project name, task in fixed pink — never status
  colors. Long ids middle-truncate; padding counts visible
  characters, not ANSI bytes.

Stats line, every bucket always present in fixed order (stable layout
beats compactness):

```
▶ 1 failed · 78 success · 759 left · 1090 total │ 79 miss · 252 up-to-date · 0 local · 0 remote │ 16s
```

The buckets feed from the same outcome predicates as the end-of-run
summary (`restored === false` splits up-to-date from restored-local /
restored-remote), so the live numbers and the final summary can never
disagree.

## Lifecycle

`defaultLogger` drives it through the optional `runStart` /
`taskStart` / `taskComplete` / `runEnd` hooks. A 100 ms unref'd ticker
advances the spinner and elapsed times between events. Focused flow:
the region lives only while dependency nodes run and is killed
permanently when a requested node starts streaming.
