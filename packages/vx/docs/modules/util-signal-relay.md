# `src/util/signal-relay.ts` — one stop, heard twice through a relaying parent

## Purpose

A parent that relays stop signals to vx (`npm-launcher.cjs` where Node
cannot `execve`, a global vx handing the call off) shares vx's process
group. Outside a terminal's foreground it passes on every stop, since it
cannot tell one sent to it alone from one sent to the whole group. A
group stop (`kill -TERM -<pgid>`, a hang-up to a background job) then
reached vx twice, and vx read the copy as a second stop, "now": every
task was SIGKILLed mid-cleanup (vercel/turborepo#14972, 2026-11-11).

Bun's package-bin runner (`bun vx run`, the form the docs use) relays
every SIGINT too, in a terminal's foreground as well, and sets no mark:
one Ctrl-C reached vx twice, 0.2 ms apart, and the run ended with no
summary, no job summary and no grace (2026-11-12).

## Public surface

```ts
export function takeSignalRelay(): boolean
export function stopActedOn(): void
export function relayedCopy(signal: string, earlier: string | undefined): boolean
```

- The parent sets `VX_SIGNAL_RELAY=1`; `bin.ts` takes it out of the env
  first, so no task and no vx it hands off to inherits it.
- `stopActedOn` marks the end of vx's work on a stop (`holdSignals`,
  `forwardSignals`); a relayed copy follows it within 40 ms.
- `relayedCopy` is true for the same signal again under a marked parent,
  outside the terminal's foreground (there the Node launcher relays
  nothing). With no mark it is true within 40 ms of the stop when the
  parent is a launcher: it sits in vx's process group, so it heard the
  same stop (a shell's job has a group of its own), and its arguments end
  with vx's, so it ran vx for its own command line (`bun vx run build`).
  The copy took 0.2 ms; a person's second Ctrl-C comes a key press later,
  so it still means "now"; so does a different signal.

## Tests

`tests/relayed-signal.test.ts`: a group SIGTERM and a group SIGHUP
through the Node launcher, a group SIGTERM through a hand-off, and a
group SIGINT through a launcher that relays it unmarked and through the
real `bun vx`, each leave the task its grace to clean up; under that
launcher a second SIGINT 200 ms later still ends the grace at once.
