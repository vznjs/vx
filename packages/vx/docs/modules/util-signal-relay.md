# `src/util/signal-relay.ts` — one stop, heard twice through a relaying parent

## Purpose

A parent that relays stop signals to vx (`npm-launcher.cjs` where Node
cannot `execve`, a global vx handing the call off) shares vx's process
group. Outside a terminal's foreground it passes on every stop, since it
cannot tell one sent to it alone from one sent to the whole group. A
group stop (`kill -TERM -<pgid>`, a hang-up to a background job) then
reached vx twice, and vx read the copy as a second stop, "now": every
task was SIGKILLed mid-cleanup (vercel/turborepo#14972, 2026-11-11).

## Public surface

```ts
export function takeSignalRelay(): boolean
export function relayedCopy(signal: string, earlier: string | undefined): boolean
```

- The parent sets `VX_SIGNAL_RELAY=1`; `bin.ts` takes it out of the env
  first, so no task and no vx it hands off to inherits it.
- `relayedCopy` is true for the same signal again under a relaying
  parent, outside the terminal's foreground. In the foreground the
  parent relays nothing, so a repeat there is the user's own and still
  means "now"; so is a different signal.

## Tests

`tests/relayed-signal.test.ts`: a group SIGTERM and a group SIGHUP
through the Node launcher, and a group SIGTERM through a hand-off, each
leave the task its grace to clean up.
