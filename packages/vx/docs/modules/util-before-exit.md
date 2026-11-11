# `src/util/before-exit.ts` — work finished before the process exits

## Purpose

A verb can start work it does not wait for, off its own path: the
workspace config's bytecode bundle (project-loader.md) builds beside a
run instead of inside its `workspace config` stage. `bin.ts` exits once
the verb answers (`exitOnceFlushed`), which would cut that work and leave
its temp dir behind, so the work registers here and `bin.ts` settles it
first, on a refusal too.

A run can also be stranded: a plugin hook that never settles leaves the
verb pending, the loop drains and `bin.ts`'s `beforeExit` ends the
process with exit 1. The run's owed work (its plugins' teardown) and the
name of the hook still awaited are kept here for that exit.

## Public surface

```ts
export function beforeExit(work: () => Promise<void>): void
export async function settleBeforeExit(): Promise<void>
export function hookStarted(plugin: string, hook: string): () => void
export function unsettledHooks(): string[]
export function owedIfStranded(work: () => Promise<void>): () => void
export async function settleStranded(): Promise<void>
```

- `beforeExit` queues `work`: a promise already running (`() => started`)
  or work that starts only once the verb has answered.
- `settleBeforeExit` runs the queue until it is empty, work that queues
  more included, and never throws (`Promise.allSettled`).
- `hookStarted` marks a plugin's hook as awaited until the call it
  returns: `plugin-host.ts`'s `safe` (every stage and factory) and
  `setup`. `unsettledHooks` lists those still awaited, as
  `plugin 'p' never settled its h hook`, for `bin.ts`'s line.
- `owedIfStranded` registers work until the call it returns withdraws
  it: `prepareRun` from its factories to its return, `run()` until its
  teardown. `settleStranded` runs what is registered, once, and never
  throws.

## Tests

`tests/config-bytecode.test.ts` ("a run that makes .vx/cache leaves the
bundle"): the run's bundle is there, with no temp dir, after the
process exits. `tests/telemetry-lifecycle.test.ts` ("a hook that never
settles"): a `setup`, `key` or `schedule` hook that never settles is
named, and the `key` and `schedule` rows' teardown runs.
