# `src/orchestrator/failure-recap.ts` — the tail the run's last block repeats

## Purpose

A failed task's frame prints when the task finishes, which in a long CI
log is thousands of lines above the end, and GitHub's API returns only
a job log's last 5,000 lines. So the run's last block repeats the end of
each failure's output (item 706). This module is the bounded capture
that block reads: a ring over the END of a task's output, and the view
of it the recap prints.

## Public surface

Its caps: `RECAP_LINES = 30` lines of each failed task's output,
`RECAP_TASK_BYTES = 8 * 1024` bytes of them, and `RECAP_TASKS = 5`
tasks with a tail (the logger names the rest), the one it exports.

```ts
export const RECAP_TASKS = 5 // tasks that get a tail; the rest are named

export interface RecapRing {
  chunks: string[]
  chars: number
  cutLines: number // newlines evicted from the head
  cutPartialBytes: number // bytes evicted from the line the kept text starts with
}

export interface RecapTail {
  text: string // the last lines: at most RECAP_LINES and RECAP_TASK_BYTES bytes
  earlierLines: number // whole lines above `text`
  cutBytes: number // bytes cut from the start of `text`'s first line
}

export function createRecapRing(): RecapRing
export function appendRecapRing(r: RecapRing, chunk: string): void
export function recapTail(r: RecapRing): RecapTail
```

## The ring

The ring holds at most `RECAP_TASK_BYTES + 1` characters however much
a task prints: the last 8 KiB of bytes lie within the last 8,192
characters, since a UTF-16 unit is at least one UTF-8 byte, and the one
extra character is the final newline the tail drops. A head chunk is
evicted whole only when what follows it still fills the ring; otherwise
it is sliced. Evicting past the cap would leave the recap fewer lines
than it has to show. Every eviction is counted: the newlines it held,
and the bytes it took from the line the kept text now starts with. So
the recap can say how much it is not showing.

`recapTail` takes the last `RECAP_LINES` lines, then the last
`RECAP_TASK_BYTES` bytes of them, cut on a character boundary. Its text
is a fresh copy (a `Buffer` round trip), so a recap entry holds nothing
of the chunks it came from, however large they were.

Five tails at the per-task cap is 40 KiB, so the recap stays under 64
KiB with no total cap of its own.

## Who holds one

`logger.ts` alone. A buffered task (every view but the single live
stream) already holds its whole output for its frame, so at a failure
the logger fills a ring from those buffers (stdout, then stderr, as the
frame orders them) and keeps only the tail. A live-streamed task keeps
no buffer, so it gets a ring at its frame-open, fed each chunk as it is
written; the ring is dropped at the outcome, pass or fail. A cache hit
is never given a ring, except the one live-streamed task, whose replay
is written through the same path.

## Tests

`tests/failure-recap.test.ts`: the exact recap block a CI run ends with
(lines 71–100 of a 100-line task that exits 3, `… 70 earlier lines`), the
control (a passing chatty task gets none), seven failures (five tails,
two named), the Actions rendering (fenced, outside every group), the
byte cap (a 20 KiB line cut to 8 KiB, on a character boundary), the
live-stream ring, each output mode, and the ring's bound over 50 MB fed
in pipe-sized chunks and in one.
