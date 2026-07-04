---
title: Distributed CI execution
description: Fan a vx run across many machines with vx agents — session-keyed distributed task execution, the Nx-Cloud-DTE equivalent. Agents share one checkout and commit; cache hits execute nowhere; outputs move only through the serve's artifact store.
---

**vx agents** distribute a single `vx run` across many machines. A
normal run on the main job fans its task graph out to a pool of agent
machines that share the same checkout and commit; cache hits execute
nowhere, outputs move between machines only through the serve's
artifact store, and the main job renders one ordinary run and owns the
exit code. This is the Nx-Cloud-DTE contract, built on parts vx
already ships.

There are two binaries:

- **`vx`** (`@vzn/vx`) — the core task runner. A plain `vx run`.
- **`vx-cloud`** (`@vzn/vx-cloud`) — the service: `vx-cloud serve`,
  `vx-cloud agent`, `vx-cloud connect`. **Distribution is a `vx-cloud`
  feature**, enabled from a normal `vx run` through the `cloud()`
  plugin.

The `vx-cloud serve` you run is the rendezvous: it holds the session
registry, schedules each submission, and hosts the shared
`/v8/artifacts` store. Agents attach to it; the main job submits to it.

## How it works

```
main job: vx run ci   (VX_CLOUD_DISTRIBUTE=6, connected to a vx-cloud)
  cloud() backend → distributed submitter
   ├ prepareRun (has the checkout) → task graph + stable hashes
   ├ dist:submit { session, commitSha, graph } ───────────────┐
   ├ self-registers as an agent (so it never deadlocks)        │
   ├ renders the relayed event stream (one normal run)         │
   └ materializes outputs back onto disk                       │
                                                               ▼
                       ┌─────────────── vx-cloud serve ───────────────┐
                       │  session registry {workspaceId, session}      │
                       │    → agents (commitSha checked at pairing)     │
                       │  per-submission scheduler:                     │
                       │    • prune: stat /v8 store by stable hash      │
                       │      → a warm task executes NOWHERE            │
                       │    • assign bare task ids to free agents       │
                       │    • re-queue + reassign on agent death        │
                       │  /v8/artifacts — the shared artifact store     │
                       └──────┬─────────────────────────────┬──────────┘
                    task:assign {taskId}          task:assign {taskId}
                              ▼                             ▼
                     vx-cloud agent                vx-cloud agent
                      same commit, own checkout      same commit, own checkout
                      scoped run(): deps restore      scoped run(): …
                      warm from /v8, task runs,       agent:done {taskId, outcome}
                      saves + uploads to /v8
```

The main job builds the graph (it has the checkout), submits it, and
renders the relayed events like any delegated run. The serve schedules
bare task ids onto agents. Each agent runs the assigned task as a
**scoped core `run()` of that exact task with its dependency closure** —
the closure's deps restore as warm `cache-hit-remote` from `/v8`, the
task executes, and its artifact uploads back to `/v8` before the agent
reports `done`. There is **no input shipping**: agents already have the
source at the shared commit, and every output travels only as a
content-addressed artifact through the store.

## The contract: same repo, same commit, clean tree

Because a task's cache key folds its inputs' git OIDs (relative paths,
never absolute checkout locations) and its upstream deps' keys, an
agent's scoped run derives keys **byte-identical** to the full run's —
but only when every machine sees the same source. So the contract is:

- **Same repository, same commit.** Registration is keyed by
  `{workspaceId, session, commitSha}`, and the serve enforces the
  commit at pairing time — an agent on a different SHA is refused,
  naming both SHAs. In GitHub Actions every job of one workflow run
  checks out the same commit automatically.
- **Clean working tree.** A `vx-cloud agent` on a dirty tree refuses to
  start (exit 1, listing the offending paths) — uncommitted changes
  can't exist on the other agents, and divergent inputs would split the
  cache. The submitting run with a dirty tree falls back to a normal
  local run.
- **A reachable remote cache.** `/v8/artifacts` on the serve is the
  transport for every output; distribution needs both remote read and
  remote write on.

Pin one CI image and prefer `--frozen` on the main job so configs
resolve identically everywhere. Divergence (env / toolchain drift)
degrades to a cache miss and re-execution — never a stale hit.

## Enabling distribution

Setup is three steps, all driven by the **one connection** (the same
`VX_CLOUD_URL` + `VX_CLOUD_TOKEN` that powers the remote cache and the
dashboard — see [Remote caching](../remote-caching/)):

1. **Connect** a vx-cloud — `vx-cloud connect <url> --token <t>`, or set
   `VX_CLOUD_URL` + `VX_CLOUD_TOKEN`.
2. **Set `VX_CLOUD_DISTRIBUTE=<n>`** on the submitting run.
3. **Run agents** — `vx-cloud agent` on each machine.

No separate cache config on the agents: the connection hosts
`/v8/artifacts`, so the agents' scoped runs restore and upload through it
automatically.

Distribution is a rung of the `cloud()` backend plugin, so declare the
plugin in `vx.workspace.ts` (it's zero-cost until enabled):

```ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({ plugins: [cloud()] })
```

A plain `vx run` becomes distributed when **both** hold:

1. `VX_CLOUD_DISTRIBUTE=<n>` is set — `<n>` is an advisory expected
   agent count (also `cloud({ distribute: n })`).
2. A vx-cloud connection is reachable. The submitter resolves it through
   the usual ladder: `VX_CLOUD_URL` env → the active `vx-cloud connect`
   environment → a locally advertised serve.

`VX_CLOUD_DISTRIBUTE` set with **no reachable connection is a hard
error** — distribution was explicitly requested, so silently running
locally would hide a broken matrix forever. (This differs from ambient
delegation, which fails safe to local.)

## Attaching agents

Each agent machine checks out the workspace at the same commit and
runs:

```sh
vx-cloud agent --url https://vx-serve.example.com --token "$VX_CLOUD_TOKEN"
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--url <origin>` | The serve to attach to. Falls back to `VX_CLOUD_URL` (then the legacy `VX_SERVICE_URL`), then a locally advertised serve. |
| `--token <t>` | Bearer token for the serve. Falls back to `VX_CLOUD_TOKEN`. |
| `--capacity <n>` | How many assignments to execute in parallel (default `1`). |
| `--session <s>` | The session key to join (default: derived, see below). |
| `--idle-timeout <ms>` | Self-terminate after this long with no assignment (default `600000` = 10 min; `0` = never). |
| `--label <l>` | Tag the agent (repeatable). Informational in v1. |

The **session** groups the agents and the submitter that belong to one
pipeline. It resolves from `--session` → `VX_AGENT_SESSION` → a CI
variable (`GITHUB_RUN_ID`+`GITHUB_RUN_ATTEMPT`, GitLab
`CI_PIPELINE_ID`, Buildkite `BUILDKITE_BUILD_ID`) → `'local'`. The
submitter and every agent **must land on the same session key** — the
simplest way in CI is to set `VX_AGENT_SESSION` on every job.

An agent drains and exits cleanly when the submission finishes (or on
its idle timeout). It **exits 0 even when tasks failed** — the main job
is the sole authority on the run's verdict, so a red agent row means
infrastructure trouble (a refusal, a dirty tree, an unexpected
disconnect), not a failing test.

## GitHub Actions

The realistic pattern points every job at **one vx-cloud reachable by all
of them** — a deployed `vx-cloud serve` behind a URL (see
[Self-host vx-cloud](../self-hosting/)). Two secrets carry the whole
connection: `VX_CLOUD_URL` and `VX_CLOUD_TOKEN`. A matrix of agent jobs
attaches to it, and a separate run job submits.

```yaml
# .github/workflows/distributed.yml
name: CI (distributed)
on: [push, pull_request]

# The one connection + a shared session for the whole workflow run — the
# submitter and every agent derive the same session key from it.
env:
  VX_CLOUD_URL: ${{ secrets.VX_CLOUD_URL }}
  VX_CLOUD_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
  VX_AGENT_SESSION: ${{ github.run_id }}-${{ github.run_attempt }}

jobs:
  agents:
    strategy:
      matrix:
        agent: [1, 2, 3, 4, 5, 6]     # six agent machines
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      # Same repo, same commit, clean tree. Blocks until the submission
      # drains it (a generous idle timeout covers the run job's startup).
      # The connection also provides the /v8 cache — no extra cache config.
      - run: |
          vx-cloud agent \
            --url "$VX_CLOUD_URL" \
            --token "$VX_CLOUD_TOKEN" \
            --session "$VX_AGENT_SESSION" \
            --capacity 4 \
            --idle-timeout 900000

  run:
    runs-on: ubuntu-latest
    env:
      VX_CLOUD_DISTRIBUTE: "6"          # advisory: expect ~6 agents
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0                # --affected needs history
      - run: curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      # A NORMAL vx run. The cloud() plugin routes it to the serve because
      # VX_CLOUD_DISTRIBUTE + the connection (VX_CLOUD_URL) are set. Zero
      # remote agents degrades to a loud local run — never a deadlock.
      - run: vx run ci --all --frozen
```

The `agents` and `run` jobs start in parallel. Agents register with the
serve and wait; the run job submits the graph and dispatch begins. The
submitter self-registers as an agent, so even if no matrix agent has
connected yet the run makes progress locally and mixes in remote agents
as they join.

If your runners share a network (self-hosted runners, or a tunnel like
Tailscale), one job can host the serve with `vx-cloud serve` instead of
using a deployed one — but every agent and the run job still need to
reach it at the same `VX_CLOUD_URL`.

## Fork PRs: present the PR token

The artifact store is **trust-scoped** so a fork PR can warm off `main`
without poisoning it, and the tier follows **which token you present** —
there is no trust flag and no autodetection. Start the serve with two
tokens:

```sh
vx-cloud serve --token "$TRUSTED_TOKEN" --pr-token "$UNTRUSTED_TOKEN"
```

A trusted token reads and writes the trusted scope. The PR token reads
`untrusted ∪ trusted` but **writes only the untrusted scope** — the
serve derives the scope from the bearer, never from a client claim. So a
fork-PR job simply presents `VX_CLOUD_PR_TOKEN` **instead of**
`VX_CLOUD_TOKEN` (a fork can't see your repo secrets, so the PR token is
the only one it has — which token you hold *is* the tier):

```yaml
  run:
    env:
      VX_CLOUD_DISTRIBUTE: "6"
      VX_CLOUD_PR_TOKEN: ${{ secrets.VX_CLOUD_PR_TOKEN }}
```

The run then reads the trusted cache (staying fast) but writes only the
untrusted scope — it can't poison a trusted build, so the PR token is
safe to expose. Present the same PR token on the agent jobs
(`--token "$VX_CLOUD_PR_TOKEN"`) so their scoped runs write to the
untrusted scope too. The full model is in
`docs/design/cache-trust-scopes-2026-07.md`.

## When a run stays local

Some runs can't be distributed. The submitter checks these up front and
**falls back to a normal local run**, printing the reason
(`vx: distribution disabled: <reason> — running locally`):

- **Forwarded args** (`vx run test -- --grep x`) — the requested-arg
  fold can't be reproduced across agents in v1.
- **A dirty worktree** — uncommitted changes can't exist on agents.
- **A cache policy without the remote layer** (`--no-cache`, `--force`,
  or any `--cache=…` that drops remote read or write) — the store is
  the transport.
- **A persistent task** anywhere in the graph — a dev server on a
  remote agent is meaningless.

Only an **unreachable serve** is a hard error; every other gate is a
graceful, loud fallback.

## Zero remote agents

Because the submitter self-registers, the zero-agent deadlock can't
occur — there's always at least one agent (the main job itself). If no
**remote** agent joins the session within `agentTimeoutMs` (default
5 min, `VX_CLOUD_AGENT_TIMEOUT_MS`), the scheduler prints a loud warning
and the run completes on the submitter alone. A green build is never
failed over missing accelerators.

## Known limits

Honest gaps in the current design (see
`docs/design/distributed-execution-2026-07.md` for the full record):

- **Standalone agents run live config eval and the full cache policy.**
  The submitter's `--frozen` / `--cache` flags apply to its own
  in-process work but are **not** propagated to remote agents (a
  per-assignment policy is a small protocol addition, not yet built).
  Keep configs env-pure and pin one image so live eval matches.
- **Uncacheable intermediate tasks re-execute** inside each dependent's
  closure on every agent that needs them — there's nothing to restore.
  Make intermediates cacheable (declare their `cache.outputs`). Dep
  affinity and each agent's warm local cache bound the waste.
- **No cross-run queueing, fairness, or priorities.** A session holds
  one active submission; the registry is a rendezvous, not a job queue.
- **No agent autoscaling or managed fleets.** Your CI matrix (or k8s)
  owns machine lifecycle; vx owns task placement only.
- **No run-history row for a distributed run.** No single `run()`
  executes the whole graph, so the dashboard records no invocation and
  ingests no summary for a distributed run.
- **Input shipping is a permanent non-goal.** Same-checkout is the
  contract; dirty trees run locally.
- **An agent that loses its WS exits** — it does not reconnect. The
  matrix restarts it or it doesn't; the scheduler reassigns its
  in-flight tasks to surviving agents.

## See also

- [Continuous integration](../ci/) — the single-machine CI setup,
  `--affected`, and the lockfile workflow.
- [Remote caching](../remote-caching/) — the `/v8/artifacts` store that
  the connection provides and agents share.
- [Self-host vx-cloud](../self-hosting/) — deploy the serve every job
  attaches to, in one `docker compose up`.
- [vx-cloud serve wire protocol](../wire-protocol/) — the JSON-RPC
  envelope the relayed run stream rides.
- `docs/design/distributed-execution-2026-07.md` — the full design and
  the correctness proof.
