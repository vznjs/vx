# `src/cli/plan-format.ts` — plan → text / JSON

## Purpose

Format a `RunPlan` (from [`plan.md`](./plan.md)) as human-readable
text or structured JSON. Pure functions; no I/O.

## Public surface

```ts
export function planReport(plan: RunPlan): ui.Block // the `Plan` panel `vx run --dry` prints
export function formatPlanText(plan: RunPlan, c?: ColorSupport): string // it, rendered
export interface PlanTaskJson {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number
  executor?: string
  download?: 'deferred'
  description?: string
  affected?: AffectedReason // why `--affected` kept it (affected-tasks.md)
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string } // a `skipped` task's own platforms, and this machine's
  blockedBy?: string // a `skipped` task's root: the task off this machine's platform it depends on
}
export function formatPlanJson(plan: RunPlan, affectedBase?: string): string
```

The two formatters return a complete string with a trailing newline; the
caller writes it to stdout or a file (`Bun.write(path, out)`).

## `formatPlanText`

The `Plan` panel: one row per real task (groups are hidden, as the live
runner hides them) on the running list's grid (`planList`, the same
component and header the run draws): the glyph and words the run would
print (`cached` `local` or `remote`, `run` `miss` or `no-cache`), its
usual time from history on a task that would run (`~p50`), a remote
hit's download size under `outputs`, how many tasks are downstream of
it under `blocks` (as the run counts them), and where it would run
under `worker`. A `description` or an `--affected` reason rides the row, dim,
after the id. Painted when `c` is enabled (the run passes stdout's);
left out, the words are plain. The cache key is in `--dry=json`.

```
─ Plan 4 ─────────────────────────────────────────────────────
      time   usual status  cache      cpu    mem outputs  blocks worker       task
 ⇢                 cached  local                               1 local        @vzn/vx#format-check
 ⇣                 cached  remote                   12MB       2 local        @vzn/vx#lint  oxlint with tsgolint-backed type-aware checks
 ⏺︎           ~4.2s run     miss                                1 local        @vzn/vx#test
 ⏺︎               — run     no-cache                            0 local        @vzn/vx#dev

  tasks      4 planned · 2 cache hits (1 local, 1 remote, 12 MB) · 1 would run · 1 no-cache
  predicted  ~4.20s wall · ~4.20s total execution · 1 task never timed (+?)
```

Glyphs and words, as the run's rows use them:

| Glyph | Status    | Cache      | Plan status   |
| ----- | --------- | ---------- | ------------- |
| `⇢`   | `cached`  | `local`    | `hit-local`   |
| `⇣`   | `cached`  | `remote`   | `hit-remote`  |
| `⏺`   | `run`     | `miss`     | `miss`        |
| `⏺`   | `run`     | `no-cache` | `no-cache`    |
| `·`   | `noop`    |            | `@noop`       |
| `⊘`   | `skipped` |            | `skipped`     |
| `◌`   | `not run` |            | `not-started` |

The fields under the rows: `tasks` counts them; `predicted` prints only
when history gave the plan something to say (at least one would-run
task has a p50) and counts the would-run tasks without history as
`(+?)`; a `--cache-download` policy adds `download`: how many tasks
would keep their outputs remote and, up to three, the tasks the
eligibility gate kept eager and why.

**Placement** is the `worker` cell: the executor the plan placed the
task on, `local` when none:

```
─ Plan 2 ─────────────────────────────────────────────────────
      time   usual status  cache      cpu    mem outputs  blocks worker       task
 ⏺︎           ~4.2s run     miss                                0 vx/reapi     @vzn/vx#test
 ⏺︎               — run     miss                                0 local        @vzn/vx#docker

  tasks     2 planned · 2 would run
```

It is the executor's NAME, not a `local`/`remote` word for the cache
tier. One placement is not an executor: `@noop` marks a `remote: 'only'`
task no remote executor took. It will not run ANYWHERE this run
(dependents use the machine's ambient state), so its row reads `noop`
and the counts name it `noop`, never would-run. See
[`schema.md` § `remote`](../schema.md#remote-optional) for what pins a task
locally and what `'only'` means.

**`skipped`** is what the run skips here: a task whose `exec.platforms`
leave this machine out, and each task that depends on one. Its row
says why after the id, as the run's frame does (`needs darwin-arm64,
this is linux-x64`, `blocked by mac#build`), and the counts name it
`skipped`.

## `formatPlanJson`

One JSON object on one line, each task a `PlanTaskJson`, led by `affectedBase` (the ref the diff
was taken from) under `--affected`; `schemas/plan.json`
states it and `tests/cli-json-schemas.test.ts` holds it:

<!-- prettier-ignore -->
```json
{"tasks":[{"id":"@vzn/vx#lint","project":"@vzn/vx","task":"lint","hash":"d66cfed2a1b2c3d4","cacheStatus":"hit-remote","deps":[],"description":"oxlint with tsgolint-backed type-aware checks"}]}
```

`p50Ms`, `executor`, `download`, `affected`, `otherPlatform` and
`blockedBy` ride a task only when set, and
`predicted` and `downloadDowngrades` ride the object only when the plan
has them. The object enumerates its fields on purpose — the plan's
internal shape is not the wire — so a new `PlannedTask` field is not on
the wire until it is added here. For tooling —
`vx run <task> --dry=json | jq …`.

## Tests

`tests/plan-format.test.ts`:

- The text form hides groups, puts every real task on the run's grid,
  shows the description only when set, and says so plainly on an empty
  or all-miss plan.
- The `~p50` and `predicted` field appear only with history; a task
  without it is counted as `(+?)`; an all-hit plan has none.
- JSON carries every planning field, `p50Ms` and `predicted` when present.
- Placement: the executor name in the worker cell, `local` when the task
  carries none, a JSON field when present.
- The samples on this page are what the formatters print for the same
  fixture.
