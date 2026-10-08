# `src/util/hangup.ts` — did vx start with SIGHUP ignored

## Purpose

`nohup` and a supervisor that wants a job to outlive its terminal start
it with SIGHUP ignored. A `process.on('SIGHUP')` replaces that
disposition, so `nohup vx run` stopped its run and exited 129 when the
terminal closed (2026-10-08). The POSIX idiom is to ask before
installing a handler; Node has no API for it.

## Public surface

```ts
export function hangupIgnored(): boolean
```

- Linux reads the `SigIgn` mask in `/proc/self/status`: `self` is this
  process in any pid namespace's procfs, so the sandbox's foreign mount
  (`util-procfs.md`) answers too.
- macOS asks `sigaction(SIGHUP)` through `bun:ffi` (about 1 ms, the
  trampoline's compile).
- False elsewhere and when the read fails: a handler is installed, as
  before.
- Read once per process, before the first handler: `signals.ts` and
  `vx watch` ask it before they install theirs, and a removed handler
  does not bring the ignore back.

## Tests

`tests/hangup-ignored.test.ts` (both answers, each from a fresh
process); `tests/task-tree-kill.test.ts` and
`tests/watch-signals.test.ts` (a nohup'd `vx run` and `vx watch` run on
through a hang-up; each fails with the handler installed regardless).
