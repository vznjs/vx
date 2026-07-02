# Dev flows, CI integration, and vx agents — design

> **Status:** proposal (2026-07-02)
>
> **Builds on / updates:**
>
> - **Builds on** `cloud-client-server-2026-07.md` — Phase 1 (environments,
>   `connect`/`env` verbs, `serve --token` auth, `/v1/meta`) is SHIPPED and
>   assumed. This doc extends its Phase 2–5 roadmap into one unified plan (§7)
>   without renumbering what it defined.
> - **Builds on** `core-cloud-split-2026-06.md` §3.3/§3.4 — the deferred
>   distribution phases. The agents design (§4.3) is the concrete shape those
>   phases were reserved for; the "no input shipping, same-checkout contract"
>   stance is inherited from §3.3 and made explicit policy here.
> - **Builds on** `distributed-ci-2026-06.md` — the shipped coordinator/worker
>   skeleton is the substrate. Its §7.1 tunnel-between-runners topology is
>   REPLACED (§4.3.2): the serve is the rendezvous, not a matrix-0 tunnel.
> - **Resolves** consulting-review findings CLOUD-3 (workspace identity, §3),
>   and fences CLOUD-4 (self-ingest) and CLOUD-7 (coordinator skeleton drift)
>   into the unified phasing.
> - **Updates** `observability-architecture-2026-06.md` — the first
>   `TELEMETRY_SCHEMA_VERSION` bump (1 → 2, §3.3).

## 1. What we're solving

Owner directive (verbatim): _"I would love to have it working like a docker.
We run the server locally or on cloud, we can connect with managers, we can
many workspaces, I wonder though how this would integrate with ci. What we
want there is have sth like nx agents. Figure out whole dev flows for best
experience."_

Three asks in one:

1. **"Like docker … many workspaces"** — one server (local or deployed), many
   repos reporting into it, switchable like Docker contexts. The connection
   layer shipped (Phase 1); the missing keystone is **workspace identity** —
   today a machine-level serve mixes every repo's runs into one undifferentiated
   pool (audit finding CLOUD-3, P1). §3 designs it.
2. **"How this integrates with CI … something like nx agents"** — §4 gives the
   CI story in three tiers: what works today (document it), what one-URL setup
   adds (existing roadmap), and the Nx-Agents-equivalent distributed CI built
   on the coordinator/worker skeleton.
3. **"Figure out whole dev flows"** — §5 is the end-to-end catalog: what the
   user types, what happens, what they see, and which phase delivers each part.

## 2. The Docker mental model, completed

The analogy the owner is reaching for, made exact — one row per Docker concept,
with the honest shipped/missing status:

| Docker concept                       | vx equivalent                                                                 | Status                                                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerd` — one long-running daemon  | `vx-cloud serve` — one long-running server, local or deployed (same artifact) | **SHIPPED** (serve, Docker image, Helm skeleton, deterministic port, `--token` auth)                                                                                         |
| `docker` CLI                         | `vx` (runs) + `vx-cloud` (server management)                                  | **SHIPPED**                                                                                                                                                                  |
| Docker Desktop                       | the embedded dashboard SPA (`serve --ui`)                                     | **SHIPPED** — but single-workspace by construction; no switcher (§3.6)                                                                                                       |
| `docker context` / `DOCKER_HOST`     | `environments.json` + `vx-cloud connect`/`env use` / `VX_CLOUD_*` env vars    | **SHIPPED** (Phase 1)                                                                                                                                                        |
| registry (Docker Hub)                | remote cache / artifact store                                                 | **HALF** — the Turbo-wire client ships in core (`VX_REMOTE_CACHE_*`), but the serve hosts no artifact endpoint; a team runs a separate cache server today. Phase 3 closes it |
| many containers on one daemon        | **many workspaces on one serve**                                              | **MISSING** — the keystone gap. Ingested runs carry no workspace identity; two repos' `web#build` collide in every query. §3 is the fix                                      |
| `docker run` against a remote daemon | WS run delegation (`delegate: true` environments)                             | **HALF** — works, but delegated runs never land in the ingest store (CLOUD-4), and the serve needs a matching checkout (documented fence)                                    |
| `docker buildx` build agents         | **vx agents** (coordinator + agent fleet)                                     | **SKELETON** — ephemeral coordinator + cache-blind worker exist, unwired from the normal flow (CLOUD-7). §4.3 is the real design                                             |
| `docker system df` / `events`        | `/v1/*` analytics + SSE/WS event streams                                      | **SHIPPED**                                                                                                                                                                  |

Reading the table: the daemon, CLI, contexts, and auth rows are done. Every
remaining gap traces to one of two things — **workspace identity** (rows 3, 6, 7) or **the serve not yet hosting artifacts/coordination** (rows 5, 8). That is
exactly the ordering §7 encodes: identity next, artifact store after, agents on
top.

## 3. Workspace identity — the keystone

### 3.1 What it is

Every `RunSummaryRecord` gains a workspace identity block inside
`RunContextRecord`:

```ts
// src/orchestrator/telemetry.ts (v2)
export interface WorkspaceRecord {
  /** Stable 16-hex id — same for every clone of the same repo (§3.2). */
  id: string
  /** Human display name, e.g. `acme/web` (§3.2 ladder). */
  name: string
  /** Normalized git remote origin URL, or null (no git / no remote). */
  remote: string | null
}

export interface RunContextRecord {
  // … existing fields unchanged …
  workspace: WorkspaceRecord
}
```

`remote` rides along because the UI wants it (link a run to its GitHub repo)
and the CI deep-link story (§6) wants it. The already-captured repo context
(`commitSha`/`branch`/`dirty`) is untouched — workspace identity answers
"WHICH repo", the git context answers "which state of it".

**Not a cache concern.** The workspace block is telemetry-only: no
`CACHE_VERSION` bump, no core `SCHEMA_VERSION` bump (the local `cache.db` is
per-workspace by construction — it needs no workspace column). The capture is
gated exactly like the rest of `runContextRecord`: it is allocated **only when
telemetry sinks exist**, so a plain run pays nothing.

### 3.2 Stable id derivation (the ladder)

Requirements: two teammates cloning the same repo derive the **same** id with
zero config; two unrelated repos named `web` never collide; no network, ≤1
extra spawn, never fails a run.

| #   | Source                                                                                           | id                                      | name                                    |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------- |
| 1   | git remote `origin` exists (`git remote get-url origin`)                                         | `xxh3hex(normalizedRemoteUrl)` (16 hex) | last two path segments, e.g. `acme/web` |
| 2   | no origin remote / not a git repo: a salt file `<root>/.vx/workspace-id` (created on first need) | the persisted 16-hex random salt        | workspace root basename                 |

`defineWorkspace({ name: 'acme-web' })` — a new optional core `WorkspaceConfig`
field — overrides the **display name** only (committed, team-shared). It never
affects the id.

**URL normalization** (the whole point — every clone syntax of one repo must
hash identically):

1. Trim; strip credentials (`user:token@`).
2. scp form `git@host:path` → `host/path`; strip `ssh://`/`https://`/`git://`
   schemes.
3. Strip a trailing `.git` and trailing `/`.
4. Lowercase the whole thing (GitHub/GitLab paths are case-insensitive; a rare
   case-sensitive host aliasing two repos is an accepted edge).

Examples — all four hash to the same id:

```
git@github.com:Acme/Web.git      → github.com/acme/web
https://x:tok@github.com/acme/web.git/ → github.com/acme/web
ssh://git@github.com/acme/web    → github.com/acme/web
https://github.com/acme/web      → github.com/acme/web
```

**Thought-through edges:**

- **Forks.** A fork has a different origin URL → a different workspace id.
  Correct: a fork IS a different repo with its own run history. A team that
  wants fork runs merged points CI at the canonical repo (CI checkouts of the
  upstream repo carry the upstream origin) — which is what happens naturally
  for PR builds on GitHub Actions (the checkout's origin is the base repo).
- **Repo renames.** `acme/web` → `acme/website` changes the origin URL → new
  id → history splits at the rename. Accepted: renames are rare, the split is
  visible (two entries in the workspace list), and `defineWorkspace({ name })`
  keeps display continuity. A server-side "merge workspaces" admin verb is
  out of scope (§6). An explicit `workspaceId` config override was REJECTED —
  a second identity source invites copy-paste collisions (template repos) and
  the failure it prevents is rarer than the failure it enables.
- **No git / no remote.** The salt file makes the id stable across process
  restarts and directory renames on that machine. `.vx/` is gitignored, so
  each checkout gets its own salt — acceptable, because without a shared
  remote there is no shared identity to agree on.
- **Multiple remotes.** Only `origin` is consulted. No origin → rung 2. Simple
  and predictable beats clever remote-picking.

**Cost:** one `git remote get-url origin` spawn (~2 ms), only on
telemetry-enabled runs, memoized per process alongside `captureGitContext`.

### 3.3 TELEMETRY_SCHEMA_VERSION 1 → 2 — the compat rule

- `TELEMETRY_SCHEMA_VERSION = 2`. Producers (core) always emit v2; the
  `workspace` field is REQUIRED in v2 (the ladder always produces one).
- **Server accepts v1 and v2.** `/v1/ingest` on a `v: 1` body (an older vx
  pushing to a newer serve) synthesizes
  `workspace = { id: 'default', name: 'default', remote: null }` and ingests
  normally — old clients keep working, their runs land in a visible `default`
  workspace instead of vanishing. `v > 2` (or missing/absurd `v`) → 400 naming
  both versions. This lands the CLOUD-9 boundary validation in the same
  change (the ingest endpoint finally checks `summary.v` + minimal shape).
- `@vzn/vx-otel` / the streaming records: additive field, mapped to OTel
  resource attributes (`service.namespace` = workspace name,
  `vcs.repository.url.full` = remote). No breaking change for OTLP consumers.

### 3.4 Server side: one store per workspace

**Decision: the IngestStore becomes a directory of per-workspace stores —
`<ingestRoot>/<workspaceId>/cache.db` — NOT workspace columns in one DB.**

The IngestStore is deliberately "a core `Cache` at a cloud-owned path" so every
`metrics.ts` query runs unchanged. Adding a `workspace_id` column would force a
workspace predicate into all ~30 metrics queries — a core change surface of
1,500+ SQL lines for zero analytical gain. A store per workspace keeps
**every query byte-identical**: the serve resolves the workspace once per
request, opens (and memoizes) that workspace's store, and runs the same
queries against it. DB-per-tenant is the standard SQLite pattern; workspaces
are fully isolated by construction; per-workspace retention/deletion is `rm -rf
one directory`.

Concretely:

- `IngestStore` grows a thin `IngestHub` above it: `storeFor(workspaceId)`
  (lazy-open + memoize, id validated `[0-9a-f]{16}` or `default`), plus a
  `workspaces.json` manifest at the ingest root (`{ id → { name, remote,
firstSeenAt, lastSeenAt } }`, updated on ingest — name/remote are display
  metadata, the id is the key).
- **Default ingest root moves to `$XDG_DATA_HOME/vx-cloud/ingest/`** (else
  `~/.local/share/vx-cloud/ingest/`), `--ingest-dir` still overrides (Docker
  keeps `/data`). This closes the audit's "workspace-scoped store,
  machine-scoped discovery" mismatch in the same change: a local serve
  discovered from ANY workspace now also stores durable data at a machine
  path, not under whichever repo it happened to start in.
- Existing single-DB deployments: on first boot the hub moves an existing
  root-level `cache.db` to `<root>/default/cache.db` (one rename, loud log
  line). v1 pushes keep landing in `default`.

### 3.5 Endpoint scoping — query param, not path

**Decision: `?ws=<workspaceId>` on the existing `/v1/*` endpoints, plus a new
`GET /v1/workspaces` (list: id, name, remote, runCount, lastRunAt).**

- No `ws` param → the sole existing workspace when there is exactly one, else
  `default`. Every current client and bookmark keeps working.
- Why query over path (`/v1/ws/:id/runs`): the serve has ~30 flat-matched
  routes (`url.pathname === '/v1/runs'` …) and the SPA fetches them from one
  `getJson` helper. A query param is resolved ONCE at the top of `fetch()`
  (one helper beside `authorized()`) and appended ONCE in `api.ts` — two
  central edits. A path prefix rewrites every route match, every UI fetch
  string, and the SSE/WS URLs, for purely cosmetic REST-shape gain. Rejected.

### 3.6 UI: the workspace switcher

Docker Desktop's context dropdown, in the shell header next to the shipped
environment badge: fed by `/v1/workspaces`, selection persisted in
localStorage (`vx-ui:workspace`) beside the existing origin/token signals,
appended to every fetch by `api.ts`. One workspace → the switcher collapses to
a static label (the zero-config local case looks exactly like today).

### 3.7 Change surface (estimate)

| Area                                                                                                                                        | Size                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| core: `run-context.ts` capture + normalization (+ salt file), `telemetry.ts` v2, `run.ts` threading, `config.ts` `name` field, tests        | **S** (~150 LOC + tests, no schema bump) |
| cloud: `IngestHub` + per-ws dirs + manifest + migration-rename, serve `ws` resolution + `/v1/workspaces` + v1 synthesis + ingest validation | **M** (~250 LOC + tests)                 |
| UI: switcher + `api.ts` param + workspaces source                                                                                           | **S–M** (~100 LOC)                       |
| vx-otel: resource-attribute mapping                                                                                                         | **S** (~15 LOC)                          |

### 3.8 Alternatives rejected (briefly)

- **Workspace columns in one DB** — forces a predicate into every metrics
  query (§3.4); loses free isolation/retention.
- **Server-assigned workspace ids (register-then-push)** — adds a handshake +
  state to a push-only contract; breaks offline/CI-first ingestion; the
  client-derived content-address needs no coordination.
- **Path-based scoping** — §3.5.
- **Explicit `workspaceId` config override** — §3.2 (rename edge).
- **Hashing the workspace root path** — different per machine; two clones of
  one repo would never share history. Defeats the point.

## 4. CI integration — three tiers

The tiers are cumulative: A works today, B collapses A's config to one URL
(existing roadmap Phase 3), C distributes execution (the Nx-Agents
equivalent). A team stops at whichever tier pays for itself.

### 4.1 Tier A — works TODAY: CI reports to the team serve; cache via Turbo wire

Prerequisites: a deployed serve (`docker run -d -p 4321:4321 -v vx-data:/data
-e VX_CLOUD_TOKEN=… vx-cloud`), the repo declares the plugin once
(committed):

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud/plugin'

export default defineWorkspace({ plugins: [cloud()] })
```

The plugin declines with no config, so this line is zero-overhead for every
dev who hasn't connected — and it is what lets CI's env vars take effect
(rung 2 of the shipped resolution ladder). The remote cache needs NO plugin —
core's `VX_REMOTE_CACHE_*` fallback ships today (any Turbo-wire server:
`ducktors/turborepo-remote-cache`, Vercel, self-hosted).

```yaml
# .github/workflows/ci.yml — Tier A, works with what is shipped today
name: ci
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx vx run ci --frozen
        env:
          # analytics → team serve (aggregates CI runs beside every dev's runs)
          VX_CLOUD_INGEST_URL: ${{ vars.VX_CLOUD_ORIGIN }}/v1/ingest
          VX_CLOUD_INGEST_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
          # cache → any Turbo-wire endpoint (separate server at this tier)
          VX_REMOTE_CACHE_URL: ${{ vars.VX_REMOTE_CACHE_URL }}
          VX_REMOTE_CACHE_TOKEN: ${{ secrets.VX_REMOTE_CACHE_TOKEN }}
```

What the team gets: every CI run and every connected dev's run in one
dashboard (branch/commit/CI provider already captured per run), warm cache
across CI runs and dev machines. The push is never-fail and 5s-bounded — a
down serve cannot fail CI. Honest costs at this tier: **two** servers (serve +
cache), **four** secrets/vars, and — until §3 lands — every repo pushing to
the same serve piles into one mixed history. Tier A is why workspace identity
is the next increment, not a nice-to-have.

### 4.2 Tier B — one URL (after the serve-hosted artifact store, Phase 3)

Phase 3 (existing roadmap) puts `/v8/artifacts` on the serve. This doc adds
the one convention that makes CI trivial: **`VX_CLOUD_URL` + `VX_CLOUD_TOKEN`
as the single-origin pair**, from which the plugin derives ingest
(`<origin>/v1/ingest`) and cache (`<origin>/v8/artifacts`). The specific vars
(`VX_CLOUD_INGEST_URL`, `VX_REMOTE_CACHE_*`) stay as overrides above it.
`connect` auto-wires the cache rung from the environment entry the same way
(resolving the open question in `cloud-client-server-2026-07.md §14` — yes,
auto-wire; `env ls` shows which capabilities the server advertises via
`/v1/meta`).

```yaml
- run: bunx vx run ci --frozen
  env:
    VX_CLOUD_URL: ${{ vars.VX_CLOUD_ORIGIN }}
    VX_CLOUD_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
```

Two settings, everything Tier A gave plus the cache, one server to operate.
This is the Nx-Cloud-grade onboarding bar: dev = `vx-cloud connect <url>`,
CI = two secrets.

### 4.3 Tier C — vx agents (the Nx-Agents equivalent)

#### 4.3.1 How Nx Agents actually works (the model to copy)

- Every agent machine has **its own checkout of the same commit** and runs the
  normal setup (install deps). **Inputs are never shipped** — same-checkout is
  the contract.
- The **main CI job** owns the run: it computes the task graph, hands it to Nx
  Cloud for distribution, renders streamed logs as if the run were local, and
  exits with the aggregate status. Agent jobs are dumb executors that exit
  when told no more work is coming.
- **Artifacts flow between agents via the remote cache** — an agent needing an
  upstream's outputs restores them by cache key; nothing is copied
  point-to-point.
- Agents are started either by the CI matrix (self-managed) or by the cloud
  (managed fleet). Cache hits short-circuit distribution — a task whose key
  already hits is never assigned.

#### 4.3.2 vx agents — the design

Same contract, built on the existing skeleton, with the serve as rendezvous:

```
main job:  vx run ci            agents (matrix): vx-cloud agent
  │  prepare graph locally               │  same checkout, same commit
  │  hash stable tasks                   │  hello {session, commitSha, token}
  ▼                                      ▼
        serve (VX_CLOUD_URL) — persistent coordinator (Phase 4)
          • matches submission ↔ agents by CI session key
          • prunes tasks whose key already hits the artifact store
          • assigns ready tasks by task id; reassigns on agent death
          • relays agent stdout/stderr → main job (WireEvents)
        serve /v8/artifacts — the artifact store (Phase 3)
          • agents save outputs here; downstream agents restore from here
```

**Decisions (each single, alternatives rejected):**

1. **The serve hosts coordination — same port, same bearer token, a
   `/v1/agents` WS path.** The standalone `vx-cloud coordinator` process (own
   port 5180, no auth, `.vx/coordinator.json` advertisement) is absorbed and
   retired. Rejected: the `distributed-ci-2026-06.md §7.1` matrix-0-hosts-it
   topology — GHA runners cannot reach each other without a tunnel
   (tailscale/ngrok), which is exactly the infrastructure vx should not
   require. Every party dials OUT to the serve over normal HTTPS/WSS egress.
   Nx Cloud is the precedent: the cloud is the rendezvous.
2. **The main job prepares; the coordinator schedules.** Today's coordinator
   builds the graph from ITS workspace — but the serve has no checkout. The
   submitter (main job) runs the normal `prepareRun` (it has the checkout),
   then submits the wire graph: nodes, edges, commands, and the predicted
   pure-input hashes for STABLE-key tasks (`deriveStableKeys` — the same gate
   remote prefetch uses). New message `coord:submit-graph`; the
   `RunRequest → serve executes run() in-process` delegation path is untouched
   and remains the non-distributed mode.
3. **Assignment key = task id; the cache key is computed by the executing
   agent.** Today's skeleton assigns by upfront hash — wrong for
   unstable-key tasks (a consumer whose input globs match an upstream's
   outputs has no honest hash until that upstream ran). Since every agent has
   an identical checkout, agents recompute hashes locally and identically.
   The coordinator still uses the submitted stable hashes for the **cache
   prune**: before assignment it probes the artifact store and marks
   already-cached tasks done without dispatching them (this is the
   "cache-aware assignment" — the Nx behavior).
4. **An agent executes an assignment as a normal scoped run where upstreams
   are warm cache hits.** This is the elegant consequence of the
   architecture: agent-side execution is core's existing `execute-task`
   pipeline with a `LayeredCache(local, serve artifact store)` — before
   running task T, each of T's upstreams restores from the shared cache
   (saved there by whichever agent ran it). No new artifact-propagation
   mechanism exists or is needed; the cache IS the transport (the reason the
   artifact store is a hard prerequisite). One correctness gate: **an agent
   awaits its remote PUT before reporting `agent:done`** — the
   background-upload optimization (CORE-3) applies to non-distributed runs
   only; here a downstream on another agent must be able to restore the
   moment readiness fires.
5. **Session rendezvous + same-commit enforcement.** Agents and the submission
   carry a session key — `VX_AGENT_SESSION` explicitly, else derived from CI
   env (`GITHUB_RUN_ID` + `GITHUB_RUN_ATTEMPT`; equivalents per provider) —
   plus the checkout's `commitSha`. The coordinator matches submission ↔
   agents by session and **refuses** an agent whose commit differs (hard
   error naming both SHAs — the same-checkout contract is enforced, not
   assumed). Dirty submitter trees refuse distribution with a clean error
   (fall back to local execution); input shipping stays out of scope.
6. **Rename `worker` → `agent`.** `vx-cloud agent --url <serve>` (URL/token
   from `VX_CLOUD_URL`/`VX_CLOUD_TOKEN` like everything else); `worker` stays
   a hidden alias for one release. "Worker" collides with worker
   pools/threads everywhere in the codebase; "agent" is the vocabulary users
   arrive with from Nx. The unreleased `worker:*` protocol family renames to
   `agent:*` in the same pass with a `DIST_PROTOCOL_VERSION` sentinel added
   (versioning rule; the current wire has none).
7. **Enablement: `VX_CLOUD_DISTRIBUTE=<n>` env (or `cloud({ distribute })`),
   no core CLI flag.** Distribution is a cloud-plugin backend concern
   (`--distribute` on core `vx run` would violate the "no core CLI for cloud"
   rule). `<n>` is advisory (expected agent count for the readiness message),
   not a gate.

**Lifecycle / failure semantics** (mostly already implemented in the skeleton
— kept, now stated as contract):

| Concern                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents joining late     | Work starts the moment the FIRST agent registers; late joiners get assignments on hello (`dispatch()` on hello — exists). No barrier: a slow matrix row delays nothing but its own capacity                                                                                                                                                                                                                                                                                                                           |
| No agents at all        | Coordinator waits up to `--agent-timeout` (default 5 min), then fails the submission loudly; the main job exits non-zero with a "0 agents joined session <key>" diagnosis                                                                                                                                                                                                                                                                                                                                             |
| Straggler / agent death | WS close re-queues that agent's in-flight tasks for reassignment (exists). Re-execution is safe — a dead task never uploaded, so no torn artifact                                                                                                                                                                                                                                                                                                                                                                     |
| Main job death          | Coordinator finishes the graph anyway (artifacts still warm the cache), then drains agents — the submitter-dies row from `distributed-ci-2026-06.md §6`, kept                                                                                                                                                                                                                                                                                                                                                         |
| End of work             | Coordinator sends `coord:drain` (exists); agents also self-terminate on `--idle-timeout` (new, default 10 min) so a crashed coordinator can't hang a paid matrix job                                                                                                                                                                                                                                                                                                                                                  |
| Failure UX              | Agent stdout/stderr stream to the coordinator (protocol exists) and are **relayed to the main job** (new — today the coordinator drops them, CLOUD-7) as WireEvents; the main job renders the normal framed output + failure replay + summary via the existing `createWireRenderer`, and exits with the aggregate status. Agents exit 0 on clean drain even when tasks failed — the main job is the single authority (Nx convention; a red matrix row means agent infrastructure broke, not "some task failed twice") |

#### 4.3.3 What changes where

| File                                            | Change                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud/src/cli/serve.ts`               | host the coordinator: `/v1/agents` WS upgrade (bearer-gated), session registry                                                                                                                                                      |
| `packages/cloud/src/cli/coordinator.ts`         | becomes the in-serve scheduler module: accepts submitted graphs (not self-prepared), session matching, cache prune via the artifact store, log relay                                                                                |
| `packages/cloud/src/cli/worker.ts` → `agent.ts` | rename; auth; per-assignment: restore upstreams → recompute hash → probe → exec → save → **await PUT** → done. Uses core's exported execute pipeline over a prepared graph instead of bare `workerExecute`                          |
| `packages/cloud/src/protocol-dist.ts`           | `agent:*` rename, `coord:submit-graph`, `DIST_PROTOCOL_VERSION`                                                                                                                                                                     |
| `packages/cloud/src/plugin.ts`                  | backend rung: `VX_CLOUD_DISTRIBUTE` → submit-graph backend instead of local                                                                                                                                                         |
| core                                            | possibly nothing; at most a small exported seam for "execute this prepared node with this cache" if the current public surface (`prepareRun` + execute path) proves insufficient — to be confirmed at implementation, kept additive |

#### 4.3.4 The workflow (Tier C)

```yaml
# .github/workflows/ci.yml — Tier C: distributed
name: ci
on: [push, pull_request]
jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx vx run ci --frozen # renders everything, owns the exit code
        env:
          VX_CLOUD_URL: ${{ vars.VX_CLOUD_ORIGIN }}
          VX_CLOUD_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
          VX_CLOUD_DISTRIBUTE: 8
  agents:
    strategy:
      matrix: { agent: [1, 2, 3, 4, 5, 6, 7, 8] }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # SAME commit — the contract
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx vx-cloud agent # session derived from GITHUB_RUN_ID
        env:
          VX_CLOUD_URL: ${{ vars.VX_CLOUD_ORIGIN }}
          VX_CLOUD_TOKEN: ${{ secrets.VX_CLOUD_TOKEN }}
```

No tunnels, no matrix-index election, no new action to maintain at v1 (a
composite action is sugar that can come later). GitLab/Buildkite shapes are
the same two job definitions.

#### 4.3.5 The dependency chain — honest

```
Phase 3: artifact store on serve          (artifacts have somewhere shared to live)
   ↓
agent cache participation                  (agents can save/restore — the transport)
   ↓
Phase 4: persistent coordinator on serve   (sessions, submitted graphs, auth, relay)
   ↓
Phase 5: vx agents (Tier C)                (rename + agent exec pipeline + GHA recipe)
```

Agents without the artifact store are strictly worse than one big runner: no
outputs would propagate between machines. Anyone asking "why not agents next"
gets this chain as the answer. Real engineering cost across the chain: **L +
L** (two multi-week increments after Phase 3), plus a real-CI testbed —
distributed-ci Phase C's honest blocker — before it can be called shipped.

## 5. The dev flows catalog — end to end

The owner-facing answer. Legend: ✅ shipped today · P*n* = delivered by unified
phase _n_ (§7).

| Flow                        | User types                                                                                                                          | What happens / what they see                                                                                                                                   | Status                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| (a) Solo dev, zero config   | `vx run build`                                                                                                                      | local run, local cache, framed output. No cloud code executes (plugins decline; zero-overhead invariant)                                                       | ✅                                                 |
| (b) Solo dev + dashboard    | `vx-cloud serve --ui` once, then plain `vx run …`                                                                                   | serve advertises per-user; the `cloud()` plugin auto-detects and pushes every run; dashboard at `:4321` fills in live                                          | ✅ (needs `cloud()` declared in `vx.workspace.ts`) |
| (c) Team server, many repos | ops: `docker run … vx-cloud serve` · each dev, once: `vx-cloud connect https://vx.corp --token …` · then plain `vx run` in ANY repo | every run pushes to the team serve with a workspace identity; dashboard has a workspace switcher; `vx-cloud env ls` shows the connection                       | connect ✅ · multi-workspace **P2a**               |
| (d) CI, plain               | Tier A YAML (§4.1) — 4 vars, or Tier B (§4.2) — 2 vars                                                                              | CI runs aggregate beside dev runs (branch/commit/provider recorded); remote cache warms CI + dev; run URL printed in the CI log                                | Tier A ✅ · deep link **P2a** · Tier B **P3**      |
| (e) Distributed CI (agents) | Tier C YAML (§4.3.4) — main job + agent matrix                                                                                      | graph fans out across N agents; cache-hits never dispatched; outputs flow via the artifact store; main job renders one normal vx output and owns the exit code | **P5** (chain: P3 → P4 → P5)                       |
| (f) OTel / native export    | declare `otel()` beside `cloud()` in `vx.workspace.ts`; set `OTEL_EXPORTER_OTLP_ENDPOINT`                                           | traces/metrics to any OTLP collector IN PARALLEL with the cloud push; flushes run concurrently; either declines independently                                  | ✅ (workspace attrs **P2a**)                       |

Narratives, one line each:

- **(a)** The floor is sacred: nothing in this roadmap adds a millisecond to
  the plain run. Every flow below is opt-in layers above it.
- **(b)** The "Docker Desktop" flow — one command, then forget it. The serve's
  per-user advertisement means any workspace on the machine reports in.
- **(c)** The "docker context" flow. `connect` once per machine; tokens live
  in the 0600 environments file; `env use staging` switches servers exactly
  like contexts. P2a makes the server genuinely multi-repo instead of a
  single mixed pool.
- **(d)** CI is deliberately env-var-only (no `connect` on ephemeral runners —
  rung 2 of the shipped ladder exists precisely for this). Tier B collapses
  the config to two values.
- **(e)** The Nx-Agents flow with no Nx Cloud bill: the serve you already
  deployed is the rendezvous, the cache you already have is the artifact
  transport, the matrix you already understand is the fleet.
- **(f)** Nothing here forks the telemetry contract: OTel, HTTP push, and
  cloud ingest all read the same versioned records.

## 6. Gaps this surfaces beyond the existing roadmap

Surfaced by writing §4–5, worth naming; each is either folded into a phase or
explicitly declared out of scope:

| Gap                                                                                                                                          | Disposition                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Serve multi-workspace UI (switcher, `/v1/workspaces`)                                                                                        | **P2a** (§3.6)                                                                                                       |
| Run-detail deep links from CI logs — after a successful push in CI, the sink prints `→ <origin>/#/runs/<runId>?ws=<id>` (one line, CI-gated) | **P2a** — trivial once the id exists; the single highest-leverage DX line in the CI story                            |
| `VX_CLOUD_URL` single-origin convention + `connect` auto-wiring the cache rung                                                               | **P3** (§4.2)                                                                                                        |
| Ingest schema-version gate + shape validation (CLOUD-9)                                                                                      | **P2a** (rides the v2 acceptance logic, §3.3)                                                                        |
| GitHub **PR-comment / job-summary** run reports (the Nx Cloud PR comment)                                                                    | **Roadmap-only note.** Needs GitHub App/token plumbing + per-provider formatting; the deep link delivers 80% free    |
| Server-side workspace merge/rename admin verbs                                                                                               | **Out of scope.** Rename splits are visible and rare (§3.2); revisit only on real demand                             |
| Agent pool **autoscaling** / vx-managed runner fleets (Nx Agents' hosted half)                                                               | **Out of scope.** CI matrix and k8s HPA own agent lifecycle; vx owns task assignment. vx does not manage machines    |
| Flaky-test detection / automatic re-runs (Nx Cloud feature)                                                                                  | **Out of scope** for this arc; `/v1/flakiness` analytics already exist read-only                                     |
| Input shipping (dirty trees / untrusted agents)                                                                                              | **Out of scope**, permanently fenced to old Phase 5/§3.3 CAS design. Same-checkout is the Tier C contract, like Nx   |
| Multi-tenancy / org tokens / per-workspace ACLs                                                                                              | **Out of scope.** One bearer = whole server; workspaces are namespaces, not security boundaries (documented as such) |

## 7. Unified phasing

Extends `cloud-client-server-2026-07.md`'s numbering (no fork; its Phase 2 is
split into 2a/2b with an explicit ordering argument, later phases keep their
names and absorb this doc's additions):

| Phase  | Ships                                                                                                                                                                                                                                  | Effort | Status / order rationale                                                                                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**  | environments + connect + auth + `/v1/meta` + UI badge                                                                                                                                                                                  | —      | **SHIPPED** (2026-07-02, `57fb617`)                                                                                                                                                  |
| **2a** | **Workspace identity** — telemetry v2 + compat rule, per-workspace ingest stores + `$XDG_DATA_HOME` root, `?ws=` scoping + `/v1/workspaces`, UI switcher, ingest validation (CLOUD-9), CI deep-link line, otel attrs                   | **M**  | **NEXT.** Before everything else that writes into the store: records ingested without identity can never be retro-attributed, and 2b's self-ingested runs must speak v2 from day one |
| **2b** | Delegation coherence — serve self-ingest (`RunOptions.telemetrySinks`, the one small core seam) + backend local auto-detect (cost-gated)                                                                                               | M      | after 2a; unchanged from the prior doc otherwise                                                                                                                                     |
| **3**  | Serve-hosted artifact store (`/v8/artifacts`, Turbo wire, CAS/volume) + `VX_CLOUD_URL` single-origin convention + `connect` cache auto-wire → **CI Tier B**                                                                            | L      | unchanged scope + the Tier B conventions from §4.2                                                                                                                                   |
| **4**  | Persistent coordinator **hosted in serve** (same port/token): session registry, submitted-graph protocol (`coord:submit-graph`, `DIST_PROTOCOL_VERSION`), cache-prune assignment, log relay; standalone `vx-cloud coordinator` retired | L      | reframed from "own design doc someday" to the concrete §4.3 scope; still deserves its own implementation review                                                                      |
| **5**  | **vx agents (CI Tier C)** — `worker`→`agent` rename + auth, agent-side execute pipeline with cache participation (await-PUT gate), idle/agent timeouts, main-job rendering + aggregate exit, GHA recipe + docs, real-CI testbed        | L      | depends 3 + 4 (§4.3.5); replaces the old "Phase 5: CAS input shipping" slot                                                                                                          |
| **6**  | CAS input shipping + multi-tenancy (renumbered from old Phase 5)                                                                                                                                                                       | XL     | far; unchanged scope, explicitly NOT a Tier C prerequisite                                                                                                                           |

## 8. Why this is the right move

- **It finishes the analogy the owner keeps reaching for instead of vaguely
  gesturing at it** — the §2 table shows exactly which Docker rows are done
  (daemon, CLI, contexts, auth) and reduces everything missing to two
  concrete items: workspace identity and serve-hosted artifacts/coordination.
- **Workspace identity is small, unblocks everything, and gets cheaper never**
  — every phase after it writes records into the store; shipping it first
  (~S core + M cloud, no schema/cache-version bumps in core) means no mixed
  un-attributable history to regret. It is also the standing P1 audit finding.
- **The CI story ships value at every tier** — Tier A is pure documentation of
  what works today; Tier B is two env vars on an already-planned phase; only
  Tier C needs real new engineering, and its dependency chain is stated
  honestly rather than sold as adjacent.
- **The agents design copies the proven contract (Nx) onto parts vx already
  has** — same-checkout instead of input shipping, the cache as the artifact
  transport instead of a new protocol, the serve as rendezvous instead of CI
  tunnels, and reassignment/drain logic that already exists in the skeleton.
  The delta is scheduling + relay + agent-side cache use, not a platform.
- **The zero-overhead floor survives every row** — all of this lives behind
  the plugin capabilities and env/environment rungs; a plain `vx run` with no
  cloud config still declines in one memoized fs read.

## 9. Open questions

- **Agent-side execution seam.** Whether core's current public surface
  (`prepareRun` + the execute pipeline) suffices for "execute this prepared
  node with this cache, upstreams assumed warm," or a small additive export is
  needed — confirm at Phase 5 implementation; keep it additive either way.
- **Workspace list growth on a long-lived serve** — dozens of dead workspaces
  (renames, experiments) clutter the switcher. Lean: `lastSeenAt` sort +
  a `vx-cloud serve` admin prune later; not a P2a blocker.
- **`default` workspace naming** — synthesized v1 pushes land in `default`;
  should the serve warn per-push or once? Lean: once per source IP per boot.
- **Tier C on non-GitHub providers** — session-key derivation per provider
  (GitLab `CI_PIPELINE_ID`, Buildkite `BUILDKITE_BUILD_ID`) is table-stakes;
  the explicit `VX_AGENT_SESSION` override is the universal escape hatch.
  Verify the matrix per provider when Phase 5 lands.
- **Composite action** (`vznjs/vx-agents-action`) — sugar over the two-job
  YAML. Decide after the raw recipe proves itself on the real-CI testbed.

## 10. Addendum (2026-07-02) — owner refinement: run vs schedule, local transport, AI access

Owner (verbatim intent): projects RUN tasks or SCHEDULE tasks (scheduled =
sent to the server, awaiting results); the runner connects to a server and
reports; locally both local and remote execution mix; `vx-cloud agent`
registers with a workspace + context id so the server distributes scheduled
work and streams it back into the main run — "exactly like DTE in Nx".
Locally, connect over a Unix socket like docker. Always-available live
reports/visualizations/logs/inspection; local must work without deploying
(one command, or docker); flexible, non-blocking, perf first; AI agents must
connect easily to manage and debug.

### 10.1 Run vs schedule — the seam is the backend, not the task schema

vx already has exactly one seam whose contract is "send work elsewhere,
stream events back, await the result": `RunBackend` (`RunRequest` →
`WireEvent` stream → `RunResult`). DTE slots in as a third backend behavior,
not a new task-level concept:

| Mode              | Who executes                                                                                            | Exists                  |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------- |
| local             | in-process scheduler                                                                                    | shipped                 |
| delegated         | the serve executes the whole run                                                                        | shipped (WS delegation) |
| distributed (DTE) | the serve's coordinator places each task on session agents; results stream back into the submitting run | Phase 5 (§4.3)          |

Two clarifications the refinement adds to §4.3:

- **The submitting runner is itself an agent.** On `--distribute` the main
  run registers in its own session, so the coordinator can place tasks on it
  too — "locally both local and remote are used" falls out of the model
  instead of being a special case (Nx does the same: the main CI job
  executes tasks alongside agents).
- **Registration is `{workspaceId, session, commitSha}`** — workspace
  identity (§3) plus the context id. The coordinator only pairs a submission
  with agents that match all three; a same-workspace agent on a different
  commit is refused loudly (§4.3's hard rule), and a different workspace
  never sees the work.

Deliberately NOT a per-task `schedule:` config field. The unit of
distribution is the run; placement per task is the coordinator's decision
(cache-aware — a warm task executes nowhere). If a real need appears to pin
a task to the submitter (local secrets, devices), a one-field
`distribute: false` hint is a trivial later addendum; minimum-parts says
don't pre-build it.

### 10.2 Unix socket — docker-parity local transport (option, not default)

Adopt in Phase 2 as `vx-cloud serve --socket` (default path
`$XDG_RUNTIME_DIR/vx-cloud/serve.sock`, mode 0600): Bun.serve binds unix
sockets natively and Bun's fetch dials them (`{ unix }`), so the plugin/CLI
client cost is one transport branch. What it buys locally: OS-enforced
same-user access (stronger than open localhost TCP — no token needed, no
port to leak onto a LAN) and zero port conflicts for parallel CI runners on
one box. What it cannot buy: the browser dashboard — browsers don't speak
unix sockets, so the serve keeps its TCP listener for the UI regardless.
Consequence: the socket is the hardened side-channel for CLI/plugin/agent
traffic; TCP:4321 stays the default because one URL for everything (UI +
API) is the simpler DX. The serve-info advertisement gains a `socket` field
beside `origin`; the plugin's local rung prefers it when present.

### 10.3 AI agents — MCP on the serve

Core already ships `vx mcp` (stdio, workspace-local introspection). The
serve grows the networked counterpart: an MCP endpoint (streamable HTTP at
`/mcp`, behind the same bearer gate as `/v1/*`) exposing exactly what the
dashboard reads — list workspaces / runs / invocations, run detail with
per-task outcomes, task logs, why-did-this-rerun input diff, cache stats,
the task graph, and (where a workspace is colocated or delegation is
enabled) trigger-and-watch a run. Implementation is a thin adapter over the
existing `/v1` handlers — they already return JSON shaped for consumption.
This makes the serve the AI-visible control plane: point Claude Code or any
MCP client at `http://localhost:4321/mcp` (or a connected environment's URL

- token) and an agent can inspect, compare, debug, and kick runs, locally or
  against the team server. Phase 2, independent of self-ingest, ~150 LOC.

### 10.4 The simplification answer

The "or simpler?" question resolves to: the simple thing already exists and
this design adds no ceremony to it. One command — `vx-cloud serve --ui` —
is the full local experience (live cockpit, graphs, flamegraphs, logs,
history), auto-detected by every `vx run` with zero config. Docker/Helm is
the same binary when a team wants it deployed; `connect` switches between
local and remote without changing anything else. Live access to reports,
visualizations, logs, and inspection is therefore ALWAYS available at
whichever serve the precedence ladder resolves — the flexibility the
directive asks for is the ladder, not a new mode.

### 10.5 Phasing deltas

- Phase 2 gains **2c: unix-socket transport option** (serve `--socket` +
  serve-info field + plugin/CLI dial support).
- Phase 2 gains **2d: MCP on the serve** (independent of 2a self-ingest;
  can land first).
- Phase 5 language fixed: the submitting runner self-registers as a session
  agent, and agent registration is keyed `{workspaceId, session, commitSha}`.
