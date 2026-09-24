---
title: Remote execution
description: Run tasks on a Bazel REAPI worker pool with @vzn/vx-reapi, while the task graph and the scheduling stay on your machine.
---

Send tasks to a pool of workers; keep the graph here. Why? →
[Chapter 8: Many machines](../../guide/many-machines/)

## Steps

1. Get a server that executes: NativeLink, BuildBuddy or Buildfarm. bazel-remote only caches.
2. Declare `reapi()` with `execute: true` (below). Remote execution is never on by default.
3. Pick a worker image with `/bin/sh` and your toolchain.
4. Run `vx run build --all --dry`: each line says where the task runs (`@vx/reapi` or `@local`).
5. A task that talks to this machine (Docker, a device, a secret)? Set `exec.remote: false`.

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  plugins: [
    reapi({
      endpoint: 'grpcs://cache.example.com:443',
      execute: true, // or VX_REAPI_EXECUTE=1
      platform: { OSFamily: 'Linux', 'container-image': 'docker://node:22' },
      capacity: 64, // remote tasks at once, apart from your cores
    }),
  ],
})
```

## Which tasks stay here

- A task with no `cache` block: it has no declared inputs to send.
- `exec.remote: false`, sandboxed and persistent tasks, and what depends on them.

`node_modules` is not on a worker: make the install a task with
`remote: 'only'`, and let the others depend on it.

## It proves your declared inputs

A worker gets only the files `cache.inputs` declares. A task that fails
there and passes here reads a file it never declared.

## Reliability

- A down server is a cache miss, never a hung run.
- Uploads chunk at 128 KB. A stalled multi-message write retries once
  at 65535 bytes — `SAFE_CHUNK_BYTES` — before the task fails.

## Common problems

- **`No such file or directory` on every task.** The worker image has no `/bin/sh`. Use one with a shell.
- **Hundreds of type errors on the worker only.** `tsconfig.json` is not in `cache.inputs.files`.
- **A secret is missing on the worker.** `exec.env.passThrough` never leaves this machine: keep the task local.
