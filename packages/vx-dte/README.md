# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx. One `vx run` spreads its tasks over
workers your own CI starts, and you see it as one run.

How a run works:

- The run you start is the orchestrator. It runs no task itself; it only
  restores cache hits.
- It starts workers and hands the ready tasks to the workers with room,
  critical path first.
- It ranks tasks by history, and ranks them again when fetched timings land.
- A worker runs a task in its own checkout. It saves the task's output, and
  the files its declared outputs left, to the workspace's cache under the
  task's key.
- Those land here before the task ends, so the run reports the task as its
  own.

No file travels through the relay; it carries only orders and status. So
the workers and this machine need one cache they all read: a remote the
workers write, or one shared store.

A worker reads that cache as the run does, under the run's refs.

With no access of its own, a worker borrows short-lived access from the
run's remote: an OIDC exchange's token, never a stored secret.

Workers and the orchestrator meet at a relay
([`@vzn/vx-dte-server`](../vx-dte-server/README.md)), since CI runners take
no inbound connection.

The relay speaks the [Switchboard protocol](../vx-dte-server/PROTOCOL.md).
The run is a session, its id the run id, the orchestrator its host and each
worker a peer.

Host your own relay: its [README](../vx-dte-server/README.md) has a Deploy
to Cloudflare button, which asks only for the repositories whose runs it
carries.

A run id is a channel:

- Workers join it before or after the orchestrator does.
- The orchestrator claims it with a key made for that run.
- The relay keeps the key's public half, and passes nothing to or from a
  side that cannot sign by it.
- The orchestrator checks each worker the moment it appears, and removes
  any without the run's key from the channel.

The relay reads nothing they say. Each worker and the orchestrator run a
[Noise](https://noiseprotocol.org/noise.html) handshake through it.

- There is one session per worker, with keys made for that session only.
- With the run's key (`VX_DTE_SECRET`, or one an adapter made for its
  workers), the handshake is `Noise_NNpsk0_25519_AESGCM_SHA256`.
- The key is the pre-shared key, so a side without it cannot finish the
  handshake.
- The worker's `join` info (cores, memory, tree) is already encrypted.
- On GitHub Actions with no key, it is `Noise_NN_25519_AESGCM_SHA256`.
- There, each side binds the handshake by an OIDC token of this repository
  (`id-token: write`). No secret is stored anywhere.
- With no adapter and no GitHub, set the same `VX_DTE_SECRET` on the run
  and on each worker.
- A message the relay changes loses its worker; one it replays is dropped.
- A worker's join the relay delivers again admits no second worker: under
  its id it is dropped, under another it is refused.
- The key never encrypts a message, so a leaked key opens no past run.

You start workers with `local()`, `docker()`, `github()` and `gitlab()`.

## Bodies

This section says what vx-dte puts in Switchboard's `info` and `body`. You
need it only to write your own worker or orchestrator.

<details><summary>Details</summary>

Each worker and the orchestrator run a Noise handshake through the relay,
prologue `vx-dte\0<run>`, with the worker as the initiator.

- With the run's key: `Noise_NNpsk0_25519_AESGCM_SHA256`, the psk being the
  key's SHA-256.
- Keyless on GitHub Actions: `Noise_NN_25519_AESGCM_SHA256`.
- Keyless, the worker's `join` carries an OIDC token whose audience is
  `vx-dte:<base64url SHA-256 of "join\0<run>\0<message 1>">`.
- Keyless, the orchestrator's `hello` carries one for
  `"hello\0<run>\0<handshake hash>"`.
- Each side checks the other's as a token of the same `repository_id`.
- With `github()`, the orchestrator also checks that a worker's `run_id` is
  a workflow run it dispatched.
- That check matters because the run's id is a dispatch input: anyone who
  reads the repository's Actions sees it.
- A dispatch GitHub answers without a run id (204) is refused, so its
  workers exit.

| Who           | `info` / `body`                                            |
| ------------- | ---------------------------------------------------------- |
| worker `join` | `info: { "noise": <message 1>, "token"? }`                 |
| orchestrator  | `{ "type": "hello", "noise": <message 2>, "token"? }`      |
| orchestrator  | `{ "type": "refused", "reason" }`, plain, then `remove`    |
| either, then  | `["<n>.<ciphertext>", …]`, or `["+", …]` with more to come |

- The orchestrator checks each worker the moment the relay says it joined,
  and `remove`s one whose handshake fails.
- Message 1's payload is the worker's info (JSON), encrypted under the psk.
- After the handshake, every body is Noise transport messages, base64, each
  at most 65535 bytes.
- Each message names its nonce `n` (Noise §11.4), since a relay may reorder.
- Each is sealed with associated data `<first n>.<parts>` of its body, so no
  part opens in another body.
- A body's parts take consecutive nonces, so none is repeated or reordered
  in it.
- A body of more than 5 parts goes over several sends of 5, each but the
  last led by `"+"`, so no frame passes the relay's 1 MiB.
- The receiver holds those sends until the last, and opens the body whole.
- A body whose first nonce was seen before is a replay, and is dropped.
- A body older than one already opened loses its sender: the relay held it
  back, since the wire's numbers are outside the seal.
- A body that does not open loses its sender.
- The plaintext is a lead byte, then the length of every body its sender
  sealed before (4 bytes, big-endian, mod 2³²), then the payload.
- Lead byte `1`: the payload is JSON, an array of the messages sent
  together (up to 64 KiB).
- Lead byte `0`, when smaller so: its zstd frame's length (4 bytes), then
  the frame.
- It is compressed before sealing, since no relay or socket compresses what
  is sealed.
- The orchestrator's bodies are compressed with the last 16 KiB of its
  bodies' JSON to that worker as their dictionary.
- So a batch's env and paths said before cost a few bytes.
- A worker's bodies go without a dictionary, which would cost the
  orchestrator some 100 µs to open each.
- A body whose length is not the receiver's own count was sealed after one
  it never opened, which the relay kept back. It loses its sender.
- A body is padded with trailing spaces to its size class: a power of two
  from 64 bytes, then whole transport messages.
- So the relay learns no size within a class.
- Inside, each send is numbered and acknowledged end to end
  (`{ "n", "b", "a"? }`: its number, body and ack).
- A quiet worker reports (Switchboard § Delivery, § Liveness).

</details>

## Try it

Install the plugin, declare it, and give the run a name:

```sh
bun add -d @vzn/vx-dte
```

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { dte, local } from '@vzn/vx-dte'

export default defineWorkspace({
  plugins: [
    dte({
      workers: { linux: { machines: { small: { max: 4, cpu: 2, memory: '8GB' } } } },
      adapter: local({ prepare: 'bun install' }),
    }),
  ],
})
```

```sh
VX_DTE_RUN=$(bun -e 'console.log(crypto.randomUUID())') vx run build --all
```

`VX_DTE_RUN` names the run and turns distribution on. Without it, `vx run`
runs here as always. Set but empty, the run is refused.

On GitHub Actions, `github()` with a relay names the run itself.

The run id is a random UUID, so no one can guess a run to open it first or
join it. vx and the relay refuse any other id.

`local()` starts each worker as a process in its own git worktree, at the
workspace's place in it:

- The worktree holds the tracked files as they are, uncommitted changes
  included.
- A file mid-merge, or flagged `assume-unchanged` or `skip-worktree`, is
  taken as it is on disk.
- Untracked files are not taken: a task that keys one fails until you
  `git add` it.
- A workspace in a subdirectory of its repository works too.
- Workers save to the run's store, a relative `cache.dir` or `--cache-dir`
  too.

<details><summary>Details</summary>

- A run from a git hook works too. The worktree and its worker drop the
  hook's repository variables (`git rev-parse --local-env-vars`).
- So the index being committed is left as it is.
- A linked worktree's hook `GIT_DIR` is dropped where git finds that
  repository anyway, as core does.
- So a workspace in a subdirectory is found there.
- When a worker fails, or cannot start, its row names the error line and
  the log that holds its whole stderr and all `prepare` printed.
- When that log cannot be written, the row names the error line alone.
- At the run's end, or on Ctrl-C, vx exits without waiting for the
  worktrees to be removed.
- A detached shell waits up to 5 s for the workers to leave, kills any still
  running, removes the worktrees and prunes git's records.
- A run whose vx was killed (`kill -9`) removes none.
- The next `local()` run on the machine that starts a worker removes them,
  once their run's process is gone. A run of cache hits starts none and
  leaves them.

</details>

`docker()` starts each worker as a container held to its size: `--cpus`
and `--memory` come from `cpu` and `memory`.

```ts
dte({
  workers: { linux: { machines: { small: { max: 4, cpu: 2, memory: '4GB' } } } },
  adapter: docker({ image: 'my/bun-git', prepare: 'bun install' }),
})
```

- The container clones this checkout (mounted read-only) into its own
  filesystem, at its tracked files as they are, uncommitted changes too.
- It runs `prepare`, then the workspace's own
  `node_modules/.bin/vx dte worker`.
- So the image needs Bun and git, and `prepare` installs vx.
- This machine's store (`~/.vx`) is mounted at its own path.
- So is a cache dir the workspace names (`cache.dir`, `VX_CACHE_DIR`,
  `--cache-dir`).
- The clone keeps this checkout's `origin`, so the workers save where the
  run reads, as `local()`'s do. No remote is needed.
- On Linux a container runs as your user (its home is `/tmp`, where the
  store is mounted).
- So what it writes is yours, and git trusts the mounted checkout.
- A container that fails names its error line, and the log of its whole
  stderr and all `prepare` printed.
- The relay stays on loopback. On Linux a container joins the host's
  network; elsewhere it reaches the relay through `host.docker.internal`.
- A container ends with its worker. One still up when the run ends is
  removed.

With no adapter, vx starts no workers: the run uses whichever workers join
its relay. For example, in three terminals on one checkout's commit:

```ts
// .vx/workspace.ts
export default defineWorkspace({ plugins: [dte({ relay: 'http://127.0.0.1:8080' })] })
```

```sh
bun /path/to/vx/packages/vx-dte-server/src/bun.ts --no-auth --port 8080   # the relay
export VX_DTE_SECRET=$(openssl rand -base64 32)                          # in each terminal: the same one
export VX_DTE_RUN=$(bun -e 'console.log(crypto.randomUUID())')   # in each terminal: the same one
vx run build --all                                                       # the run, first
vx dte worker                                                             # a worker, as many as you like
```

A worker started before its run finds no run on the relay: it says so
and exits. So does one the run ends before taking (a warm run takes none).

A run with no worker yet says once, a second in,
`[vx] waiting for a worker to join run <id> on the relay…`.

Its live
`workers` row reads `0 joined · waiting for a worker to join the relay`
with no time left shown until one does.

A worker prints its name, the run, the relay and its machine. Then it
prints a row as each task starts and ends:

```
─ vx dte worker ───────────────────────────────────────────────
  worker     worker#1
  run       5f0c7a52-…
  relay     http://127.0.0.1:8080
  machine   10 cores · 17.2 GB · Apple M1 Pro
› b#build  running
✓ b#build  308ms
```

## On GitHub

The run is your own job's `vx run`. When it needs workers, it dispatches
`.github/workflows/vx-worker.yml` once per size.

- That size's workers run as a matrix, each job named for its worker
  (`name: ${{ matrix.worker }}`).
- A job that ends badly before its worker joins marks that worker `failed`,
  with the step it failed at.
- The run then starts another worker in its place.
- When the run ends, it cancels each worker run it dispatched. So one still
  queued does not hold a runner the next run waits for.
- On GitHub Actions with a relay, the run names itself: you set no
  `VX_DTE_RUN`.
- No secret: each side proves its key with the job's OIDC token.
- The relay's token is an OIDC token for the relay's URL.
- Such a token lasts 5 minutes, so each side asks for a new one a minute
  before its token expires.

<details><summary>Details</summary>

- Every job of a repository shares its `GITHUB_TOKEN`'s API limit, 1000
  requests an hour.
- So the run reads its workers' jobs at most every 30 s.
- It asks with each answer's ETag, since an unchanged answer is free.
- It asks nothing until a spent limit resets.
- A dispatch the limit refuses is sent again at the reset, if that comes
  within 5 minutes. Past that it fails, naming when.
- A cancel the limit refuses is sent again at the reset, if that comes
  within a minute.
- A run that dies before it cancels (a kill, a timed-out job) leaves the
  cancel to its workers.
- The first worker that starts finds the run gone at the relay, and cancels
  its own workflow run, its queued fellows with it.

</details>

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      workers: { linux: { machines: { small: { max: 8, cpu: 4, memory: '16GB' } } } },
      adapter: github(),
    }),
  ],
})
```

```yaml
# .github/workflows/ci.yml
# Written by vx dte init: the run. main and a merge queue run every task;
# a pull request runs what it changed and its dependents. This job only
# orchestrates: every task runs on a worker (vx-worker.yml).
name: ci

on:
  pull_request:
  merge_group:
  push:
    branches: [main]

# A newer push to a pull request cancels its older run, and its workers.
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  vx:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      # The relay and the workers: each side proves itself by its OIDC token.
      id-token: write
      # Dispatching and cancelling the workers.
      actions: write
    env:
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      # One commit: --affected fetches its base itself.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      - run: bun install --frozen-lockfile --filter './'
      - run: bun vx lock --check
      # Name the tasks in both quotes, as 'build test --affected' and
      # 'build test --all': with none named, vx fails, listing them.
      - run: bun vx run ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}
```

`vx dte init` writes both workflows from `dte()`: the run's above and the
workers' below. Then it prints what is left to do:

- a relay that admits them (its `ALLOW`, and how to deploy one)
- a shared remote cache
- the commit

What `vx dte init` writes:

- In a terminal it asks what main runs (`pipelines.main`'s tasks by
  default) and what a pull request runs (main's by default). No tasks is
  refused.
- Without a terminal it writes `pipelines.main`'s tasks. With none
  declared it names none, and the run fails, listing the tasks, until you do.
- A workspace in a subdirectory of its repository gets the files at the
  repository's root, its jobs running in that directory.
- Each size runs on its platform's GitHub-hosted runner: `ubuntu-latest`
  for none named, `ubuntu-24.04-arm`, `macos-latest`, `macos-15-intel`.
- Or it runs on the label a machine's `runsOn: 'ubuntu-latest-16-cores'`
  names, as `gitlab({ tags })` does.
- It installs with the package manager your lockfile names.
- It runs vx as `bun vx`, which runs the repo's own vx and never downloads
  one, as `pnpm exec` does.
- Yarn works too, but Bun reads no Plug'n'Play, so a Yarn workspace sets
  `nodeLinker: node-modules`.
- `--dry` prints the files. A file you changed is kept unless you pass
  `--force`.

A worker's job is its setup and one command, `vx dte worker`:

- It reads what the run dispatched it with (the run, the relay,
  `github({ env })`) from the event.
- The event is `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH`, in the workflow
  `GITHUB_WORKFLOW_REF` names.
- It joins, works, and leaves when the run ends.

For the sizes above:

```yaml
# .github/workflows/vx-worker.yml
# Written by vx dte init from dte() in .vx/workspace.ts: the workers of a
# DTE run, which github() dispatches once per size. After changing the
# sizes, run vx dte init --force.
name: vx-worker

on:
  workflow_dispatch:
    inputs:
      run: { required: true }
      relay: { required: true }
      sha: { required: true }
      size: { required: true }
      workers: { required: true }
      # The variables github({ env }) hands the workers, as a JSON object.
      env: { required: false, default: '{}' }

permissions:
  contents: read
  id-token: write

jobs:
  worker:
    # The run reads a job that failed before its worker joined by this name.
    name: ${{ matrix.worker }}
    # A job's permissions replace the workflow's, so it names all three.
    permissions:
      contents: read
      id-token: write
      # A worker of a run that is over cancels its own run.
      actions: write
    runs-on: ${{ fromJSON('{"linux.small":"ubuntu-latest"}')[inputs.size] }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        worker: ${{ fromJSON(inputs.workers) }}
    env:
      VX_DTE_WORKER: ${{ matrix.worker }}
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: '${{ inputs.sha }}', persist-credentials: false }
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      # Every project: only pnpm selects by a git diff, as
      # `pnpm install --frozen-lockfile --filter "...[origin/main]"`
      # (fetch origin/main first: the checkout is one commit).
      - run: bun install --frozen-lockfile
      # Joins the run, works, and leaves when it ends; one that finds its
      # run over cancels this workflow run, its queued workers with it.
      - run: bun vx dte worker
```

## On GitLab

You need one pipeline file. Your `vx` job is the orchestrator.

- Once on the relay, it triggers a pipeline of the same file for each wave
  of workers it asks of a size.
- It triggers with the job's own `CI_JOB_TOKEN`, so no worker starts before
  the run and no token is stored.
- Each size's job is a matrix of `max` slots (`VX_DTE_SLOT`).
- That pipeline runs only the slots the wave names (`VX_DTE_PICK`), at the
  run's commit.
- Each slot takes its name from `VX_DTE_IDS`.
- The run starts workers as its work needs them, up to each size's `max`.
- `gitlab()` needs `max`, at most 200 (a matrix's limit).
- GitLab lets a job token trigger a pipeline but not cancel one.
- So a worker the run no longer needs leaves when it joins, or when the run
  ends.
- Each trigger passes the workers' variables. So set Settings > CI/CD >
  Variables > "Minimum role to use pipeline variables" to Developer.
- A project made since GitLab 17.7 lets no one use pipeline variables, and
  refuses every trigger.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      workers: { linux: { machines: { small: { max: 4, cpu: 2, memory: '8GB' } } } },
      adapter: gitlab(),
    }),
  ],
})
```

`vx dte init` writes the file from `dte()`, in the package manager your
lockfile names. It asks what main and a merge request run:

```yaml
# .gitlab-ci.yml
# Written by vx dte init from dte() in .vx/workspace.ts. The vx job
# runs no task: once it is on the relay it triggers a pipeline of this
# file for each wave of workers of a size, which runs only those slots
# of that size's job.
# Name the tasks in the vx job, as 'build test --all': with none named,
# vx fails, listing them.
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "pipeline" && $VX_DTE_SIZE

# The image needs Bun; a job adds git if it lacks it. By digest: a tag
# can move under the same name.
default:
  image: oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d

vx:
  rules:
    - if: $VX_DTE_SIZE
      when: never
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      variables: { VX_TASKS: '--affected' }
    - when: on_success
      variables: { VX_TASKS: '--all' }
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
  before_script:
    - command -v git || (apt-get update -qq && apt-get install -qq -y --no-install-recommends git)
    - bun install --frozen-lockfile --filter './'
  script:
    - bun vx lock --check
    - bun vx run $VX_TASKS

# A worker runs at the run's commit, which its branch may have moved past.
.vx-worker:
  variables: { GIT_DEPTH: 1 }
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
  before_script:
    - command -v git || (apt-get update -qq && apt-get install -qq -y --no-install-recommends git)
    - git fetch -q --depth 1 origin $VX_DTE_SHA
    - git checkout -q FETCH_HEAD
    - bun install --frozen-lockfile
  script: [bun vx dte worker]

'vx-worker linux.small':
  extends: .vx-worker
  parallel:
    matrix:
      - VX_DTE_SLOT: ['1', '2', '3', '4']
  rules: [{ if: $VX_DTE_SIZE == "linux.small" && $VX_DTE_SLOT =~ $VX_DTE_PICK }]
```

- `gitlab({ tags })` names each size's runner tags.
- Each job's ID token (`VX_DTE_TOKEN`) admits it to the relay.
- The worker proves itself to the run by the run's secret, made for that
  run only and passed as a trigger variable.
- A GitLab ID token cannot bind the handshake as GitHub's does: its
  audience is fixed when its job starts.
- To use your own secret, set `VX_DTE_SECRET` as a masked variable in
  Settings > CI/CD > Variables. Both the vx job and the workers read it.
- The run never passes a secret you set as a trigger variable: anyone who
  sees the pipeline could read it.

## What runs where

Tasks run on workers, cache hits restore here, and every result comes back
here. The rules below say how.

**Room on a worker.** A task goes to a worker only when it fits now: while
one of its cores is free and the task's memory fits.

- A worker reports the cores and memory its machine has when it joins.
- A worker the run started is held to the size it was started as.
- So `local()` workers sharing a host split it, rather than each take all
  of it.
- Every task sent begins at once; none waits in a worker's queue.

<details><summary>Details</summary>

- Each frame a worker sends (a task saved, its report, a fault) carries its
  machine's load.
- That load is the cores busy over the last second, and the memory in use.
- With nothing else to say, the worker sends its report as a heartbeat:
  that load, the tasks it runs and the last batch it read.
- A task of that batch, or of one before, that its report no longer names
  goes back to the queue at once.
- A worker's use counts what its running tasks used on their last run
  (history's measured CPU and peak RAM).
- Plus the cores its machine spends on no task of the run while it runs
  some: each frame's load less its tasks', averaged.
- That overhead is a GitHub runner's own agent and the like: 0.6 to 1.1
  cores of a 4-core small.
- The use is instead what its tasks use live, when that is more.
- Live use is its machine's load where the tasks do not say, plus those
  cores and what was sent since.
- Never less: load lags a task's start, and a test shard idle for a second
  then uses all its cores.
- A command that ended frees its cores while its outputs save.
- It also frees its worker's load until the next frame, since that load
  counted the task.

</details>

**Which worker gets a task.** Where each task goes is the plan's (see
`workers` under [API](#api)). A task fills a worker before another is
asked.

- So a 10-core task facing one free core asks a worker.
- And two small tasks share a busy worker rather than pay a warm-up.
- Of equal choices, a task goes to the worker the last plan gave it, then
  to the busiest.
- So workers fill before the next takes work, and the ones no longer needed
  fall idle and leave.

<details><summary>Details</summary>

- A task that filled its worker last time runs only on a bigger size while
  the run has or may ask one.
- A task wider than every worker runs on the most cores free on one, when
  that ends the run sooner than waiting for room.
- For example, a 20-core task of 60 s starts now on the 9 free cores of a
  10-core worker busy with a 150 s chain, not after it.

</details>

**Platforms and worker types.** A task naming `exec.platforms` runs only on
a worker of the platform core placed it on.

- That is this machine's platform when a size has it, else the first of the
  task's platforms that a size has.
- A task naming `exec.worker` runs only on machines of that worker type.
- Any other task runs on the first type, in declared order, with a machine
  of one of its platforms.
- So a type listed last (a costly Mac) gets only the tasks no other type
  can take.

<details><summary>Details</summary>

- A worker reports its platform when it joins.
- A size naming a platform refuses a worker of another.
- A size naming none is planned as this machine's, and takes any worker.
- When the sizes run this machine's platform and another, a task naming
  none runs only on this machine's.
- A worker of another platform runs only the tasks that name it, so they
  never wait behind the rest. It leaves when they are done.
- The run starts a worker of each platform its work needs.
- A task none of whose platforms any size has refuses the run before a
  worker starts.
- Core refuses the run before a worker starts when no type has the
  `exec.worker` name.
- It refuses it too when none of that type's machines runs one of the
  task's platforms.
- A worker that joins on its own is of the first type with its platform.

</details>

**Nothing runs here.** No task runs on the orchestrator; only cache hits
restore there.

- A task with `exec.remote: false`, an interactive task, and their
  dependants run on workers too (the executor is `exclusive`).
- A task no worker can take refuses the run before any starts, naming it.
- That is one whose `exec.platforms` no size offers, or a persistent task
  asked for on its own.
- An `exec.remote: 'only'` task's files stay on the workers: this machine
  restores its output, never its files.
- Under `--cache-download=toplevel` or `none`, a task's files it defers land
  here only if a task here needs them.

**Sandboxed tasks.** A sandboxed task runs on a worker inside the worker's
own sandbox, with the same `exec.sandbox`, built there
(`workerRuntime().prepare`).

<details><summary>Details</summary>

- Its paths, walls and credential stores are the worker's. So an
  orchestrator on Linux can run macOS workers.
- A violation there fails the task here, named in this checkout's paths.
- Its `fix:` line names the grant a run here would, from what the worker's
  checkout held when the task ended (`SandboxViolation.entry`).
- An empty file it wrote over a write grant's placeholder is its output.
  Only a placeholder it never touched is removed.
- The outputs of its dependencies that it may read are listed there too,
  once they are restored on the worker.
- Its order names the dependencies, so it is sent before their files are
  back on the orchestrator.
- A sandbox the worker cannot host (no `bwrap` in its image) fails the task
  there, as it fails here. The worker stays in the run.

</details>

**Results coming back.** A task's output replays here as its worker read
it: stdout and stderr in the order the task wrote them, bounded as core
bounds a run's.

<details><summary>Details</summary>

- A task whose dependants all run on workers is done once it ran. Its `end`
  carries its output.
- Its files come to the orchestrator meanwhile (core's
  `download: 'trailing'`).
- A dependant starts at once, its own files land after its upstream's, and
  the run ends with every file here.
- They land as the worker made them, through its entry: bytes, modes,
  symlinks and empty directories. A dependant on another worker gets them
  the same way.
- An output no entry can hold (a link out of the workspace or into
  `.git`) fails the task on its worker, naming it.
- A run here keeps such a file and saves no entry, but a worker's files
  come back only through an entry.
- Two runs that make one key at once each land their own; the cache keeps
  one whole entry, and a later hit lands that one.
- A cached one is saved here once its files land.
- An output over 256 KB is read from the entry first.
- A task that declares no output (a test, a lint) is done here once its
  worker says so.
- Its `end` carries its output, and its entry is not read back first. Core
  saves it here as after any task.
- A result too long for one relay frame (thousands of sandbox violations,
  or of files a formatter changed) is sent in parts, none of it dropped.
- An order too long for one frame (a task with thousands of deps) sends its
  deps ahead of it the same way.
- A worker gets each dependency in full once. Later orders name it, so a
  deep graph's orders stay small.

</details>

**Persistent tasks.** A persistent task a task depends on starts on the
worker that runs the task, once per worker, ready before it.

<details><summary>Details</summary>

- It stops there once no task left in the run uses it (the run's
  `unneeded`), or when the worker leaves.
- The orchestrator never starts it, and a worker no dependant reaches never
  does.
- Its CPU is learned on the worker each second as
  `cores = base + each running dependant's cost`.
- The base comes from looks with no dependant running, each cost from looks
  with it. A look on a full machine only raises them.
- Each dependant's cost is added to its CPU, so its history books it.
- The base is booked once on each worker that starts the server, in
  placement and in the plan.
- The base is kept in history for the next run, as warm-ups are.
- A server that crashes (a non-zero exit) or never becomes ready fails, as
  on one machine.
- A dependant that ran against it ends as its command did, but is not
  saved, nor is what builds on it.
- A dependant that had not begun is skipped, blocked by it.
- Each says why as a warning.

</details>

**Commands and environment.** A task's command runs on a worker as written:
a plugin changes where a command runs, never what it is.

- A path under this machine's checkout in the environment is moved to the
  worker's.
- A path written into the command is not. So a `local()` worker would read
  and write this checkout through it.
- Name a file relative to the task's directory, or through `$PWD`.

<details><summary>Details</summary>

- A task runs with the orchestrator's environment under the worker's root.
- `HOME`, `TMPDIR`, `USER` and the like are the worker's own, unless the
  task's `env.define` sets them or its `inputs.env` keys them.
- A keyed one is the orchestrator's value, or unset where it is unset
  there. So the worker runs on what the key saw.
- A pattern (`TMP*`) keys each name it covers: one unset on the
  orchestrator is unset on the worker too.
- `npm_execpath` is the workspace's package manager on the worker, as core
  sets it on a local task.
- A task whose key hashes a runtime probe (`inputs.runtime`, such as
  `bun --version`) runs on a worker, which answers the probe first.
- A worker that answers otherwise than this machine did is refused, as
  one on another tree is.
- Its line: `[vx] dte: refused worker <id>: \`bun --version\`
  answers "1.4.3" on this worker, "1.4.4" on the run's machine, …`.
- It runs nothing more, and its tasks go to workers that answer alike.
- One the run started counts as a failed start: with none left, the run
  says no worker could start.
- A worker answers each probe once, in each directory it is asked in.
- A task whose `exec.env.define` sets `PATH` (or whose `inputs.env` keys it)
  has its probes answered on that `PATH`, as it runs, not the worker's own.
- A path under the worker's checkout root reads as the same path under this
  machine's, as the task's environment does.

</details>

**Dependencies' files.** A worker restores, by key, the declared outputs of
every task the one it runs depends on.

- It restores each after its own dependencies, so an additive task's
  rewrite of an upstream file stands.
- It skips the ones it ran or restored before.
- Files a task writes without declaring them stay on the worker.

<details><summary>Details</summary>

- An uncached task declares no outputs, so no cache carries its files.
- Its dependants go to the worker it ran on, unless it is sandboxed with no
  write grant and so leaves no file.
- A dependant waits there up to 10 s. Past that, the upstream runs again
  where the dependant can go, and the dependant follows it.
- The same happens when that worker is gone or of another platform, or when
  its uncached upstreams are on two workers.
- An idle worker holding such files stays while a task to come reads them.
  No new worker is asked for such a task.
- An uncached task whose `exec.worker` or `exec.platforms` rules out where
  its dependant runs refuses the run before a worker starts.
- That refusal names both tasks: cache the upstream, or run both alike.
- A task whose upload no remote took after three tries (too big, a 429, a
  reset connection) is its worker's fault.
- That worker takes no more tasks, and the task runs on another. A second
  fault fails the run.
- Before a task runs, its worker removes the files under its outputs that
  an earlier task left.
- It keeps committed files (one reached through a linked output
  directory, `dist -> build`, too), nested projects' files, and its
  dependencies' outputs (an additive task builds on its upstream's tree).
- Before laying what the task left, this machine removes the same, cached
  task or not. So its outputs end as the worker's did.
- An upstream's file the task leaves as it found it is not saved in its
  entry.
- One it removes, or a committed file under its own outputs it removes, is
  removed on this machine too.
- Unless a link on its path leads elsewhere: that file is kept, with a
  warning.
- Such a task saves no entry, as core saves none.
- A hit only this machine's cache holds (the remote evicted it, or this run
  does not write the remote) is uploaded to the remotes the workers read.
- That upload happens before a task that depends on it is sent.
- With no remote written, its dependant fails on the worker, naming the
  entry.
- A hit whose remote copy does not read back on a worker (a truncated
  upload) is sent again from this machine over that copy.
- The task then runs again; this happens once per entry.

</details>

**Saves no lookup hits.** A failed or uncached task is saved under a key of
the run, the task and the send, so no later lookup ever hits it. A retry
gets its own key.

<details><summary>Details</summary>

The same goes for a task core would not save:

- one of a `--no-cache` or read-only run
- one built on a dependency `--exclude-dependencies` left out
- one that left a process running that may still write its outputs
- one a stopped run cancelled
- one whose declared outputs did not all land there by core's rule, which
  fails it, as a run here does
- one whose outputs hold a committed file reached through a linked output
  directory (`dist -> build`): no key names it, so a hit put old bytes back
  over a newer commit
- one that left a tracked file under its project changed on its worker (a
  formatter's input)
- one that found an untracked, unignored file under its project there (its
  outputs and its dependencies' aside), which this machine never sees

For those last two, core withholds its own save when the key read that file
or its inputs declare it, and says so.

- Under `--force`, a success is saved under its key (which keeps an entry it
  already holds, as core does) and under the run's key.
- This machine and the dependants' workers restore the run's key: the bytes
  this run built, never the entry it bypassed.

</details>

**Same tree.** A worker whose tracked files differ from the orchestrator's
is refused. The orchestrator says so as it happens:
`[vx] dte: refused worker <id>: <reason>`.

<details><summary>Details</summary>

- A different tree is another commit, or the same commit with a tracked
  file changed, such as by a prepare step.
- The reason first names a project of the run git does not track.
- `git add` that project: a worktree lacks it, so its install rewrites the
  lockfile.
- Then the reason names up to three tracked files the worker changed after
  checkout.
- Both sides read their tracked files as they are on disk, a file flagged
  `assume-unchanged` or `skip-worktree` too.
- A file a sparse checkout left off disk is read as its index holds it.
- So the same change on both sides is the same tree.
- A worker runs the commit's bytes and modes, which are the ones the key
  read.
- The run's snapshot takes each file's executable bit as on disk, under
  `core.fileMode=false` too, as core keys it.
- A worker writes back, as the commit holds it, each file a git filter of
  its own checked out otherwise.
- Those filters are `text`, `eol`, `ident`, `filter` such as LFS,
  `working-tree-encoding`, and `core.autocrlf`.
- A task whose key hashes a tracked file that is on disk other than the
  commit holds it fails, naming the file.
- Examples: CRLF such a filter wrote, an expanded ident, an LFS file's
  content. No worker builds on those bytes.
- A task whose key hashes a file the run's commit lacks fails, naming the
  file: no worker has it.
- Such a file is untracked, gitignored and named outright, or inside a
  submodule, whose files the commit holds only as a gitlink.
- `git add` puts it in the tree `local()` and `docker()` workers check out.
- Workers on CI check out the pushed commit, so there it must be committed.
- A dependency's declared output is not such a file: its worker restores it
  first, or, uncached, ran it there.
- A task whose project the commit lacks (no file under it tracked) fails,
  naming the project.
- A run whose `.vx/workspace.*` is untracked is refused before a worker
  starts.

</details>

**Timeouts and retries.** A task's `exec.timeout` counts from its start on
its worker: the wait for a worker still booting is not its run (the
executor declares `timeouts`).

<details><summary>Details</summary>

- A worker that stops answering, stops saying it holds a task, or cannot
  run one (a full disk) gets no more work.
- Its tasks run again on another worker.
- A task two such workers were sent fails, naming both. One whose send
  failed does not count.
- With no worker of the run left to take it and none starting, it fails at
  once.
- A task that failed and retries (its `retries`, or the one retry a
  known-flaky task gets) runs on another worker than the attempt that
  failed.
- Core asks for this (`ExecuteRequest.attempt`): the worker, or what ran
  beside it, may be the flake.
- With no other worker of its platform in the run, it runs there again
  rather than wait.
- A worker still holding a cancelled attempt that it has not answered
  takes no new attempt of that task until it ends that one. Its end is
  never counted as the retry's.
- A cancelled attempt that ends after its retry lays none of its files
  here, and dependants are sent the retry's entry, not its own. Its time
  is not learned as the task's either.

</details>

**Relay faults.** A relay that answers nothing for 10 s, every try counted,
fails every task not done (`the relay is unreachable`).

<details><summary>Details</summary>

- None of those tasks runs here, since this machine may be far smaller than
  the workers.
- What finished is saved, so a rerun resumes from it.
- The footer counts each worker that had joined as `lost`, with what it
  ran.
- A fault (a `5xx`, a dropped or refused connection) is tried again 3
  times, by the orchestrator and workers alike.
- The third failed retry ends them (`no socket in 3 dials`).
- The waits are random, from 250 ms doubling to half a heartbeat, each
  jittered to half: 1.4 to 2.75 s in all on the default.
- So a relay down or restarting is asked through only when it is back
  within them.
- A relay down under 1.4 s always is; one down past 2.75 s fails the run.
- The relay stores nothing, so a restart forgets the run.
- After one, the orchestrator joins again as its host and each worker joins
  again as itself, for two heartbeats (4 s on the default).
- Tasks keep running meanwhile. What either side sent goes again once both
  are back, taken once.
- A worker keeps what it runs, and one sent a task it runs already does not
  run it again. So no work repeats.
- One not back by then ends: a worker's tasks run elsewhere, an
  orchestrator's run fails.
- Joining has the same 10 s in all and the same 3 retries.
- Its waits spread over the 10 s (1.25 s doubling, jittered to half: 4.4 to
  8.75 s in all).
- So a relay or network down a few seconds is still joined.
- A relay silent that long fails the run with
  `cannot connect to the relay <origin>: no answer in 10 s`.
- Four failed tries say why and how long, as
  `cannot connect to the relay <origin>: ENOTFOUND, 4 dials in 9.1 s`.

</details>

**Workers that never join.** A worker that never joins says why on its row
(`failed  exited 1: …`). Its job ending, a success too, is what says so.

<details><summary>Details</summary>

- A worker asked is never given up for joining late: the run waits on it
  until its job ends or the run does.
- Giving up and asking again would not help. A CI with no runner to give
  queues both.
- That CI later hands over the extra workers, only for them to be told to
  exit.
- The first three such failures in a run each start another worker in its
  place, as a checkout, install or join can fail on the network.
- A fourth failure starts none.
- No worker is promised: a run may get one of those it asked, or none.
- A late worker blocks no ask. Each worker the plan needs is asked, up to
  its size's max.
- The run goes on with whichever workers join.
- When none is online or starting and this machine has no share, the
  remaining tasks fail with `no worker could start`.

</details>

**Leaving and liveness.** Only `leave` ends a participant at once: the
orchestrator's at its run's end is the final call that closes the run, and
a worker's when it is done.

<details><summary>Details</summary>

- Either side whose socket drops without `leave` dials again, 3 times as
  above and within 10 s.
- The relay keeps it, and its run, for 10 s. Past either limit the run is
  over.
- Either side hearing nothing from the other for 3 heartbeats (6 s on the
  default) loses it. The rest follows from that.
- Time its own process did not run (a GC, a long synchronous call, a
  starved CPU) does not count: the other's frames wait unread meanwhile.
- A worker that said nothing for half of that (3 s) sends its report.
- The orchestrator never speaks on a timer: only orders, and the acks of
  what it heard.
- A send unacknowledged for 3 s goes again.
- A worker that loses its orchestrator stops its tasks, says so, and joins
  the run again as a new worker. Once the run is over it exits.
- A worker the orchestrator lost that speaks again is answered no more. So
  it does the same: its tasks already run elsewhere.
- Nobody probes, the relay answers neither, and nobody pings.
- An orchestrator with no worker yet asks the relay an empty frame instead.
- A frame the relay leaves unanswered a heartbeat closes the socket, which
  is dialed again.
- The orchestrator's socket, its acks and redials run on a thread of their
  own. So sync work on the run's loop never holds them.
- A loop held a second or more says so, with how long.
- A loop held 5 heartbeats (10 s) ends the run, as a dead orchestrator
  would.
- Each send is numbered for its receiver and held until the receiver
  acknowledges it.
- So a send a socket or the relay dropped goes again after a heartbeat and
  a half, or at once on a new socket.
- The receiver takes each send once, in order.
- An ack rides the next send back.
- The orchestrator's acks, with no order to ride, go together after half a
  heartbeat. A quiet worker's beat is acked at once.
- A task sent runs at once: no message says it began.
- A command that ended (`ran`, with when it began and ended by the worker's
  clock) rides the worker's next frame, never alone.
- A task that saves first says it in its `end` (begun, ran, ended).
- The run reads those times against the clock of the frame that carried
  them.
- A run where no task began or ended for a minute warns what it waits on.
- That warning is a line a task: which worker, and whether it runs or
  saves.
- A message the relay would not take is a warning naming it, its receiver
  and the relay's answer.
- A message to a participant the relay already lost (404) is not a warning,
  since that loss is reported on its own.
- Its number still reaches the receiver, carrying nothing, so the sends
  after it are not held up.
- A worker whose OIDC token could not be checked is refused by that cause,
  not as a key mismatch, and the run says so.

</details>

## What the run shows

Each task a worker ran names that worker last on its row, and after the id
on its frame:

```
 ⏺︎   308ms success miss     c#build · linux.small#1
```

- The name is the worker's size and the order the run started it.
- It is in that worker's own color.

**When workers start and leave.** Workers start at the first task the cache
does not answer, so a warm run starts none.

- An idle worker the rest of the run cannot keep busy leaves (`left`).
- That is a worker beyond the peak of the cores the remaining tasks keep
  busy. So a lull between two wide parts keeps it.
- A lost worker's tasks run again on another, and the run starts one in its
  place.
- A lost worker says nothing of its tasks: a task fails only once 4 workers
  were lost under it, or 2 failed it (a full disk, an unpack that failed).

<details><summary>Details</summary>

- A worker a remaining task needs for its size stays.
- So does one a later task needs when its size's `max` is spent, since none
  could start in its place.
- With that `max` spent, the last worker of its platform also stays while
  any task of that platform has not ended.
- That is because a hit whose restore fails runs after all.
- A worker is lost when its socket closes, or when it says nothing for 3
  heartbeats (6 s).
- It is lost at once when its adapter sees its process or job end.
- Once one worker has joined, its warm-up is the least the next of its size
  takes.
- So work that ends sooner starts no worker while others are online or
  starting.
- New workers are started for the cores the run keeps busy after that
  warm-up, not before it.

</details>

**What history learns.** Each size's worker is timed as a task is, so the
next run plans by it before any worker of that size joins.

<details><summary>Details</summary>

- The worker's measure is `@vzn/vx-dte#worker:<size>`, defined by the
  size's name, platform, cores, memory and runner.
- So a size you change starts over.
- Its warm-up is the task's time, at most twice what history said (more is
  the CI's queue).
- Its cores are its machine's cores besides the run's tasks.
- Its join spread is `@vzn/vx-dte#join-spread:<size>`.
- Its pace, `@vzn/vx-dte#pace:<size>`, is how long its tasks took per 1000
  ms history said.
- History keeps a task's time alone, and packed tasks run slower.
- So a plan reads each platform's work as long as it ran, before any of its
  tasks ends.
- Its pace's spread, `@vzn/vx-dte#pace-spread:<size>`, is how far its tasks'
  times strayed from that, per 1000 of the mean.
- So a plan's first decisions leave each lane room for a task that runs
  long, rather than end it on the dot.
- Each server's base is `@vzn/vx-dte#server-base:<task>`, its start that
  measure's time.
- Core keeps them in the run's history.
- A history plugin (`@vzn/vx-history`) shares them as it shares task
  timings.

</details>

**The workers rows.** The `workers` rows show live while the run goes, and
again in the footer:

```
  workers    linux.small#1  online    3 done · 2 running
            linux.small#2  starting
            local    online    1 done
```

- Each worker shows its status: `starting`, `online`, `left`, `lost`, or
  `failed` with why.
- A failure's why reads like `exited 1: Cannot find package '@vzn/vx-dte'`.
- Once the run is over, a worker still starting is `not joined`.
- Each row counts the tasks done, failed or aborted by a stop, and the ones
  running now.
- While the run goes, the workers that left share one line
  (`3 workers  left  9 done`).
- A worker the run started is named by its size and the order it was
  started in. One that joined on its own is `worker#N`.

<details><summary>Details</summary>

- A task waiting for a worker has no row.
- The tasks line counts it `scheduled`
  (`30 success · 4 running · 12 scheduled · 62 total`).
- Its row and clock start when it is sent: a worker runs what it is sent at
  once.
- A worker is `online` while the run goes.
- It ends `left` when the run let it go as not needed, `lost` when it
  crashed or went silent, and `stopped` when the run's end stopped it.
- Once the run is over, each worker adds its warm-up, from asking the
  adapter to its join.
- Under it go the cores and memory its size declares and its machine
  reports: green when they agree, red when not.

</details>

```
  workers    linux.small#1  stopped  5 done · warm-up 0.1s
                     declared 2c/8G · actual 4c/16G
            linux.small#2  lost     1 done · warm-up 0.2s
                     declared 2c/8G · actual 4c/16G
            local    online   1 done
                     actual 10c/32G
```

- A finished run that started no worker (every task a hit) says
  `workers   none started: no task needed one`.
- One where a task waited on a worker and none joined says
  `workers   none joined: a task waited on one`.
- When the run refused workers, it says
  `workers   none joined: 2 refused (<first reason>)`.

**The footer.** Under each worker, and `local`, the footer spells out what
it did:

```
            linux.small#1  stopped  5 done · warm-up 0.2s
                     declared 4c/14G · actual 4c/14G
                     online 12.1s · busy 9.8s · idle 2.3s
                     cpu peak 3.6 · used avg 2.4 cores · machine avg 2.9 · booked avg 3.8
                     cpu utilization machine 78% · tasks 64% · worker 2%
                     memory peak 1.2 GB · avg 640.0 MB
                     sent 6 messages · 3.1 MB, received 15 messages · 8.4 MB
            probe    at 0.4s: 5 tasks left to run, 5 known misses
            asked    1 at 0.5s for 5 tasks (5 measured), estimate 12.0s
            ideal    11.4s: the best the workers it may start allow, its longest chain or each platform's work on all their cores
            perfect  10.8s: its longest chain as long as it took, no task waiting for a worker, holding 34.5 core-s at least
            drift    +0.7s past ideal, +1.3s past perfect: workers joining 0.8s · waiting for room 0.3s · sending inputs 0.1s
            best     2 × linux.small (4c/14G): 11.4s, the fewest of its sizes
            more     3 × linux.small (4c/14G): 10.8s, past its sizes' max
            any      1 × (8c/28G): 10.9s, of any cores, the least core time
            total    cpu utilization machine 74% · tasks 60% · worker 2% · held 52.1 core-s
```

<details><summary>Details</summary>

Each worker's lines give:

- its time online, busy and idle
- its CPU peak and average in cores
- the cores the run booked for the tasks it was running, on average (a task
  is booked from its start to its command's end)
- its cpu utilization from its first task's send to its last one's end, the
  warm-up and the wait for a first task left out
- that utilization for its machine, its tasks, and its worker process
- its memory peak and average, when its tasks reported any
- for a worker, the messages and bytes the run sent it and received from it

More on those lines:

- The machine's utilization is any process's busy core-time over the
  core-time it had. So what is left is idle cores.
- A worker that ran two tasks or fewer names them on its row.
- `used avg` is the cores its tasks used.
- `machine avg` is the cores its machine was busy on average since the
  worker started, any process's, as its last frame said.

Where the rest went, the worker says in its own log as it leaves. The last
part comes from one `ps` as it starts and one as it leaves:

```
cpu over 61.2s: machine 2.80 cores · tasks 2.00 cores · this worker 0.15 cores · its other children 0.05 cores · most besides: Runner.Worker 0.30 cores
```

- A Linux kernel worker is named by its thread (`kworker/0:1`), not the work
  queue it serves at the moment.

The run's lines:

- `probe`: when core's cache probe answered, and how many tasks it left to
  run (held in no cache, or not answered for).
- It also says how many of those it found in none.
- `asked`: each time the run asked for workers: how many, when, and for how
  many tasks that missed.
- It also says how many of them had a measured need (an unmeasured one
  counts as `unmeasured`), and the planner's estimate of the run's time
  then.
- The first ask waits for the needs another plugin fetches
  (`ctx.refining()`), such as `@vzn/vx-history`'s default-branch timings.
- `unmeasured`: the tasks the first ask had no measure of.
- `ideal` and `perfect`: the run's ideal end and perfect end (see below).
  So every log reads them beside core's `time` row.
- The `perfect` line also gives the least CPU a run ending then holds.
- That least is, on each platform, its tasks' cores for as long as each
  held its worker.
- It counts as few workers of the least costly size as end that work by
  then.
- It counts each worker's cores less what its machine spends besides the
  run's tasks, plus each worker's warm-up.
- `drift`: how far past each end the run ended, and what kept it from the
  perfect end, along the chain of tasks that ended the run.

What `drift` names:

- tasks waiting while a worker asked for their platform is still to join
  past its fastest warm-up
- waiting for room with every worker joined
- their inputs reaching their worker
- a dependency's files coming to this machine before the run hands over
  the task that waited on it
- an uncached dependency made again for it where its first worker left or
  stayed full
- the run's time after its last task

The `total` line:

- It gives the same cpu utilization of every machine together, and the
  share of their history the run's tasks used.
- It gives the CPU the workers held: each one's cores from when the run
  asked for it until it left, was cancelled or the run ended, idle or not.
- So it reads against the `perfect` line's least.

</details>

**Profiles.** `vx run --profile[=<path>]` adds the run in time to the
profile it writes. Open it in https://ui.perfetto.dev or
`chrome://tracing`.

<details><summary>Details</summary>

- Each worker is a process. Its first row holds its warm-up, its idle
  stretches, and how it ended.
- The warm-up is split, when the worker says when its `vx` started, into
  its machine's start and vx's boot.
- A `cores` counter shows the cores booked and used at once.
- A `machine` counter shows the cores its machine reported busy, its tasks'
  or not. Placement never fills a worker past it.
- Beside it are the cores its running tasks' process trees used, read each
  second as core's `task.sample` reads them.
- Each task takes the first lane free over its time there: from its send,
  through restoring its dependencies, its command, and its save.
- It shows its exit code, duration, CPU time and booked cores.
- It shows where its worker says the save's time went: `checkMs` reading
  what it left, `saveMs` saving here, `uploadMs` until a remote took it.
- The `orchestrator` process holds the cache probe, each ask for workers,
  stalls, the time each task waited for room, and each restore.
- It holds each plan that started or let go of workers, with what it saw of
  each worker.
- A plan that started workers also holds each task's planned time, cores
  and platform, and each size's warm-up, so it can be played back.
- The run's first plan holds all `plan()` was given, as `input`.
- So does a plan that played its work because the packing ended later or
  left a task out.
- Times are the orchestrator's: when it heard.
- Without `--profile` nothing is written.
- On CI, upload the file as an artifact. This repo's `ci.yml` does, and
  links it from the job summary.

</details>

**Ideal and perfect ends.** Before the run, the planner's figure is an
estimate. After it, `dte()` works out two ends no run of these tasks could
beat.

- The perfect end has no worker cap: its longest chain, each task as long
  as it held its worker, no task waiting for room.
- In it, each worker is there after its platform's fastest real warm-up.
- The ideal end is the best with the workers the run may start.
- That is the perfect end, or later where a platform's work fills every
  core its sizes' `max` allows.
- A platform's work is each task's cores for as long as it held them.
- With no `workers` declared, the workers that joined stand for the sizes,
  for the ideal end and for `best` and `any` alike.
- With no task run on a worker, there is nothing to replay: the footer says
  `ideal  not worked out`.
- The ideal end (`distribution.idealMs`) sits beside the real time in the
  run summary and the footer's `ideal` line. `@vzn/vx-ci` prints it.

<details><summary>Details</summary>

- In the ideal end, each worker comes from the first ask after its own real
  warm-up.
- A slot no worker joined comes after the platform's fastest warm-up.
- The spread of joins is no plan's, but when the run asked is.

</details>

**Workers to declare.** A replay of the run says which workers to declare
next time (`TaskExecutor.advice`).

- `best` is how many of each size.
- `more`, shown only when more than a size's `max` would end the run sooner
  past the margin, is how many it would take.
- `any` is one shape for each platform, of 2 to 64 cores: the one ending as
  soon for the least CPU held.
- Raise a size's `max`, or change its `cpu` and `memory`, by them.
- They are in the footer and the run summary, and `@vzn/vx-ci` prints them
  under "Workers to declare".
- The replays get 2 s at the run's end. Past that, no `best`, `more` or
  `any` line is given, not even from the replays that finished, and the
  footer says `best  not worked out` instead; the summary has none.

<details><summary>Details</summary>

- Each replay starts from an empty run, with the plan's own rule: the
  fewest workers that end it within 5% of the soonest.
- For `any`, memory a core is the most the platform's sizes have.
- For `any`, each worker counts from its ask to its last task's end.
- A task goes only on a size with room for its cores and peak memory, when
  one is declared.
- The replays plan plain, as a live run does under history's spread.
- They play side by side on this machine's cores once the run ends.

</details>

## Environment

`@vzn/vx-dte` reads these variables from the CI job it runs in:

- `GITHUB_SHA`: the commit every worker checks out.
- `GITHUB_API_URL`, `GITHUB_REPOSITORY` and `GITHUB_TOKEN`: the API
  `github()` dispatches, watches and cancels worker runs through.
- `GITHUB_HEAD_REF` or `GITHUB_REF_NAME`, then `GITHUB_BASE_REF`: the ref
  `github()` dispatches the worker workflow on.
- It falls back to the base ref when the head has no workflow file.
- `GITHUB_RUN_ID`, `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, on a worker: one
  that finds its run over cancels its own workflow run, so its queued
  fellows hold no runner.
- `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`: where
  the job asks GitHub for its OIDC token.
- `GITHUB_REPOSITORY_ID`: the repository a token must name.
- `GITLAB_CI` and `CI_JOB_TOKEN`: `gitlab()` runs on GitLab CI.
- `CI_API_V4_URL`, `CI_PROJECT_ID` and `CI_COMMIT_SHA`: the API, project
  and commit `gitlab()` triggers each wave's pipeline with.
- `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` or `CI_COMMIT_REF_NAME`, then
  `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`: the ref worker pipelines run on.
- `PATH`: a worker keeps the task's own bin directories, then its own
  machine's `PATH`.
- A task whose `exec.env.define` sets `PATH`, or whose `inputs.env` names
  it, runs on that `PATH` as the orchestrator sent it.
- `GIT_INDEX_FILE`: `local()` clears it before `git worktree add`. So a run
  started from a git hook checks out the run's commit, not the hook's index.
- `GIT_DIR`: with no `GIT_WORK_TREE`, the run's snapshot and `local()`'s
  and `docker()`'s git drop it when git finds that repository anyway.
- That is, when git finds it from the workspace (a linked worktree's hook
  sets it), as core does.

## API

`dte(options?: DteOptions)` is the plugin, as in
`dte({ workers, adapter: github() })`.

- `DteOptions` is `{ workers?, adapter?, relay?, token?, unmeasured?, headers? }`.
- A key it does not take, in a size or `unmeasured` too, is refused.

**`headers`** go on every dial to the relay, the orchestrator's and each
worker's (redials too), for a proxy in front of it.

- For example, a Cloudflare Access service token:
  `{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, … }`.
- An unset value is left out.
- A name the dial sets itself (`authorization`, `content-type`,
  `relay-proof`) is refused.

**`workers`** names each worker type, a `WorkerType` `{ machines }`, in
order of preference. `exec.worker` picks one.

- Each machine is a size the adapter may start, named `<type>.<machine>`
  (`linux.small`) in the run's output and an adapter's options.
- Each name is letters, digits, `_` and `-`, as worker ids and log files
  carry them.
- A machine's name may also have a `.` after its first character
  (`c5.large`).
- A size is a `WorkerSize`: `{ cpu, memory, max?, platform?, runsOn? }`.
- `cpu` and `memory` (bytes, or `'8GB'`, `'512MiB'`) are what the run counts
  on when it starts one, until the worker reports what its machine has.
- `max` is how many of it may be in the run at once, a lost one replaced.
  Absent, there is no cap.
- `platform` is its machines' platform: `linux-x64`, `linux-arm64`,
  `darwin-x64` or `darwin-arm64`.
- Absent, the size is planned as this machine's platform and not checked on
  join.
- `runsOn` is the runner label `vx dte init` writes for it.
- With no adapter, the sizes' platforms are the ones joining workers may
  have.

**What counts as work.** Only work needs a worker: a task that missed the
cache, or waits on a cached one that did, and every uncached task. Groups
and hits need none.

- An uncached task runs every time, so it is always work.
- Before any worker can say what misses, the run guesses from git.
- It counts as work each cached task whose inputs changed since HEAD's
  parent (`git diff HEAD^`), and every task after one (`src/forecast.ts`).
- A lockfile or `.vx/` change counts every cached task.
- A hit it guessed wrong costs a worker the plan cancels.
- With no parent commit, the run waits for its misses.
- Each task core's up-front cache probe found in no store counts as work
  too, the moment the probe answers.
- So does each uncached task, which no probe asks
  (`TaskExecutor.demand`'s `missed`).

**How the run plans.** The run plans that work over its workers and new
ones (`src/plan/engine.ts`, design `docs/design/dte-planner-2026-11.md`).

- The plan compares, in order: the run's expected end, then the core-time
  its workers are held (warm-ups included), then fewer workers.
- Each task, least slack first, goes where it adds least to the first, then
  the second.
- That is room on a worker now, a wait for room there, or a new worker of
  the smallest size it fits.
- A new worker is asked a warm-up before the task needs it.
- The run starts what the plan starts now, and asks the workers it asks
  now.
- It plans again at each event: a task ready, started or ended, or a worker
  asked, joined or lost.
- An idle worker no planned task needs leaves, unless it holds files a task
  to come reads.

<details><summary>Details</summary>

- Each new worker joins after its size's warm-up: the mean of this run's
  joins of that size, else an earlier run's.
- It also joins a spread after the one of its size asked before it, as a CI
  queue lets them in one after another.
- That spread is what the workers this run asked together showed, else an
  earlier run's (kept in history, as warm-ups are).
- A worker's tasks share its cores: past them, each runs at its share.
- A task's time is its history, scaled by how this run's finished tasks
  compared to theirs.
- A running task's rest is what tasks that ran that long took more.
- Those times are the commands' own, told with each result, not when the
  run heard them end.
- A task's dependants and the run's end also wait for the servers it starts
  first: each server's learned start, its cores free meanwhile.
- A task history never measured takes what the measured ones take, with the
  unmeasured that ended.
- Each unmeasured task still running past that mean counts as ended at what
  it has run.
- So the first to end, the short ones, do not speak for all.
- While no task's time is known at all, no idle worker leaves.
- A task waiting on running tasks whose ends are uncertain expects to start
  past the latest of them, not their mean.
- A task placed before one whose start is uncertain pays the lateness its
  overrun would add.
- With every time known, the plan tries other starts within each task's
  slack, up to 16 times a decision (fewer as tasks grow).
- It keeps the best, and tries it first at the next decision.
- Past 10,000 tasks it plans in one forward pass instead: a million plan in
  about two seconds.

</details>

**Measured need.** A measured task counts for the cores it kept busy on
average, and a whole core at least.

<details><summary>Details</summary>

- What a task used counts divided by its share of the CPU.
- A Linux worker reads its run queue (`procs_running` in /proc/stat) every
  200 ms.
- A macOS worker reads its load average while all its cores are busy.
- So a task whose threads got a third of a core each used a third of its
  need, not its need.
- The run history keeps that share (`ExecuteResult.machine.cpuShare`).
- It learns the need, at most the machine's cores, as the mean over runs.

</details>

**Cancelling and sizing.** A worker still starting is cancelled once its
platform has no task left.

<details><summary>Details</summary>

- The adapter stops it before its setup if it can. One that joins anyway is
  told to exit.
- `github()` cancels its workflow run once no worker in it is needed and
  none of its jobs has a runner.
- A worker the adapter leaves running is counted again, and the run takes
  it when it joins.
- That happens when its job had a runner, its run holds a worker still
  needed, or the adapter stops none.
- A task that used all of its worker's cores or memory (90%) last time runs
  only on a bigger size while the run has or may ask one.
- Each run's history keeps where every task ran and that machine's size,
  so sizing improves run by run.

</details>

**The other options:**

- `adapter` is the `DteAdapter` that starts workers, of the sizes in
  `workers`.
- With an adapter, at least one size needs `max` above 0, or `dte()` is
  refused.
- Absent, the run starts no workers and uses the ones that join `relay`.
- `relay` is the relay's base URL, http(s), without `/v1`, `?query` or
  `#fragment`. Absent, the adapter's own.
- `VX_DTE_RELAY`, read when the run starts, beats `relay`, so a pipeline's
  `env` can switch distribution on.
- `token` answers the relay's bearer token (default `VX_DTE_TOKEN`).
- It is asked again a minute before the token's `exp`, when it has one.
- `unmeasured`, `{ cpu, memory }`, is what a task with no measure keeps
  busy.
- That is a new task, or one over before the Linux sandbox's first look
  (250 ms), which leaves no CPU.
- The plan counts it for `cpu` cores; absent, for the measured tasks' mean.
- On a worker it holds one free core and no memory, so it goes to any
  worker with a free core.

**`vx dte worker`** is a worker.

- It reads `VX_DTE_RUN`, `VX_DTE_RELAY` (unset or empty: `relay`), and
  `VX_DTE_SECRET` (the run's).
- When the run started it, it also reads `VX_DTE_WORKER` (its name).
- It is described only by the cores and memory its machine reports.
- It exits 0 when the run ended before it joined.
- A relay that refuses it or cannot be reached is one line,
  `vx dte worker: cannot connect to the relay …`, and exit 1.
- On SIGINT or SIGTERM it stops its tasks and leaves the run, which runs
  them again on another worker.
- It then exits 130 or 143; a second signal ends it at once.

**`DteAdapter`** starts workers:

```text
{ spawn(worker: WorkerSpawn), relay?(), close?(), cancel?(ids), init?(setup: DteSetup), runId?(), workerId?(), handed?(), over?(), adopt?(worker), report?(warn), keyless?, workerRuns?() }
```

- `init` gets a `DteSetup` and returns a `DteInit`: the CI files
  `vx dte init` writes and the steps it prints.
- A `DteSetup` holds the workspace root, its directory in the repository,
  the relay, the sizes, the `PackageManager` read from the lockfile, and the
  tasks asked for.
- `report` hands it the run's warning channel as the run starts.
- There `github()` reports a status poll or a cancel the CI API refused, by
  status and body.
- `adopt` hands each worker the CI started before the run to
  `worker(id, size)`, which counts it and returns its spawn.
- `cancel` stops workers the run no longer needs that have not joined.
- `cancel` may answer with those it left running, which the run takes.
- `runId` names the run, in the adapter's own CI, when `VX_DTE_RUN` is
  unset.
- `workerId` names a worker in a job its CI started for several, when
  `VX_DTE_WORKER` is unset.
- `keyless` workers prove themselves by GitHub OIDC.
- `workerRuns` names the workflow runs whose jobs alone may join as them
  (`undefined`: any job of the repository).
- In a worker's job, `handed` returns the `Handed` its CI gave it:
  `{ run?, relay?, env }`, which `vx dte worker` reads before it joins.
- In a worker's job, `over` stops the workers its CI still holds for a run
  that ended before this one joined.

**`WorkerSpawn`** is what `spawn` gets:

```text
{ run, relay, size, max, cpu, memory, index, id, workspaceRoot, commit, cacheDir?, env, exited }
```

- `memory` is in bytes, and `max` is its size's (`Infinity` uncapped).
- `id` is the worker's name (`linux.small#2`, numbered within its size).
- `commit` is the tracked files as the run saw them at its start,
  uncommitted changes included. A worker must check out its tree.
- `cacheDir` is the run's cache dir (absolute) when the workspace names
  one, so workers on this machine save where the run reads.
- `env` holds what the worker reads: `VX_DTE_RUN`, `VX_DTE_WORKER`,
  `VX_DTE_RELAY`, and `VX_DTE_SECRET` when the run has a key.
- `exited(reason)` says the worker's job or process ended, a success
  too, and why: its exit or its last stderr line.

**The adapters:**

- `docker(options: DockerOptions)` starts workers as containers, and a
  relay of its own on loopback.
- `DockerOptions` is `{ image, prepare? }`.
- `github(options?: GithubOptions)` dispatches workers as matrix jobs of one
  workflow, one dispatch per size and demand.
- It dispatches at most 256 workers, a matrix's limit.
- `GithubOptions` is `{ workflow?, env? }`.
- `workflow` defaults to `vx-worker.yml`: a file name in `.github/workflows`
  other than `ci.yml`, the run's own.
- `env` is variables every worker gets: one-line strings, and no
  secret-named one, since the worker job's log shows them.
- `env` is sent as the dispatch's `env` input only when set, which
  `vx dte init`'s workflow exports.
- `github()` workers are `keyless`, and only jobs of the workflow runs it
  dispatched join as them.
- It needs `GITHUB_TOKEN` with `actions: write`. See
  [On GitHub](#on-github).
- `gitlab(options?: GitlabOptions)` triggers a pipeline of the project's
  `.gitlab-ci.yml` per wave and size, with `CI_JOB_TOKEN`.
- `GitlabOptions` is `{ tags? }`: runner tags by size, which `vx dte init`
  writes. See [On GitLab](#on-gitlab).
- `local(options?: LocalOptions)` starts workers on this machine, and a
  relay of its own on loopback.
- `LocalOptions` is `{ prepare? }`: a shell line each worktree runs before
  its worker starts.

`@vzn/vx-dte-server` is a dependency for the relay of `local()` and
`docker()`, loaded only when a DTE run starts.
