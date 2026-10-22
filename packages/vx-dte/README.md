# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx: one `vx run` spread over agents your
own CI starts, replayed here as one run. The run you start is the
orchestrator. It keeps a share of the tasks, starts agents for the rest,
and hands the ready tasks to the agents with room, critical path first. An agent runs it in its own checkout and saves the task's
output and the files its declared outputs left to the workspace's cache,
under the task's key. They land here before the task ends, so the run
reports the task as its own. No file travels through the relay: it
carries only orders and status, so the agents and this machine need one
cache they all read (a remote the agents write, or one shared store). An agent reads that cache as the run does:
under the run's refs, with the short-lived access the run's remote lends
it (an OIDC exchange's token, never a stored secret) when it has none of
its own.

Agents and the orchestrator meet at a relay
([`@vzn/vx-dte-relay`](../vx-dte-relay/PROTOCOL.md)), since CI runners
take no inbound connection. Host your own: its
[README](../vx-dte-relay/README.md) has a Deploy to Cloudflare button,
which asks only for the repositories whose runs it carries.

A run id is a channel. Agents join it before or after the orchestrator
does, and the orchestrator claims it with a key made for that run; the
relay keeps the public half and passes nothing to or from a side that
cannot sign by it. The orchestrator checks each agent the moment it
appears and removes any without the run's key from the channel.

The relay reads nothing they say. Each agent and the orchestrator run a
[Noise](https://noiseprotocol.org/noise.html) handshake through it, one
session per agent, with keys made for that session only. With the run's
key (`VX_DTE_SECRET`, the one `vx dte plan` wrote, or one an adapter made
for its agents) it is `Noise_NNpsk0_25519_AESGCM_SHA256`: the key is the
pre-shared key, so a side without it cannot finish the handshake, and the
agent's `join` info (cores, memory, tree) is already encrypted. On GitHub
Actions with no key it is `Noise_NN_25519_AESGCM_SHA256`, and each side
binds the handshake by an OIDC token of this repository (`id-token:
write`): no secret is stored anywhere. With no adapter and no GitHub, set
the same `VX_DTE_SECRET` on the run and each agent. A message the relay
changes loses its agent; one it replays is dropped. The key never
encrypts a message, so a leaked one opens no past run.

It is not on npm yet: it is being built in this repo. Today it runs on
`local()` and `docker()`; the GitLab adapter comes next.

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
      agents: { small: { max: 4, cpu: 2, memory: '8GB' } },
      adapter: local({ prepare: 'bun install' }),
    }),
  ],
})
```

```sh
VX_DTE_RUN=$(uuidgen) vx run build --all
```

`VX_DTE_RUN` names the run and turns distribution on; without it, `vx run`
runs here as always. It is a random UUID, so no one can guess a run to
open it first or join it; vx and the relay refuse any other. `local()` starts each agent as a process in its own
git worktree of the tracked files as they are, uncommitted changes
included (untracked files are not). When an agent fails, its row names
the error line and the log that holds its whole stderr. At the run's end,
or on Ctrl-C, vx exits without waiting for the worktrees to be removed:
a detached shell removes them and prunes git's records.

`docker()` starts each agent as a container held to its size: `--cpus`
and `--memory` come from `cpu` and `memory`. The container clones this
checkout (mounted read-only) into its own filesystem at its tracked
files as they are, uncommitted changes too, runs
`prepare`, then the workspace's own `node_modules/.bin/vx dte agent`, so
the image needs Bun and git, and `prepare` installs vx. This machine's store
(`~/.vx`) and `VX_CACHE_DIR` are mounted at their own paths, and the
clone keeps this checkout's `origin`, so the agents save where the run
reads, as `local()`'s do; no remote is needed. On Linux a container runs
as this user (its home is `/tmp`, where the store is mounted), so what it
writes is this user's and git trusts the mounted checkout. A container that fails
names its error line and the log of its whole stderr:

```ts
dte({
  agents: { small: { max: 4, cpu: 2, memory: '4GB' } },
  adapter: docker({ image: 'my/bun-git', prepare: 'bun install' }),
})
```

The relay stays on loopback: on Linux a container joins the host's
network; elsewhere it reaches the relay through `host.docker.internal`.
A container ends with its agent; one still up when the run ends is
removed.

With no adapter, vx starts no agents: the run uses whichever join its
relay. In three terminals on one checkout's commit:

```ts
// .vx/workspace.ts
export default defineWorkspace({ plugins: [dte({ relay: 'http://127.0.0.1:8080' })] })
```

```sh
bun /path/to/vx/packages/vx-dte-relay/src/bun.ts --no-auth --port 8080   # the relay
export VX_DTE_SECRET=$(openssl rand -base64 32)                          # in each terminal: the same one
export VX_DTE_RUN=$(uuidgen)                                             # in each terminal: the same one
vx dte agent                                                             # an agent, as many as you like
vx run build --all                                                       # the run
```

An agent prints its name, the run, the relay and its machine, then a row
as each task starts and ends:

```
─ vx dte agent ───────────────────────────────────────────────
  agent     agent#1
  run       5f0c7a52-…
  relay     http://127.0.0.1:8080
  machine   10 cores · 17.2 GB
› b#build  running
✓ b#build  308ms
```

## On GitHub

The run is your own job's `vx run`. When it needs agents it dispatches
`.github/workflows/vx-agent.yml` once per size, with the agents of that
size as a matrix. When the run ends it cancels each agent run it
dispatched, so one still queued does not hold a runner the next run
waits for. A vx that is killed never gets to: it also lists each run in
`$RUNNER_TEMP/vx-dte-runs`, one API path per line, for an `if: always()`
step to cancel (this repo's `ci.yml` does). No secret: each side proves its key with the job's OIDC
token, and the relay's token is an OIDC token for the relay's URL. Such a
token lasts 5 minutes, so each side asks for a new one a minute before
its token expires.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      agents: { small: { max: 8, cpu: 4, memory: '16GB' } },
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
  - run: echo "VX_DTE_RUN=$(uuidgen)" >> "$GITHUB_ENV"
  - run: bunx @vzn/vx run build test --all
    env: { GITHUB_TOKEN: '${{ github.token }}' }
```

```yaml
# .github/workflows/vx-agent.yml
name: vx-agent
on:
  workflow_dispatch:
    inputs:
      {
        run: { required: true },
        relay: { required: true },
        sha: { required: true },
        size: { required: true },
        agents: { required: true },
      }
permissions: { id-token: write, contents: read }
jobs:
  agent:
    runs-on: ${{ fromJSON('{"small":"ubuntu-latest"}')[inputs.size] }}
    strategy: { matrix: { agent: '${{ fromJSON(inputs.agents) }}' } }
    env:
      {
        VX_DTE_RUN: '${{ inputs.run }}',
        VX_DTE_RELAY: '${{ inputs.relay }}',
        VX_DTE_AGENT: '${{ matrix.agent }}',
      }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ inputs.sha }}' }
      - run: bun install --frozen-lockfile
      - run: bunx @vzn/vx dte agent
```

## On GitLab

Three jobs of your own pipeline: `vx-plan` writes the agents' child
pipeline, `vx-agents` triggers it, and `vx` is the orchestrator, your own
`vx run`. Every agent the plan wrote starts at once, beside the
orchestrator, and leaves when the run ends.

```ts
// .vx/workspace.ts
export default defineWorkspace({
  plugins: [
    dte({
      relay: 'https://relay.example.com',
      agents: { small: { max: 4, cpu: 2, memory: '8GB' } },
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
  script: [pnpm exec vx dte plan build test --all] # the run's selection
  artifacts:
    paths: [vx-agents.yml, .vx/dte/]
    reports: { dotenv: vx-dte.env }
    access: none
    expire_in: 1 hour # as long as the pipeline may run

vx-agents:
  needs: [vx-plan]
  variables: { PARENT_PIPELINE_ID: $CI_PIPELINE_ID }
  trigger:
    include: [{ artifact: vx-agents.yml, job: vx-plan }]

vx:
  extends: .vx
  needs: [vx-plan]
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
  script: [pnpm exec vx run build test --all]
```

```yaml
# .gitlab/vx.yml
.vx:
  image: oven/bun:1.4
  before_script: [pnpm install --frozen-lockfile]

.vx-agent:
  extends: .vx
  id_tokens: { VX_DTE_TOKEN: { aud: https://relay.example.com } }
```

The run's secret is an artifact no one can download (`access: none`);
the orchestrator and the agents get it through `needs`. Set
`VX_DTE_SECRET` to use your own instead.

Set `VX_DTE_GITLAB_TOKEN` (an access token with `api` scope, as a masked
CI/CD variable both `vx-plan` and `vx` see) to spawn live: the plan then
starts with the run only the agents its start keeps busy, and writes the
others as `when: manual` jobs. It reads that from the run's own graph
(`vx run <its args> --dry=json`) and history, so give `vx dte plan` the
run's selection; a task with no history takes a whole agent. The run plays one when its work needs it and cancels
the ones it never played when it ends.

## What runs where

- An agent reports the cores and memory its machine has when it joins.
  One the run started is held to the size it was started as, so
  `local()` agents sharing a host split it rather than each take all of
  it. Tasks go to it in batches that fill those by each task's recorded peak
  (cores used, peak memory; one core for a task with no history), plus a
  quarter of its cores as a prefetch, so a successor is there when a task
  ends. The agent starts only what fits; a task bigger than any agent runs
  alone on an idle one. A prefetched task an agent has not begun moves to
  an agent with nothing to do, so a short gate is never stuck behind a
  long task while another machine idles.
- A task goes to the agent that holds most of its dependencies' outputs,
  so a chain stays on one machine.
- A sandboxed task runs on an agent inside the agent's own sandbox, with
  the same `exec.sandbox`; a violation there fails it here, named in this
  checkout's paths.
- A persistent task a task depends on starts on the agent that runs the
  task, once per agent, ready before it, and stops when the agent leaves;
  the orchestrator never starts it, and an agent no dependant reaches
  never does (owner, 2026-10-22).
- A task whose key folds a runtime probe (`inputs.runtime`, such as
  `bun --version`) runs on an agent, which answers the probe first and
  fails the task when it answers otherwise than this machine did.
- Tasks that must run here stay here: a requested persistent task, one
  with `exec.remote: false`, interactive tasks, and their dependants
  (core's placement).
- An agent restores, by key, the declared outputs of every task the one
  it runs depends on, unless it ran or restored them before. Files a task
  writes without declaring them stay on the agent.
- A failed or uncached task is saved under a key of the run and the task,
  so no later lookup ever hits it.
- An agent whose tracked files differ from the orchestrator's (another
  tree) is refused.
- An agent that stops answering, stops saying it holds a task, or cannot
  run one (a full disk) gets no more work, and its tasks run again on
  another. A task two such agents had begun fails, naming both; one an
  agent had not begun yet does not count.
- A relay unreachable for three heartbeats fails every task not done
  (`the relay is unreachable`); none runs here, which may be far smaller
  than the agents. What finished is saved, so a rerun resumes from it.
- An agent that never joins says why on its row (`failed  exited 1:
…`). The first such failure in a run starts another agent in its
  place, as a checkout or install can fail on the network; a second
  starts none. When none is online or starting and this machine has no
  share, the remaining tasks fail with `no agent could start`.

## What the run shows

Each task an agent ran says which one last on its row and after the id
on its frame, in that agent's own color, by size and the order the run
started it:

```
 ⏺︎   308ms success miss     c#build · small#1
```

An idle agent the rest of the run cannot keep busy leaves (`left`): one
beyond the peak of the cores the remaining tasks keep busy, so a lull
between two wide parts keeps it. One a remaining task needs for its size
stays. A lost agent's begun tasks run again on
another, and the run starts one in its place. Agents start at the first
task the cache does not answer, so a warm run starts none. Once one has
joined, its warm-up is what the next takes at the least: work that ends
sooner starts no agent while others are online or starting, and new
agents are started for the cores the run keeps busy after that warm-up,
not before it.

The `agents` rows, live while the run goes and again in the footer,
give each agent its status (`starting`, `online`, `left`, `gone`, or `failed`
with why, such as `exited 1: Cannot find package '@vzn/vx-dte'`), the tasks it
has done, failed or had aborted by a stop, and the ones it runs now; while the run goes, those that left
are one line (`3 agents  left  9 done`). This machine is `local`. An agent the
run started is named by its size and the order it was started in; one
that joined on its own is `agent#N`. A task sent to an agent but not yet
begun there has no row; the tasks line counts it `scheduled`
(`30 success · 4 running · 12 scheduled · 62 total`). Its row and clock
start when the agent begins it. An agent is `online` while the run
goes; it ends `left` when the run let it go as not needed, `lost` when
it crashed or went silent, and `stopped` when the run's end stopped it.
Once the run is over, each agent adds its warm-up (from asking the
adapter to its join), and under it the cores and memory its size
declares and its machine reports, green when they agree and red when
not:

```
  agents    small#1  online    3 done · 2 running
            small#2  starting
            local    online    1 done
```

```
  agents    small#1  stopped  5 done · warm-up 0.1s
                     declared 2c/8G · actual 4c/16G
            small#2  lost     1 done · warm-up 0.2s
                     declared 2c/8G · actual 4c/16G
            local    online   1 done
                     actual 10c/32G
```

Under each agent, and `local`, the footer then spells out what it did:
its time online, busy and idle; its CPU peak and average in cores and
its cpu utilization (the core-time its tasks used over the core-time it
had); its memory peak and average, when its tasks reported any; and, for an agent, the messages and
bytes the run sent it and received from it. The `total` line is the cpu
utilization of every machine together:

```
            small#1  stopped  5 done · warm-up 0.2s
                     declared 4c/14G · actual 4c/14G
                     online 12.1s · busy 9.8s · idle 2.3s
                     cpu peak 3.6 · avg 2.4 cores · cpu utilization 61%
                     memory peak 1.2 GB · avg 640.0 MB
                     sent 6 messages · 3.1 MB, received 15 messages · 8.4 MB
            total    cpu utilization 58%
```

## API

- `dte(options: DteOptions)` is the plugin. `DteOptions` is
  `{ agents?, adapter?, relay?, local?, token? }`:
  - `agents` names each `AgentSize`, `{ cpu, memory, max? }`: its cores
    and memory (bytes, or `'8GB'`, `'512MiB'`), which the run counts on
    when it starts one, until the agent reports what its machine has, and
    how many of it one run may start (absent, no cap). Agents start in
    declared order for the cores the remaining tasks keep busy: laid out
    as early as their dependencies allow, each for its usual duration
    (1 s without history), the most cores in use at once for at least
    half the time left, less this machine's share. None stops before the
    run ends. A task the history has not measured runs alone on an agent;
    one that used all of its agent's cores or memory (90%) last time runs
    alone on the smallest bigger size, which the run starts for it. Each
    run's history keeps where every task ran and that machine's size, so
    sizing improves run by run.
  - `adapter` is the `DteAdapter` that starts agents. Absent, the run
    starts none and uses the agents that join `relay`.
  - `relay` is the relay's URL; absent, the adapter's own.
  - `local` is how many tasks this machine runs at once beside the agents
    (default 0: agents run every task).
  - `token` answers the relay's bearer token (default `VX_DTE_TOKEN`). It
    is asked again a minute before the token's `exp`, when it has one.
- `vx dte agent` is an agent. It reads `VX_DTE_RUN`, `VX_DTE_RELAY` (else
  `relay`), `VX_DTE_SECRET` (the run's) and, when the run started it,
  `VX_DTE_AGENT` (its name). With no `VX_DTE_SECRET` it reads
  `.vx/dte/secret`, the one `vx dte plan` wrote. It is
  described only by the cores and memory its machine reports. It exits 0
  when the run ended before it joined.
- `vx dte plan [<tasks> <run flags>]` writes the CI files that start the
  run's agents, through the adapter's `render`: every size's `max`
  agents. With an adapter that spawns live (`live()`), only the first
  wave starts at once: the agents the run's start keeps busy, from
  `vx run <args> --dry=json` and history, as the run's own demand counts
  them. It names the run (`VX_DTE_RUN`, else the adapter's `runId()`),
  writes the agents for the orchestrator to `.vx/dte/plan.json` and,
  unless `VX_DTE_SECRET` is set, a secret to `.vx/dte/secret`.
- `DteAdapter` is `{ spawn(agent: AgentSpawn), relay?(), close?(), render?(plan: DtePlan), live?(), runId?() }`.
  `DtePlan` is `{ run, relay, workspaceRoot, agents }`, each agent
  `{ id, size, cpu, memory, live }`: a `live` one the run `spawn`s when
  it needs it.
  `AgentSpawn` is `{ run, relay, size, cpu, memory, index, id, workspaceRoot, env }`,
  with `memory` in bytes,
  where `id` is the agent's name (`small#2`) and `env` holds the three
  variables the agent reads.
- `docker(options: DockerOptions)` starts agents as containers and a relay
  of its own on loopback. `DockerOptions` is `{ image, prepare? }`.
- `github(options?: GithubOptions)` dispatches agents as matrix jobs of
  one workflow, one dispatch per size and demand. `GithubOptions` is
  `{ workflow? }` (default `vx-agent.yml`). Its agents are `keyless`. It
  needs `GITHUB_TOKEN` with `actions: write`. See [On GitHub](#on-github).
- `gitlab(options: GitlabOptions)` runs agents as jobs of a child
  pipeline. `GitlabOptions` is `{ include, tags? }`: the file holding the
  `.vx-agent` job template every agent job extends, and runner tags by
  size. See [On GitLab](#on-gitlab).
- `local(options?: LocalOptions)` starts agents on this machine and a relay
  of its own on loopback. `LocalOptions` is `{ prepare? }`: a shell line
  each worktree runs before its agent starts.

`@vzn/vx-dte-relay` is a dependency for `local()`'s and `docker()`'s relay, loaded only
when a distributed run starts.
