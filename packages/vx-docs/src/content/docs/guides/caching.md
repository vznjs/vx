---
title: Caching
description: Declare what a task reads and writes, so vx restores the result instead of running it — and ask vx why when it did not.
---

Skip a task whose inputs did not change, and trust the result. Why? →
[Chapter 5: Caching](../../guide/caching/) and
[Chapter 6: Can you trust a hit?](../../guide/trust/)

## Steps

1. Add a `cache` block: `inputs.files` is every file the command reads, `outputs.files` what it writes (`[]` for test or lint).
2. Reads an env var? List it in `cache.inputs.env` **and** `exec.env.passThrough`.
3. Reads a file outside the package? List it in `inputs.workspaceFiles`, from the root.
4. Run it twice. The second run restores the outputs and replays the logs.
5. Unsure the list is complete? Add [`exec.sandbox`](../sandboxing/): an undeclared read fails the task.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'vite build', env: { passThrough: ['NODE_ENV'] } },
      cache: {
        inputs: {
          files: ['src/**', 'index.html', '!**/*.test.ts'],
          env: ['NODE_ENV'],
          workspaceFiles: ['tsconfig.base.json'],
        },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

## What the key holds

Always in the key: the package's `package.json`, the lockfile, the keys of the
tasks it depends on, the task's config and arguments after `--`.

What's always excluded: `node_modules`, `.git`, `.vx`, `*.tsbuildinfo`,
`vx-lock.json`, `*.bun-build`, files git ignores, the task's own outputs
and a nested project's files.

## Outputs

Declared outputs are wiped before every run and every restore, so `dist/`
ends as the cache stored it. A failed task is never saved.

## Why did it re-run?

```bash
vx why app#build
```

```console
app#build — run 019f5a02-…
  this run   2026-07-13T05:39:20.590Z · success · executed · key f7ee661520…
  previous   2026-07-13T05:37:29.550Z · success · key 8b2e9bb2e8…
  verdict    cache key changed between the previous run and this one (inputs differ)

  what changed (1 component, 41 unchanged):
    changed file  src/index.ts  a1b2c3… → d4e5f6…
```

| The verdict line says | It means |
| --- | --- |
| `cache key changed between the previous run and this one (inputs differ)` | the lines below name what changed |
| `cache key unchanged — this run was served from cache, nothing re-ran` | a hit |
| `cache key unchanged — re-executed on the same key (--no-cache / --force, or unrelated)` | you forced it, or something unkeyed |
| `cache key unchanged — this run recorded no cache outcome, so whether it re-ran is unknown` | vx does not guess |
| `` this task declares no `cache` block — it runs on every invocation; its key is folded by dependents only `` | not cached at all |

## Common problems

- **A hit after you changed something.** What changed is not declared: a file (`inputs.files`), an env var (`inputs.env`) or a root file (`inputs.workspaceFiles`).
- **Everything downstream rebuilt.** A key folds its dependencies' keys. For a dependency that is only about order, set `inputs.tasks: []`.
- **You want a clean run.** `--force` runs everything and refreshes the cache; `--no-cache` ignores it.

A fully cached 3,270-task run: vx 510ms, Turborepo 760ms, Nx 3.59s
([benchmarks](../../benchmarks/)). The key, part by part:
[Caching in depth](../../caching/).
