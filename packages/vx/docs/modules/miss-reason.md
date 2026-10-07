# `src/orchestrator/miss-reason.ts` — what a miss's key changed

## Purpose

A telemetry sink wants to say why a task ran: "rebuilt because a source file changed". `vx why` answers that after a run, from the run
history; this answers it during one, so a live export carries it. A
missed task's key components (captured before its command spawns)
are joined with those of the last entry the cache saved for the same
task, by `diffKeyComponents`, the rule `vx why` uses.

## Public surface

```ts
export type MissExplainer = (
  taskId: string,
  components: readonly TaskInputComponent[],
) => InputChanges | undefined
export function createMissExplainer(db: Database): MissExplainer
```

- Undefined when the cache holds no earlier entry for the task, or its
  fingerprint rows are gone; a count of 0 when the key is the entry's
  own (the entry went, so the task ran).
- Names the first ten changes; `count` is all of them. Hashes are left
  out, so a secret input's value never reaches a sink.

## Cost

`run()` creates one only when a telemetry sink exists. The first miss
reads the newest entry per task (one `GROUP BY` over `entries`); each
miss then reads its entry's `entry_inputs` by primary key. A hit asks
nothing.
