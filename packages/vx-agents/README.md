# `@vzn/vx-agents`

Run vx tasks on a pool of warm agents — containers, Nomad allocations or
Kubernetes pods — instead of shipping an input tree per action.

```ts
import { defineWorkspace } from '@vzn/vx'
import { agents } from '@vzn/vx-agents'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'

export default defineWorkspace({
  plugins: [
    agents({ image: 'my-toolchain:latest', count: 8, cpu: 2, memory: '3g', prepare: 'bun ci' }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

Declared before the local executor it takes every task the local one would
have run. Declared after — or with no `image` and no `VX_AGENTS_IMAGE` — it
declines and costs nothing.

## Why this exists

The Remote Execution API is built for hermetic, fine-grained actions: each one
declares a complete input tree, the server materialises it, runs, and returns
outputs. That is right when an action's inputs are a handful of files.

This workspace hands it 26 084 in one opaque `node_modules`, so every task paid
to materialise all of it before its command started — a floor of about seven
seconds, uncorrelated with the work. Linting 40 files cost the same as linting 225.

An agent is prepared once and reused, so there is no floor. Measured on the
same repo and the same command:

| task                    | REAPI  | agents | host   |
| ----------------------- | ------ | ------ | ------ |
| `lint.oxlint` (vx-otel) | 7.36 s | 175 ms | 64 ms  |
| `lint.oxfmt` (vx-reapi) | 7.45 s | 517 ms | 361 ms |
| `build.bun.linux-arm64` | 7.35 s | 476 ms | 340 ms |

Nothing is uploaded and nothing is downloaded: the agents share the workspace,
so a command reads the same bytes vx just hashed and writes its outputs where
vx expects them. No Merkle tree, no CAS, no graft, nothing to go stale between
the two.

**The trade.** A task can read files it never declared, so the declared-input
set is no longer PROVEN by execution the way a remote action proves it. vx
still hashes inputs locally, so caching is unaffected — but the completeness
of `cache.inputs` becomes something your harness enforces rather than
something the executor discovers.

## Backends

All three keep agents **warm** and exec into them. Every scheduler's natural
unit is a job that runs to completion, and dispatching one per vx task pays
container start every time — measured at ~400 ms against ~30 ms for exec'ing
into something already running.

| `backend`    | agent is          | needs           | `cpu` / `memory` |
| ------------ | ----------------- | --------------- | ---------------- |
| `docker`     | a container       | nothing         | `2` / `'3g'`     |
| `nomad`      | one job, N allocs | `nomad` on PATH | MHz / MiB        |
| `kubernetes` | a long-lived Pod  | `kubectl`       | `'2'` / `'4Gi'`  |

Each shells out to the CLI rather than vendoring a client: nothing to version,
no auth matrix to reimplement, and failure modes an operator already reads.

## The shared workspace

Every agent must see the **same files** — vx hashes them here and the command
reads them there.

- `docker` and `nomad` take a host path in `volume`, defaulting to the
  workspace root. Right for a local cluster.
- `kubernetes` takes a volume source verbatim: `{ hostPath: { path: '…' } }`
  on a single node, a ReadWriteMany claim across real ones.

vx does not pretend a remote cluster can see your laptop. A task whose files
are not there fails on its first command, loudly.

## `prepare`

Runs once before any task takes an agent — typically the install. A non-zero
exit is **fatal**: an agent that silently skipped it would run every task
against a half-built tree and report the failures as the tasks' own.

`prepareScope` defaults to `'pool'` because every built-in backend shares one
workspace, so the install belongs to the workspace rather than the agent.
Running it per agent against a shared mount is not merely wasteful — eight
concurrent `bun ci` processes fight, and the loser reports
`EEXIST: failed to symlink dependencies`. Agents that did not run it still wait
for it. Set `'agent'` when your agents have their own checkout.

## Other transports

`pool.ts` owns leasing and knows nothing about containers, so a fourth backend
is one function:

```ts
agents({ createAgent: async (index) => ({ id: `ssh-${index}`, exec, dispose }) })
```

## Things learned the hard way

- The image's `ENTRYPOINT` is **overridden**, not appended to. A toolchain
  image usually has one, and the keep-alive would otherwise become an argument
  to it — the container exits and every task reports "not running".
- An agent needs the same two `node_modules/.bin` entries core puts on a local
  task's PATH, or a package binary exits 127 remotely while working locally.
- `nomad alloc exec` and `kubectl exec` take no `-e` flags, so environment
  crosses as a shell prefix — and therefore must be quoted, or a value with a
  space becomes another command.
