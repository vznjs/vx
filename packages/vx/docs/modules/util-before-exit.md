# `src/util/before-exit.ts` — work finished before the process exits

## Purpose

A verb can start work it does not wait for, off its own path: the
workspace config's bytecode bundle (project-loader.md) builds beside a
run instead of inside its `workspace config` stage. `bin.ts` exits once
the verb answers (`exitOnceFlushed`), which would cut that work and leave
its temp dir behind, so the work registers here and `bin.ts` settles it
first, on a refusal too.

## Public surface

```ts
export function beforeExit(work: () => Promise<void>): void
export async function settleBeforeExit(): Promise<void>
```

- `beforeExit` queues `work`: a promise already running (`() => started`)
  or work that starts only once the verb has answered.
- `settleBeforeExit` runs the queue until it is empty, work that queues
  more included, and never throws (`Promise.allSettled`).

## Tests

`tests/config-bytecode.test.ts` ("a run that makes .vx/cache leaves the
bundle"): the run's bundle is there, with no temp dir, after the
process exits.
