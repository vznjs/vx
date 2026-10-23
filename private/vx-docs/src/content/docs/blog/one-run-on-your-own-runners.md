---
title: '$12k a year saved with vx vs Nx Cloud'
date: 2026-10-23T17:30:00Z
authors:
  - vzn
tags:
  - execution
  - plugins
  - ci
excerpt: "vx's CI is one distributed run over its own Linux and Mac runners, through a relay on the Cloudflare Workers free plan. On Nx Cloud's Team plan with Nx's agents, the same CI would cost about $12,192 a year; on vx it costs $0. How it works, end to end, the math, and what is still slow."
---

:::caution[Alpha, not released]
`@vzn/vx-dte` and `@vzn/vx-dte-relay` are alpha. They are not on npm
and not in any vx release. They are open source, MIT, in
[the vx repository](https://github.com/vznjs/vx/tree/main/packages/vx-dte),
and vx's own CI runs on them every push. Names and options may still
change.
:::

**$12,192 a year** is what this repository's CI would cost on Nx
Cloud's Team plan with Nx's agents, at the 108 runs a day it really
had last week; on vx DTE it costs $0. The math and its assumptions are in
[What it costs](#what-it-costs-next-to-nx-cloud): Nx's public prices
read 2026-10-23, Mac work and concurrent connections not counted.

Until today vx's CI had three jobs: Linux, the arm64 binary and macOS.
[#4119](https://github.com/vznjs/vx/pull/4119) made them one
distributed run. Tasks bound to a platform say so
(`exec.platforms`), and the run starts a Mac or arm worker only when
the graph has such a task.

The first green main after it, on
[49adc41](https://github.com/vznjs/vx/actions/runs/39985872848), took
1 min 59 s from job start to end, docs deploy included:

| What                                 | Count |
| ------------------------------------ | ----: |
| tasks                                |   129 |
| answered by the local cache          |    96 |
| downloaded from the remote cache     |     8 |
| ran on workers                       |    22 |
| workers that ran tasks (4 Linux, 2 Mac) |  6 |
| workers started, then cancelled as not needed | 13 |

The job's own `vx run` step took 93 s; vx's footer says 89.93 s. Each
worker's warm-up, from the dispatch to its join, and its time online:

| Worker  | Warm-up | Online |
| ------- | ------: | -----: |
| small#1 | 19.9 s  | 47.3 s |
| small#4 | 21.1 s  | 58.9 s |
| small#6 | 20.3 s  | 19.8 s |
| small#8 | 19.8 s  | 52.8 s |
| mac#17  | 37.2 s  | 52.5 s |
| mac#19  | 31.9 s  | 15.4 s |

The workers are jobs of the repository's own `vx-worker.yml`, and they
meet the run at a relay anyone can host.

## The pieces

```mermaid
flowchart TB
  orch[your CI job: vx run, the orchestrator]
  api[CI API]
  workers[your CI jobs: vx dte worker, one per worker]
  relay[(relay: one Durable Object per run)]
  cache[(your remote cache)]
  orch -->|dispatch, cancel| api
  api --> workers
  orch <-->|orders and status, encrypted| relay
  workers <-->|encrypted| relay
  workers -->|save outputs by key| cache
  cache -->|restore by key| orch
```

- **The orchestrator** is your CI job's own `vx run`. It builds the
  graph, asks the cache what it already has, plans how many workers the
  rest needs, starts them through the CI's API and hands each ready task
  to a worker with room. It runs no task itself.
- **A worker** is `vx dte worker` in a CI job of yours. It checks out the
  run's commit, joins, runs what it is sent and saves each task's output
  and declared files to the workspace's cache under the task's key. It
  reports its cores, memory and platform when it joins, and its load
  with every frame after.
- **The relay** passes messages, because CI runners take no inbound
  connection: the orchestrator and every worker dial out to it.
- **The cache** carries every file. No file travels through the relay.
  The orchestrator restores each task's outputs by its key, so the run
  reports the task as its own, as if it ran here.

Adapters start the workers: `github()` dispatches `vx-worker.yml` once
per size with the workers as a matrix and cancels the ones the run no
longer needs, `gitlab()` writes a child pipeline, `local()` uses git
worktrees and `docker()` containers on this machine.

## The relay

[`@vzn/vx-dte-relay`](https://github.com/vznjs/vx/tree/main/packages/vx-dte-relay)
is a generic package. Its one runtime dependency is
[`jose`](https://github.com/panva/jose), which checks CI OIDC tokens;
it does not import vx. Any server that speaks its
[PROTOCOL.md](https://github.com/vznjs/vx/blob/main/packages/vx-dte-relay/PROTOCOL.md)
can replace it.

- **Two requests.** A participant joins on the websocket it opens
  ([#4128](https://github.com/vznjs/vx/pull/4128)), one request, and
  falls back to an HTTP `join` only when that socket does not open.
- **One Durable Object per run** on Cloudflare, or memory on Bun. The
  object hibernates between messages, the runtime answers pings without
  waking it, and an alarm finds a participant that went silent.
- **It stores no message.** It keeps who takes part in which run, never
  what they say.
- **One var, `ALLOW`**, lists who may take part as
  `issuer:owner/repo:workflow`; every other token is refused. The
  README has a Deploy to Cloudflare button.

It fits the Workers free plan. Cloudflare's free plan allows 100,000
Durable Object requests and 100,000 rows written a day, and counts 20
incoming websocket messages as one request
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
read 2026-10-23). The relay's
[README](https://github.com/vznjs/vx/blob/main/packages/vx-dte-relay/README.md#on-cloudflare-workers)
measures a CI run of 18 participants over two minutes at about 65 Durable
Object requests and 60 rows written: about 1,500 such runs a day. A
run with 50 workers would be about three times that run's participants;
if its requests grow the same way, that is about 500 runs a day. That
second figure is an estimate, not a measurement.

## End-to-end encryption

The relay reads nothing it carries. Each worker runs a
[Noise](https://noiseprotocol.org/noise.html) handshake with the
orchestrator through it, one session per worker, on WebCrypto with no
dependency, held to the cacophony test vectors
(`packages/vx-dte/src/noise.ts`, tested in `packages/vx-dte/tests/noise.test.ts`).

```mermaid
sequenceDiagram
  participant W as worker
  participant R as relay
  participant O as orchestrator
  W->>R: join (CI OIDC token)
  R->>O: a worker joined
  W->>R: Noise message 1: e (psk), join info encrypted
  R->>O: message 1
  O->>R: Noise message 2: e, ee
  R->>W: message 2
  Note over W,O: transport keys exist only on W and O
  O->>R: order (task, keys, env), encrypted
  R->>W: order
  W->>R: begun, ran, saved, encrypted
  R->>O: status
```

- **With a run key** (`VX_DTE_SECRET`, or one an adapter makes for its
  workers) it is `Noise_NNpsk0_25519_AESGCM_SHA256`. The key is the
  pre-shared key, so a side without it cannot finish the handshake.
- **On GitHub Actions with no key** it is `Noise_NN_25519_AESGCM_SHA256`,
  and each side binds the handshake with an OIDC token of the same
  repository. No secret is stored anywhere.
- **Ephemeral keys only.** The run key never encrypts a message, so a
  leaked one opens no past run.
- **Each message names its nonce.** A message the relay changes loses
  its worker; one it replays is dropped.
- **The orchestrator claims the run** with a P-256 key made for that
  run. The relay keeps the public half and takes a request as the
  orchestrator only when it is signed by it.
- **Env travels encrypted**, and each task gets only the env its config
  passes, not the worker's whole environment.
- **Cache access is lent, never stored.** The orchestrator lends a
  worker the short-lived token its remote cache got from an OIDC
  exchange, so the worker reads and writes the cache under the run's
  rules.

## How a run schedules

Only work counts: a task that missed the cache, or one waiting on a
miss. Hits and groups need no worker, so a run the cache answers whole
starts none.

**How many workers.** At each miss, finish and join, the planner
(`packages/vx-dte/src/planner.ts`) plays the known work out on the
workers online and starting, and on N more joining after the warm-up
the first took (20 s before any has joined). It starts the fewest N
that end within 5% (5 s at least) of the best. A worker the plan needs
later starts when its warm-up nears. An idle worker leaves when the plan
ends as well without it.

**Where a task goes.** A task is sent only to a worker where it fits
now: a core free and its memory fitting what the worker's running tasks
used last time, or the worker's live load, whichever is more. It goes to
the worker that holds most of its dependencies' outputs, so a chain
stays on one machine, then to the one with fewest cores free, so workers
fill before the next takes work. A task naming `exec.platforms` runs
only on a worker of that platform.

**Which task first.** The longest tail: its recorded duration plus its
longest chain of dependants.

**What a task books.** What history measured: the most cores any of
its recent runs kept busy, and its peak memory. A task with no history gets a whole worker. One
that used 90% of its worker's cores or memory moves up one size next
run.

Each of those four is a layer you can swap with `dte({ scheduler })`
(`packages/vx-dte/src/strategy.ts`):

| Layer   | Choices (default first)                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- |
| `order` | `critical-path` (HEFT's rank), `graphene` (long and wide first, Grandl OSDI'16), `fifo`                   |
| `place` | `best-fit` (fewest cores left), `tetris` (needs aligned with what is free, SIGCOMM'14), `worst-fit`, `first-fit` |
| `book`  | `measured` (history), `margin` (a fifth more, as Borg does), `whole` (a worker each)                        |
| `scale` | `plan` (the planner above), `backlog` (cores for what is ready or running, as Spark's dynamic allocation)  |

## The simulator

`packages/vx-dte/tests/sim.ts` plays a distributed run on a virtual
clock with the plugin's own decide and dispatch code: core hands over
each miss as its dependencies end, workers join after their warm-up and
run each task for as long as it took on main. It is pure and
deterministic, so a run of minutes plays in milliseconds.
`packages/vx-dte/tests/sim.test.ts` holds every scheduling change to it: no worker
booked past its cores, every miss run once, no worker idle while a task
waits, no worker let go and started again.

Main's run at a09b987 (65 misses, recorded as a fixture, its misses
forecast right), every choice
of every layer, the rest at their defaults, 4-core workers with 20 s
warm-up. The best possible end on unlimited workers is 120.5 s:

| Strategy          | Simulated end | Workers | Utilization | Worker time |
| ----------------- | ------------: | ------: | ----------: | ----------: |
| default           |       120.5 s |      10 |         86% |    13.1 min |
| order: graphene   |       120.5 s |      10 |         89% |    12.7 min |
| order: fifo       |       120.5 s |      10 |         76% |    14.8 min |
| place: tetris     |       120.5 s |      10 |         77% |    14.6 min |
| place: worst-fit  |       120.5 s |      10 |         77% |    14.6 min |
| place: first-fit  |       120.5 s |      10 |         86% |    13.1 min |
| book: margin      |       120.5 s |      12 |         69% |    16.2 min |
| book: whole       |       348.9 s |      11 |         19% |    58.9 min |
| scale: backlog    |       120.5 s |      12 |         86% |    13.1 min |

All nine played in under a second on one machine, Bun's start included. Run it
yourself from a checkout:

```sh
bun test packages/vx-dte/tests/sim.test.ts
```

The simulator matches real runs. Main's run at
[c5d8353](https://github.com/vznjs/vx/actions/runs/40014645919), played
on its own graph with each task's measured time, CPU and memory:

| c5d8353           | Real    | Simulated |
| ----------------- | ------: | --------: |
| run end           | 113.8 s |   112.7 s |
| CPU used          |     53% |       56% |
| workers           |       4 |         4 |
| cancelled workers |       0 |         0 |

## Why not split it another way

The same graphs, played five ways on 4 vCPU machines that each take
20 s to start (checkout and install):

- **One machine.** Every task on one CI job, packed onto its 4 cores.
- **Static matrix.** N jobs written in YAML, each a fixed share of the
  tasks by count, the way test sharding is done, tuned once for the full
  run and then left as it is for every PR. A job runs again the misses its share depends on. A job whose
  share all hit still starts.
- **Build stage, then a matrix.** One job runs every task another waits
  on; then N jobs split the rest.
- **Naive DTE.** N workers start up front, each takes one task at a
  time in the order tasks got ready, and all stay until the run ends.
- **vx DTE.** The default above: critical path first, tasks booked by
  measured CPU, workers started as the plan needs them.

N is the number of workers vx DTE starts for the full run. Machine time
is what CI bills, in 4 vCPU minutes: every job and worker from its start
to its end, warm-up included. The orchestrator only coordinates, so it
runs on a 1 vCPU machine and counts a quarter, as minutes priced by vCPU
do (Nx's own credit table: 5 a minute against 20). Runners can also be
your own, self-hosted. CPU used is the work's
core-minutes over the cores of that machine time. Every way but vx DTE
is played by the planner's ideal packer, where no task slows another;
vx DTE is played by the full simulator. Run it yourself:

```sh
bun packages/vx-dte/scripts/compare.ts
```

**vx's main run, a09b987.** 65 tasks run, 45.0 core-minutes of work.
The graph is flat: 52 test shards and a few short tasks.

| Way                       |    Ends | Machine time | CPU used |
| ------------------------- | ------: | -----------: | -------: |
| One machine               | 751.0 s |     12.5 min |      90% |
| Static matrix, 10 jobs    | 126.0 s |     18.3 min |      62% |
| Build stage, then 10 jobs | 190.0 s |     18.6 min |      60% |
| Naive DTE, 10 workers     | 392.8 s |     67.1 min |      17% |
| vx DTE, 10 workers        | 120.5 s |     16.9 min |      67% |

**A vx PR.** The same graph; only lint and 6 test shards miss. 16 tasks
run, 9.2 core-minutes of work. Each lane below is a job or a worker on
one clock; a bar is a task, as tall as the cores it used of the 4.
Orange is warm-up, grey is a machine up and billed with nothing on it.

<figure class="vx-gantt"><figcaption>A vx PR, as it runs</figcaption><div class="vx-gantt-way"><div class="vx-gantt-head"><span>One machine</span><span class="vx-gantt-end" style="--e:1000">189.9 s · 3.2 min</span></div><svg viewBox="0 0 1000 24" preserveAspectRatio="none" height="24" role="img" aria-label="One machine: ends 189.9 s, 3.2 machine-minutes"><rect class="w" x="0" y="0" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="0" width="894.7" height="20" style="--s:105.3;--e:1000"/><rect class="t" x="105.3" y="16.3" width="369.4" height="3.8" style="--s:105.3;--e:474.7"/><rect class="t" x="105.3" y="12.8" width="362.7" height="3.5" style="--s:105.3;--e:468"/><rect class="t" x="105.3" y="9" width="356.9" height="3.8" style="--s:105.3;--e:462.2"/><rect class="t" x="105.3" y="5.5" width="313.4" height="3.5" style="--s:105.3;--e:418.7"/><rect class="t" x="105.3" y="2" width="309.6" height="3.5" style="--s:105.3;--e:414.9"/><rect class="t" x="414.9" y="2" width="289.8" height="3.5" style="--s:414.9;--e:704.7"/><rect class="t" x="418.7" y="0" width="289.1" height="3.8" style="--s:418.7;--e:707.8"/><rect class="t" x="462.2" y="9" width="285.5" height="3.8" style="--s:462.2;--e:747.7"/><rect class="t" x="468" y="0" width="274.6" height="3.8" style="--s:468;--e:742.6"/><rect class="t" x="474.7" y="16.3" width="273.8" height="3.8" style="--s:474.7;--e:748.5"/><rect class="t" x="704.7" y="12.8" width="253.2" height="3.5" style="--s:704.7;--e:957.9"/><rect class="t" x="707.8" y="5.5" width="224.7" height="3.5" style="--s:707.8;--e:932.5"/><rect class="t" x="742.6" y="0.5" width="94.9" height="5" style="--s:742.6;--e:837.5"/><rect class="t" x="748.5" y="0" width="0.7" height="5" style="--s:748.5;--e:749.2"/><rect class="t" x="932.5" y="0" width="61.5" height="15" style="--s:932.5;--e:994"/><rect class="t" x="994" y="5" width="6" height="15" style="--s:994;--e:1000"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="24"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Static matrix, 10 jobs</span><span class="vx-gantt-end" style="--e:474.7">90.1 s · 13.2 min</span></div><svg viewBox="0 0 1000 240" preserveAspectRatio="none" height="240" role="img" aria-label="Static matrix, 10 jobs: ends 90.1 s, 13.2 machine-minutes"><rect class="w" x="0" y="0" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="0" width="309.6" height="20" style="--s:105.3;--e:414.9"/><rect class="t" x="105.3" y="16.5" width="309.6" height="3.5" style="--s:105.3;--e:414.9"/><rect class="t" x="105.3" y="1.5" width="61.5" height="15" style="--s:105.3;--e:166.8"/><rect class="w" x="0" y="24" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="24" width="289.7" height="20" style="--s:105.3;--e:395"/><rect class="t" x="105.3" y="40.5" width="289.7" height="3.5" style="--s:105.3;--e:395"/><rect class="t" x="105.3" y="35.5" width="0.7" height="5" style="--s:105.3;--e:106"/><rect class="w" x="0" y="48" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="48" width="362.7" height="20" style="--s:105.3;--e:468"/><rect class="t" x="105.3" y="64.5" width="362.7" height="3.5" style="--s:105.3;--e:468"/><rect class="t" x="105.3" y="59.5" width="94.9" height="5" style="--s:105.3;--e:200.2"/><rect class="w" x="0" y="72" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="72" width="274.6" height="20" style="--s:105.3;--e:379.9"/><rect class="t" x="105.3" y="88.3" width="274.6" height="3.8" style="--s:105.3;--e:379.9"/><rect class="t" x="105.3" y="84.8" width="224.8" height="3.5" style="--s:105.3;--e:330.1"/><rect class="w" x="0" y="96" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="96" width="369.4" height="20" style="--s:105.3;--e:474.7"/><rect class="t" x="105.3" y="112.3" width="369.4" height="3.8" style="--s:105.3;--e:474.7"/><rect class="t" x="105.3" y="108.8" width="253.3" height="3.5" style="--s:105.3;--e:358.6"/><rect class="w" x="0" y="120" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="120" width="289.1" height="20" style="--s:105.3;--e:394.4"/><rect class="t" x="105.3" y="136.3" width="289.1" height="3.8" style="--s:105.3;--e:394.4"/><rect class="w" x="0" y="144" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="144" width="356.9" height="20" style="--s:105.3;--e:462.2"/><rect class="t" x="105.3" y="160.3" width="356.9" height="3.8" style="--s:105.3;--e:462.2"/><rect class="t" x="105.3" y="145.3" width="6" height="15" style="--s:105.3;--e:111.3"/><rect class="w" x="0" y="168" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="168" width="285.5" height="20" style="--s:105.3;--e:390.8"/><rect class="t" x="105.3" y="184.3" width="285.5" height="3.8" style="--s:105.3;--e:390.8"/><rect class="w" x="0" y="192" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="192" width="273.9" height="20" style="--s:105.3;--e:379.2"/><rect class="t" x="105.3" y="208.3" width="273.9" height="3.8" style="--s:105.3;--e:379.2"/><rect class="w" x="0" y="216" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="216" width="313.4" height="20" style="--s:105.3;--e:418.7"/><rect class="t" x="105.3" y="232.5" width="313.4" height="3.5" style="--s:105.3;--e:418.7"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="240"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Build stage, then 10 jobs</span><span class="vx-gantt-end" style="--e:580">110.1 s · 13.6 min</span></div><svg viewBox="0 0 1000 264" preserveAspectRatio="none" height="264" role="img" aria-label="Build stage, then 10 jobs: ends 110.1 s, 13.6 machine-minutes"><rect class="w" x="0" y="0" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="w" x="105.3" y="24" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="24" width="309.6" height="20" style="--s:210.7;--e:520.3"/><rect class="t" x="210.7" y="40.5" width="309.6" height="3.5" style="--s:210.7;--e:520.3"/><rect class="t" x="210.7" y="25.5" width="61.5" height="15" style="--s:210.7;--e:272.2"/><rect class="w" x="105.3" y="48" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="48" width="289.7" height="20" style="--s:210.7;--e:500.4"/><rect class="t" x="210.7" y="64.5" width="289.7" height="3.5" style="--s:210.7;--e:500.4"/><rect class="t" x="210.7" y="59.5" width="0.7" height="5" style="--s:210.7;--e:211.4"/><rect class="w" x="105.3" y="72" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="72" width="362.7" height="20" style="--s:210.7;--e:573.4"/><rect class="t" x="210.7" y="88.5" width="362.7" height="3.5" style="--s:210.7;--e:573.4"/><rect class="t" x="210.7" y="83.5" width="94.8" height="5" style="--s:210.7;--e:305.5"/><rect class="w" x="105.3" y="96" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="96" width="274.6" height="20" style="--s:210.7;--e:485.3"/><rect class="t" x="210.7" y="112.3" width="274.6" height="3.8" style="--s:210.7;--e:485.3"/><rect class="t" x="210.7" y="108.8" width="224.7" height="3.5" style="--s:210.7;--e:435.4"/><rect class="w" x="105.3" y="120" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="120" width="369.3" height="20" style="--s:210.7;--e:580"/><rect class="t" x="210.7" y="136.3" width="369.3" height="3.8" style="--s:210.7;--e:580"/><rect class="t" x="210.7" y="132.8" width="253.2" height="3.5" style="--s:210.7;--e:463.9"/><rect class="w" x="105.3" y="144" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="144" width="289" height="20" style="--s:210.7;--e:499.7"/><rect class="t" x="210.7" y="160.3" width="289" height="3.8" style="--s:210.7;--e:499.7"/><rect class="w" x="105.3" y="168" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="168" width="356.8" height="20" style="--s:210.7;--e:567.5"/><rect class="t" x="210.7" y="184.3" width="356.8" height="3.8" style="--s:210.7;--e:567.5"/><rect class="t" x="210.7" y="169.3" width="6" height="15" style="--s:210.7;--e:216.7"/><rect class="w" x="105.3" y="192" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="192" width="285.5" height="20" style="--s:210.7;--e:496.2"/><rect class="t" x="210.7" y="208.3" width="285.5" height="3.8" style="--s:210.7;--e:496.2"/><rect class="w" x="105.3" y="216" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="216" width="273.8" height="20" style="--s:210.7;--e:484.5"/><rect class="t" x="210.7" y="232.3" width="273.8" height="3.8" style="--s:210.7;--e:484.5"/><rect class="w" x="105.3" y="240" width="105.4" height="20" style="--s:105.3;--e:210.7"/><rect class="o" x="210.7" y="240" width="313.4" height="20" style="--s:210.7;--e:524.1"/><rect class="t" x="210.7" y="256.5" width="313.4" height="3.5" style="--s:210.7;--e:524.1"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="264"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Naive DTE, 10 workers</span><span class="vx-gantt-end" style="--e:633.2">120.2 s · 20.5 min</span></div><svg viewBox="0 0 1000 240" preserveAspectRatio="none" height="240" role="img" aria-label="Naive DTE, 10 workers: ends 120.2 s, 20.5 machine-minutes"><rect class="w" x="0" y="0" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="0" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="5" width="61.5" height="15" style="--s:105.3;--e:166.8"/><rect class="t" x="166.8" y="16.5" width="289.8" height="3.5" style="--s:166.8;--e:456.6"/><rect class="w" x="0" y="24" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="24" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="39" width="94.9" height="5" style="--s:105.3;--e:200.2"/><rect class="t" x="200.2" y="40.5" width="362.7" height="3.5" style="--s:200.2;--e:562.9"/><rect class="w" x="0" y="48" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="48" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="64.3" width="274.6" height="3.8" style="--s:105.3;--e:379.9"/><rect class="t" x="379.9" y="64.5" width="253.3" height="3.5" style="--s:379.9;--e:633.2"/><rect class="w" x="0" y="72" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="72" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="88.3" width="369.4" height="3.8" style="--s:105.3;--e:474.7"/><rect class="w" x="0" y="96" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="96" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="112.3" width="289.1" height="3.8" style="--s:105.3;--e:394.4"/><rect class="t" x="394.4" y="111" width="0.7" height="5" style="--s:394.4;--e:395.1"/><rect class="w" x="0" y="120" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="120" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="136.3" width="356.9" height="3.8" style="--s:105.3;--e:462.2"/><rect class="w" x="0" y="144" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="144" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="160.3" width="285.5" height="3.8" style="--s:105.3;--e:390.8"/><rect class="t" x="390.8" y="149" width="6" height="15" style="--s:390.8;--e:396.8"/><rect class="w" x="0" y="168" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="168" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="184.3" width="273.9" height="3.8" style="--s:105.3;--e:379.2"/><rect class="t" x="379.2" y="184.5" width="224.7" height="3.5" style="--s:379.2;--e:603.9"/><rect class="w" x="0" y="192" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="192" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="208.5" width="313.4" height="3.5" style="--s:105.3;--e:418.7"/><rect class="w" x="0" y="216" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="216" width="527.9" height="20" style="--s:105.3;--e:633.2"/><rect class="t" x="105.3" y="232.5" width="309.6" height="3.5" style="--s:105.3;--e:414.9"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="240"/></svg></div><div class="vx-gantt-way vx-gantt-lead"><div class="vx-gantt-head"><span>vx DTE, 3 workers</span><span class="vx-gantt-end" style="--e:474.7">90.1 s · 4.4 min</span></div><svg viewBox="0 0 1000 72" preserveAspectRatio="none" height="72" role="img" aria-label="vx DTE, 3 workers: ends 90.1 s, 4.4 machine-minutes"><rect class="w" x="0" y="0" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="0" width="369.4" height="20" style="--s:105.3;--e:474.7"/><rect class="t" x="105.3" y="16.3" width="369.4" height="3.8" style="--s:105.3;--e:474.7"/><rect class="t" x="105.3" y="12.8" width="362.7" height="3.5" style="--s:105.3;--e:468"/><rect class="t" x="105.3" y="9" width="356.9" height="3.8" style="--s:105.3;--e:462.2"/><rect class="t" x="105.3" y="5.5" width="313.4" height="3.5" style="--s:105.3;--e:418.7"/><rect class="t" x="105.3" y="2" width="309.6" height="3.5" style="--s:105.3;--e:414.9"/><rect class="w" x="0" y="24" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="24" width="289.7" height="20" style="--s:105.3;--e:395"/><rect class="t" x="105.3" y="40.5" width="289.7" height="3.5" style="--s:105.3;--e:395"/><rect class="t" x="105.3" y="36.8" width="289.1" height="3.8" style="--s:105.3;--e:394.4"/><rect class="t" x="105.3" y="33" width="285.5" height="3.8" style="--s:105.3;--e:390.8"/><rect class="t" x="105.3" y="29.3" width="274.6" height="3.8" style="--s:105.3;--e:379.9"/><rect class="t" x="105.3" y="25.5" width="273.9" height="3.8" style="--s:105.3;--e:379.2"/><rect class="w" x="0" y="48" width="105.3" height="20" style="--s:0;--e:105.3"/><rect class="o" x="105.3" y="48" width="292.3" height="20" style="--s:105.3;--e:397.6"/><rect class="t" x="105.3" y="64.5" width="253.3" height="3.5" style="--s:105.3;--e:358.6"/><rect class="t" x="105.3" y="61" width="224.8" height="3.5" style="--s:105.3;--e:330.1"/><rect class="t" x="105.3" y="56" width="94.9" height="5" style="--s:105.3;--e:200.2"/><rect class="t" x="105.3" y="51" width="0.7" height="5" style="--s:105.3;--e:106"/><rect class="t" x="330.1" y="49.5" width="61.5" height="15" style="--s:330.1;--e:391.6"/><rect class="t" x="391.6" y="53" width="6" height="15" style="--s:391.6;--e:397.6"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="72"/></svg></div></figure>

| Way                       |    Ends | Machine time | CPU used |
| ------------------------- | ------: | -----------: | -------: |
| One machine               | 189.9 s |      3.2 min |      73% |
| Static matrix, 10 jobs    |  90.1 s |     13.2 min |      17% |
| Build stage, then 10 jobs | 110.1 s |     13.6 min |      17% |
| Naive DTE, 10 workers     | 120.2 s |     20.5 min |      11% |
| vx DTE, 3 workers         |  90.1 s |      4.4 min |      53% |

**An app monorepo after a change to its base library.** Not ours: 24
libraries, each built on the one before it and one further down, each
with a test and a lint, and 4 apps on six libraries each, built, tested
and run end to end. 84 tasks run, 71.0 core-minutes of work.

<figure class="vx-gantt"><figcaption>The app monorepo after a base library change, as it runs</figcaption><div class="vx-gantt-way"><div class="vx-gantt-head"><span>One machine</span><span class="vx-gantt-end" style="--e:1000">1205.0 s · 20.1 min</span></div><svg viewBox="0 0 1000 24" preserveAspectRatio="none" height="24" role="img" aria-label="One machine: ends 1205.0 s, 20.1 machine-minutes"><rect class="w" x="0" y="0" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="0" width="983.4" height="20" style="--s:16.6;--e:1000"/><rect class="t" x="16.6" y="12.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="16.6" y="7.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="2.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="7.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="2.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="12.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="33.2" y="7.5" width="37.3" height="5" style="--s:33.2;--e:70.5"/><rect class="t" x="33.2" y="2.5" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="2.5" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="12.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="49.8" y="2.5" width="37.3" height="5" style="--s:49.8;--e:87.1"/><rect class="t" x="66.4" y="12.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="70.5" y="7.5" width="37.4" height="5" style="--s:70.5;--e:107.9"/><rect class="t" x="83" y="12.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="87.1" y="2.5" width="37.4" height="5" style="--s:87.1;--e:124.5"/><rect class="t" x="99.6" y="12.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="107.9" y="7.5" width="37.3" height="5" style="--s:107.9;--e:145.2"/><rect class="t" x="116.2" y="12.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="124.5" y="2.5" width="37.3" height="5" style="--s:124.5;--e:161.8"/><rect class="t" x="132.8" y="12.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="145.2" y="7.5" width="37.4" height="5" style="--s:145.2;--e:182.6"/><rect class="t" x="149.4" y="12.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="161.8" y="2.5" width="37.4" height="5" style="--s:161.8;--e:199.2"/><rect class="t" x="166" y="12.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="12.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="182.6" y="7.5" width="37.3" height="5" style="--s:182.6;--e:219.9"/><rect class="t" x="199.2" y="12.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="199.2" y="2.5" width="37.3" height="5" style="--s:199.2;--e:236.5"/><rect class="t" x="215.8" y="12.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="219.9" y="7.5" width="37.4" height="5" style="--s:219.9;--e:257.3"/><rect class="t" x="232.4" y="12.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="236.5" y="2.5" width="37.4" height="5" style="--s:236.5;--e:273.9"/><rect class="t" x="249" y="12.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="257.3" y="7.5" width="37.3" height="5" style="--s:257.3;--e:294.6"/><rect class="t" x="265.6" y="12.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="273.9" y="2.5" width="37.3" height="5" style="--s:273.9;--e:311.2"/><rect class="t" x="282.2" y="12.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="294.6" y="7.5" width="37.4" height="5" style="--s:294.6;--e:332"/><rect class="t" x="298.8" y="12.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="311.2" y="2.5" width="37.3" height="5" style="--s:311.2;--e:348.5"/><rect class="t" x="315.4" y="12.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="12.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="332" y="7.5" width="37.3" height="5" style="--s:332;--e:369.3"/><rect class="t" x="348.5" y="12.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="348.5" y="2.5" width="37.4" height="5" style="--s:348.5;--e:385.9"/><rect class="t" x="365.1" y="12.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="369.3" y="7.5" width="37.3" height="5" style="--s:369.3;--e:406.6"/><rect class="t" x="381.7" y="12.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="385.9" y="2.5" width="37.3" height="5" style="--s:385.9;--e:423.2"/><rect class="t" x="398.3" y="12.5" width="16.6" height="7.5" style="--s:398.3;--e:414.9"/><rect class="t" x="406.6" y="7.5" width="37.4" height="5" style="--s:406.6;--e:444"/><rect class="t" x="414.9" y="15" width="37.4" height="5" style="--s:414.9;--e:452.3"/><rect class="t" x="414.9" y="0" width="37.4" height="5" style="--s:414.9;--e:452.3"/><rect class="t" x="423.2" y="0" width="37.4" height="5" style="--s:423.2;--e:460.6"/><rect class="t" x="444" y="10" width="8.3" height="5" style="--s:444;--e:452.3"/><rect class="t" x="452.3" y="5" width="74.7" height="15" style="--s:452.3;--e:527"/><rect class="t" x="460.6" y="0" width="8.3" height="5" style="--s:460.6;--e:468.9"/><rect class="t" x="468.9" y="0" width="8.3" height="5" style="--s:468.9;--e:477.2"/><rect class="t" x="477.2" y="0" width="8.3" height="5" style="--s:477.2;--e:485.5"/><rect class="t" x="485.5" y="0" width="8.3" height="5" style="--s:485.5;--e:493.8"/><rect class="t" x="493.8" y="0" width="8.3" height="5" style="--s:493.8;--e:502.1"/><rect class="t" x="502.1" y="0" width="8.3" height="5" style="--s:502.1;--e:510.4"/><rect class="t" x="510.4" y="0" width="8.3" height="5" style="--s:510.4;--e:518.7"/><rect class="t" x="518.7" y="0" width="8.3" height="5" style="--s:518.7;--e:527"/><rect class="t" x="527" y="5" width="74.7" height="15" style="--s:527;--e:601.7"/><rect class="t" x="527" y="0" width="49.8" height="5" style="--s:527;--e:576.8"/><rect class="t" x="576.8" y="0" width="8.3" height="5" style="--s:576.8;--e:585.1"/><rect class="t" x="585.1" y="0" width="8.3" height="5" style="--s:585.1;--e:593.4"/><rect class="t" x="593.4" y="0" width="8.3" height="5" style="--s:593.4;--e:601.7"/><rect class="t" x="601.7" y="5" width="74.6" height="15" style="--s:601.7;--e:676.3"/><rect class="t" x="601.7" y="0" width="49.8" height="5" style="--s:601.7;--e:651.5"/><rect class="t" x="651.5" y="0" width="8.3" height="5" style="--s:651.5;--e:659.8"/><rect class="t" x="659.8" y="0" width="8.2" height="5" style="--s:659.8;--e:668"/><rect class="t" x="668" y="0" width="8.3" height="5" style="--s:668;--e:676.3"/><rect class="t" x="676.3" y="5" width="74.7" height="15" style="--s:676.3;--e:751"/><rect class="t" x="676.3" y="0" width="49.8" height="5" style="--s:676.3;--e:726.1"/><rect class="t" x="726.1" y="0" width="8.3" height="5" style="--s:726.1;--e:734.4"/><rect class="t" x="734.4" y="0" width="8.3" height="5" style="--s:734.4;--e:742.7"/><rect class="t" x="742.7" y="0" width="8.3" height="5" style="--s:742.7;--e:751"/><rect class="t" x="751" y="12.5" width="124.5" height="7.5" style="--s:751;--e:875.5"/><rect class="t" x="751" y="5" width="124.5" height="7.5" style="--s:751;--e:875.5"/><rect class="t" x="751" y="0" width="49.8" height="5" style="--s:751;--e:800.8"/><rect class="t" x="875.5" y="12.5" width="124.5" height="7.5" style="--s:875.5;--e:1000"/><rect class="t" x="875.5" y="5" width="124.5" height="7.5" style="--s:875.5;--e:1000"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="24"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Static matrix, 6 jobs</span><span class="vx-gantt-end" style="--e:672.2">810.0 s · 73.1 min</span></div><svg viewBox="0 0 1000 144" preserveAspectRatio="none" height="144" role="img" aria-label="Static matrix, 6 jobs: ends 810.0 s, 73.1 machine-minutes"><rect class="w" x="0" y="0" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="0" width="531.1" height="20" style="--s:16.6;--e:547.7"/><rect class="t" x="16.6" y="12.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="12.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="49.8" y="12.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="66.4" y="12.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="12.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="12.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="12.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="12.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="12.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="12.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="12.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="12.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="12.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="12.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="12.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="12.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="12.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="12.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="12.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="12.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="12.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="12.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="12.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="398.3" y="5" width="74.7" height="15" style="--s:398.3;--e:473"/><rect class="t" x="473" y="5" width="74.7" height="15" style="--s:473;--e:547.7"/><rect class="w" x="0" y="24" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="24" width="580.9" height="20" style="--s:16.6;--e:597.5"/><rect class="t" x="16.6" y="36.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="36.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="33.2" y="31.5" width="37.3" height="5" style="--s:33.2;--e:70.5"/><rect class="t" x="49.8" y="36.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="66.4" y="36.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="66.4" y="26.5" width="37.3" height="5" style="--s:66.4;--e:103.7"/><rect class="t" x="83" y="36.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="36.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="99.6" y="31.5" width="37.3" height="5" style="--s:99.6;--e:136.9"/><rect class="t" x="116.2" y="36.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="36.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="132.8" y="26.5" width="37.3" height="5" style="--s:132.8;--e:170.1"/><rect class="t" x="149.4" y="36.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="36.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="166" y="31.5" width="37.3" height="5" style="--s:166;--e:203.3"/><rect class="t" x="182.6" y="36.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="36.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="199.2" y="26.5" width="37.3" height="5" style="--s:199.2;--e:236.5"/><rect class="t" x="215.8" y="36.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="36.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="232.4" y="31.5" width="37.3" height="5" style="--s:232.4;--e:269.7"/><rect class="t" x="249" y="36.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="36.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="265.6" y="26.5" width="37.3" height="5" style="--s:265.6;--e:302.9"/><rect class="t" x="282.2" y="36.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="36.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="298.8" y="31.5" width="37.3" height="5" style="--s:298.8;--e:336.1"/><rect class="t" x="315.4" y="36.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="36.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="332" y="26.5" width="37.3" height="5" style="--s:332;--e:369.3"/><rect class="t" x="348.5" y="36.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="36.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="365.1" y="31.5" width="37.4" height="5" style="--s:365.1;--e:402.5"/><rect class="t" x="381.7" y="36.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="398.3" y="24" width="74.7" height="15" style="--s:398.3;--e:473"/><rect class="t" x="402.5" y="39" width="37.3" height="5" style="--s:402.5;--e:439.8"/><rect class="t" x="473" y="29" width="74.7" height="15" style="--s:473;--e:547.7"/><rect class="t" x="473" y="24" width="49.8" height="5" style="--s:473;--e:522.8"/><rect class="t" x="547.7" y="39" width="49.8" height="5" style="--s:547.7;--e:597.5"/><rect class="w" x="0" y="48" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="48" width="655.6" height="20" style="--s:16.6;--e:672.2"/><rect class="t" x="16.6" y="60.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="16.6" y="55.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="50.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="55.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="50.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="60.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="33.2" y="55.5" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="33.2" y="50.5" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="55.5" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="41.5" y="50.5" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="60.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="49.8" y="55.5" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="49.8" y="50.5" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="58.1" y="55.5" width="8.3" height="5" style="--s:58.1;--e:66.4"/><rect class="t" x="58.1" y="50.5" width="8.3" height="5" style="--s:58.1;--e:66.4"/><rect class="t" x="66.4" y="60.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="60.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="60.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="60.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="60.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="60.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="60.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="60.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="60.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="60.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="60.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="60.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="60.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="60.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="60.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="60.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="60.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="60.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="60.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="60.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="398.3" y="53" width="74.7" height="15" style="--s:398.3;--e:473"/><rect class="t" x="473" y="53" width="74.7" height="15" style="--s:473;--e:547.7"/><rect class="t" x="547.7" y="60.5" width="124.5" height="7.5" style="--s:547.7;--e:672.2"/><rect class="t" x="547.7" y="53" width="124.5" height="7.5" style="--s:547.7;--e:672.2"/><rect class="w" x="0" y="72" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="72" width="547.7" height="20" style="--s:16.6;--e:564.3"/><rect class="t" x="16.6" y="84.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="84.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="49.8" y="84.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="66.4" y="84.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="84.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="84.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="84.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="84.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="84.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="84.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="84.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="84.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="84.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="84.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="84.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="84.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="84.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="84.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="84.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="84.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="84.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="84.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="77" width="74.7" height="15" style="--s:381.7;--e:456.4"/><rect class="t" x="456.4" y="77" width="74.7" height="15" style="--s:456.4;--e:531.1"/><rect class="t" x="531.1" y="84.5" width="16.6" height="7.5" style="--s:531.1;--e:547.7"/><rect class="t" x="547.7" y="84.5" width="16.6" height="7.5" style="--s:547.7;--e:564.3"/><rect class="w" x="0" y="96" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="96" width="585.1" height="20" style="--s:16.6;--e:601.7"/><rect class="t" x="16.6" y="108.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="108.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="49.8" y="108.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="49.8" y="103.5" width="37.3" height="5" style="--s:49.8;--e:87.1"/><rect class="t" x="66.4" y="108.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="108.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="83" y="98.5" width="37.3" height="5" style="--s:83;--e:120.3"/><rect class="t" x="99.6" y="108.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="108.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="116.2" y="103.5" width="37.3" height="5" style="--s:116.2;--e:153.5"/><rect class="t" x="132.8" y="108.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="108.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="149.4" y="98.5" width="37.3" height="5" style="--s:149.4;--e:186.7"/><rect class="t" x="166" y="108.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="108.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="182.6" y="103.5" width="37.3" height="5" style="--s:182.6;--e:219.9"/><rect class="t" x="199.2" y="108.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="108.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="215.8" y="98.5" width="37.3" height="5" style="--s:215.8;--e:253.1"/><rect class="t" x="232.4" y="108.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="108.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="249" y="103.5" width="37.3" height="5" style="--s:249;--e:286.3"/><rect class="t" x="265.6" y="108.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="108.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="282.2" y="98.5" width="37.3" height="5" style="--s:282.2;--e:319.5"/><rect class="t" x="298.8" y="108.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="108.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="315.4" y="103.5" width="37.3" height="5" style="--s:315.4;--e:352.7"/><rect class="t" x="332" y="108.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="108.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="348.5" y="98.5" width="37.4" height="5" style="--s:348.5;--e:385.9"/><rect class="t" x="365.1" y="108.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="96" width="74.7" height="15" style="--s:381.7;--e:456.4"/><rect class="t" x="385.9" y="111" width="37.3" height="5" style="--s:385.9;--e:423.2"/><rect class="t" x="456.4" y="101" width="74.7" height="15" style="--s:456.4;--e:531.1"/><rect class="t" x="456.4" y="96" width="49.8" height="5" style="--s:456.4;--e:506.2"/><rect class="t" x="531.1" y="108.5" width="16.6" height="7.5" style="--s:531.1;--e:547.7"/><rect class="t" x="531.1" y="103.5" width="49.8" height="5" style="--s:531.1;--e:580.9"/><rect class="t" x="547.7" y="108.5" width="16.6" height="7.5" style="--s:547.7;--e:564.3"/><rect class="t" x="564.3" y="111" width="37.4" height="5" style="--s:564.3;--e:601.7"/><rect class="w" x="0" y="120" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="120" width="639" height="20" style="--s:16.6;--e:655.6"/><rect class="t" x="16.6" y="132.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="16.6" y="127.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="122.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="127.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="122.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="132.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="33.2" y="127.5" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="33.2" y="122.5" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="127.5" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="41.5" y="122.5" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="132.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="49.8" y="127.5" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="49.8" y="122.5" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="58.1" y="127.5" width="8.3" height="5" style="--s:58.1;--e:66.4"/><rect class="t" x="58.1" y="122.5" width="8.3" height="5" style="--s:58.1;--e:66.4"/><rect class="t" x="66.4" y="132.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="132.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="132.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="132.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="132.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="132.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="132.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="132.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="132.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="132.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="132.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="132.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="132.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="132.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="132.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="132.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="132.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="132.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="132.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="125" width="74.7" height="15" style="--s:381.7;--e:456.4"/><rect class="t" x="456.4" y="125" width="74.7" height="15" style="--s:456.4;--e:531.1"/><rect class="t" x="531.1" y="132.5" width="124.5" height="7.5" style="--s:531.1;--e:655.6"/><rect class="t" x="531.1" y="125" width="124.5" height="7.5" style="--s:531.1;--e:655.6"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="144"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Build stage, then 6 jobs</span><span class="vx-gantt-end" style="--e:879.7">1060.0 s · 27.3 min</span></div><svg viewBox="0 0 1000 168" preserveAspectRatio="none" height="168" role="img" aria-label="Build stage, then 6 jobs: ends 1060.0 s, 27.3 machine-minutes"><rect class="w" x="0" y="0" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="0" width="697.1" height="20" style="--s:16.6;--e:713.7"/><rect class="t" x="16.6" y="12.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="12.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="49.8" y="12.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="66.4" y="12.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="12.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="12.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="12.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="12.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="12.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="12.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="12.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="12.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="12.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="12.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="12.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="12.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="12.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="12.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="12.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="12.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="12.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="12.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="12.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="398.3" y="5" width="74.7" height="15" style="--s:398.3;--e:473"/><rect class="t" x="473" y="5" width="74.7" height="15" style="--s:473;--e:547.7"/><rect class="t" x="547.7" y="5" width="74.7" height="15" style="--s:547.7;--e:622.4"/><rect class="t" x="622.4" y="5" width="74.7" height="15" style="--s:622.4;--e:697.1"/><rect class="t" x="697.1" y="12.5" width="16.6" height="7.5" style="--s:697.1;--e:713.7"/><rect class="w" x="713.7" y="24" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="w" x="713.7" y="48" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="o" x="730.3" y="48" width="149.4" height="20" style="--s:730.3;--e:879.7"/><rect class="t" x="730.3" y="63" width="49.8" height="5" style="--s:730.3;--e:780.1"/><rect class="t" x="730.3" y="58" width="49.8" height="5" style="--s:730.3;--e:780.1"/><rect class="t" x="730.3" y="53" width="37.3" height="5" style="--s:730.3;--e:767.6"/><rect class="t" x="730.3" y="48" width="37.3" height="5" style="--s:730.3;--e:767.6"/><rect class="t" x="767.6" y="53" width="37.4" height="5" style="--s:767.6;--e:805"/><rect class="t" x="767.6" y="48" width="37.4" height="5" style="--s:767.6;--e:805"/><rect class="t" x="780.1" y="63" width="37.3" height="5" style="--s:780.1;--e:817.4"/><rect class="t" x="780.1" y="58" width="37.3" height="5" style="--s:780.1;--e:817.4"/><rect class="t" x="805" y="53" width="37.3" height="5" style="--s:805;--e:842.3"/><rect class="t" x="805" y="48" width="37.3" height="5" style="--s:805;--e:842.3"/><rect class="t" x="817.4" y="63" width="37.4" height="5" style="--s:817.4;--e:854.8"/><rect class="t" x="817.4" y="58" width="37.4" height="5" style="--s:817.4;--e:854.8"/><rect class="t" x="842.3" y="53" width="37.4" height="5" style="--s:842.3;--e:879.7"/><rect class="t" x="842.3" y="48" width="37.4" height="5" style="--s:842.3;--e:879.7"/><rect class="w" x="713.7" y="72" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="o" x="730.3" y="72" width="124.5" height="20" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="84.5" width="124.5" height="7.5" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="77" width="124.5" height="7.5" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="72" width="8.3" height="5" style="--s:730.3;--e:738.6"/><rect class="t" x="738.6" y="72" width="8.3" height="5" style="--s:738.6;--e:746.9"/><rect class="t" x="746.9" y="72" width="8.3" height="5" style="--s:746.9;--e:755.2"/><rect class="t" x="755.2" y="72" width="8.3" height="5" style="--s:755.2;--e:763.5"/><rect class="t" x="763.5" y="72" width="8.3" height="5" style="--s:763.5;--e:771.8"/><rect class="t" x="771.8" y="72" width="8.3" height="5" style="--s:771.8;--e:780.1"/><rect class="t" x="780.1" y="72" width="8.3" height="5" style="--s:780.1;--e:788.4"/><rect class="t" x="788.4" y="72" width="8.3" height="5" style="--s:788.4;--e:796.7"/><rect class="t" x="796.7" y="72" width="8.3" height="5" style="--s:796.7;--e:805"/><rect class="t" x="805" y="72" width="8.3" height="5" style="--s:805;--e:813.3"/><rect class="t" x="813.3" y="72" width="8.3" height="5" style="--s:813.3;--e:821.6"/><rect class="t" x="821.6" y="72" width="8.3" height="5" style="--s:821.6;--e:829.9"/><rect class="w" x="713.7" y="96" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="w" x="713.7" y="120" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="o" x="730.3" y="120" width="149.4" height="20" style="--s:730.3;--e:879.7"/><rect class="t" x="730.3" y="135" width="49.8" height="5" style="--s:730.3;--e:780.1"/><rect class="t" x="730.3" y="130" width="49.8" height="5" style="--s:730.3;--e:780.1"/><rect class="t" x="730.3" y="125" width="37.3" height="5" style="--s:730.3;--e:767.6"/><rect class="t" x="730.3" y="120" width="37.3" height="5" style="--s:730.3;--e:767.6"/><rect class="t" x="767.6" y="125" width="37.4" height="5" style="--s:767.6;--e:805"/><rect class="t" x="767.6" y="120" width="37.4" height="5" style="--s:767.6;--e:805"/><rect class="t" x="780.1" y="135" width="37.3" height="5" style="--s:780.1;--e:817.4"/><rect class="t" x="780.1" y="130" width="37.3" height="5" style="--s:780.1;--e:817.4"/><rect class="t" x="805" y="125" width="37.3" height="5" style="--s:805;--e:842.3"/><rect class="t" x="805" y="120" width="37.3" height="5" style="--s:805;--e:842.3"/><rect class="t" x="817.4" y="135" width="37.4" height="5" style="--s:817.4;--e:854.8"/><rect class="t" x="817.4" y="130" width="37.4" height="5" style="--s:817.4;--e:854.8"/><rect class="t" x="842.3" y="125" width="37.4" height="5" style="--s:842.3;--e:879.7"/><rect class="t" x="842.3" y="120" width="37.4" height="5" style="--s:842.3;--e:879.7"/><rect class="w" x="713.7" y="144" width="16.6" height="20" style="--s:713.7;--e:730.3"/><rect class="o" x="730.3" y="144" width="124.5" height="20" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="156.5" width="124.5" height="7.5" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="149" width="124.5" height="7.5" style="--s:730.3;--e:854.8"/><rect class="t" x="730.3" y="144" width="8.3" height="5" style="--s:730.3;--e:738.6"/><rect class="t" x="738.6" y="144" width="8.3" height="5" style="--s:738.6;--e:746.9"/><rect class="t" x="746.9" y="144" width="8.3" height="5" style="--s:746.9;--e:755.2"/><rect class="t" x="755.2" y="144" width="8.3" height="5" style="--s:755.2;--e:763.5"/><rect class="t" x="763.5" y="144" width="8.3" height="5" style="--s:763.5;--e:771.8"/><rect class="t" x="771.8" y="144" width="8.3" height="5" style="--s:771.8;--e:780.1"/><rect class="t" x="780.1" y="144" width="8.3" height="5" style="--s:780.1;--e:788.4"/><rect class="t" x="788.4" y="144" width="8.3" height="5" style="--s:788.4;--e:796.7"/><rect class="t" x="796.7" y="144" width="8.3" height="5" style="--s:796.7;--e:805"/><rect class="t" x="805" y="144" width="8.3" height="5" style="--s:805;--e:813.3"/><rect class="t" x="813.3" y="144" width="8.3" height="5" style="--s:813.3;--e:821.6"/><rect class="t" x="821.6" y="144" width="8.3" height="5" style="--s:821.6;--e:829.9"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="168"/></svg></div><div class="vx-gantt-way"><div class="vx-gantt-head"><span>Naive DTE, 6 workers</span><span class="vx-gantt-end" style="--e:634.9">765.0 s · 79.7 min</span></div><svg viewBox="0 0 1000 144" preserveAspectRatio="none" height="144" role="img" aria-label="Naive DTE, 6 workers: ends 765.0 s, 79.7 machine-minutes"><rect class="w" x="0" y="0" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="0" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="12.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="33.2" y="15" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="15" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="15" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="66.4" y="15" width="37.3" height="5" style="--s:66.4;--e:103.7"/><rect class="t" x="116.2" y="15" width="37.3" height="5" style="--s:116.2;--e:153.5"/><rect class="t" x="166" y="15" width="37.3" height="5" style="--s:166;--e:203.3"/><rect class="t" x="215.8" y="15" width="37.3" height="5" style="--s:215.8;--e:253.1"/><rect class="t" x="265.6" y="15" width="37.3" height="5" style="--s:265.6;--e:302.9"/><rect class="t" x="315.4" y="15" width="37.3" height="5" style="--s:315.4;--e:352.7"/><rect class="t" x="365.1" y="15" width="37.4" height="5" style="--s:365.1;--e:402.5"/><rect class="t" x="402.5" y="12.5" width="16.6" height="7.5" style="--s:402.5;--e:419.1"/><rect class="t" x="419.1" y="5" width="74.7" height="15" style="--s:419.1;--e:493.8"/><rect class="t" x="493.8" y="15" width="49.8" height="5" style="--s:493.8;--e:543.6"/><rect class="w" x="0" y="24" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="24" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="39" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="39" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="39" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="39" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="39" width="8.3" height="5" style="--s:49.8;--e:58.1"/><rect class="t" x="66.4" y="36.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="39" width="37.3" height="5" style="--s:83;--e:120.3"/><rect class="t" x="132.8" y="39" width="37.3" height="5" style="--s:132.8;--e:170.1"/><rect class="t" x="182.6" y="39" width="37.3" height="5" style="--s:182.6;--e:219.9"/><rect class="t" x="232.4" y="39" width="37.3" height="5" style="--s:232.4;--e:269.7"/><rect class="t" x="282.2" y="39" width="37.3" height="5" style="--s:282.2;--e:319.5"/><rect class="t" x="332" y="39" width="37.3" height="5" style="--s:332;--e:369.3"/><rect class="t" x="373.4" y="39" width="49.8" height="5" style="--s:373.4;--e:423.2"/><rect class="t" x="423.2" y="36.5" width="16.6" height="7.5" style="--s:423.2;--e:439.8"/><rect class="t" x="439.8" y="39" width="37.4" height="5" style="--s:439.8;--e:477.2"/><rect class="t" x="493.8" y="36.5" width="124.5" height="7.5" style="--s:493.8;--e:618.3"/><rect class="w" x="0" y="48" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="48" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="63" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="63" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="63" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="63" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="63" width="37.3" height="5" style="--s:49.8;--e:87.1"/><rect class="t" x="99.6" y="63" width="37.3" height="5" style="--s:99.6;--e:136.9"/><rect class="t" x="149.4" y="63" width="37.3" height="5" style="--s:149.4;--e:186.7"/><rect class="t" x="199.2" y="63" width="37.3" height="5" style="--s:199.2;--e:236.5"/><rect class="t" x="249" y="63" width="37.3" height="5" style="--s:249;--e:286.3"/><rect class="t" x="298.8" y="63" width="37.3" height="5" style="--s:298.8;--e:336.1"/><rect class="t" x="348.5" y="63" width="37.4" height="5" style="--s:348.5;--e:385.9"/><rect class="t" x="385.9" y="53" width="74.7" height="15" style="--s:385.9;--e:460.6"/><rect class="t" x="460.6" y="63" width="49.8" height="5" style="--s:460.6;--e:510.4"/><rect class="t" x="510.4" y="63" width="49.8" height="5" style="--s:510.4;--e:560.2"/><rect class="w" x="0" y="72" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="72" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="87" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="87" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="87" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="87" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="49.8" y="84.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="83" y="84.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="99.6" y="84.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="116.2" y="84.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="84.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="149.4" y="84.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="166" y="84.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="84.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="199.2" y="84.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="215.8" y="84.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="84.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="249" y="84.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="265.6" y="84.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="84.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="298.8" y="84.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="315.4" y="84.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="84.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="348.5" y="84.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="365.1" y="84.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="87" width="37.4" height="5" style="--s:381.7;--e:419.1"/><rect class="t" x="419.1" y="87" width="37.3" height="5" style="--s:419.1;--e:456.4"/><rect class="t" x="460.6" y="84.5" width="124.5" height="7.5" style="--s:460.6;--e:585.1"/><rect class="w" x="0" y="96" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="96" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="111" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="111" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="111" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="111" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="298.8" y="101" width="74.6" height="15" style="--s:298.8;--e:373.4"/><rect class="t" x="373.4" y="108.5" width="124.5" height="7.5" style="--s:373.4;--e:497.9"/><rect class="t" x="510.4" y="108.5" width="124.5" height="7.5" style="--s:510.4;--e:634.9"/><rect class="w" x="0" y="120" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="120" width="618.3" height="20" style="--s:16.6;--e:634.9"/><rect class="t" x="16.6" y="135" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="135" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="135" width="8.3" height="5" style="--s:33.2;--e:41.5"/><rect class="t" x="41.5" y="135" width="8.3" height="5" style="--s:41.5;--e:49.8"/><rect class="t" x="381.7" y="132.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="398.3" y="135" width="37.4" height="5" style="--s:398.3;--e:435.7"/><rect class="t" x="435.7" y="125" width="74.7" height="15" style="--s:435.7;--e:510.4"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="144"/></svg></div><div class="vx-gantt-way vx-gantt-lead"><div class="vx-gantt-head"><span>vx DTE, 6 workers</span><span class="vx-gantt-end" style="--e:597.5">720.0 s · 34.7 min</span></div><svg viewBox="0 0 1000 144" preserveAspectRatio="none" height="144" role="img" aria-label="vx DTE, 6 workers: ends 720.0 s, 34.7 machine-minutes"><rect class="w" x="0" y="0" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="0" width="580.9" height="20" style="--s:16.6;--e:597.5"/><rect class="t" x="16.6" y="12.5" width="16.6" height="7.5" style="--s:16.6;--e:33.2"/><rect class="t" x="16.6" y="7.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="2.5" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="7.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="2.5" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="33.2" y="12.5" width="16.6" height="7.5" style="--s:33.2;--e:49.8"/><rect class="t" x="33.2" y="7.5" width="37.3" height="5" style="--s:33.2;--e:70.5"/><rect class="t" x="49.8" y="12.5" width="16.6" height="7.5" style="--s:49.8;--e:66.4"/><rect class="t" x="49.8" y="2.5" width="37.3" height="5" style="--s:49.8;--e:87.1"/><rect class="t" x="66.4" y="12.5" width="16.6" height="7.5" style="--s:66.4;--e:83"/><rect class="t" x="83" y="12.5" width="16.6" height="7.5" style="--s:83;--e:99.6"/><rect class="t" x="83" y="7.5" width="37.3" height="5" style="--s:83;--e:120.3"/><rect class="t" x="99.6" y="12.5" width="16.6" height="7.5" style="--s:99.6;--e:116.2"/><rect class="t" x="99.6" y="2.5" width="37.3" height="5" style="--s:99.6;--e:136.9"/><rect class="t" x="116.2" y="12.5" width="16.6" height="7.5" style="--s:116.2;--e:132.8"/><rect class="t" x="132.8" y="12.5" width="16.6" height="7.5" style="--s:132.8;--e:149.4"/><rect class="t" x="132.8" y="7.5" width="37.3" height="5" style="--s:132.8;--e:170.1"/><rect class="t" x="149.4" y="12.5" width="16.6" height="7.5" style="--s:149.4;--e:166"/><rect class="t" x="149.4" y="2.5" width="37.3" height="5" style="--s:149.4;--e:186.7"/><rect class="t" x="166" y="12.5" width="16.6" height="7.5" style="--s:166;--e:182.6"/><rect class="t" x="182.6" y="12.5" width="16.6" height="7.5" style="--s:182.6;--e:199.2"/><rect class="t" x="182.6" y="7.5" width="37.3" height="5" style="--s:182.6;--e:219.9"/><rect class="t" x="199.2" y="12.5" width="16.6" height="7.5" style="--s:199.2;--e:215.8"/><rect class="t" x="199.2" y="2.5" width="37.3" height="5" style="--s:199.2;--e:236.5"/><rect class="t" x="215.8" y="12.5" width="16.6" height="7.5" style="--s:215.8;--e:232.4"/><rect class="t" x="232.4" y="12.5" width="16.6" height="7.5" style="--s:232.4;--e:249"/><rect class="t" x="232.4" y="7.5" width="37.3" height="5" style="--s:232.4;--e:269.7"/><rect class="t" x="249" y="12.5" width="16.6" height="7.5" style="--s:249;--e:265.6"/><rect class="t" x="249" y="2.5" width="37.3" height="5" style="--s:249;--e:286.3"/><rect class="t" x="265.6" y="12.5" width="16.6" height="7.5" style="--s:265.6;--e:282.2"/><rect class="t" x="282.2" y="12.5" width="16.6" height="7.5" style="--s:282.2;--e:298.8"/><rect class="t" x="282.2" y="7.5" width="37.3" height="5" style="--s:282.2;--e:319.5"/><rect class="t" x="298.8" y="12.5" width="16.6" height="7.5" style="--s:298.8;--e:315.4"/><rect class="t" x="298.8" y="2.5" width="37.3" height="5" style="--s:298.8;--e:336.1"/><rect class="t" x="315.4" y="12.5" width="16.6" height="7.5" style="--s:315.4;--e:332"/><rect class="t" x="332" y="12.5" width="16.5" height="7.5" style="--s:332;--e:348.5"/><rect class="t" x="332" y="7.5" width="37.3" height="5" style="--s:332;--e:369.3"/><rect class="t" x="348.5" y="12.5" width="16.6" height="7.5" style="--s:348.5;--e:365.1"/><rect class="t" x="348.5" y="2.5" width="37.4" height="5" style="--s:348.5;--e:385.9"/><rect class="t" x="365.1" y="12.5" width="16.6" height="7.5" style="--s:365.1;--e:381.7"/><rect class="t" x="381.7" y="12.5" width="16.6" height="7.5" style="--s:381.7;--e:398.3"/><rect class="t" x="381.7" y="7.5" width="37.4" height="5" style="--s:381.7;--e:419.1"/><rect class="t" x="398.3" y="0" width="74.7" height="15" style="--s:398.3;--e:473"/><rect class="t" x="473" y="12.5" width="124.5" height="7.5" style="--s:473;--e:597.5"/><rect class="t" x="473" y="7.5" width="49.8" height="5" style="--s:473;--e:522.8"/><rect class="w" x="0" y="24" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="24" width="464.7" height="20" style="--s:16.6;--e:481.3"/><rect class="t" x="16.6" y="39" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="34" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="29" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="24" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="39" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="34" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="29" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="24" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="66.4" y="39" width="37.3" height="5" style="--s:66.4;--e:103.7"/><rect class="t" x="116.2" y="39" width="37.3" height="5" style="--s:116.2;--e:153.5"/><rect class="t" x="166" y="39" width="37.3" height="5" style="--s:166;--e:203.3"/><rect class="t" x="215.8" y="39" width="37.3" height="5" style="--s:215.8;--e:253.1"/><rect class="t" x="265.6" y="39" width="37.3" height="5" style="--s:265.6;--e:302.9"/><rect class="t" x="282.2" y="24" width="74.6" height="15" style="--s:282.2;--e:356.8"/><rect class="t" x="315.4" y="39" width="37.3" height="5" style="--s:315.4;--e:352.7"/><rect class="t" x="356.8" y="36.5" width="124.5" height="7.5" style="--s:356.8;--e:481.3"/><rect class="t" x="356.8" y="31.5" width="49.8" height="5" style="--s:356.8;--e:406.6"/><rect class="t" x="398.3" y="24" width="16.6" height="7.5" style="--s:398.3;--e:414.9"/><rect class="t" x="414.9" y="31.5" width="37.4" height="5" style="--s:414.9;--e:452.3"/><rect class="w" x="0" y="48" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="48" width="16.6" height="20" style="--s:16.6;--e:33.2"/><rect class="t" x="16.6" y="63" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="58" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="53" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="48" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="24.9" y="63" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="58" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="53" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="t" x="24.9" y="48" width="8.3" height="5" style="--s:24.9;--e:33.2"/><rect class="w" x="0" y="72" width="16.6" height="20" style="--s:0;--e:16.6"/><rect class="o" x="16.6" y="72" width="8.3" height="20" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="87" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="82" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="77" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="t" x="16.6" y="72" width="8.3" height="5" style="--s:16.6;--e:24.9"/><rect class="w" x="344.4" y="96" width="16.6" height="20" style="--s:344.4;--e:361"/><rect class="o" x="361" y="96" width="203.3" height="20" style="--s:361;--e:564.3"/><rect class="t" x="365.1" y="101" width="74.7" height="15" style="--s:365.1;--e:439.8"/><rect class="t" x="365.1" y="96" width="37.4" height="5" style="--s:365.1;--e:402.5"/><rect class="t" x="439.8" y="108.5" width="124.5" height="7.5" style="--s:439.8;--e:564.3"/><rect class="t" x="439.8" y="103.5" width="49.8" height="5" style="--s:439.8;--e:489.6"/><rect class="w" x="361" y="120" width="16.6" height="20" style="--s:361;--e:377.6"/><rect class="o" x="377.6" y="120" width="203.3" height="20" style="--s:377.6;--e:580.9"/><rect class="t" x="381.7" y="125" width="74.7" height="15" style="--s:381.7;--e:456.4"/><rect class="t" x="398.3" y="120" width="37.4" height="5" style="--s:398.3;--e:435.7"/><rect class="t" x="456.4" y="132.5" width="124.5" height="7.5" style="--s:456.4;--e:580.9"/><rect class="t" x="456.4" y="127.5" width="49.8" height="5" style="--s:456.4;--e:506.2"/><rect class="vx-gantt-now" x="0" y="0" width="2" height="144"/></svg></div></figure>

| Way                      |     Ends | Machine time | CPU used |
| ------------------------ | -------: | -----------: | -------: |
| One machine              | 1205.0 s |     20.1 min |      88% |
| Static matrix, 6 jobs    |  810.0 s |     73.1 min |      24% |
| Build stage, then 6 jobs | 1060.0 s |     27.3 min |      65% |
| Naive DTE, 6 workers     |  765.0 s |     79.7 min |      22% |
| vx DTE, 6 workers        |  720.0 s |     34.7 min |      51% |

**The same monorepo, one app changed.** 3 tasks run, 9.3 core-minutes
of work.

| Way                      |    Ends | Machine time | CPU used |
| ------------------------ | ------: | -----------: | -------: |
| One machine              | 260.0 s |      4.3 min |      53% |
| Static matrix, 6 jobs    | 260.0 s |     10.0 min |      23% |
| Build stage, then 6 jobs | 280.0 s |      7.3 min |      32% |
| Naive DTE, 6 workers     | 260.0 s |     27.1 min |       9% |
| vx DTE, 1 worker         | 260.0 s |      5.4 min |      43% |

Why each loses:

- **One machine** bills the least in every case and ends last whenever
  there is work to spread: 751.0 s on our main run.
- **A static matrix** is tuned by hand for one graph and stays fixed.
  On our flat main run, the graph it was split for, it ends 5.5 s after
  vx DTE. Every PR then runs a different set of tasks, as affected
  selection and the cache decide, and the YAML cannot follow: on the PR
  all 10 jobs still start, 13.2 machine-minutes for 9.2 core-minutes of
  work, against 4.4 for vx DTE. On a deep graph each job builds again
  the libraries its share needs: 73.1 machine-minutes against 34.7.
  vx DTE sizes every run on its own.
- **A build stage** makes every test wait for the slowest build, and
  each stage pays its own warm-up: 1060.0 s on the monorepo.
- **Naive DTE** gives each task a whole worker and keeps every worker
  until the end: 67.1 machine-minutes on our main run, at 17% CPU.
- **vx DTE** ends first, or level with the best, in all four. Of the
  ways that spread the work, it bills the least but once: the build
  stage on the monorepo bills 27.3 machine-minutes against 34.7 and ends
  340 s later. With one app changed, one task sets the end, so one
  machine ends as early and bills 4.3 machine-minutes against 5.4.

## What is still slow

Fixed since the first runs: real runs match the simulator (c5d8353
above); a task with no history takes one free core
([#4148](https://github.com/vznjs/vx/pull/4148)); the run asks only
the workers it uses: 4 or 5 asked and at most 1 cancelled, against 22
asked and 14 cancelled on c27c238
([#4160](https://github.com/vznjs/vx/pull/4160)); history keeps what a
task needs, not the share it got on a crowded worker
([#4156](https://github.com/vznjs/vx/pull/4156)); and the plan uses
learned warm-ups and uncrowded durations
([#4168](https://github.com/vznjs/vx/pull/4168)).

What is left, on main's three runs after #4168:

| Run | Tasks run | Workers | Plan | Real | CPU used |
| --- | --- | --- | --- | --- | --- |
| [ef42557](https://github.com/vznjs/vx/actions/runs/40032885630) | 25 | 3 | 106.7 s | 147.0 s | 64% |
| [417328e](https://github.com/vznjs/vx/actions/runs/40032902248) | 27 | 4 | 109.4 s | 116.7 s | 56% |
| [b910453](https://github.com/vznjs/vx/actions/runs/40033392306) | 9 | 3 | 49.5 s | 86.5 s | 40% |

- **Runs end after the plan**: 7 to 40 s later. On b910453 the last
  worker was asked at 51.3 s, after the plan's own end.
- **CPU used is 40% to 64%.** The simulator's bound is 90%. Bookings
  still miss use both ways: on 417328e small#1 booked 3.0 cores and
  used 1.9; on ef42557 mac#2 booked 2.1 and used 3.1.
- **Every worker pays a warm-up** of 15 to 29 s, Linux and Mac alike,
  before its first task. On a run of a minute or two that is a large
  share of what CI bills.

## What it costs, next to Nx Cloud

vx DTE is self-hosted end to end: the orchestrator and the workers are
your CI's jobs, the relay is yours, and so is the cache. Nx Cloud is the
closest product. On its Hobby and Team plans, Nx Cloud's own service
coordinates the run; its agents are Nx's machines, billed in credits a
minute, or jobs your CI starts. It schedules much as vx DTE does: since
2026-10-22 its
[dynamic task packing](https://nx.dev/blog/dynamic-task-packing-ultracache)
packs tasks onto workers by the CPU and memory history says they use,
and runs first the tasks others wait on. The difference here is where it
runs and what it costs. Running Nx Cloud yourself is on its Enterprise
plan, at a custom price. Its public prices, read 2026-10-23
from [nx.dev/pricing](https://nx.dev/pricing),
[Credit Pricing](https://nx.dev/docs/reference/nx-cloud/credits-pricing)
and
[CI with Nx Cloud](https://nx.dev/docs/features/ci-features#what-happens-when-i-use-up-my-credits):

| Item                                 | Nx Cloud                                                               | vx DTE        |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------- |
| Hobby plan                           | free, 50,000 credits a month, 5 contributors, 10 concurrent CI connections; features turn off when credits run out | —             |
| Team plan                            | $29 a month, $29 of usage included                                     | —             |
| Extra credits                        | $5.50 per 10,000                                                       | —             |
| Each CI pipeline execution           | 500 credits                                                            | nothing       |
| Contributors beyond 5                | $19 each                                                               | nothing       |
| Concurrent CI connections beyond 10  | $2.25 each                                                             | nothing       |
| Its agents, Linux x64                | 5 credits/min per vCPU (4 vCPU: 20)                                    | your CI's own runners |
| Its agents, Linux arm64              | 26 credits/min for 4 vCPU                                              | your CI's own runners |
| Its agents, macOS                    | no resource class listed                                               | your CI's own runners |
| Self-hosted                          | Enterprise plan, custom price                                          | every plan there is: MIT, all of it |

Assumptions: 30-day months, the Team plan with Nx's agents, a 4 vCPU
agent per worker, resource-usage reports off, concurrent connections,
the Mac work and taxes not counted. The Team plan's $29 fee buys $29 of
usage, so the bill is the usage alone once it passes $29.

**This repository.** CI ran to an end 760 times in the 7 days before
18:00 UTC on 2026-10-23: 451 PR runs, 304 main runs, 5 manual
(GitHub's API; cancelled runs not counted). That is 108 a day, 3,257
a month.

No two runs do the same work: a PR runs only what it affects, and the
cache answers what did not change. So the agent minutes come from the
54 runs that finished after
[#4150](https://github.com/vznjs/vx/pull/4150) (2026-10-23, 19:51 to
21:39 UTC), each worker's time online in its `vx dte worker` step. A
PR run kept Linux workers online 4.2 minutes on average (0 to 18.9), a
main run 2.1 (0.7 to 12.9). Weighted by last week's mix, a run is 67
agent credits and, with the 500 per execution, 567. That is 1,846,529
credits a month: $1,016, with one contributor. The Hobby plan's 50,000
credits cover 88 runs, under one day. [The per-run numbers](https://github.com/vznjs/vx/pull/4167) are
in the PR.

**A 20-person team**, a made-up case, with 200 executions per working day, 21 working
days a month, and 10 agent minutes per execution: 4,200 executions of
700 credits, 2,940,000 credits, $1,617, plus 15 contributors beyond the
first 5 at $19, $285. $1,902 a month.

| Scenario            | Nx Cloud Team, Nx's agents      | vx DTE |
| ------------------- | ------------------------------: | -----: |
| this repository     | $1,016 a month, $12,192 a year  |     $0 |
| a 20-person team    | $1,902 a month, $22,824 a year  |     $0 |

vx DTE costs $0 for both: no plan, no credits, no seats. Its compute is
the CI minutes your runners already bill (or don't). The relay runs on
the Workers free plan, and 200 runs a day is well under what our run's
size fits there.

## Try it

It is not on npm yet: import `dte` and `github` from a checkout's
`packages/vx-dte/src/index.ts`, as the
[README](https://github.com/vznjs/vx/tree/main/packages/vx-dte#try-it)
shows. Then host a relay
([README](https://github.com/vznjs/vx/tree/main/packages/vx-dte-relay#run-it)):

```ts
// in .vx/workspace.ts's plugins
dte({
  relay: 'https://relay.example.com',
  workers: { small: { max: 8, cpu: 4, memory: '16GB' } },
  adapter: github(),
})
```

The run's job needs `id-token: write` and `actions: write`, and a
`vx-worker.yml` whose jobs run `bunx @vzn/vx dte worker`. The
[package README](https://github.com/vznjs/vx/tree/main/packages/vx-dte#on-github)
has both workflows, GitLab's pipeline and every option. vx's own are
[ci.yml](https://github.com/vznjs/vx/blob/main/.github/workflows/ci.yml)
and
[vx-worker.yml](https://github.com/vznjs/vx/blob/main/.github/workflows/vx-worker.yml).

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
