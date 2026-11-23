---
title: Spread a CI run over several machines
description: Add dte() and one CI job hands its tasks to worker jobs it starts, then reports one result.
---

Add `dte()` and your CI job starts more jobs, called **workers**, gives
them its tasks, and still reports one result.

```ts title=".vx/workspace.ts" ins={4,12-16}
import { defineWorkspace } from '@vzn/vx/config'
import { vxCache } from '@vzn/vx-cache'
import { github as ci } from '@vzn/vx-ci'
import { dte, github } from '@vzn/vx-dte'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({
  plugins: [
    bun(),
    ci(),
    vxCache({ url: 'https://vx-cache-server.acme.workers.dev', issuer: 'https://token.actions.githubusercontent.com', repository: 'acme/app' }),
    dte({
      relay: 'https://vx-dte-server.acme.workers.dev',
      workers: { linux: { machines: { cpu4: { max: 8, cpu: 4, memory: '16GB' } } } },
      adapter: github(),
    }),
  ],
})
```

:::note[Before you start]
Workers hand files back through a [remote cache](../../remote-cache/),
and meet your job at a relay you host, the [DTE server](../../servers/dte/).
:::

Install the plugin, lock the config and let vx write both workflows:

```sh
bun add -d @vzn/vx-dte
vx lock
vx dte init
```

```ansi
[1m[38;2;6;182;212mvx dte init:[0m[2m wrote .github/workflows/ci.yml[0m
[1m[38;2;6;182;212mvx dte init:[0m[2m wrote .github/workflows/vx-worker.yml[0m

[38;2;6;182;212mNext:[0m
[38;2;6;182;212m  1. Let these workflows use the relay at https://vx-dte-server.acme.workers.dev: set its ALLOW.[0m
[38;2;6;182;212m     Its ALLOW (a plain var, no secret): https://token.actions.githubusercontent.com:acme/app:ci.yml https://token.actions.githubusercontent.com:acme/app:vx-worker.yml[0m
[38;2;6;182;212m  2. A remote cache the run and the workers share: workers hand back outputs only through it. https://vznjs.github.io/vx/docs/remote-cache/[0m
[38;2;6;182;212m  3. Commit .github/workflows/ci.yml, .github/workflows/vx-worker.yml, .vx/workspace.ts and the lock (vx lock), and push.[0m
[38;2;6;182;212m  How a run spreads over workers: https://vznjs.github.io/vx/docs/distributed-task-execution/[0m
```

`ci.yml` runs `vx run`. `vx-worker.yml` is each worker's job: check out,
install, then `vx dte worker`. `max: 8` caps how many workers one run starts.

Put the `ALLOW` line it printed into the relay's settings and deploy the
relay again ([how](../../servers/dte/#2-say-who-may-use-it-allow)).
Then commit and push. No secret goes into your repository.

The run's log and job summary name the worker beside each task it ran.
A push that changes nothing starts no worker: the cache answers it.

---

To choose what CI runs, edit the last line of `ci.yml`:

```yaml title=".github/workflows/ci.yml"
      - run: bun vx run build test ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}
```

See [Distributed task execution](../../distributed-task-execution/).
