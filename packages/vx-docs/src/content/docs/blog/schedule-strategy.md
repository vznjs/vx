---
title: 'Pick the order your graph wants'
date: 2026-10-09T17:00:00Z
authors:
  - vzn
tags:
  - performance
  - execution
excerpt: 'One line in vx.workspace.ts picks which ready task starts first when there are no timings yet. The default is unchanged, and a history plugin still leads.'
---

When more tasks are ready than workers, something picks which one
starts. Without timings every rule is a guess, and
[each guess loses some graph](../scheduling-strategies/). Now you pick
the guess:

```ts
// vx.workspace.ts
export default {
  schedule: 'critical-path',
}
```

| `schedule` | Starts first |
| --- | --- |
| `most-work` (default) | The task the most work waits on, at any depth |
| `critical-path` | The task at the head of the longest chain of tasks |
| `direct-dependents` | The task the most tasks wait on directly |
| `ready-order` | The task that became ready first |

## Plugins still lead

A `schedule` plugin such as
[`@vzn/vx-schedule-history`](../../plugins/vx-schedule-history/) ranks
tasks by recorded time. Its ranking still comes first under every
strategy. The strategy only breaks its ties, and decides the order for
tasks the plugin has no timing for yet.

## It costs nothing unless you set it

The default runs the same code as before. Another strategy is computed
only when the workspace names it, and each is one pass over the graph.

## Which one?

Keep the default unless you know your graph. If a slow task with
nothing after it (a typecheck, a lint) keeps starting late, try
`ready-order` or add the history plugin. If long chains of small tasks
finish last, try `critical-path`. Once the history plugin has a run to
learn from, it picks a better order than any of these.
