# @vzn/vx-dte

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

Distributed task execution for vx: one `vx run` spread over agents your
own CI starts, replayed here as one run. The run you start is the
orchestrator. It keeps a share of the tasks, starts agents for the rest,
and hands each ready task to an agent with a free slot, critical path
first. An agent runs it in its own checkout and sends back the task's
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
    dte({ agents: { small: { max: 4, cpu: 2 } }, adapter: local({ prepare: 'bun install' }) }),
  ],
})
```

```sh
VX_DTE_RUN=try vx run build --all
```

`VX_DTE_RUN` names the run and turns distribution on; without it, `vx run`
runs here as always. `local()` starts each agent as a process in its own
git worktree of `HEAD`, so agents run committed code only.

## What runs where

- Tasks that must run here stay here: sandboxed, persistent, interactive,
  `exec.remote: false`, and their dependants (core's placement).
- An agent receives the declared outputs of every task the one it runs
  depends on, unless it ran or received them before. Files a task writes
  without declaring them stay on the agent.
- An agent on another commit than the orchestrator is refused.
- An agent that stops answering is dropped, and its tasks run again.
- A relay unreachable for three heartbeats hands every task back to this
  machine.

## API

- `dte(options: DteOptions)` is the plugin. `DteOptions` is
  `{ agents, adapter, relay?, local?, token? }`:
  - `agents` names each `AgentSize`, `{ max, cpu }`: how many of it one
    run may start, and its cores, which are the tasks it runs at once.
    Agents start in declared order as ready work outgrows this machine's
    share; none stops before the run ends.
  - `adapter` is the `DteAdapter` that starts agents.
  - `relay` is the relay's URL; absent, the adapter's own.
  - `local` is how many tasks this machine runs at once beside the agents
    (default: the run's worker count). `0` sends all of them to agents.
  - `token` answers the relay's bearer token (default `VX_DTE_TOKEN`).
- `vx dte agent` is an agent. It reads `VX_DTE_RUN`, `VX_DTE_SIZE` (one of
  `agents`) and `VX_DTE_RELAY` (else `relay`).
- `DteAdapter` is `{ spawn(agent: AgentSpawn), relay?(), close?() }`.
  `AgentSpawn` is `{ run, relay, size, index, workspaceRoot, env }`, where
  `env` holds the three variables the agent reads.
- `local(options?: LocalOptions)` starts agents on this machine and a relay
  of its own on loopback. `LocalOptions` is `{ prepare? }`: a shell line
  each worktree runs before its agent starts.

`@vzn/vx-dte-relay` is a dependency for `local()`'s relay, loaded only
when a distributed run starts.
