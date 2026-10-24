---
title: 'A key with nothing to run'
date: 2026-10-09T12:30:00Z
authors:
  - vzn
tags:
  - caching
  - migration
excerpt: 'A group task can carry inputs. A task that depends on it re-runs when those files change, and nothing spawns for the group itself.'
---

`fixtures` runs nothing. It only holds a key:

```ts
// packages/b/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    fixtures: { inputs: { files: ['fixtures/**'] } },
    test: {
      exec: { command: 'bun test' },
      dependsOn: ['fixtures'],
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: [] } },
    },
  },
})
```

```sh frame="terminal"
$ vx run packages/b#test
  tasks     1 success · 1 total
  cache     local 1✓

$ echo '{"user":"grace"}' > fixtures/user.json
$ vx run packages/b#test
  tasks     1 success · 1 total
  cache     local 1↑

$ echo "# readme" > README.md
$ vx run packages/b#test
  tasks     1 success · 1 total
  cache     local 1✓
```

A fixture edit re-runs `test` (`1↑`: ran and saved). A README edit
hits. The count is `1 total`: `fixtures` spawned no process and wrote
no cache entry. Linux x64, vx at `69617eb`, 2026-10-23.

## When to use one

Some inputs belong to no command: test fixtures, a shared config, the
source of a dependency that needs no build. A task should re-run when
they change, but nothing has to run for them.

- A keyed group is `inputs` with no `exec`.
- It takes no `cache`: a group writes nothing.
- `--affected` follows it like any other edge.

## Where migrations need it

Nx keys a task on its dependencies' `production` files even when no
task edge joins them, and Turbo hashes a transit node per package.
`@vzn/vx-migrate` writes each as a keyed group: the same keys, no
processes. On TanStack/query, `vx run build` counts 25 tasks, as Nx
does.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
