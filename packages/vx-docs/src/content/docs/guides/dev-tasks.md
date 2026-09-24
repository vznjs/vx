---
title: Dev & long-running tasks
description: Run a dev server or watcher as a persistent task, start its dependents once it prints a ready line, and let vx stop it when the run ends.
---

Start a dev server, wait until it is up, run what needs it, and stop it.
Why tasks wait for each other → [Chapter 3: Dependencies](../../guide/dependencies/)

## Steps

1. Add `persistent` to the task's `exec`: vx does not wait for it to exit.
2. Set `readyWhen` to a line the server prints when it is up (a regex).
3. Set `exec.timeout`: if the line never comes, vx kills the server and fails the task.
4. Let other tasks `dependsOn` it. They start once the line appears.
5. Run `vx run e2e`. vx starts `dev`, runs `e2e`, then stops `dev`.

## Config

```ts
// packages/web/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    dev: {
      exec: {
        command: 'vite',
        persistent: { readyWhen: 'Local:' },
        timeout: 30_000,
      },
    },
    e2e: {
      dependsOn: ['dev'],
      exec: { command: 'playwright test' },
      cache: {
        inputs: { files: ['e2e/**'], tasks: [] }, // dev is for order, not the key
        outputs: { files: ['playwright-report/**'] },
      },
    },
  },
})
```

When the run ends, vx sends the server `SIGTERM` and waits. A server that
ignores it gets a 2-second grace and is then `SIGKILL`ed. `vx run dev` on
its own keeps running until the server exits or you press `Ctrl-C`.

## Common problems

- **A persistent task with a `cache` block.** vx refuses it: a server has no result to store.
- **The browser cannot reach a sandboxed server on Linux.** List the port: `sandbox: { allow: { read: ['.'], localBinding: [5173] } }`.
- **You want to re-run tests on every change.** That is `vx watch test`, not a persistent task: it re-runs a cached task when files change.
