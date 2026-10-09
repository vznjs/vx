---
title: 'How many tasks at once? Count the cores you are given'
date: 2026-10-09T13:40:00Z
authors:
  - vzn
tags:
  - performance
  - execution
excerpt: 'Inside a container, the CPU count a program sees is the host’s. A task runner that trusts it starts more work than the kernel will run. Here is how vx picks its worker count.'
---

A task runner's first number is how many tasks to run at once. Too few
and cores sit idle. Too many and tasks fight for the same cores, each
one slower, and the run ends later than it would have with fewer.

The obvious answer is "one per CPU". Inside a container, that answer is
wrong.

## The CPU count lies in a container

A CI job often runs in a container with a CPU limit: Docker's
`--cpus=2`, a Kubernetes `limits.cpu`, a hosted runner's plan. The
kernel enforces that limit through the job's cgroup. But the CPU count
a program reads (`navigator.hardwareConcurrency` in Bun, `os.cpus()` in
Node) is the HOST's.

So on a 32-core host, a job limited to two cores still reads 32. A
runner that starts 32 tasks there gets two cores of work done, slower,
with 30 tasks waiting on the scheduler of the kernel instead of its own.
Memory has the same trap: `os.totalmem()` reports the host's RAM, not
the container's limit.

## Read the limit the kernel enforces

On Linux, vx reads the limit from the cgroup filesystem:

- **cgroup v2**: `cpu.max` holds `<quota> <period>`, or `max` for no
  limit. `200000 100000` is two cores.
- **cgroup v1**: `cpu.cfs_quota_us` over `cpu.cfs_period_us`, where a
  quota of `-1` means no limit.

A limit set on a parent cgroup binds too, so vx walks from its own
cgroup up to the root and keeps the tightest one. The worker count is
the CPU count capped by that quota, rounded up and never below one: a
1.5-core quota gets two workers, since half a core still does work.
Memory follows the same walk (`memory.max`, or `memory.limit_in_bytes`
on v1).

On macOS there are no cgroups, so the machine's numbers stand.

## See what vx chose

`vx info` prints the worker count and where it came from:

```sh frame="terminal"
$ vx info
workers:          2 — cgroup CPU quota 2 of 32 cores
memory:           4 GB usable — cgroup limit; the machine has 128 GB
```

On a laptop the same line reads `8 — the CPU count`.

## When you know better

The default is a starting point, not a rule:

```sh
vx run test --all --concurrency 4     # exactly four
vx run test --all --concurrency 50%   # half the cores, never below one
vx run test --all --concurrency 1     # one at a time, still in graph order
```

`concurrency` in `vx.workspace.ts` sets a workspace default, and the
flag still wins. A percentage above 100% is allowed for tasks that mostly
wait on the network or disk.

## Not every task needs a core

Two kinds of work never take a worker slot:

- **Cache restores.** A hit only copies files back from the cache. It is
  disk work, so restores run on their own lane, up to twice the worker
  count, and never hold up a task that has to execute.
- **Remote tasks.** An executor that runs tasks on another machine
  declares its own `capacity`. Its tasks count against that pool, so a
  64-worker remote pool stays full even from a 10-core laptop, or a run
  with `--concurrency 1`.

The details are in [Concurrency](../../execution/#concurrency).
