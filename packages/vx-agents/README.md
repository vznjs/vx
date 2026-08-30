# `@vzn/vx-agents`

Distributed execution for vx: a small **synchronizer** plus a fleet of
**persistent workers** that keep a checkout, an install and a local cache
between runs. Nx Agents' concepts, without the cloud UI.

```ts
import { defineWorkspace } from '@vzn/vx'
import { agents } from '@vzn/vx-agents'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({
  plugins: [
    agents({ endpoint: 'https://sync.internal:8787', concurrency: 8 }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

Declared before the local executor it takes every task the local one would have
run. With no `endpoint` and no `VX_AGENTS_ENDPOINT` it declines and costs
nothing, so a workspace can declare it unconditionally.

## The shape

```
vx run (CI)  ──HTTPS──►  synchronizer  ◄──HTTPS──  worker … worker
     │                                                  │
     └──────────────── remote cache (CAS) ──────────────┘
```

**The fleet is yours.** A Nomad job, a compose file, a systemd unit — anything
that keeps N `vx-agent` processes alive. Nothing in it is vx-specific, and vx
never talks to your scheduler, holds cloud credentials, or provisions anything.

**Workers persist**, which is the whole point. Per run a worker fetches the
commit and reinstalls only if the lockfile moved; a task it ran last week may
still be a **local** cache hit — a tier below the remote cache that a container
started per run can never have.

**The synchronizer is a rendezvous, not a coordinator.** It exists because an
ephemeral CI job cannot open a connection into a cluster and a worker cannot
open one back to a job that may not exist in ten minutes — but both can reach
one HTTPS endpoint. It holds a queue, streams output back, and decides the one
thing vx cannot: **which** worker, preferring one already sitting on the run's
commit.

**vx keeps the scheduler.** Assignments are one task at a time in the order
core decided. The run record, the summary and `where` attribution never leave
the `vx run` process.

## Running it

```sh
# the synchronizer — one process, no database
VX_SYNC_PORT=8787 VX_SYNC_TOKEN=… bunx vx-sync

# a worker — N of these, wherever you like
VX_AGENTS_ENDPOINT=https://sync.internal:8787 \
VX_SYNC_TOKEN=… \
VX_AGENT_WORKSPACE=/work \
VX_AGENT_IMAGE=vx-toolchain \
VX_AGENT_CORES=4 VX_AGENT_MEMORY=8192 \
VX_AGENT_MAX_ASSIGNMENTS=200 \
  bunx vx-agent
```

A worker needs `git`, the toolchain your tasks use, and read access to the
repository — it fetches the run's commit itself.

## Matching tasks to workers

A worker advertises what it is; a task declares what it needs. Both are
`exec.resources`, which core strips from the cache key, so declaring them never
invalidates anything:

```ts
e2e: {
  exec: {
    command: 'playwright test',
    resources: { cpus: 2, memory: 4096, image: 'vx-playwright' },
  },
}
```

`cpus` is cores, `memory` is megabytes, `image` matches `VX_AGENT_IMAGE`. An
axis the task omits constrains nothing; an axis a **worker** omits satisfies
only a task that did not ask — "unknown" is not "enough", and routing an 8 GB
task to a worker that never advertised its memory would turn a placement error
into someone's OOM.

## How results come back

Three kinds, three routes:

- **Exit code and logs** ride the synchronizer, live, so the CI terminal looks
  like an ordinary `vx run`.
- **Artifacts never travel worker→vx directly.** The worker saves its cache
  entry; whoever needs the bytes restores them. Another worker restoring a
  dependency is the normal path; the CI job pulling home what it asked for is
  `--download=toplevel`.
- **The run record** never left the submitter.

So a **remote cache is not optional** here. Without one, workers cannot see
each other's outputs and every one of them re-runs its upstreams.

## Requirements on your side

- The commit must be **reachable from the remote** — workers fetch it. On a
  pull request that is the merge SHA, which lives on no branch, so the worker
  fetches the SHA directly rather than cloning a branch.
- The tree should be **clean**. Uncommitted work never reaches a worker; this
  is a CI feature, and running it locally is for testing it.

## Extending

`src/protocol.ts` is the whole wire — HTTP + JSON, long-poll for work, SSE for
the stream back, deliberately dull so both ends can reach one endpoint through
any firewall. `SyncClient` is shared by the plugin and the worker on purpose:
two clients would drift on a field name with nothing to catch it until a run
hung.
