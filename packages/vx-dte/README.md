# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx: one `vx run` spread over agents your
own CI starts, replayed here as one run. The run you start is the
orchestrator. It keeps a share of the tasks, starts agents for the rest,
and hands the ready tasks to the agents with room, critical path first. An agent runs it in its own checkout and sends back the task's
output and the files its declared outputs left. They land here before the
task ends, so the run saves, uploads and reports the task as its own.

Agents and the orchestrator meet at a relay
([`@vzn/vx-dte-relay`](../vx-dte-relay/PROTOCOL.md)), since CI runners
take no inbound connection.

It is not on npm yet: it is being built in this repo. Today it runs on
`local()`; the GitLab adapter comes next.

## Try it

Until it is on npm, import it from a checkout of this repo:

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
VX_DTE_RUN=try vx run build --all
```

`VX_DTE_RUN` names the run and turns distribution on; without it, `vx run`
runs here as always. `local()` starts each agent as a process in its own
git worktree of `HEAD`, so agents run committed code only.

With no adapter, vx starts no agents: the run uses whichever join its
relay. In three terminals on one checkout's commit:

```ts
// .vx/workspace.ts
export default defineWorkspace({ plugins: [dte({ relay: 'http://127.0.0.1:8080' })] })
```

```sh
bun /path/to/vx/packages/vx-dte-relay/src/bin.ts --no-auth --port 8080   # the relay
VX_DTE_RUN=try vx dte agent                                              # an agent, as many as you like
VX_DTE_RUN=try vx run build --all                                        # the run
```

An agent prints its name, the run, the relay and its machine, then a row
as each task starts and ends:

```
─ vx dte agent ───────────────────────────────────────────────
  agent     agent·1
  run       try
  relay     http://127.0.0.1:8080
  machine   10 cores · 17.2 GB
› b#build  running
✓ b#build  308ms
```

## What runs where

- An agent reports the cores and memory its machine has when it joins.
  Tasks go to it in batches that fill those by each task's recorded peak
  (cores used, peak memory; one core for a task with no history), plus a
  quarter of its cores as a prefetch, so a successor is there when a task
  ends. The agent starts only what fits; a task bigger than any agent runs
  alone on an idle one.
- A task goes to the agent that holds most of its dependencies' outputs,
  so a chain stays on one machine.
- A sandboxed task runs on an agent inside the agent's own sandbox, with
  the same `exec.sandbox`; a violation there fails it here, named in this
  checkout's paths.
- Tasks that must run here stay here: persistent, interactive,
  `exec.remote: false`, and their dependants (core's placement).
- An agent receives the declared outputs of every task the one it runs
  depends on, unless it ran or received them before. Files a task writes
  without declaring them stay on the agent.
- An agent on another commit than the orchestrator is refused.
- An agent that stops answering is dropped, and its tasks run again.
- A relay unreachable for three heartbeats hands every task back to this
  machine.

## What the run shows

Each task an agent ran says which one on its row and frame, by size and
the order the run started it:

```
 ⏺︎   308ms success miss     c#build  on small·1
```

The footer's `agents` row counts the agents online, starting and gone
while the run goes, then lists each one with the tasks it ran and its
warm-up (from asking the adapter to its join), and the tasks this
machine ran. An agent the run started is named by its size and the order
it was started in; one that joined on its own is `agent·N`. Once the run
is over, a size whose agents reported other cores or memory than it
declares is named:

```
  agents    2 online
            small·1  5 ran, warm-up 0.1s
            small·2  0 ran, warm-up 0.2s
            here     1 ran
            ! small: config 2 cores 8 GB, reported 4 cores 16 GB
```

## API

- `dte(options: DteOptions)` is the plugin. `DteOptions` is
  `{ agents?, adapter?, relay?, local?, token? }`:
  - `agents` names each `AgentSize`, `{ cpu, memory, max? }`: its cores
    and memory (bytes, or `'8GB'`, `'512MiB'`), which the run counts on
    when it starts one, until the agent reports what its machine has, and
    how many of it one run may start (absent, no cap). Agents start in
    declared order until their cores and memory cover the remaining
    tasks' recorded peaks beyond this machine's share; none stops before
    the run ends.
  - `adapter` is the `DteAdapter` that starts agents. Absent, the run
    starts none and uses the agents that join `relay`.
  - `relay` is the relay's URL; absent, the adapter's own.
  - `local` is how many tasks this machine runs at once beside the agents
    (default: the run's worker count). `0` sends all of them to agents.
  - `token` answers the relay's bearer token (default `VX_DTE_TOKEN`).
- `vx dte agent` is an agent. It reads `VX_DTE_RUN`, `VX_DTE_RELAY` (else
  `relay`) and, when the run started it, `VX_DTE_AGENT` (its name). It is
  described only by the cores and memory its machine reports.
- `DteAdapter` is `{ spawn(agent: AgentSpawn), relay?(), close?() }`.
  `AgentSpawn` is `{ run, relay, size, index, id, workspaceRoot, env }`,
  where `id` is the agent's name (`small·2`) and `env` holds the three
  variables the agent reads.
- `local(options?: LocalOptions)` starts agents on this machine and a relay
  of its own on loopback. `LocalOptions` is `{ prepare? }`: a shell line
  each worktree runs before its agent starts.

`@vzn/vx-dte-relay` is a dependency for `local()`'s relay, loaded only
when a distributed run starts.
