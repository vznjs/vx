# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx: one `vx run` spread over workers your
own CI starts, replayed here as one run. The run you start is the
orchestrator. It runs no task itself, only restores cache hits: it starts
workers and hands the ready tasks to the workers with room, critical path first. A worker runs it in its own checkout and saves the task's
output and the files its declared outputs left to the workspace's cache,
under the task's key. They land here before the task ends, so the run
reports the task as its own. No file travels through the relay: it
carries only orders and status, so the workers and this machine need one
cache they all read (a remote the workers write, or one shared store). A worker reads that cache as the run does:
under the run's refs, with the short-lived access the run's remote lends
it (an OIDC exchange's token, never a stored secret) when it has none of
its own.

Workers and the orchestrator meet at a relay
([`@vzn/vx-dte-server`](../vx-dte-server/README.md)), since CI runners
take no inbound connection. It speaks the
[Switchboard protocol](../vx-dte-server/PROTOCOL.md): the run is a
session, its id the run id, the orchestrator its host and each worker a
peer. Host your own: its
[README](../vx-dte-server/README.md) has a Deploy to Cloudflare button,
which asks only for the repositories whose runs it carries.

A run id is a channel. Workers join it before or after the orchestrator
does, and the orchestrator claims it with a key made for that run; the
relay keeps the public half and passes nothing to or from a side that
cannot sign by it. The orchestrator checks each worker the moment it
appears and removes any without the run's key from the channel.

The relay reads nothing they say. Each worker and the orchestrator run a
[Noise](https://noiseprotocol.org/noise.html) handshake through it, one
session per worker, with keys made for that session only. With the run's
key (`VX_DTE_SECRET`, or one an adapter made for its workers) it is `Noise_NNpsk0_25519_AESGCM_SHA256`: the key is the
pre-shared key, so a side without it cannot finish the handshake, and the
worker's `join` info (cores, memory, tree) is already encrypted. On GitHub
Actions with no key it is `Noise_NN_25519_AESGCM_SHA256`, and each side
binds the handshake by an OIDC token of this repository (`id-token:
write`): no secret is stored anywhere. With no adapter and no GitHub, set
the same `VX_DTE_SECRET` on the run and each worker. A message the relay
changes loses its worker; one it replays is dropped. The key never
encrypts a message, so a leaked one opens no past run.

It runs workers with `local()`, `docker()`, `github()` and `gitlab()`.

### Bodies

What vx-dte puts in Switchboard's `info` and `body`, for anyone writing a
worker or orchestrator of their own. Each worker and the orchestrator run
a Noise handshake through the relay, prologue `vx-dte\0<run>`, the worker
the initiator.

- With the run's key: `Noise_NNpsk0_25519_AESGCM_SHA256`, the psk the
  key's SHA-256.
- Keyless on GitHub Actions: `Noise_NN_25519_AESGCM_SHA256`. The worker's
  `join` carries an OIDC token whose audience is
  `vx-dte:<base64url SHA-256 of "join\0<run>\0<message 1>">`; the
  orchestrator's `hello` one for `"hello\0<run>\0<handshake hash>"`. Each
  side checks the other's as a token of the same `repository_id`; with
  `github()`, the orchestrator also checks a worker's `run_id` is a
  workflow run it dispatched, since the run's id is a dispatch input
  anyone who reads the repository's Actions sees.

| Who           | `info` / `body`                                         |
| ------------- | ------------------------------------------------------- |
| worker `join` | `info: { "noise": <message 1>, "token"? }`              |
| orchestrator  | `{ "type": "hello", "noise": <message 2>, "token"? }`   |
| orchestrator  | `{ "type": "refused", "reason" }`, plain, then `remove` |
| either, then  | `{ "seal": ["<n>.<ciphertext>", …] }`                   |

The orchestrator checks each worker the moment the relay says it joined,
and `remove`s one whose handshake fails. Message 1's payload is the
worker's info (JSON), encrypted under the psk. After the handshake every
body is Noise transport messages, base64, each at most 65535 bytes and
naming its nonce `n` (Noise §11.4, since a relay may reorder); each is
sealed with associated data `<first n>.<parts>` of its body, so no part
opens in another body. A body whose first nonce was seen before is a
replay and is dropped; one that does not open loses its sender. The
plaintext is JSON, or over 256 bytes and smaller so, a `0` byte, the
zstd frame's length (4 bytes, big-endian) and the frame: compressed
before sealing, since no relay or socket compresses what is sealed. It
is padded with trailing spaces to its size class, a power of two from
256 bytes, then whole transport messages, so the relay learns no size
within a class. Inside, each send is numbered and acknowledged
end to end, and a quiet peer probed (Switchboard § Delivery, § Liveness).

## Try it

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
included (untracked files are not: a task that keys one fails), at the
workspace's place in it (a workspace in a subdirectory of its repository too),
saving to the run's store (a relative `cache.dir` or `--cache-dir` too).
A run from a git hook works too: the worktree and its worker drop the
hook's repository variables (`git rev-parse --local-env-vars`), so the
index being committed is left as it is. When a worker fails, its row names
the error line and the log that holds its whole stderr and all `prepare`
printed. At the run's end,
or on Ctrl-C, vx exits without waiting for the worktrees to be removed:
a detached shell removes them and prunes git's records.

`docker()` starts each worker as a container held to its size: `--cpus`
and `--memory` come from `cpu` and `memory`. The container clones this
checkout (mounted read-only) into its own filesystem at its tracked
files as they are, uncommitted changes too, runs
`prepare`, then the workspace's own `node_modules/.bin/vx dte worker`, so
the image needs Bun and git, and `prepare` installs vx. This machine's store
(`~/.vx`) and a cache dir the workspace names (`cache.dir`, `VX_CACHE_DIR`, `--cache-dir`)
are mounted at their own paths, and the
clone keeps this checkout's `origin`, so the workers save where the run
reads, as `local()`'s do; no remote is needed. On Linux a container runs
as this user (its home is `/tmp`, where the store is mounted), so what it
writes is this user's and git trusts the mounted checkout. A container that fails
names its error line and the log of its whole stderr and all `prepare` printed:

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
bun /path/to/vx/packages/vx-dte-server/src/bun.ts --no-auth --port 8080   # the relay
export VX_DTE_SECRET=$(openssl rand -base64 32)                          # in each terminal: the same one
export VX_DTE_RUN=$(uuidgen)                                             # in each terminal: the same one
vx run build --all                                                       # the run, first
vx dte worker                                                             # a worker, as many as you like
```

A worker started before its run finds no run on the relay: it says so
and exits.

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
waits for. Every job of a repository shares its `GITHUB_TOKEN`'s API
limit, 1000 requests an hour, so the run reads its workers' jobs at most
every 30 s, asks with each answer's ETag (an unchanged answer is free),
and asks nothing until a spent limit resets. A dispatch the limit refuses
is sent again at the reset, if that comes within 5 minutes; past that it
fails, naming when. A cancel the limit refuses is sent again at the
reset, if that comes within a minute. A run that dies before it cancels
(a cancelled or timed-out job) leaves it to the job's last step, which
cancels each worker run the run listed in `RUNNER_TEMP`. Past both, a
worker that starts reads its run's attempt (`parent`) first, and once
that is over cancels its own workflow run, its queued fellows with it.
On GitHub Actions with a relay, the run names itself: no
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
# .github/workflows/ci.yml
# Written by vx dte init: the run. main runs every task and fills the cache;
# a pull request runs what it changed and its dependents. This job only
# orchestrates: every task runs on a worker (vx-worker.yml).
name: ci

on:
  pull_request:
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
      # Name the tasks to run, as 'bun vx run build test --affected': with
      # none named, vx fails, listing the workspace's tasks.
      - run: bun vx run ${{ github.event_name == 'pull_request' && '--affected' || '--all' }}
      - name: Cancel the workers
        if: cancelled()
        run: |
          [ -f "$RUNNER_TEMP/vx-dte-runs" ] || exit 0
          while read -r run; do curl -sS -o /dev/null -X POST -H "authorization: Bearer $GITHUB_TOKEN" "$GITHUB_API_URL$run/cancel" || true; done < "$RUNNER_TEMP/vx-dte-runs"
```

`vx dte init` writes both from `dte()`, the run's above and the workers' below,
and prints what is left: a relay that admits them (its `ALLOW`, and how
to deploy one), a shared remote cache, the commit. In a terminal it asks
what main runs and what a pull request runs (main's by default); without
one it names none, and the run fails, listing the tasks, until you do. A
workspace in a subdirectory of its repository gets them at the repository's
root, its jobs running in that directory. Each size runs on
its platform's GitHub-hosted runner (`ubuntu-latest` for none named,
`ubuntu-24.04-arm`, `macos-latest`, `macos-15-intel`), or on the label
`github({ runsOn: { small: 'ubuntu-latest-16-cores' } })` names, as
`gitlab({ tags })` does. It installs with the package manager your lockfile
names and runs vx as `bun vx`, which runs the repo's own and never
downloads one, as `pnpm exec` does (Yarn too: Bun reads no Plug'n'Play,
so a Yarn workspace sets `nodeLinker: node-modules`). `--dry` prints it; a file you changed
is kept unless `--force`. For the sizes above:

```yaml
# .github/workflows/vx-worker.yml
# Written by vx dte init from dte() in .vx/workspace.ts: the workers of a
# DTE run, which github() dispatches once per size. Run vx dte init
# again after changing the sizes.
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
      # The run's attempt, which a worker reads first.
      parent: { required: false, default: '' }

permissions:
  contents: read
  id-token: write
  # A worker of a run that is over cancels its own run.
  actions: write

jobs:
  worker:
    # The run reads a job that failed before its worker joined by this name.
    name: ${{ matrix.worker }}
    runs-on: ${{ fromJSON('{"small":"ubuntu-latest"}')[inputs.size] }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        worker: ${{ fromJSON(inputs.workers) }}
    env:
      VX_DTE_RUN: ${{ inputs.run }}
      VX_DTE_RELAY: ${{ inputs.relay }}
      VX_DTE_WORKER: ${{ matrix.worker }}
    steps:
      - name: Leave if the run is over
        if: inputs.parent != ''
        env: { GH_TOKEN: '${{ github.token }}', PARENT: '${{ inputs.parent }}' }
        run: |
          runs="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs"
          status=$(curl -fsS -H "authorization: Bearer $GH_TOKEN" "$runs/$PARENT" | jq -r .status) || exit 0
          [ "$status" = completed ] || exit 0
          echo "::notice::run $PARENT is over: cancelling this one"
          curl -fsS -o /dev/null -X POST -H "authorization: Bearer $GH_TOKEN" "$runs/$GITHUB_RUN_ID/cancel"
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { ref: '${{ inputs.sha }}', persist-credentials: false }
      - env: { HANDED: '${{ inputs.env }}' }
        run: |
          jq -r 'to_entries[] | if (.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) and (.value | type == "string") and (.value | test("[\r\n]") | not) then "\(.key)=\(.value)" else error("env \(.key): a name, and a string of one line") end' <<<"$HANDED" >> "$GITHUB_ENV"
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      # Every project: only pnpm selects by a git diff, as
      # `pnpm install --frozen-lockfile --filter "...[origin/main]"`
      # (fetch origin/main first: the checkout is one commit).
      - run: bun install --frozen-lockfile
      - run: bun vx dte worker
```

## On GitLab

One pipeline file. Your `vx` job is the orchestrator; once it is on the
relay, it triggers a pipeline of the same file for each wave of workers
it asks of a size, with the job's own `CI_JOB_TOKEN`, so no worker starts
before the run and no token is stored. Each size's job is a matrix of
`max` slots (`VX_DTE_SLOT`); that pipeline runs only the slots the wave
names (`VX_DTE_PICK`), at the run's commit, and each takes its name from
`VX_DTE_IDS`. The run starts workers as its work needs them, up to each
size's `max`, which `gitlab()` needs (at most 200, a matrix's limit).
GitLab lets a job token trigger but not cancel, so a worker the run no
longer needs leaves when it joins or when the run ends. Each trigger
passes the workers' variables, so set Settings > CI/CD > Variables >
"Minimum role to use pipeline variables" to Developer: a project made
since GitLab 17.7 lets no one, and refuses every trigger.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      workers: { small: { max: 4, cpu: 2, memory: '8GB' } },
      adapter: gitlab(),
    }),
  ],
})
```

`vx dte init` writes it, from `dte()`, in the package manager your
lockfile names, asking what main and a merge request run:

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

'vx-worker small':
  extends: .vx-worker
  parallel:
    matrix:
      - VX_DTE_SLOT: ['1', '2', '3', '4']
  rules: [{ if: $VX_DTE_SIZE == "small" && $VX_DTE_SLOT =~ $VX_DTE_PICK }]
```

`gitlab({ tags })` names each size's runner tags. Each job's ID token
(`VX_DTE_TOKEN`) admits it to the relay; the worker proves itself to the
run by the run's secret, made for that run only and passed as a trigger
variable, since a GitLab ID token's audience is fixed when its job starts
and cannot bind the handshake as GitHub's does. Set `VX_DTE_SECRET` to
use your own instead.

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
  frees its cores while its outputs save, and its worker's load until the
  next frame: that load counted the task. Every
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
  this checkout's paths. An empty file it wrote over a write grant's
  placeholder is its output; only a placeholder it never touched goes.
  A sandbox the worker cannot host (no `bwrap` in its image) fails the
  task there, as it fails here; the worker stays in the run.
- A persistent task a task depends on starts on the worker that runs the
  task, once per worker, ready before it, and stops when the worker leaves;
  the orchestrator never starts it, and a worker no dependant reaches
  never does (2026-10-22).
- A task whose key hashes a runtime probe (`inputs.runtime`, such as
  `bun --version`) runs on a worker, which answers the probe first and
  fails the task when it answers otherwise than this machine did. A path
  under the worker's checkout root reads as the same path under this
  machine's, as the task's environment does.
- No task runs on the orchestrator, only cache hits restore there
  (2026-10-24): a task with `exec.remote: false`, an interactive
  one and their dependants run on workers too (the executor is
  `exclusive`). A task no worker can take refuses the run before any
  starts, naming it: one whose `exec.platforms` no size offers, or a
  persistent task asked for on its own.
- An `exec.remote: 'only'` task's files stay on the workers: this machine
  restores its output, never its files. Under `--cache-download=toplevel`
  or `none`, a task's files it defers land here only if a task here needs
  them.
- A task's output replays here as its worker read it: stdout and stderr
  in the order the task wrote them, bounded as core bounds a run's.
- A result too long for one relay frame (thousands of sandbox violations,
  or of files a formatter changed) is sent in parts, none of it dropped.
  An order too long for one frame (a task with thousands of deps) sends
  its deps ahead of it the same way.
- A task runs with the orchestrator's environment under the worker's
  root. `HOME`, `TMPDIR`, `USER` and the like are the worker's own, unless
  the task's `env.define` sets them; `npm_execpath` is the workspace's
  package manager on the worker, as core sets it on a local task.
- A worker restores, by key, the declared outputs of every task the one
  it runs depends on, each after its own dependencies (an additive task's
  rewrite of an upstream file stands), unless it ran or restored them before. Files a task
  writes without declaring them stay on the worker. An uncached task
  declares none, so no cache carries its files: its dependants go to the
  worker it ran on, unless it is sandboxed with no write grant and so
  leaves no file. One waits there up to 10 s; past that, with that worker
  gone or of another platform, or with its uncached upstreams on two
  workers, the upstream runs again where the dependant can go, and the
  dependant follows it. A task whose upload no remote took (too big, a 429) is kept the same way: its output comes to the orchestrator with
  its result, its files stay on the worker, and a task on the
  orchestrator's machine that needs them fails saying so. Before a task
  runs, its
  worker removes the files under its outputs that an earlier task left,
  except committed files, nested projects' files, and its dependencies'
  outputs (an additive task builds on its upstream's tree). An upstream's
  file the task leaves as it found it is not saved in its entry; one it
  removes is removed on this machine too, and the task saves no entry, as
  core saves none.
- A hit only this machine's cache holds (the remote evicted it, or this
  run does not write the remote) is uploaded to the remotes the workers
  read before a task that depends on it is sent; with none written, its
  dependant fails on the worker, naming the entry. One whose remote copy
  does not read back on a worker (a truncated upload) is sent again from
  this machine over that copy, and the task runs again; once per entry.
- A failed or uncached task is saved under a key of the run, the task and
  the send (a retry gets its own), so no later lookup ever hits it; so is one core would not save (a
  `--no-cache` or read-only run, a dependant of a failure under
  `--continue=always`, one that left a process running that may still
  write its outputs, one a stopped run cancelled), and one that left a tracked file under its project
  changed on its worker (a formatter's input), which this machine never
  sees: core withholds its own save when the key read that file, and says so.
- Under `--force`, a success is saved under its key (which keeps an entry
  it already holds, as core does) and under the run's key, which this
  machine and the dependants' workers restore: the bytes this run built,
  never the entry it bypassed.
- A worker whose tracked files differ from the orchestrator's (another
  tree, or the same commit with a tracked file changed, such as by a
  prepare step) is refused. Both sides read their tracked files as they
  are, so the same change on both is the same tree.
- A task whose key hashes a file the run's commit lacks (untracked, or
  gitignored and named outright, or inside a submodule, whose files the
  commit holds only as a gitlink) fails, naming the file: no worker has it.
  A dependency's declared output is not one: its worker restores it first.
- A task's `exec.timeout` counts from its start on its worker: the wait
  for a worker still booting is not its run (the executor declares
  `timeouts`).
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
- The relay stores nothing, so a restart forgets the run. The orchestrator
  joins again as its host and each worker joins again as itself, for two
  heartbeats (4 s on the default); tasks keep running meanwhile, and what
  either side sent goes again once both are back, taken once. Leases
  wait while either is away, and a worker sent a task it runs already
  does not run it again, so no work repeats. One not back by then
  ends: a worker's tasks run elsewhere, an orchestrator's run fails.
  Joining has the same 10 s in all, its socket and request together: a
  relay silent that long fails the run with `cannot connect to the relay
<origin>: no answer in 10 s`.
- A worker that never joins says why on its row (`failed  exited 1:
…`); its job ending, a success too, is what says so. Once the first
  worker of a size joins, each other of that size not joined within twice
  that first join is given up (`did not join within 60 s`) and its job
  stopped; before one has, none is. One its CI started anyway that joins
  later is taken, as any worker the plan may let go. The first three such failures in a
  run each start another worker in its place, as a checkout, install or
  join can fail on the network; a fourth starts none. While a worker of
  a size is past its warm-up unjoined, or given up so beside one of its
  size online, the run asks no more of that size: its CI queued it, and
  one asked then would queue behind it. When none is online
  or starting and this machine has no share, the remaining tasks fail
  with `no worker could start`.
- Only `leave` ends a participant at once (2026-10-25): the
  orchestrator's at its run's end is the final call that closes the run,
  and a worker's when it is done. Either whose socket drops without it
  dials again, 3 times within 10 s, and the relay keeps it, and its run,
  for those 10 s; past them the run is over. A peer quiet on a socket that never
  closed is lost within two heartbeats (4 s on the default): only a
  peer heard from for none of a heartbeat and a half is probed (an
  empty numbered send), which it acks at once; either side hearing
  nothing from the other for 1.9 heartbeats loses it, a worker by
  ending. A quiet pair trades one probe and its ack each heartbeat and a
  half, the relay answers neither, and nobody pings. An orchestrator
  with no worker yet asks the relay an empty frame instead; a frame the
  relay leaves unanswered a heartbeat closes the socket, which is dialed
  again.
- Each send is numbered for its receiver and held until the receiver
  acknowledges it, so one a socket or the relay dropped goes again after
  a heartbeat, or at once on a new socket; the receiver takes each once,
  in order. An ack rides the next send back, and those with none to ride
  go together in one frame per half heartbeat: no message of its own on
  a busy run.
- A run where no task began or ended for a minute warns what it waits
  on, a line a task: which worker, and whether it runs or saves.
- A message the relay would not take is a warning naming it, its
  receiver and the relay's answer; one to a participant the relay already
  lost (404) is not, since its loss is reported on its own. Its number
  still reaches the receiver, carrying nothing, so the sends after it are
  not held up. A worker whose
  OIDC token could not be checked is refused by that cause, not as a key
  mismatch, and the run says so.

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
stays, and so does one a later task needs when its size's `max` is
spent, since none could start in its place. A lost worker's begun tasks run again on
another, and the run starts one in its place. A worker is lost when its
socket closes, when it stops answering the orchestrator's probes, or at
once when its adapter sees its process or job end. Workers start at the first
task the cache does not answer, so a warm run starts none. Once one has
joined, its warm-up is what the next of its size takes at the least: work
that ends sooner starts no worker while others are online or starting, and
new workers are started for the cores the run keeps busy after that
warm-up, not before it. A run on CI keeps each size's warm-up in the
workspace's cache under its commit, and the next commit's run plans by it
before any worker of that size joins.

The `workers` rows, live while the run goes and again in the footer,
give each worker its status (`starting`, `online`, `left`, `gone`, or `failed`
with why, such as `exited 1: Cannot find package '@vzn/vx-dte'`; once the
run is over, one still starting is `not joined`), the tasks it
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

A run over that started none (every task a hit) says
`workers   none started: no task needed one`.

Under each worker, and `local`, the footer then spells out what it did:
its time online, busy and idle; its CPU peak and average in cores and
the cores the run booked for the tasks it was running, on average (a
booked from a task's start to its command's end); its cpu utilization (the core-time its
tasks used over the core-time it had); its memory peak and average, when its tasks reported any; and, for a worker, the messages and
bytes the run sent it and received from it. The `probe` line says when
core's cache probe answered, how many tasks it left to run (held in no
cache, or not answered for) and how many of them it found in none. The `asked` line says each
time the run asked for workers: how many, when, for how many tasks that
missed, how many of them with a measured need (an unmeasured one counts
as `unmeasured`), and when its plan ended then. The `ideal` line is the run's ideal end
(below), so every log reads it beside core's `time` row. The first ask
waits for the needs another plugin fetches (`ctx.refining()`), such as
`@vzn/vx-history`'s default-branch timings. The `unmeasured`
line names the tasks the first ask had no measure of, and a worker that
ran two tasks or fewer names them on its row. `used avg` is the cores
its tasks used, `machine avg` the cores its machine was busy on average since
the worker started, any process's, as its last frame said. Where the
rest went, the worker says in its own log as it leaves: `cpu over 61.2s:
machine 2.80 cores · tasks 2.00 cores · this worker 0.15 cores · its other
children 0.05 cores · most besides: Runner.Worker 0.30 cores`, the last
from one `ps` as it starts and one as it leaves. The `total` line is the cpu utilization of every
machine together, and the share of their history the run's tasks used:

```
            small#1  stopped  5 done · warm-up 0.2s
                     declared 4c/14G · actual 4c/14G
                     online 12.1s · busy 9.8s · idle 2.3s
                     cpu peak 3.6 · used avg 2.4 cores · machine avg 2.9 · booked avg 3.8 · cpu utilization 61%
                     memory peak 1.2 GB · avg 640.0 MB
                     sent 6 messages · 3.1 MB, received 15 messages · 8.4 MB
            probe    at 0.4s: 5 tasks left to run, 5 known misses
            asked    1 at 0.5s for 5 tasks (5 measured), plan 12.0s
            ideal    10.8s: each task as long as it took, placed perfectly
            total    cpu utilization 58%
```

`vx run --profile[=<path>]` adds the run in time to the profile it
writes (open it in https://ui.perfetto.dev or `chrome://tracing`).
Each worker is a process: its first row holds its warm-up (split, when it
says when its `vx` started, into its machine's start and vx's boot), its
idle stretches, how it ended, a `cores` counter of the cores booked
and used at once, and a `machine` counter of the cores its machine
reported busy, its tasks' or not (placement never fills a worker past
it), beside the cores its running tasks' process trees used, read each
second as core's `task.sample` reads them; each task takes the first lane free over its time
there, from its send through restoring its dependencies, its command
and its save, with its exit code, duration, CPU time and booked cores.
The `orchestrator` process holds the cache probe, each ask for workers, each
plan that started or let go of workers with what it saw of each worker
(one that started workers also with each task's planned time, cores and
platform and each size's warm-up, so it can be played back),
stalls, the time each task waited for room, and each restore. Times are
the orchestrator's: when it heard. Without `--profile` nothing is
written. On CI, upload the file as an artifact; this repo's `ci.yml`
does and links it from the job summary.

After the run, `dte()` replays it perfectly: each task as long as it held
its worker and with the cores it used meanwhile, on as many
workers as the sizes allow, each joining after its platform's fastest
real warm-up. That ideal end (`TaskExecutor.idealMs`) sits beside the
real time in the run summary and the footer's `ideal` line, and
`@vzn/vx-ci` prints it.

## API

- `dte(options?: DteOptions)` is the plugin. `DteOptions` is
  `{ workers?, adapter?, relay?, local?, token?, scheduler?, unmeasured?, headers? }`.
  `headers` go on every dial to the relay, the orchestrator's and each
  worker's (redials too), for a proxy in front of it, such as a
  Cloudflare Access service token (`{ 'CF-Access-Client-Id':
process.env.CF_ACCESS_CLIENT_ID, … }`); an unset value is left out, and
  `authorization` stays the token's. The rest:
  - `workers` names each `WorkerSize`, `{ cpu, memory, max?, platform? }`: its cores
    and memory (bytes, or `'8GB'`, `'512MiB'`), which the run counts on
    when it starts one, until the worker reports what its machine has,
    how many of it one run may start (absent, no cap), and its machines'
    platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`;
    absent, planned as this machine's and not checked on join). With no adapter, the sizes' platforms are
    the ones joining workers may have. Only work counts:
    a task that missed the cache, or waits on a cached one that did, and
    every uncached task, which runs every time; groups and hits need no worker. At each miss, finish and join the run plays
    that work out on its workers and on N more (`src/planner.ts`), each new
    one joining after its size's warm-up: this run's first of that size,
    else an earlier run's, else any size's this run, else 20 s,
    and takes the fewest N that end within 5% (5 s at least) of the best.
    Sizes of different platforms come in turns, so of those N it drops
    each the plan ends as soon without, its platform's work no more than
    5 s later.
    That margin is spent once: later plans keep its deadline until new
    work is known. A task waiting on one that runs waits until it ends.
    What is left, running tasks too, takes as many times its history as
    the run's finished tasks took theirs (once they had 20 s of it; never
    less): a task past its forecast would otherwise be planned to end now,
    and a plan that thinks the run nearly done cancels the worker it asked.
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
    What a task used counts divided by its share of the CPU: a Linux
    worker reads its run queue (`procs_running` in /proc/stat) every 200 ms,
    a macOS one its load average while all its cores are busy (a GitHub Mac reads a load of 49 with a core idle), and a task whose threads got a third of a core each used a third of
    its need, not its need. A task wanted at most what it used and the
    cores left free beside it, so its share is never read below that. The run history keeps that share
    (`ExecuteResult.machine.cpuShare`) and learns the need, at most the
    machine's cores: learning the share packed the next run tighter, nine
    1.1-core test shards on one 4-core worker. The need is the mean over
    runs, and a task fills its worker only when it does on average: one
    crowded run's 2.84 cores for a build using 1.3 to 1.9 booked it a whole
    Mac.
    A worker the plan needs later starts when its warm-up nears. An idle
    worker leaves when the plan gives it no task (its warm-up is spent), or,
    when its next task is two warm-ups away, with one started in its place
    a warm-up after it left: none is let go and started again. A worker still
    starting that the plan gives no task (asked, a worker stays while the
    plan has work for it, though the run would end no later without) is
    cancelled: the adapter
    stops it before its setup if it can (`github()` cancels its workflow
    run once no worker in it is needed), and one that joins anyway is told
    to exit. The same signal changes nothing. The
    run ends: a task the history has not measured books one free core on
    any worker (`unmeasured` sizes the run); one that used all of its worker's cores or memory (90%) last time runs
    alone on the smallest bigger size, which the run starts for it. Each
    run's history keeps where every task ran and that machine's size, so
    sizing improves run by run.
  - `adapter` is the `DteAdapter` that starts workers, of the sizes in
    `workers`: at least one with `max` above 0, or `dte()` is refused.
    Absent, the run starts none and uses the workers that join `relay`.
  - `relay` is the relay's URL, http(s); absent, the adapter's own.
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
- `vx dte worker` is a worker. It reads `VX_DTE_RUN`, `VX_DTE_RELAY` (unset or empty,
  `relay`), `VX_DTE_SECRET` (the run's) and, when the run started it,
  `VX_DTE_WORKER` (its name). It is
  described only by the cores and memory its machine reports. It exits 0
  when the run ended before it joined.
- `DteAdapter` is `{ spawn(worker: WorkerSpawn), relay?(), close?(), cancel?(ids), init?(setup: DteSetup), runId?(), adopt?(worker), report?(warn), keyless?, workerRuns?() }`; `init` gets a `DteSetup` (workspace root, its directory in the repository, relay, sizes, the `PackageManager` read from the lockfile, the tasks asked for) and returns a `DteInit`: the CI files `vx dte init` writes and the steps it prints; `report` hands it the run's warning channel as the run starts, where `github()` says a status poll or a cancel the CI API refused, by status and body; `adopt` hands each worker the CI started before the run to `worker(id, size)`, which counts it and returns its spawn; `cancel` stops workers the run no longer needs that have not joined; `runId` names the run, in the adapter's own CI, when `VX_DTE_RUN` is unset; `workerId` names a worker in a job its CI started for several, when `VX_DTE_WORKER` is unset; `keyless` workers prove themselves by GitHub OIDC, and `workerRuns` names the workflow runs whose jobs alone may join as them (`undefined`: any job of the repository).
  `WorkerSpawn` is `{ run, relay, size, max, cpu, memory, index, id, workspaceRoot, commit, cacheDir?, env }`,
  with `memory` in bytes and `max` its size's (`Infinity` uncapped),
  where `id` is the worker's name (`small#2`, numbered within its size), `commit` the
  tracked files as the run saw them at its start (uncommitted changes included), whose
  tree a worker must check out, `cacheDir` the run's cache dir (absolute) when the
  workspace names one, for workers on this machine to save where the run reads, and
  `env` holds the three variables the worker reads.
- `docker(options: DockerOptions)` starts workers as containers and a relay
  of its own on loopback. `DockerOptions` is `{ image, prepare? }`.
- `github(options?: GithubOptions)` dispatches workers as matrix jobs of
  one workflow, one dispatch per size and demand (at most 256 workers,
  a matrix's limit). `GithubOptions` is `{ workflow?, runsOn?, env? }`:
  `workflow` defaults to `vx-worker.yml`; `runsOn` is the runner label
  of each size, which `vx dte init` writes; `env` is variables every
  worker gets (one-line strings, no secret-named one: the worker job's
  log shows them), sent as the
  dispatch's `env` input only when set, which `vx dte init`'s workflow
  exports. Its workers are `keyless`, and only jobs of the workflow runs
  it dispatched join as them. It
  needs `GITHUB_TOKEN` with `actions: write`. See [On GitHub](#on-github).
- `gitlab(options?: GitlabOptions)` triggers a pipeline of the project's
  `.gitlab-ci.yml` per wave and size, with `CI_JOB_TOKEN`. `GitlabOptions` is
  `{ tags? }`: runner tags by size, which `vx dte init` writes. See
  [On GitLab](#on-gitlab).
- `local(options?: LocalOptions)` starts workers on this machine and a relay
  of its own on loopback. `LocalOptions` is `{ prepare? }`: a shell line
  each worktree runs before its worker starts.

`@vzn/vx-dte-server` is a dependency for `local()`'s and `docker()`'s relay, loaded only
when a DTE run starts.
