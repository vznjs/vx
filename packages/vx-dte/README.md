# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx: one `vx run` spread over workers your
own CI starts, replayed here as one run. The run you start is the
orchestrator. It keeps a share of the tasks, starts workers for the rest,
and hands the ready tasks to the workers with room, critical path first. A worker runs it in its own checkout and saves the task's
output and the files its declared outputs left to the workspace's cache,
under the task's key. They land here before the task ends, so the run
reports the task as its own. No file travels through the relay: it
carries only orders and status, so the workers and this machine need one
cache they all read (a remote the workers write, or one shared store). A worker reads that cache as the run does:
under the run's refs, with the short-lived access the run's remote lends
it (an OIDC exchange's token, never a stored secret) when it has none of
its own.

Workers and the orchestrator meet at a relay
([`@vzn/vx-dte-relay`](../vx-dte-relay/PROTOCOL.md)), since CI runners
take no inbound connection. Host your own: its
[README](../vx-dte-relay/README.md) has a Deploy to Cloudflare button,
which asks only for the repositories whose runs it carries.

A run id is a channel. Workers join it before or after the orchestrator
does, and the orchestrator claims it with a key made for that run; the
relay keeps the public half and passes nothing to or from a side that
cannot sign by it. The orchestrator checks each worker the moment it
appears and removes any without the run's key from the channel.

The relay reads nothing they say. Each worker and the orchestrator run a
[Noise](https://noiseprotocol.org/noise.html) handshake through it, one
session per worker, with keys made for that session only. With the run's
key (`VX_DTE_SECRET`, the one `vx dte plan` wrote, or one an adapter made
for its workers) it is `Noise_NNpsk0_25519_AESGCM_SHA256`: the key is the
pre-shared key, so a side without it cannot finish the handshake, and the
worker's `join` info (cores, memory, tree) is already encrypted. On GitHub
Actions with no key it is `Noise_NN_25519_AESGCM_SHA256`, and each side
binds the handshake by an OIDC token of this repository (`id-token:
write`): no secret is stored anywhere. With no adapter and no GitHub, set
the same `VX_DTE_SECRET` on the run and each worker. A message the relay
changes loses its worker; one it replays is dropped. The key never
encrypts a message, so a leaked one opens no past run.

It is not on npm yet: it is being built in this repo. It runs workers with
`local()`, `docker()`, `github()` and `gitlab()`.

## Try it

Until it is on npm, import it from a checkout of this repo. Inside this
repo it is a workspace package, so the import there is `'@vzn/vx-dte'`.

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { dte, local } from '/path/to/vx/packages/vx-dte/src/index.ts'

export default defineWorkspace({
  plugins: [
    dte({
      workers: { small: { max: 4, cpu: 2, memory: '8GB' } },
      adapter: local({ prepare: 'bun install' }),
    }),
  ],
})
```

```sh
VX_DTE_RUN=$(uuidgen) vx run build --all
```

`VX_DTE_RUN` names the run and turns distribution on; without it, `vx run`
runs here as always (on GitHub Actions, `github()` with a relay names one
itself). It is a random UUID, so no one can guess a run to
open it first or join it; vx and the relay refuse any other. `local()` starts each worker as a process in its own
git worktree of the tracked files as they are, uncommitted changes
included (untracked files are not). When a worker fails, its row names
the error line and the log that holds its whole stderr. At the run's end,
or on Ctrl-C, vx exits without waiting for the worktrees to be removed:
a detached shell removes them and prunes git's records.

`docker()` starts each worker as a container held to its size: `--cpus`
and `--memory` come from `cpu` and `memory`. The container clones this
checkout (mounted read-only) into its own filesystem at its tracked
files as they are, uncommitted changes too, runs
`prepare`, then the workspace's own `node_modules/.bin/vx dte worker`, so
the image needs Bun and git, and `prepare` installs vx. This machine's store
(`~/.vx`) and `VX_CACHE_DIR` are mounted at their own paths, and the
clone keeps this checkout's `origin`, so the workers save where the run
reads, as `local()`'s do; no remote is needed. On Linux a container runs
as this user (its home is `/tmp`, where the store is mounted), so what it
writes is this user's and git trusts the mounted checkout. A container that fails
names its error line and the log of its whole stderr:

```ts
dte({
  workers: { small: { max: 4, cpu: 2, memory: '4GB' } },
  adapter: docker({ image: 'my/bun-git', prepare: 'bun install' }),
})
```

The relay stays on loopback: on Linux a container joins the host's
network; elsewhere it reaches the relay through `host.docker.internal`.
A container ends with its worker; one still up when the run ends is
removed.

With no adapter, vx starts no workers: the run uses whichever join its
relay. In three terminals on one checkout's commit:

```ts
// .vx/workspace.ts
export default defineWorkspace({ plugins: [dte({ relay: 'http://127.0.0.1:8080' })] })
```

```sh
bun /path/to/vx/packages/vx-dte-relay/src/bun.ts --no-auth --port 8080   # the relay
export VX_DTE_SECRET=$(openssl rand -base64 32)                          # in each terminal: the same one
export VX_DTE_RUN=$(uuidgen)                                             # in each terminal: the same one
vx dte worker                                                             # a worker, as many as you like
vx run build --all                                                       # the run
```

A worker prints its name, the run, the relay and its machine, then a row
as each task starts and ends:

```
─ vx dte worker ───────────────────────────────────────────────
  worker     worker#1
  run       5f0c7a52-…
  relay     http://127.0.0.1:8080
  machine   10 cores · 17.2 GB
› b#build  running
✓ b#build  308ms
```

## On GitHub

The run is your own job's `vx run`. When it needs workers it dispatches
`.github/workflows/vx-worker.yml` once per size, with the workers of that
size as a matrix, each job named for its worker (`name: ${{ matrix.worker }}`):
a job that ends badly before its worker joins marks that worker `failed`
with the step it failed at, and the run starts another in its place. When the run ends it cancels each worker run it
dispatched, so one still queued does not hold a runner the next run
waits for. On GitHub Actions with a relay, the run names itself: no
`VX_DTE_RUN` to set. No secret: each side proves its key with the job's OIDC
token, and the relay's token is an OIDC token for the relay's URL. Such a
token lasts 5 minutes, so each side asks for a new one a minute before
its token expires.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      workers: { small: { max: 8, cpu: 4, memory: '16GB' } },
      adapter: github(),
    }),
  ],
})
```

```yaml
# .github/workflows/ci.yml, the run's job
permissions: { id-token: write, contents: read, actions: write }
steps:
  - uses: actions/checkout@v4
  - run: bun install --frozen-lockfile
  - run: bunx @vzn/vx run build test --all
    env: { GITHUB_TOKEN: '${{ github.token }}' }
```

```yaml
# .github/workflows/vx-worker.yml
name: vx-worker
on:
  workflow_dispatch:
    inputs:
      {
        run: { required: true },
        relay: { required: true },
        sha: { required: true },
        size: { required: true },
        workers: { required: true },
      }
permissions: { id-token: write, contents: read }
jobs:
  worker:
    runs-on: ${{ fromJSON('{"small":"ubuntu-latest"}')[inputs.size] }}
    strategy: { matrix: { worker: '${{ fromJSON(inputs.workers) }}' } }
    env:
      {
        VX_DTE_RUN: '${{ inputs.run }}',
        VX_DTE_RELAY: '${{ inputs.relay }}',
        VX_DTE_WORKER: '${{ matrix.worker }}',
      }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ inputs.sha }}' }
      - run: bun install --frozen-lockfile
      - run: bunx @vzn/vx dte worker
```

## On GitLab

Three jobs of your own pipeline: `vx-plan` writes the workers' child
pipeline, `vx-workers` triggers it, and `vx` is the orchestrator, your own
`vx run`. Every worker the plan wrote starts at once, beside the
orchestrator, and leaves when the run ends.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      workers: { small: { max: 4, cpu: 2, memory: '8GB' } },
      adapter: gitlab({ include: '.gitlab/vx.yml' }),
    }),
  ],
})
```

```yaml
# .gitlab-ci.yml
include: [{ local: .gitlab/vx.yml }]

vx-plan:
  extends: .vx
  script: [bunx @vzn/vx dte plan build test --all] # the run's selection
  artifacts:
    paths: [vx-workers.yml, .vx/dte/]
    reports: { dotenv: vx-dte.env }
    access: none
    expire_in: 1 hour # as long as the pipeline may run

vx-workers:
  needs: [vx-plan]
  variables: { PARENT_PIPELINE_ID: $CI_PIPELINE_ID }
  trigger:
    include: [{ artifact: vx-workers.yml, job: vx-plan }]

vx:
  extends: .vx
  needs: [vx-plan]
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
  script: [bunx @vzn/vx run build test --all]
```

```yaml
# .gitlab/vx.yml
.vx:
  image: oven/bun:1.4
  before_script: [pnpm install --frozen-lockfile]

.vx-worker:
  extends: .vx
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
```

The run's secret is an artifact no one can download (`access: none`);
the orchestrator and the workers get it through `needs`. Set
`VX_DTE_SECRET` to use your own instead.

Set `VX_DTE_GITLAB_TOKEN` (an access token with `api` scope, as a masked
CI/CD variable both `vx-plan` and `vx` see) to spawn live: the plan then
starts with the run only the workers its start keeps busy, and writes the
others as `when: manual` jobs. It reads that from the run's own graph
(`vx run <its args> --dry=json`) and history, so give `vx dte plan` the
run's selection; a task with no history counts as `unmeasured` says. The run plays one when its work needs it and cancels
the ones it never played when it ends. A played job that fails before
its worker joins fails the run's wait for it, so the run starts another or
stops, instead of waiting for the job's timeout.

## What runs where

- A worker reports the cores and memory its machine has when it joins.
  One the run started is held to the size it was started as, so
  `local()` workers sharing a host split it rather than each take all of
  it. Each frame it sends (a task begun, a command ended, a task saved,
  its heartbeat) carries its machine's load: cores busy over the last
  second and memory in use. A task goes to it only when it fits now: while
  one of its cores is free and the task's memory fits. What a worker has
  in use is what its running tasks used on their last run (history's
  measured CPU and peak RAM), or its live load plus what was sent since
  when that is more. Never less: load lags a task's start, and a test
  shard idle for a second then uses all its cores. A command that ended
  frees its cores while its outputs save. Every
  task sent begins at once; none waits in a worker's queue. A task asking
  a whole worker, or bigger than any, runs alone on an idle one (one that
  filled its worker last time). The first such task waiting holds
  the worker that empties soonest: no task after it is sent there, so it
  is not passed over again and again.
- A task naming `exec.platforms` runs only on a worker of the platform
  core placed it on: this machine's when a size has it, else the first of
  the task's a size has. A worker reports its platform when it joins: a
  size naming one refuses a worker of another; a size naming none is
  planned as this machine's and takes any worker. When the sizes run
  this machine's platform and another, a task naming none runs only on
  this machine's: a worker of another platform runs only the tasks that
  name it, so they never wait behind the rest, and leaves when they are
  done. The run starts a worker of each
  platform its work needs. A task none of whose platforms any size has
  refuses the run before a worker starts.
- Tasks waiting for room go out longest tail first: a task's recorded
  duration and its longest chain of dependants, so a long chain that got
  ready late does not queue behind many short tasks ready at once.
- A task goes to the worker that holds most of its dependencies' outputs,
  so a chain stays on one machine; then to the one with fewest cores
  free that it fits, so workers fill before the next takes work and the
  ones the rest no longer needs fall idle and leave.
- A sandboxed task runs on a worker inside the worker's own sandbox, with
  the same `exec.sandbox`, built there (`sandboxRequestFor`): its paths,
  walls and credential stores are the worker's, so an orchestrator on
  Linux can run macOS workers. A violation there fails it here, named in
  this checkout's paths.
- A persistent task a task depends on starts on the worker that runs the
  task, once per worker, ready before it, and stops when the worker leaves;
  the orchestrator never starts it, and a worker no dependant reaches
  never does (owner, 2026-10-22).
- A task whose key folds a runtime probe (`inputs.runtime`, such as
  `bun --version`) runs on a worker, which answers the probe first and
  fails the task when it answers otherwise than this machine did.
- Tasks that must run here stay here: a requested persistent task, one
  with `exec.remote: false`, interactive tasks, and their dependants
  (core's placement).
- A worker restores, by key, the declared outputs of every task the one
  it runs depends on, unless it ran or restored them before. Files a task
  writes without declaring them stay on the worker.
- A failed or uncached task is saved under a key of the run and the task,
  so no later lookup ever hits it.
- A worker whose tracked files differ from the orchestrator's (another
  tree) is refused.
- A worker that stops answering, stops saying it holds a task, or cannot
  run one (a full disk) gets no more work, and its tasks run again on
  another. A task two such workers had begun fails, naming both; one an
  worker had not begun yet does not count. With no worker of the run left
  to take it and none starting, it fails at once.
- A relay that answers nothing for 10 s, every try counted, fails every task not done
  (`the relay is unreachable`); none runs here, which may be far smaller
  than the workers. What finished is saved, so a rerun resumes from it.
  A shorter fault (a `5xx` while the host restarts the relay, a dropped
  connection) is asked through, by the orchestrator and workers alike.
- A worker that never joins says why on its row (`failed  exited 1:
…`); its job ending, a success too, is what says so. Once the first
  worker of a size joins, each other of that size not joined within twice
  that first join is given up (`did not join within 60 s`) and its job
  stopped; before one has, none is. The first three such failures in a
  run each start another worker in its place, as a checkout, install or
  join can fail on the network; a fourth starts none. When none is online
  or starting and this machine has no share, the remaining tasks fail
  with `no worker could start`.
- A socket the relay stopped pushing to, though its pings are answered,
  is found within 15 s on the relay's default: quiet a heartbeat, the
  client's beat is a frame the relay must answer within two (10 s at
  most), which also makes it push down that socket again. A participant
  the relay hears nothing from for two heartbeats is lost.
- A run where no task began or ended for a minute warns what it waits
  on, a line a task: which worker, and whether it runs or saves.

## What the run shows

Each task a worker ran says which one last on its row and after the id
on its frame, in that worker's own color, by size and the order the run
started it:

```
 ⏺︎   308ms success miss     c#build · small#1
```

An idle worker the rest of the run cannot keep busy leaves (`left`): one
beyond the peak of the cores the remaining tasks keep busy, so a lull
between two wide parts keeps it. One a remaining task needs for its size
stays. A lost worker's begun tasks run again on
another, and the run starts one in its place. A worker is lost when the
relay stops hearing it, or at once when its adapter sees its process or
job end. Workers start at the first
task the cache does not answer, so a warm run starts none. Once one has
joined, its warm-up is what the next takes at the least: work that ends
sooner starts no worker while others are online or starting, and new
workers are started for the cores the run keeps busy after that warm-up,
not before it.

The `workers` rows, live while the run goes and again in the footer,
give each worker its status (`starting`, `online`, `left`, `gone`, or `failed`
with why, such as `exited 1: Cannot find package '@vzn/vx-dte'`), the tasks it
has done, failed or had aborted by a stop, and the ones it runs now; while the run goes, those that left
are one line (`3 workers  left  9 done`). A worker the
run started is named by its size and the order it was started in; one
that joined on its own is `worker#N`. A task sent to a worker but not yet
begun there has no row; the tasks line counts it `scheduled`
(`30 success · 4 running · 12 scheduled · 62 total`). Its row and clock
start when the worker begins it. A worker is `online` while the run
goes; it ends `left` when the run let it go as not needed, `lost` when
it crashed or went silent, and `stopped` when the run's end stopped it.
Once the run is over, each worker adds its warm-up (from asking the
adapter to its join), and under it the cores and memory its size
declares and its machine reports, green when they agree and red when
not:

```
  workers    small#1  online    3 done · 2 running
            small#2  starting
            local    online    1 done
```

```
  workers    small#1  stopped  5 done · warm-up 0.1s
                     declared 2c/8G · actual 4c/16G
            small#2  lost     1 done · warm-up 0.2s
                     declared 2c/8G · actual 4c/16G
            local    online   1 done
                     actual 10c/32G
```

Under each worker, and `local`, the footer then spells out what it did:
its time online, busy and idle; its CPU peak and average in cores and
the cores the run booked for the tasks it was running, on average (a
booked from a task's start to its command's end); its cpu utilization (the core-time its
tasks used over the core-time it had); its memory peak and average, when its tasks reported any; and, for a worker, the messages and
bytes the run sent it and received from it. The `asked` line says each
time the run asked for workers: how many, when, for how many tasks that
missed, how many of them with a measured need (an unmeasured one counts
as `unmeasured`), and when its plan ended then. The first ask
waits for the needs another plugin fetches (`ctx.refining()`), such as
`@vzn/vx-schedule-history`'s default-branch timings. The `unmeasured`
line names the tasks the first ask had no measure of, and a worker that
ran two tasks or fewer names them on its row. The `total` line is the cpu utilization of every
machine together, and the share of their history the run's tasks used:

```
            small#1  stopped  5 done · warm-up 0.2s
                     declared 4c/14G · actual 4c/14G
                     online 12.1s · busy 9.8s · idle 2.3s
                     cpu peak 3.6 · used avg 2.4 cores · booked avg 3.8 · cpu utilization 61%
                     memory peak 1.2 GB · avg 640.0 MB
                     sent 6 messages · 3.1 MB, received 15 messages · 8.4 MB
            asked    1 at 0.0s for 4 cores, 5 tasks (5 measured)
            total    cpu utilization 58%
            trace    .vx/dte/trace.json · open in https://ui.perfetto.dev
```

At its end the run writes `.vx/dte/trace.json`, the run in time as a
Chrome trace (open it in https://ui.perfetto.dev or `chrome://tracing`).
Each worker is a process: its first row holds its warm-up (split, when it
says when its `vx` started, into its machine's start and vx's boot), its
idle stretches and how it ended; each task takes the first row free over
its time there, from its send through restoring its dependencies, its
command and its save, with its exit code, duration, CPU time and booked
cores. A `cores` counter per worker shows the cores booked and used at
once. The `orchestrator` process holds the cache probe, each ask for
workers, stalls, the time each task waited for room, and each restore.
Times are the orchestrator's: when it heard. On CI, upload the file as an
artifact; this repo's `ci.yml` does and links it from the job summary.

## API

- `dte(options: DteOptions)` is the plugin. `DteOptions` is
  `{ workers?, adapter?, relay?, local?, token?, scheduler?, unmeasured? }`:
  - `workers` names each `WorkerSize`, `{ cpu, memory, max?, platform? }`: its cores
    and memory (bytes, or `'8GB'`, `'512MiB'`), which the run counts on
    when it starts one, until the worker reports what its machine has,
    how many of it one run may start (absent, no cap), and its machines'
    platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`;
    absent, planned as this machine's and not checked on join). With no adapter, the sizes' platforms are
    the ones joining workers may have. Only work counts:
    a task that missed the cache, or waits on a cached one that did; groups
    and hits need no worker. At each miss, finish and join the run plays
    that work out on its workers and on N more (`src/planner.ts`), each new
    one joining after the warm-up the first took (20 s before one has),
    and takes the fewest N that end within 5% (5 s at least) of the best.
    That margin is spent once: later plans keep its deadline until new
    work is known. A task waiting on one that runs waits until it ends.
    Before any worker can say what misses, the run counts as work each
    cached task whose inputs changed since HEAD's parent (`git diff
HEAD^`), and every task after one (`src/forecast.ts`): a lockfile or
    `.vx/` change counts every cached task. A hit it guessed wrong costs a
    worker the plan cancels; with no parent, the run waits for its misses.
    Each task core's up-front cache probe found in no store
    (`TaskExecutor.demand`'s `missed`) counts as work too, the moment the
    probe answers.
    A measured task books its cores times the share of their history the
    run's finished tasks used (once they used a minute of core-time; never
    under two thirds), so a worker's bookings may reach 1.5 times its
    cores when tasks use less than history says; plans book the same.
    A worker the plan needs later starts when its warm-up nears. An idle
    worker leaves when the plan still ends in that margin without it, or,
    when its next task is two warm-ups away, with one started in its place
    a warm-up after it left: none is let go and started again. A worker still
    starting that the plan ends as well without is cancelled: the adapter
    stops it before its setup if it can (`github()` cancels its workflow
    run once no worker in it is needed), and one that joins anyway is told
    to exit. The same signal changes nothing. The
    run ends: a task the history has not measured books one free core on
    any worker (`unmeasured` sizes the run); one that used all of its worker's cores or memory (90%) last time runs
    alone on the smallest bigger size, which the run starts for it. Each
    run's history keeps where every task ran and that machine's size, so
    sizing improves run by run.
  - `adapter` is the `DteAdapter` that starts workers. Absent, the run
    starts none and uses the workers that join `relay`.
  - `relay` is the relay's URL; absent, the adapter's own.
  - `token` answers the relay's bearer token (default `VX_DTE_TOKEN`). It
    is asked again a minute before the token's `exp`, when it has one.
  - `unmeasured`, `{ cpu, memory }` (default 2 cores, `'4GB'`), is what a
    task with no measure counts for when the run decides how many workers
    to start: a new task, or one over before the Linux sandbox's first
    look (250 ms), which leaves no CPU. It books one free core on any
    worker, so it waits for no worker of its own.
  - `scheduler` (a partial `Strategy`) picks each layer of how the run schedules; a layer left
    out is the default (first named):
    - `order`, which waiting task goes first: `critical-path` (the
      longest chain after it), `graphene` (the long and the wide first),
      `fifo`;
    - `place`, which worker takes it: `best-fit` (fewest cores left),
      `tetris` (needs aligned with what is free), `worst-fit`,
      `first-fit`;
    - `book`, what a task holds: `measured` (its history), `margin`
      (a fifth more), `whole` (a worker each);
    - `scale`, how many workers: `plan` (above), `backlog` (cores for
      what is ready or running, Spark's dynamic allocation).
      `tests/sim.test.ts` plays main's runs with each.
- `vx dte worker` is a worker. It reads `VX_DTE_RUN`, `VX_DTE_RELAY` (else
  `relay`), `VX_DTE_SECRET` (the run's) and, when the run started it,
  `VX_DTE_WORKER` (its name). With no `VX_DTE_SECRET` it reads
  `.vx/dte/secret`, the one `vx dte plan` wrote. It is
  described only by the cores and memory its machine reports. It exits 0
  when the run ended before it joined.
- `vx dte plan [<tasks> <run flags>]` writes the CI files that start the
  run's workers, through the adapter's `render`: every size's `max`
  workers. With an adapter that spawns live (`live()`), only the first
  wave starts at once: the workers the run's start keeps busy, from
  `vx run <args> --dry=json` and history, as the run's own demand counts
  them. It names the run (`VX_DTE_RUN`, else the adapter's `runId()`),
  writes the workers for the orchestrator to `.vx/dte/plan.json` and,
  unless `VX_DTE_SECRET` is set, a secret to `.vx/dte/secret`.
- `DteAdapter` is `{ spawn(worker: WorkerSpawn), relay?(), close?(), cancel?(ids), render?(plan: DtePlan), live?(), runId?(), adopt?(worker) }`; `adopt` hands each worker the CI started before the run to `worker(id, size)`, which counts it and returns its spawn; `cancel` stops workers the run no longer needs that have not joined.
  `DtePlan` is `{ run, relay, workspaceRoot, workers }`, each worker
  `{ id, size, cpu, memory, live }`: a `live` one the run `spawn`s when
  it needs it.
  `WorkerSpawn` is `{ run, relay, size, cpu, memory, index, id, workspaceRoot, env }`,
  with `memory` in bytes,
  where `id` is the worker's name (`small#2`, numbered within its size) and `env` holds the three
  variables the worker reads.
- `docker(options: DockerOptions)` starts workers as containers and a relay
  of its own on loopback. `DockerOptions` is `{ image, prepare? }`.
- `github(options?: GithubOptions)` dispatches workers as matrix jobs of
  one workflow, one dispatch per size and demand. `GithubOptions` is
  `{ workflow? }` (default `vx-worker.yml`). Its workers are `keyless`. It
  needs `GITHUB_TOKEN` with `actions: write`. See [On GitHub](#on-github).
- `gitlab(options: GitlabOptions)` runs workers as jobs of a child
  pipeline. `GitlabOptions` is `{ include, tags? }`: the file holding the
  `.vx-worker` job template every worker job extends, and runner tags by
  size. See [On GitLab](#on-gitlab).
- `local(options?: LocalOptions)` starts workers on this machine and a relay
  of its own on loopback. `LocalOptions` is `{ prepare? }`: a shell line
  each worktree runs before its worker starts.

`@vzn/vx-dte-relay` is a dependency for `local()`'s and `docker()`'s relay, loaded only
when a distributed run starts.
