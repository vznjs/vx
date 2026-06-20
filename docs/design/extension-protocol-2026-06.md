# Extension protocol — third-party tooling on top of vx

Status: proposal (2026-06-20). Builds on `event-stream-2026-06.md`
(`WireEvent` + devframe surface), `execution-service-2026-06.md`
(backend protocol), and the `vx serve` / `vx dev` plumbing already
shipped.

## 1. The pitch

vx becomes a **platform**. Third parties (developers, agents, vendors,
IDE plugins, dashboards) write small programs that consume the vx
event stream and/or talk to a vx service. We define a typed, versioned
**extension API** so that a 3rd-party tool written today still works
tomorrow. The bar: writing a useful vx extension should take 30
minutes and 50 lines of code.

This is what unlocks the "openness vs nx and turbo" story. Turbo
exposes nothing programmatic. Nx exposes a plugin API but it's tied
to their TS runtime + executor schema. vx exposes a **wire protocol**
+ a small SDK that targets the wire — language-agnostic, transport-
agnostic, no Bun lock-in for consumers.

## 2. Three roles for extensions

Every extension fits one of three roles, distinguished by *what data
flows in which direction*:

### 2.1 Subscriber — read-only consumer of the event stream

The simplest case. Connects to `vx serve` (or a `vx run` with
`--ui`), subscribes to the `vx:events` channel, observes everything.
Doesn't write back.

Use cases:
- **Custom CI annotators**: a tool that posts `run:end` summaries to
  Slack with custom formatting.
- **Cost trackers**: tally CPU-minutes per task across the team.
- **Notification systems**: ping the dev when their long-running CI
  job finishes.
- **Custom UIs**: a phone app that shows team build health.

API surface: just the WireEvent stream + (optionally) the reduced
`RunState`. Today's `vx:run` shared state already exposes this.
Subscribers connect, read, exit. **Read-only — they cannot disrupt
the run.**

### 2.2 Inspector — read-only RPC consumer

A subscriber, but instead of subscribing to a live stream, makes
typed RPC queries against vx state:
- `getRunState(runId)` → `RunState`
- `getRunHistory(filter)` → `Run[]` (uses the `vx-cloud` data model)
- `getTaskLogs(runId, taskId)` → `string`
- `getCacheStats(scope)` → `{ entries, sizeBytes, hitRate24h }`
- `explainCacheKey(taskId)` → `{ files, env, config, upstream }`
- `whyDidThisRerun(runId, taskId)` → `{ changedInputs: string[] }`

These power agent-facing UIs (an LLM asking "why is this slow")
and IDE plugins ("show me cache hit rate for the file I'm editing").

### 2.3 Driver — write-capable submitter

A driver *submits work* to vx. Use cases:
- **Custom dispatchers**: a tool that watches GitHub PR comments and
  submits `vx run pr-validate` on `/test` commands.
- **AI agents**: an autonomous coding agent that submits builds
  during exploration.
- **Build-on-save IDE features**: editor saves trigger a
  task-specific vx run.

Drivers go through the same `RunBackend` protocol the local CLI uses
— `RunRequest` in, `WireEvent` stream + `RunResult` out. Permissions
are checked at the service boundary (auth tokens).

## 3. The wire (the only thing that matters)

vx commits to **one wire protocol per service**, versioned:

```ts
// 1. vx:events — the event stream (subscribers + inspectors + drivers)
type WireEvent = …            // already shipped in events.ts

// 2. vx:run — the reduced shared state
type RunState = …             // already shipped in run-state.ts

// 3. vx:rpc — typed inspector RPCs
type RpcRequest =
  | { method: 'getRunState'; runId: string }
  | { method: 'getRunHistory'; filter: HistoryFilter }
  | { method: 'getCacheStats'; scope: 'all' | { project: string } }
  | { method: 'explainCacheKey'; taskId: string }
  | { method: 'whyDidThisRerun'; runId: string; taskId: string }
  | { method: 'getTaskLogs'; runId: string; taskId: string }

// 4. vx:submit — driver protocol
type SubmitRequest = RunRequest   // already shipped in protocol.ts
type SubmitResponse =             // streamed
  | { kind: 'event'; event: WireEvent }
  | { kind: 'result'; result: RunResult }
```

The transport is **WebSocket + birpc + valibot** (we already pulled
this in via devframe). The schemas live in `src/orchestrator/
protocol.ts` and are *the* version-controlled artifact — everything
else is implementation.

### 3.1 Versioning

A `vx serve` exposes its protocol version on `/version`. Clients
negotiate: a v1.2 client connecting to a v1.5 server uses v1.2; a
v1.5 client connecting to a v1.2 server uses v1.2 (downgrade). When
a major version bumps (v1 → v2), the old endpoint stays alive at
`/v1/*` for one minor release of the new version. SemVer for wire
protocols.

### 3.2 Auth

Local: no auth (loopback). Hosted/remote: bearer token in the WS
handshake. The vx-cloud proposal (`vx-cloud-2026-06.md`) defines the
token model; extension protocol *uses* it.

## 4. The SDK

We publish three thin SDKs (more on demand):

### 4.1 `@vzn/vx-client` (TypeScript / Bun + Node)

```ts
import { connect } from '@vzn/vx-client'

const vx = await connect('ws://localhost:5176')   // local vx serve

// Subscriber
for await (const event of vx.events()) {
  if (event.kind === 'task:complete') {
    console.log(`${event.taskId}: ${event.outcome.status}`)
  }
}

// Inspector
const stats = await vx.rpc('getCacheStats', { scope: 'all' })

// Driver
const run = vx.submit({ tasks: ['build'] })
for await (const ev of run.events) { … }
const result = await run.result
```

### 4.2 `@vzn/vx-client-py` (Python)

Same API shape, async. Targets data-science / ops use cases — a
Python notebook tracking build trends.

### 4.3 `vx-client` (CLI helper)

```bash
$ vx events --tail
{ "kind": "task:start", "taskId": "pkg-a#build", ... }
$ vx rpc getCacheStats --scope all
{ "entries": 1234, "sizeBytes": 5e8, "hitRate24h": 0.84 }
```

Shell scripts and `jq`-pipelined dashboards. The escape hatch.

## 5. Plugin model (in-process extensions)

A class of extension *runs in the same process as `vx run`* — it
observes the run from inside the host, doesn't go over a wire. Use
case: a config-side hook ("run `npm audit` after every install
task," "annotate every task with cost data," "send failures to
Sentry"). Today these would require modifying vx core.

We expose plugins via the existing `defineWorkspace` config:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { sentryPlugin } from '@vzn/vx-plugin-sentry'
import { costTracker } from './plugins/cost-tracker'

export default defineWorkspace({
  plugins: [
    sentryPlugin({ dsn: process.env.SENTRY_DSN }),
    costTracker({ ratePerCpuMin: 0.0001 }),
  ],
})
```

A `Plugin` is just an in-process subscriber to the bus:

```ts
type Plugin = {
  name: string
  setup(ctx: PluginContext): void | Promise<void>
}

type PluginContext = {
  on(event: 'run:start' | 'task:complete' | …, handler: (event) => void): void
  rpc: RpcServer                      // a plugin can also expose RPCs (next §)
  workspaceRoot: string
  cacheDir: string
}
```

This is *exactly* what `terminalSubscriber` is today, generalized to
allow N subscribers from config. The terminal renderer becomes the
first built-in plugin; user plugins layer on top.

**Plugins cannot block the run.** Same backpressure rule as the
event stream — a plugin's queue is bounded; a wedged plugin loses
lossy events, never blocks producers. (Mechanism is already built;
we extend it to N subscribers.)

## 6. RPC plugins — extending the inspector surface

A plugin can also *register* RPC methods, exposing them on
`vx:rpc`:

```ts
const myPlugin: Plugin = {
  name: 'cost-tracker',
  setup(ctx) {
    ctx.rpc.register('getCostReport', async ({ since, until }) => {
      const events = await ctx.history.events({ since, until })
      return computeCost(events)
    })
  },
}
```

Now `vx rpc getCostReport --since 2026-06-01` works. The cost
tracker becomes a first-class introspection target — IDEs, agents,
shell scripts all see it the same way.

This is the **open-platform** payoff: any team can extend vx's
introspection surface without touching core. The MCP server we ship
(for AI agents) is itself a plugin.

## 7. The agent surface (special case)

LLM-based coding agents are first-class users. A plugin exposing
`vx:mcp` (MCP server adapter, already on the roadmap from
`event-stream-2026-06.md`) gives agents typed tools:

- `runTasks(tasks: string[]) → RunResult`
- `getRunStatus() → RunState`
- `tailTask(id: string) → ReadableStream<string>`
- `whyDidThisRerun(taskId) → { changedInputs: string[] }`
- `explainCacheKey(taskId) → CacheKeyComponents`
- `runHistory(project, task, n=20) → Run[]`

Agents use these instead of shelling out + parsing terminal output.
This is **agent-native ergonomics** — most build tools today force
agents to scrape ANSI; we give them a typed surface.

## 8. Discovery — how a plugin gets loaded

`defineWorkspace.plugins` is the canonical source. Plugins:
1. Resolve as ordinary npm/Bun packages: `import { foo } from
   '@vendor/vx-plugin-foo'`.
2. Get a chance to validate the workspace before the run starts
   (return a `UserError` to abort with a clean message).
3. Get instantiated *once per `vx run`* — same lifetime as the bus.

For *cloud-deployed* extensions (a subscriber running in a SaaS), we
provide an OPT-IN registration: `vx insights link --org acme`
registers the local insights uploader with the cloud, so every local
run uploads. This is the connection between in-process plugins and
the hosted face — they layer.

## 9. Three example extensions we ship as reference

To prove the API + force-test it:

### 9.1 `@vzn/vx-plugin-sentry`

Forwards `task:complete` events with `status === 'failed'` to Sentry
as exceptions. ~50 lines.

### 9.2 `@vzn/vx-plugin-slack`

Posts a `run:end` summary to a Slack channel. Configurable template,
threshold (only post if duration > X), and channels per branch.
~80 lines.

### 9.3 `@vzn/vx-plugin-influx`

Streams every `task:complete` to InfluxDB. Powers a Grafana
dashboard. ~30 lines (mostly tag-mapping).

Each ships in this repo under `packages/plugin-*`. They double as
documentation and as smoke tests for the API surface.

## 10. Performance bar

- Plugin emit overhead per event: **< 10µs in-process**, dominated by
  the bounded-queue enqueue.
- WS subscription: **< 1ms per event** at p99 from emit to
  subscriber receive (localhost).
- RPC: **< 5ms p99** for trivial methods.
- A plugin that throws on every event loses its connection (we drop
  it) within 100ms; the run is unaffected (the safe-observer pattern
  from the deleted Observer subsystem revived).

The performance contract: **subscribers cannot slow the run**. If a
subscriber falls behind, it loses events. The producer never waits.
This is the inverse of the philosophy that broke the deleted TUI
three times — and the lesson directly informs this design.

## 11. Phasing

| Phase | Ships                                                                                                                                       | Validates                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **A** | `@vzn/vx-client` (TS SDK). Connects to existing `vx serve` and consumes `vx:events`. Documented. The subscriber role is real.               | One-direction streaming API works.                         |
| **B** | RPC server in `vx serve`. Inspector role with 4-5 built-in methods (`getCacheStats`, `getRunHistory`, `explainCacheKey`, …).               | Read-only typed queries work.                              |
| **C** | Driver role — clients submit runs via SDK. Same code path as the existing serviceBackend, exposed publicly.                                  | Hosted + agent use cases unlocked.                         |
| **D** | In-process Plugin API on `defineWorkspace`. The bus exposes itself to user code.                                                            | Custom in-process extensions work.                         |
| **E** | RPC plugins — third-party RPCs on top. `@vzn/vx-plugin-sentry|slack|influx` reference impls.                                                | Open-platform story complete.                              |
| **F** | Python SDK + the `vx-client` CLI helper. Language coverage.                                                                                 | Cross-runtime is real.                                     |
| **G** | MCP adapter for agents. (Already on the `event-stream` roadmap as Phase 4.)                                                                | Agent-native ergonomics shipped.                           |

Phase A is small — the SDK is a thin wrapper on existing primitives.
Each subsequent phase adds value without breaking the previous.

## 12. Non-goals

- **A general-purpose plugin sandbox.** In-process plugins run with
  the same trust as `vx.workspace.ts` — same module-loading
  semantics, same access. If you import an untrusted plugin, that's
  on you. Same model as Webpack/Vite plugins.
- **A marketplace.** We have npm. Plugins live there.
- **Backwards compat into perpetuity.** SemVer the wire; major
  versions break, minor versions don't.
- **Custom executors / pluggable task runtimes.** Shell is the API
  (existing principle). Plugins observe and submit; they don't
  redefine what executing a task means.

## 13. Open questions

- **Multi-version plugin loading.** What happens when two plugins
  depend on different vx versions? Plugins are *compiled against* a
  vx API version; the host runtime negotiates. Today's npm peer-dep
  model is sufficient.
- **Plugin order.** Plugins see events in the order they're declared
  in config. For RPC methods, last-registration-wins (with a
  warning logged). Deterministic.
- **Error model.** A plugin's `setup()` throwing is a `UserError` —
  aborts the run with a clean message naming the plugin. A
  per-event handler throwing is caught + logged + the plugin keeps
  receiving events (same safe-observer pattern). After N throws,
  the plugin is disabled for the run (and we report it).

## 14. The architectural reason this works

The thing that makes vx extensible — and makes it different from
Turbo/Nx — is that **every internal call has been refactored through
the event stream**. The terminal renderer is a subscriber. The
devframe surface is a subscriber. The insights uploader is a
subscriber. The cloud event ingester is a subscriber.

Once the producer fires events to a bus, adding the N+1th subscriber
is free. The protocol IS the SDK. We don't have to choose between
"build a great CLI" and "build a great platform" — they're the same
thing, viewed through different subscribers.

This is the payoff of the event-stream refactor (Phase 1a/1b
already shipped). Extensions are the harvest.
