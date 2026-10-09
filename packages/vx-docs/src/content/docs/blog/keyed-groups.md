---
title: 'A key with nothing to run'
date: 2026-10-09T12:30:00Z
authors:
  - vzn
tags:
  - caching
  - migration
excerpt: 'A group task can carry cache inputs now. A task that depends on it re-runs when those files change, and nothing spawns for the group itself.'
---

Some inputs belong to no command. Test fixtures, a shared config, or the
source of a dependency that needs no build: a task should re-run when they
change, but nothing has to run for them on their own.

A group task can now carry that key:

```ts
// vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    fixtures: { cache: { inputs: { files: ['fixtures/**'] }, outputs: { files: [] } } },
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['fixtures'],
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
  },
})
```

Edit a file under `fixtures/` and `test` misses. Edit anything else and it
hits. `fixtures` spawns no process, writes no cache entry, and the run
summary does not count it. `--affected` follows it like any other edge.

## Why now

Migrated Nx and Turbo repos need it. Nx keys a task on its dependencies'
`production` files even when no task edge joins them, and Turbo hashes a
transit node per package. `@vzn/vx-migrate` used to write each of those as
a task that ran `true`. On TanStack/query that made `vx run build` report
36 tasks where Nx ran 25. They are keyed groups now: the same keys, no
processes, and the same task count as Nx.
