# Core / cloud split + plugin-based extension points — design

> **Status:** proposal (2026-06-27)
>
> **Supersedes / updates:**
>
> - **Updates** `execution-service-2026-06.md` — its `RunBackend` / `resolveBackend` foundation is promoted from a hardcoded env-probe in core to a plugin-resolved interface, and `vx serve` moves to `@vzn/vx-cloud`. The roadmap items it deferred (in-flight dedup, one global scheduler, persistent coordinator) are now explicitly owned by the cloud package's later phases.
> - **Updates** `extension-protocol-2026-06.md` — its observe-only in-process `Plugin` (`{ name, setup(ctx) }`) is **widened** to a three-capability `VxPlugin` (`backend? | cache? | eventSink?`). The existing `setup`/bus-subscriber model becomes the `eventSink` capability; nothing it shipped is removed.
> - **Re-reverses** `vx-cloud-2026-06.md` in a way consistent with that doc's own 2026-06-21 superseding directive. That doc was killed because cloud was "exactly the same as `vx serve` … runs in Docker, not a separate Cloudflare stack." The owner now wants a **separate package** — but **Bun + Docker**, NOT Cloudflare. This is the same runtime/Docker decision, plus a clean package + plugin boundary. The deleted `apps/cloud/` (Cloudflare/D1/R2) stays dead; `@vzn/vx-cloud` is a Bun service.
> - **Updates** `distributed-ci-2026-06.md` — its coordinator/worker code (`src/cli/coordinator.ts`, `worker.ts`, the `worker:*`/`coord:*` protocol families) moves wholesale to `@vzn/vx-cloud`. Its §9.3 sparse-clone / signed-manifest input-shipping sketch is the basis for the optional blob-CAS input-shipping phase here.

## 1. What we're solving

`@vzn/vx` has grown three categories of code that are conceptually "the service layer" but physically live inside core:

1. **A run-submission service** — `vx serve` (`src/cli/serve.ts`, 619 lines), its WS run submission, its `/v1/*` metrics HTTP surface, the run-cockpit `/v1/graph` planner endpoint, plus the embedded dashboard SPA (`apps/ui`).
2. **A distributed-execution cluster** — `vx coordinator` (`src/cli/coordinator.ts`) + `vx run --worker` (`src/cli/worker.ts`) + their orchestrator helpers (`coordinator-prepare.ts`, `worker-exec.ts`) + the `worker:*`/`coord:*`/`task:assign` protocol families in `protocol.ts`.
3. **A metrics/analytics query layer** — `src/orchestrator/metrics.ts` (the entire `/v1/*` SQL surface, re-exported through `orchestrator/index.ts:80-129`).

None of this is needed for a `vx run` on a laptop or in CI. It bloats core's surface, couples core's CLI to a service it shouldn't own, and — most importantly — bakes three integration decisions into core as **hardcoded hooks** that a third party cannot replace:

- **Run backend selection** is hardcoded in `src/cli/backend.ts:119-136`: `resolveBackend` reads `VX_SERVICE_URL`, probes `.vx/serve.json`, and otherwise returns `localBackend()`. The decision "where does work route" is wired into core with vx-cloud-specific knowledge (the serve info-file convention).
- **Remote cache configuration** is hardcoded in `src/orchestrator/remote-cache-setup.ts:22-49`: `wrapWithRemoteCache` reads six `VX_REMOTE_CACHE_*` env vars and constructs a `LayeredCache(local, new RemoteCache(...))`. The cache topology is fixed at one Turbo-wire HTTP client.
- **Event observability** is half-inverted: the bus (`src/orchestrator/events.ts`) already fans out to subscribers, and an in-process `Plugin` (`src/orchestrator/plugin.ts`) can observe it — but OTel export is hardcoded in core (`otel-emit.ts`, attached unconditionally in `run.ts:63-66`), and there is no typed way for a plugin to **upload** events to an external sink as a first-class capability.

**The owner's decision** (gathered across several messages):

- **Two packages**: `@vzn/vx` (core) + `@vzn/vx-cloud` (orchestrator service). Cloud runs **locally OR hosted** — same artifact; roles collapse into one process locally, a coordinator + scalable worker fleet when hosted (Docker / k8s / Helm).
- **Cloud integrates via a PLUGIN.** Core exposes three extension points; `vx-cloud` is the first-party plugin; anyone can write a different one. **Dependency direction is `cloud → core`, never the reverse. Core names no specific plugin.**
- **Three extension points**, inverting today's hardcoded hooks: (1) run **backend**, (2) **cache layer**, (3) **event sink**.
- **Plugins are config-declared** in `vx.workspace.ts` via `defineWorkspace({ plugins: [...] })` — explicit, typed, no auto-discovery (Architecture principle #1, "explicit over magical").
- **No CLI from plugins.** Core's CLI stays limited (`run/watch/lock/migrate/show/info/cache`); `vx-cloud` has its own CLI (`serve/coordinator/worker/login/…`). The plugin surface contributes no subcommands.
- **Optional orchestration.** Routing execution to cloud workers is opt-in via the backend plugin; **core defaults to local in-process and never requires cloud.**
- **Honor Architecture principle #3** ("Shell is the API … no executor plugin protocol"): plugins hook **run-level infrastructure** (where work routes / which cache / who observes), **never how a task executes.** Tasks stay shell strings. Surface is minimal: `backend | cache | eventSink` (+ optional `setup`/`teardown`).

This doc resolves the five open questions, specifies the `VxPlugin` interface and core's public library API, gives the exact file-move plan, the "local or hosted" shape for `@vzn/vx-cloud`, the cross-package boundary guard, and a phasing that keeps `bun src/bin.ts run ci` green at every step.

## 2. Access pattern — what actually gets called

Before reaching for packaging, the operative question is: at each of the three seams, _what gets invoked, how often, with what?_

| Seam           | Call site                                                                                                                               | Frequency              | Payload                                                                      | Today's coupling                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **backend**    | `cli/run.ts:430` → `resolveBackend(cwd)` → `backend.run(request)`                                                                       | once per `vx run`      | `RunRequest` (`protocol.ts:16`), serializable                                | env probe + `.vx/serve.json` baked into `cli/backend.ts`                                |
| **cache**      | `prepare.ts:200` → `wrapWithRemoteCache(localCache, log, policy)` → returns a `CacheLayer`                                              | once per `prepareRun`  | `Cache` (local) + `CachePolicy`; per-task `get`/`save`/`prefetch` at runtime | six `VX_REMOTE_CACHE_*` env vars + `new RemoteCache` baked into `remote-cache-setup.ts` |
| **event sink** | `run.ts:54-55` `bus.subscribe(terminalSubscriber(sink))`; `run.ts:63` `attachOtelEmit(bus)`; `run.ts:89` `installPlugins({ ..., bus })` | every event, every run | `WireEvent` (serializable) / `RunEvent` (live refs)                          | OTel hardcoded; plugins observe-only via bus                                            |

The critical observations:

1. **The backend seam already takes a serializable `RunRequest` and returns a `RunResult`.** The interface (`RunBackend`, `backend.ts:30-32`) is already clean. What's hardcoded is only _which_ backend `resolveBackend` picks. Inverting this is cheap.
2. **The cache seam already returns a `CacheLayer` interface** (`cache.ts:355`), and `LayeredCache` already composes a local `Cache` with any `RemoteCache`. What's hardcoded is only _how_ the remote layer is constructed (the env-var reading). The orchestrator never knows the difference — `prepare.ts:200` just gets back "a `CacheLayer`."
3. **The event seam is already a bus** (`events.ts:47`), already fans out to N subscribers with crash isolation (`events.ts:63-69`), and already loads config-declared plugins (`run.ts:87-100`). It is the _most_ inverted of the three. The work is widening `Plugin` from observe-only to "can also be a sink that uploads," which is mostly type work.

This is why the split is feasible without a rewrite: **two of the three seams are already interfaces; only their selection logic is hardcoded.** The design is "invert the selection, not the interface."

## 3. Open questions — resolved

### 3.1 Repo layout

**Options:**

- **(a)** Core stays at root `.`; add `packages/cloud` (and reuse the existing root `apps/*` glob, or add `packages/*`).
- **(b)** Symmetric `packages/vx` (core moves) + `packages/cloud`.
- **(c) [middle path]** Core stays at root `.`; cloud lives at `apps/cloud` (the `apps/*` glob already exists in root `package.json:25-28`); the `apps/ui` dashboard stays where it is and is consumed by `apps/cloud` as a workspace dependency.

**The load-bearing constraint:** the root `"."` workspace member is not cosmetic. `loadWorkspace` (`src/workspace/workspace.ts`) switches from single-project mode to glob mode the moment `workspaces` is set in the root `package.json`. vx **dogfoods its own root `vx.config.ts`** (the `lint`/`test`/`ci`/`build.bun.*` task graph driven by `bun src/bin.ts run ci`). If `"."` stops being a member, the root config stops being a project and the entire CI/release gate breaks. This is documented in CLAUDE.md's docs-site entry and is a hard invariant.

**Recommendation: (c) — core stays at root `.`; cloud is a new `packages/cloud` workspace member; `apps/ui` stays where it is.**

Add `"packages/*"` to the root `workspaces` array (it becomes `[".", "apps/*", "packages/*"]`). Rationale:

- **Option (b) is the cleanest in theory but the most expensive and riskiest.** Moving core out of root means relocating `src/`, the root `vx.config.ts`, `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `bun.lock` resolution, every relative path in 250+ tests, the `bin` entry, the `.github/workflows/*` invocations (`bun src/bin.ts run ci` → `bun packages/vx/src/bin.ts run ci`), and — critically — re-proving that the `"."` dogfood member still resolves under the new layout. That's a large, behavior-neutral churn with real chance of breaking the self-hosting gate, for a symmetry payoff that doesn't ship any user value.
- **Option (a)/(c) keep `"."` exactly where it is** — zero risk to the dogfood invariant. `apps/ui` already proved this layout works (the docs-site entry: Bun tolerates `"."` alongside globbed members).
- **Why `packages/cloud` over `apps/cloud`:** `apps/*` is by convention "end-user applications with a build step" (the docs site, the UI SPA). `@vzn/vx-cloud` is a **publishable library + binary** (`bin: vx-cloud`), the sibling of `@vzn/vx` — it belongs in `packages/*` (published libs), establishing the `packages/*` convention that `extension-protocol-2026-06.md §9` already assumes for the reference plugins (`packages/plugin-sentry`, etc.). `apps/ui` stays in `apps/*` (it _is_ a built SPA), and `@vzn/vx-cloud` depends on it as a workspace dep to embed the dashboard HTML.

Resulting layout:

```
package.json            workspaces: [".", "apps/*", "packages/*"]
src/                    @vzn/vx core (UNMOVED)
vx.config.ts            the dogfood root project (UNMOVED — "." stays a member)
apps/
  ui/                   @vzn/vx-ui dashboard SPA (UNMOVED; built, embedded by cloud)
  docs/                 the docs site (UNMOVED)
packages/
  cloud/                @vzn/vx-cloud — the service + the first-party plugin
    src/
      plugin.ts         the VxPlugin export: cloud() — backend + cache + eventSink
      cli/              serve.ts, coordinator.ts, worker.ts, login.ts, bin.ts
      service/          (moved-from-core service internals)
      ...
    package.json        depends on "@vzn/vx": "workspace:*", "@vzn/vx-ui": "workspace:*"
    Dockerfile
    helm/
```

**Out of scope for this choice:** publishing mechanics (npm org, versioning lockstep). `@vzn/vx-cloud` versions independently and declares a peer/normal dep on a `@vzn/vx` version range; the cross-package boundary guard (§9) pins what it may import.

### 3.2 Remote-cache placement

**Options:**

- **(a)** The Turbo-wire `RemoteCache` HTTP client stays a **core built-in**, env-configured exactly as today (`remote-cache-setup.ts`). A solo dev points `VX_REMOTE_CACHE_URL` at Vercel / a turbo-cache server with zero plugins.
- **(b)** **All** remote caching becomes plugin-contributed. Core ships only the local `Cache` + the `CacheLayer` interface + `LayeredCache`. A first-party `turboCache()` plugin (in core's package or a sibling) provides the Turbo-wire client; `@vzn/vx-cloud` provides the cloud cache. Env-var ergonomics are preserved by the plugin reading the same env vars by default.

**Recommendation: a deliberate middle — (a) the Turbo-wire client and its env vars stay in core; the cache _seam_ is additionally opened to plugins via the new `cache` capability.** Concretely:

- `RemoteCache` (the Turbo-wire HTTP client, `src/cache/remote-cache.ts`) **stays in core's `cache` module.** It's 1 of core's value props (Turbo-wire compatibility lets a Turbo shop adopt vx incrementally), it's already shipped, it's only ~1 file, and pulling it out would break the zero-plugin "point at Vercel" path that real users rely on today.
- `wrapWithRemoteCache`'s **env reading stays in core** as the _default_ cache resolution — but it is refactored to run **only when no plugin contributes a cache.** A plugin's `cache` capability takes precedence; the env path is the fallback.
- `@vzn/vx-cloud`'s plugin contributes its **own** `cache` (a cloud-cache `CacheLayer` — could itself wrap `RemoteCache` pointed at the cloud's `/v8/artifacts` endpoint, or a richer signed/multi-tenant layer). When the cloud plugin is active, _it_ owns cache topology; when it's absent, core's env path is unchanged.

Why this over pure (b): the owner wants "best separation + plugin flexibility," but principle #1 ("explicit over magical") and the never-break-shipped-behavior bar both push back on ripping out the env path. The honest tradeoff:

- **Purity cost of keeping (a):** core retains the `RemoteCache` HTTP client and six env vars it could theoretically shed. This is a real but small surface (one client class, one setup function). It does **not** leak cloud-specific knowledge into core — `RemoteCache` is a generic Turbo-wire client, not a vx-cloud client.
- **Behavior cost of pure (b):** every existing `VX_REMOTE_CACHE_URL` user must install a plugin to keep working. That's a breaking change to a shipped, documented feature (`docs/caching.md`, `docs/design/remote-cache.md`) for no functional gain — the env path and a `turboCache()` plugin would read identical env vars and construct an identical `LayeredCache`.

So: **core keeps a zero-plugin remote cache (Turbo-wire, env-configured); the `cache` plugin capability lets cloud (or anyone) override it.** This gives full plugin flexibility _and_ preserves the solo-dev ergonomics. Precedence rule (§5.4): plugin `cache` wins; env fallback only fires if no plugin contributes one. If both a plugin _and_ the env vars are present, core logs a one-line note and uses the plugin (explicit beats ambient).

### 3.3 Optional cloud-worker orchestration — and the hard part (input shipping)

The backend plugin routes execution to a coordinator/worker fleet. The mechanics already exist (`coordinator.ts`, `worker.ts`, the `worker:*`/`task:assign` protocol), they just move to cloud. The plugin's `backend` capability returns a `RunBackend` whose `run(request)` submits to a coordinator (today's `serviceBackend`, generalized).

**The hard part: a remote worker needs the task's INPUT FILES.** Today's `worker.ts:112-118` calls `workerExecute({ command, cwd: node.projectDir, ... })` — it assumes the worker already has the full workspace checked out at `projectDir`. That holds for the CI matrix case (every runner does `actions/checkout`) and the self-hosted-fleet-on-a-shared-NFS case, but **not** for:

- a **dirty local working tree** (uncommitted changes the worker's checkout won't have), or
- a **rented/3rd-party worker** that should see only the minimal input set, not the whole repo.

vx already content-addresses every input by **git blob OID** (the v20 hashing change: `git ls-files -s` harvests index OIDs; dirty/untracked files get the identical OID computed in-process). This is the enabler. The design (sketch — this is a **later, optional phase**, not Phase 1):

**Blob-CAS input shipping.** Reuse the `CASBackend` + `Digest` abstractions that already exist in core (`src/cache/cas-backend.ts`, `src/cache/digest.ts`) — these were built precisely "so a future R2 backend (vx Cloud), S3 backend, or REAPI CAS bridge can drop in." A `Digest` is `{ hash, sizeBytes }` keyed by git blob OID. The flow:

1. **Submitter side (in the cloud backend plugin):** when submitting a task to a coordinator, the plugin already knows the resolved input set + every input's blob OID (core exposes this — see §3.5, the plugin gets the resolved-inputs view). It sends the task assignment with a **manifest**: `{ command, cwd-relative, inputs: [{ path, digest }] }`.
2. **Coordinator/worker negotiate missing blobs:** the worker checks its local blob-CAS (an `FsCASBackend` keyed by OID) for each digest; for misses, it requests them. The submitter (or a shared cloud blob-CAS / R2 bucket) serves the bytes. Clean committed blobs can alternatively be materialized via a **sparse git checkout** (the `distributed-ci-2026-06.md §9.3` path) — `git checkout` by OID needs no upload at all; only **dirty** blobs must be shipped.
3. **Worker materializes the declared input set** into a scratch dir, runs the shell command there, captures outputs, uploads the output artifact to the shared cache keyed by the task hash, reports `worker:done`. Content addressing makes the result fungible (`distributed-ci-2026-06.md §4`).

**Why this stays optional and late:** it's the single most complex piece, it's only needed for dirty-local or untrusted-worker scenarios, and the trusted-fleet / clean-CI cases work **today** with whole-workspace checkout (`distributed-ci-2026-06.md §9` "distributed CI on trusted self-hosted infra works today with item 2 alone"). Phase 1 ships the package split + plugin API + the _existing_ whole-checkout worker path moved to cloud. Blob-CAS input shipping is a clearly-marked later phase that _reuses_ core's already-built `CASBackend`/`Digest`/git-OID infrastructure — no new core abstraction is invented for it.

**What core must expose to enable this (and only this):** the resolved input set + per-input digest for a task. Core already computes this (`cache/inputs.ts:resolveInputs`, the git-OID map in `GitFilesCache`). The plugin reads it via the backend `ctx` (§5.2). Core does **not** gain a worker, a coordinator, or any shipping logic — those are entirely cloud's.

### 3.4 Coordinator persistence

Today's `coordinator.ts` is **ephemeral-per-run**: `startCoordinator(opts)` builds one graph from `opts.tasks`, runs one ready-queue to drain, and `done` resolves when `outcomes >= target` (`coordinator.ts:168-172`). A deployable always-on cloud service needs a **persistent coordinator** that merges many concurrent runs into one global scheduler — the "one global scheduler" + "in-flight dedup" deferred in `execution-service-2026-06.md §6` items 1-2.

**Decision: defer the persistent coordinator to a clearly-marked later phase (Phase 5). This doc scopes the split + the plugin API + repackaging the _existing_ ephemeral coordinator; it does NOT redesign the coordinator into a multi-run service.**

Rationale: the owner's lean is explicit — "split + plugin API + repackaging first; persistent coordinator as Phase N." The ephemeral coordinator already works end-to-end (`distributed-ci-2026-06.md` Phase A-B shipped, `tests/distributed-e2e.test.ts`). Moving it to `@vzn/vx-cloud` is mechanical. Turning it into a persistent multi-tenant scheduler is a substantial design (fairness policy, global queue, dedup map, run lifecycle, supersede-on-staleness) that deserves its own doc and should not gate the packaging win. The plugin API (`backend` capability returning a `RunBackend`) is **forward-compatible** with a persistent coordinator: the submitter protocol (`RunRequest` → `WireEvent` stream → `RunResult`) is identical whether the coordinator is ephemeral or persistent. So Phase 5 changes only cloud internals, never the core seam.

### 3.5 Core's public library API — the crux

Once `@vzn/vx-cloud` is a **separate package**, every symbol it imports from `@vzn/vx` becomes a **stable cross-package contract**. Today `serve.ts` / `coordinator.ts` / `worker.ts` reach into `orchestrator/index.js` freely (same-package, allowed by the module matrix). After the split those imports cross a package boundary and must come through `@vzn/vx`'s public `src/index.ts` (the package's `exports` map, `package.json:8-13`).

Today `src/index.ts` exports only ~8 things (run/policy/types/event-bus, `index.ts:3-34`). The cloud package needs **far more**. The exact stable surface core must publish:

**A. Run + planning entry points**

- `run`, `planRun` — the in-process engine (`orchestrator/run.ts`).
- `prepareRun` + `PreparedRun` — cloud's coordinator builds the graph via this (`coordinator-prepare.ts` already wraps it; after the split, `prepareForCoordinator` moves to cloud and calls the now-public `prepareRun`).
- `buildTaskGraph`, `expandRequested`, `markSurfacedDeps`, `isGroupTask`, `TaskNode`, `TaskOutcome`, `TaskStatus` — graph primitives the coordinator/worker reason over.
- `computeTaskHash` + `HashCache` / `createHashCache` — the coordinator computes the per-node assignment hash (today `computeTaskHashForCoord`, which moves to cloud and calls public `computeTaskHash`).

**B. Cache classes + the layer interface (the `cache` capability's currency)**

- `Cache`, `LayeredCache`, `RemoteCache` — so a cache plugin can compose them.
- `CacheLayer`, `CachePolicy`, `FULL_CACHE_POLICY`, `parseCachePolicy`, `RunRecord` — the interface a plugin's cache must satisfy + the policy it honors.
- `CASBackend`, `FsCASBackend`, `MemoryCASBackend`, `Digest`, `makeDigest`/`parseDigest`/`digestEqual` — the blob-CAS substrate for §3.3.
- `GitFilesCache`, `resolveInputs`, `resolveOutputs` — input/output resolution the worker materialization path needs.

**C. The protocol types + `RunBackend` (the `backend` capability's currency)**

- `RunBackend` (moves to core's public surface — see §6), `RunRequest`, `RunResult`, `optionsToRequest`, `requestToOptions`.
- `WireEvent`, `TaskView`, `OutcomeView`, `projectNode`, `projectOutcome`, `toWireEvent` — the serializable event projection.
- `createWireRenderer` — rebuilds a `Logger`-driven view from `WireEvent`s (the delegated-render path; cloud's `serviceBackend` uses it).

**D. The event bus + sink plumbing (the `eventSink` capability's currency)**

- `createEventBus`, `EventBus`, `RunEvent`, `RunEventSubscriber`, `wireForwarder`, `terminalSubscriber`.

**E. The wire envelope (so cloud speaks the JSON-RPC framing)**

- `WIRE_PROTOCOL_VERSION`, `WIRE_CHANNELS`, the envelope adapters (`isEnvelope`, `envelopeToClientMessage`, `serverMessageToEnvelope`, `encodeForSSE`/`encodeForNDJSON`, etc.) — currently `serve.ts` imports all of these from `orchestrator/index.js`.

**F. The new plugin types**

- `VxPlugin`, `BackendFactory`, `CacheFactory`, `EventSink`, `PluginSetupContext`, `BackendContext`, `CacheContext` (§5).
- `defineWorkspace`, `WorkspaceConfig` — already public (`index.ts:18`), extended with `plugins: VxPlugin[]`.

**G. Workspace discovery (cloud's CLI needs it)**

- `findWorkspaceRoot`, `loadWorkspaceConfig`, `resolveCacheDir` — `serve.ts:53` already imports these; after the split they must be public.

**What core must NOT export (stays internal):** the metrics SQL layer (`metrics.ts` — see §7, it stays in core but is consumed by `mcp`/`info`, not re-architected), `execute-task.ts` internals, `scheduler.ts`/`runGraph` internals (cloud drives execution via `run()` or `workerExecute`, never the raw scheduler), the framed-output/status-line/summary renderers, the coordinator/worker themselves.

**The boundary guard** (§9): a new `tests/package-boundaries.test.ts` (sibling to `module-boundaries.test.ts`) asserts that `packages/cloud/src/**` imports `@vzn/vx` **only** through the bare `'@vzn/vx'` specifier (never a deep `@vzn/vx/src/...` path), and asserts core **never** imports `@vzn/vx-cloud` (the dependency-direction invariant). It also pins the exact set of symbols core's `src/index.ts` exports, so an accidental narrowing of the public surface fails CI.

## 4. The three extension points (the inversion)

Each hardcoded hook becomes a **factory the plugin contributes**, consulted by core with a **fallback to today's default**. The orchestrator's call sites barely change — they ask the plugin registry first, then fall back.

```
                        ┌─ plugin.backend(ctx)  ─┐
resolveBackend(ctx) ────┤                        ├─→ first non-undefined, else localBackend()
                        └─ (none) ───────────────┘

                        ┌─ plugin.cache(ctx)    ─┐
resolveCache(ctx) ──────┤                        ├─→ first non-undefined, else env LayeredCache, else local Cache
                        └─ wrapWithRemoteCache ──┘   (§3.2 precedence: plugin > env > local)

bus.subscribe ──────────── plugin.eventSink (∀ plugins)  + terminalSubscriber + (env) otel
```

- **Backend** (`backend.ts:resolveBackend`): today reads `VX_SERVICE_URL` + `.vx/serve.json` (vx-cloud-specific knowledge). Inverted: core's `resolveBackend` asks each plugin's `backend(ctx)` factory; the **cloud plugin** is what knows about `VX_SERVICE_URL` and serve-info discovery. Core's fallback is `localBackend()` — pure in-process. **Core no longer mentions `VX_SERVICE_URL` or `.vx/serve.json`.**
- **Cache** (`remote-cache-setup.ts:wrapWithRemoteCache`): per §3.2, the env-var Turbo-wire path **stays in core as the fallback**; a plugin's `cache(ctx)` factory takes precedence. The cloud plugin contributes its cloud cache.
- **Event sink** (the bus): today `installPlugins` already subscribes observe-only hooks, and `attachOtelEmit` is hardcoded. Inverted: a plugin's `eventSink` is a `WireEvent` consumer subscribed via `wireForwarder`; OTel becomes the cloud plugin's (or a tiny first-party `otelSink()` plugin's) `eventSink`, no longer hardcoded in `run.ts`. (`otel-emit.ts` can stay in core as an opt-in helper a plugin wraps, or move to a sibling — see §10 migration note; it does not block the split.)

## 5. The `VxPlugin` interface (precise)

A plugin is a single object contributing **zero or more of three capabilities**, plus optional lifecycle. Minimal, typed, no executor protocol. Lives in core at `src/orchestrator/plugin.ts` (replacing the observe-only `Plugin`; the old `Plugin`/`PluginContext`/hook types are **subsumed** — the `eventSink` capability is the generalization of today's `setup`+bus-subscriber).

```ts
// src/orchestrator/plugin.ts  (core; exported from src/index.ts)

import type { CacheLayer, CachePolicy, Cache } from '../cache/index.js'
import type { WireEvent } from './events.js'
import type { RunBackend, RunRequest } from './protocol.js'

/**
 * A vx plugin. Contributes any subset of three RUN-LEVEL infrastructure
 * capabilities — where work routes (backend), which cache is used (cache),
 * who observes the run (eventSink). It NEVER changes how a task executes
 * (Architecture principle #3: shell is the API). Registered explicitly in
 * vx.workspace.ts via defineWorkspace({ plugins: [...] }). No auto-discovery.
 */
export interface VxPlugin {
  /** Stable identifier, convention `'org/name'`. Used in errors + precedence logs. */
  readonly name: string

  /**
   * Contribute a run backend. Returns a RunBackend (run(request) → result),
   * or undefined to decline (core then tries the next plugin, else
   * localBackend()). Consulted ONCE per run, before scheduling. At most one
   * plugin's backend is used (first non-undefined, in declaration order).
   */
  backend?(ctx: BackendContext): RunBackend | undefined | Promise<RunBackend | undefined>

  /**
   * Contribute a cache layer. Returns a CacheLayer wrapping (or replacing)
   * the local Cache, or undefined to decline. Consulted ONCE per prepareRun.
   * Precedence: first non-undefined plugin cache wins; else core's env-var
   * Turbo-wire LayeredCache; else the bare local Cache (§3.2).
   */
  cache?(ctx: CacheContext): CacheLayer | undefined | Promise<CacheLayer | undefined>

  /**
   * Contribute an event sink — a consumer of the serializable WireEvent
   * stream, subscribed for the whole run via wireForwarder. Fire-and-forget;
   * a throwing sink is isolated by the bus and cannot break the run. This is
   * the generalization of the old observe-only Plugin: an uploader, an OTel
   * exporter, a Slack notifier all fit here.
   */
  eventSink?(ctx: EventSinkContext): EventSink | undefined | Promise<EventSink | undefined>

  /**
   * Optional one-time setup before any capability is consulted (validate the
   * workspace, open a connection, read a token). Throwing aborts the run with
   * a clean UserError naming the plugin — same contract as the old setup().
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>

  /** Optional teardown at end-of-run (flush a sink, close a socket). Errors are logged, never thrown. */
  teardown?(): void | Promise<void>
}

/** A WireEvent consumer. onEvent is fire-and-forget; flush is awaited at teardown. */
export interface EventSink {
  onEvent(event: WireEvent): void
  flush?(): Promise<void>
}

/** Shared, read-only context every capability factory receives. */
interface BaseContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  /** Funnel warnings into the run:status channel (framed output). */
  warn(message: string): void
}

export interface PluginSetupContext extends BaseContext {}
export interface EventSinkContext extends BaseContext {}

export interface BackendContext extends BaseContext {
  /** The resolved RunRequest about to be executed — cwd, tasks, policy, flow. */
  readonly request: RunRequest
}

export interface CacheContext extends BaseContext {
  /** The local Cache handle the plugin may wrap (LayeredCache(local, remote)). */
  readonly localCache: Cache
  /** The run's cache policy (the 4 read/write axes). */
  readonly policy: CachePolicy
}
```

### 5.1 How core consults plugins

A new `src/orchestrator/plugin-host.ts` (core) owns the consultation. Three functions, each consulted at the existing seam:

```ts
// resolveBackend — replaces cli/backend.ts:resolveBackend's env logic.
export async function resolveBackend(
  plugins: readonly VxPlugin[],
  ctx: BackendContext,
): Promise<RunBackend> {
  for (const p of plugins) {
    const b = await safe(p, 'backend', () => p.backend?.(ctx))
    if (b !== undefined) return b // first non-undefined wins
  }
  return localBackend() // core default — pure in-process
}

// resolveCache — wraps remote-cache-setup.ts:wrapWithRemoteCache as the fallback.
export async function resolveCache(
  plugins: readonly VxPlugin[],
  localCache: Cache,
  ctx: CacheContext,
  log: Logger,
): Promise<CacheLayer> {
  for (const p of plugins) {
    const c = await safe(p, 'cache', () => p.cache?.(ctx))
    if (c !== undefined) {
      if (process.env.VX_REMOTE_CACHE_URL)
        log.status(`[vx] plugin '${p.name}' cache overrides VX_REMOTE_CACHE_*`)
      return c
    }
  }
  return wrapWithRemoteCache(localCache, log, ctx.policy) // env fallback (§3.2)
}

// subscribeEventSinks — generalizes installPlugins' bus subscription.
export async function subscribeEventSinks(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: EventSinkContext,
): Promise<() => void> {
  const disposers: Array<() => void> = []
  for (const p of plugins) {
    const sink = await safe(p, 'eventSink', () => p.eventSink?.(ctx))
    if (sink)
      disposers.push(
        bus.subscribe(
          wireForwarder((e) => {
            try {
              sink.onEvent(e)
            } catch {}
          }),
        ),
      )
  }
  return () => disposers.forEach((d) => d())
}
```

`safe(plugin, hook, fn)` wraps each factory call: a throw becomes a `UserError` for `setup`/`backend`/`cache` (these are load-bearing — a broken backend can't silently fall through to local without the user knowing) and a logged-and-disabled warning for `eventSink` (observability must never break a run — the existing `events.ts:63-69` isolation contract). This mirrors the current `installPlugins` error model (`plugin.ts:154-160`).

### 5.2 Where `prepareRun` / `run` thread plugins

Plugins are loaded from `WorkspaceConfig.plugins` in `prepareRun` (already partially wired — `run.ts:87` reads `prepared.workspaceConfig.plugins`). The threading:

- **`prepareRun`** loads `workspaceConfig` (already does, `prepare.ts:113`). It calls `resolveCache(plugins, localCache, cacheCtx, log)` **instead of** the unconditional `wrapWithRemoteCache(localCache, log, policy)` at `prepare.ts:200`. The resolved `CacheLayer` flows out as `prepared.cache` exactly as today — the rest of the orchestrator is untouched (it only ever sees "a `CacheLayer`").
- **`run`** calls `subscribeEventSinks(plugins, bus, ctx)` in place of the current `installPlugins` block (`run.ts:87-100`) and `attachOtelEmit` (`run.ts:63-66`, which becomes a plugin — see §10). Disposed in the existing `finally` (`run.ts:484`).
- **The backend seam is at the CLI**, not in `run()`. `cli/run.ts:430` (`resolveBackend(cwd)` → `backend.run(request)`) changes to load plugins + call the new `resolveBackend(plugins, ctx)`. Core's `cli/backend.ts` keeps `localBackend()` (the default); `serviceBackend` + the env/serve-info discovery **move to the cloud plugin**.

This keeps the inversion **minimal and at the exact three seams** — no new event types, no executor hooks, no speculative everything-bus. The owner's "minimal: `backend | cache | eventSink`" is honored literally.

### 5.3 `defineWorkspace({ plugins })` wiring

`WorkspaceConfig.plugins` already exists (`config.ts:13`) typed as `readonly Plugin[]` with a leaf-safe structural shape (`config.ts:28-31`, a re-declaration so `config.ts` stays a leaf module — it must NOT import from `orchestrator`). That structural shape widens to the `VxPlugin` shape (still structurally re-declared in `config.ts` to preserve the leaf-module rule; the full typed `VxPlugin` lives in `orchestrator/plugin.ts` and is what users import). Authoring:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { cloud } from '@vzn/vx-cloud'

export default defineWorkspace({
  plugins: [
    cloud({ url: process.env.VX_CLOUD_URL, token: process.env.VX_CLOUD_TOKEN }),
    // anyone can write a different one — core names no plugin
  ],
})
```

`cloud()` returns a `VxPlugin` contributing all three capabilities (a `backend` that submits to the cloud coordinator, a `cache` that points at the cloud's artifact store, an `eventSink` that uploads the event log for insights). A user can also compose finer-grained first-party plugins (a hypothetical `turboCache()` or `otelSink()`) — the registry consults them in declaration order.

### 5.4 Precedence + determinism (resolved)

- **Backend:** at most one. First plugin returning a non-undefined `backend` wins; ties impossible (declaration order is total). No plugin → `localBackend()`.
- **Cache:** at most one plugin cache; first non-undefined wins; else env `LayeredCache`; else local `Cache`. A plugin cache + env vars both present → plugin wins, one-line note logged.
- **Event sinks:** **all** plugins' sinks subscribe (additive — observability composes). Order = declaration order = bus fan-out order (`events.ts:48`, already order-preserving).

## 6. Wire-protocol split (core vs cloud)

`protocol.ts` today carries **two concerns fused** (`protocol.ts:36-78`): the submitter contract (`RunRequest`/`RunResult`/`ServerMessage`'s `event`/`result`/`error` + the `RunOptions⇄RunRequest` mappers) and the **distributed extension** (`task:assign`/`cache:exists`/`coord:drain` + the whole `worker:*` `ClientMessage` family + `WireTaskNode`/`WireOutcome`).

**Split plan:**

- **STAYS IN CORE** (`src/orchestrator/protocol.ts`, the plugin/client contract):
  - `RunRequest`, `RunResult` (`protocol.ts:16-34`).
  - `ServerMessage` **narrowed** to `{ t: 'event' } | { t: 'result' } | { t: 'error' }` (drop the three coordinator variants at `protocol.ts:44-46`).
  - `ClientMessage` **narrowed** to `{ t: 'run'; request }` (drop the `worker:*` family at `protocol.ts:52-59`).
  - `optionsToRequest`, `requestToOptions` (`protocol.ts:81-117`).
  - `RunBackend` — **moves from `cli/backend.ts:30` into `orchestrator/protocol.ts`** so it's part of the public wire contract and the `backend` plugin capability can reference it without a `cli` import (core's `cli` can't be a public type source for a sibling package).
- **MOVES TO CLOUD** (`packages/cloud/src/protocol-dist.ts`):
  - `WireTaskNode`, `WireOutcome` (`protocol.ts:62-78`).
  - The `worker:*` `ClientMessage` family + `task:assign`/`cache:exists`/`coord:drain` `ServerMessage` variants.
  - The matching `wire.ts` JSON-RPC envelope adapters for the `worker.*`/`coord.*` namespaces (the distributed-message adapters noted in `distributed-ci-2026-06.md`'s snapshot row "JSON-RPC 2.0 envelope adapters for distributed messages"). The **base** envelope (`Envelope`/`Request`/`Response`/`Notification`, `WIRE_PROTOCOL_VERSION`, `WIRE_CHANNELS`, the `vx:events`/`vx:submit` adapters) **stays in core** `wire.ts` — it's the substrate the submitter contract rides on, and `serve.ts`/MCP both need it.

**Consequence for the narrowed core types:** the comment at `protocol.ts:97-98` ("`task:assign` / `cache:exists` / `coord:drain` are coordinator-side messages … the run-submitter ignores them") in `cli/backend.ts:82-98` is precisely the seam — after the move, core's `serviceBackend` is gone (moved to cloud), so core's `ServerMessage` legitimately drops those variants. Cloud's WS message handler unions the core `ServerMessage`/`ClientMessage` with its own `protocol-dist.ts` extension types — a plain TS union, no core change needed.

## 7. Exactly what moves to `@vzn/vx-cloud`

Each file's core deps verified before asserting it can move:

| File (today)                                                                                          | Verified deps                                                                                                                                 | Move?                                                  | Notes                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/serve.ts`                                                                                    | imports only from `cache/index`, `orchestrator/index`, `version`, `workspace/index` — all public-able                                         | **MOVE** → `packages/cloud/src/cli/serve.ts`           | The whole `/v1/*` metrics API + `/v1/graph` run-cockpit + WS run submission + SSE/NDJSON. After the move it imports `@vzn/vx` for the engine + `metrics` (which stays public in core, see below).                                                                                                                                               |
| `src/cli/coordinator.ts`                                                                              | imports `computeTaskHashForCoord`, `prepareForCoordinator`, `createEventBus`, the `worker:*` protocol types, `findWorkspaceRoot`, `UserError` | **MOVE** → `packages/cloud/src/cli/coordinator.ts`     | Calls the now-public `prepareRun`/`computeTaskHash` from `@vzn/vx`.                                                                                                                                                                                                                                                                             |
| `src/cli/worker.ts`                                                                                   | imports `workerExecute`, the dist protocol types                                                                                              | **MOVE** → `packages/cloud/src/cli/worker.ts`          | Calls public `workerExecute` (or, post-blob-CAS, a cloud-side materialize+`runCommand` path).                                                                                                                                                                                                                                                   |
| `src/orchestrator/coordinator-prepare.ts`                                                             | imports `prepareRun`, `PreparedRun`, `TaskNode`, `computeTaskHash`                                                                            | **MOVE** → `packages/cloud/src/coordinator-prepare.ts` | Pure adapter over public `prepareRun`/`computeTaskHash`; nothing core-internal.                                                                                                                                                                                                                                                                 |
| `src/orchestrator/worker-exec.ts`                                                                     | imports `runCommand` from `exec/index`                                                                                                        | **STAYS in core** (export `workerExecute` publicly)    | **Subtlety:** this is the one file touching `exec` (`runCommand`), and the module matrix has **`cli → exec` deliberately absent** (`module-boundaries.test.ts:33`). Keep `workerExecute` in core's `orchestrator`, export it from `src/index.ts`; cloud's worker stays a thin loop calling public `workerExecute`. `exec` stays fully internal. |
| `src/orchestrator/remote-cache-setup.ts`                                                              | imports `Cache`/`LayeredCache`/`RemoteCache`/policy                                                                                           | **STAYS** (env fallback, §3.2)                         | The cloud cache is a **new** `packages/cloud/src/cache-plugin.ts` contributing the `cache` capability.                                                                                                                                                                                                                                          |
| `src/orchestrator/metrics.ts` (+ all `/v1/*` query fns re-exported at `orchestrator/index.ts:80-129`) | imports only `bun:sqlite` `Database`                                                                                                          | **STAYS in core**, exported publicly                   | Pure, dependency-free SQL over `cache.db`. Core's own `vx info` doctor + `vx mcp` read aggregates from it. Cloud's `serve.ts` imports it from `@vzn/vx`. (Correction to the original assumption that it moves: keeping it in core is lower-churn and forces no `mcp` move; it carries zero cloud-specific knowledge.)                           |
| `apps/ui` (the dashboard SPA + `cli/ui-asset.ts` embed)                                               | `serve.ts --ui` serves it                                                                                                                     | **STAYS at `apps/ui`**, consumed by cloud              | `@vzn/vx-cloud` depends on `@vzn/vx-ui` (workspace dep) and embeds `apps/ui/dist/index.html`. `src/cli/ui-asset.ts` + `ui-server.ts` move to cloud (they only feed `serve`/`--ui`).                                                                                                                                                             |
| `src/cli/dev.ts`, `dev-client.ts`                                                                     | the `vx dev` observe hub                                                                                                                      | **MOVE** → cloud                                       | `dev` is the observe sibling of `serve`. Per `execution-service-2026-06.md §6.4` they converge. `vx dev`/`vx serve` are the service CLI; core keeps no service subcommand. `localBackend`'s `connectDevForwarder` mirror (`backend.ts:43-48`) becomes a no-op in core (or a tiny optional hook the cloud plugin re-enables).                    |
| `src/cli/mcp.ts`, `mcp-rpc.ts`                                                                        | the agent inspector                                                                                                                           | **STAYS in core**                                      | MCP is an inspector over local `cache.db` (`metrics.ts`), not the service. Agents querying a local run shouldn't require the cloud package.                                                                                                                                                                                                     |

**The net consequence (must be stated plainly):** a **pure-core install has no dashboard, no `vx serve`, no `vx coordinator`, no `vx worker`, no `/v1/*` API, no `vx dev`.** A solo dev gets `run/watch/lock/migrate/show/info/cache/upgrade/mcp` and the full local + Turbo-wire remote cache. The dashboard and the whole service layer appear only after `vx-cloud serve`. This is the intended separation and the cost is real: **`vx run --ui` (the one-shot local devframe UI) leaves core.** That's acceptable — it was always "superseded by `vx serve` + the converged UI" (`execution-service-2026-06.md §7`).

**CLI dispatcher impact** (`src/cli/index.ts:17-18,58-61`): drop the `coordinator`/`worker` cases and the `serve`/`dev` cases from core's switch; drop their parser re-exports (`index.ts:84-85`). Core's `printHelp` loses those rows. `@vzn/vx-cloud`'s own `bin: vx-cloud` dispatches `serve/coordinator/worker/login/dev`.

## 8. "Local or hosted" — the `@vzn/vx-cloud` shape

The owner's invariant: **same artifact, roles collapse locally, scale out hosted.** Layering principle: **vx owns task scheduling; k8s owns pod lifecycle.**

### 8.1 Collapsed local process

`vx-cloud serve` (the local face) = one Bun process that is coordinator + worker + submission target + dashboard host + cache + insights store. This is exactly today's `vx serve` (which already runs `run()` in-process with a shared `inflight` registry, `serve.ts:144-146`) plus the coordinator's assignment logic and the dashboard. One binary, `bun:sqlite` cache, `/v1/*` HTTP, embedded SPA. No new infra. This is the `vx-cloud-2026-06.md` "vx cloud is exactly vx serve … runs in Docker" decision, honored.

### 8.2 Hosted (Docker / k8s / Helm)

Two deployables off the **same image**, selected by the subcommand:

```
┌──────────── k8s namespace: vx-cloud ─────────────────────────────────┐
│                                                                       │
│  Service: coordinator        (vx-cloud coordinator)                   │
│   • 1-3 replicas, leader-elected (persistent coordinator = Phase 5)   │
│   • holds the global ready-queue + run state + WS fan-out             │
│   • exposes /v1/* (metrics), /v1/submit (WS), /health, /version       │
│                                                                       │
│  Deployment: workers         (vx-cloud worker --coordinator <svc>)    │
│   • HPA-scaled (CPU / queue-depth custom metric)                      │
│   • stateless, fungible; pull → execute shell → upload artifact       │
│   • k8s owns pod lifecycle; vx owns which task each worker pulls       │
│                                                                       │
│  Shared remote-cache CAS    (RemoteCache target / R2 / S3 / FsCAS PVC)│
│   • <hash>.tar.zst artifacts, content-addressed                       │
│   • the blob-CAS for input shipping (Phase 6) lives here too          │
│                                                                       │
│  cache.db / Postgres        (insights store; SQLite PVC or external)  │
└───────────────────────────────────────────────────────────────────────┘
```

**Reference Dockerfile shape** (high level):

```dockerfile
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @vzn/vx-ui build        # build the embedded dashboard
# compile @vzn/vx-cloud (depends on @vzn/vx workspace:*) to a single binary
RUN bun build --compile packages/cloud/src/cli/bin.ts --outfile /out/vx-cloud

FROM oven/bun:1.3-slim
COPY --from=build /out/vx-cloud /usr/local/bin/vx-cloud
ENTRYPOINT ["vx-cloud"]      # CMD picks the role: ["serve"] | ["coordinator"] | ["worker", ...]
```

**Helm chart SHAPE** (not full manifests):

- `coordinator`: a `Deployment` (1-3 replicas) + `Service` + `Ingress` (TLS, `wss://`). `readinessProbe: /health`, `startupProbe: /version`.
- `worker`: a `Deployment` + `HorizontalPodAutoscaler` (target CPU + an optional custom `queue_depth` metric scraped from the coordinator's `/v1/*`). `terminationGracePeriodSeconds` long enough for graceful `worker:bye` drain (`coordinator.ts:223-225` already handles `worker:bye`; `worker.ts:97-104` already drains on `coord:drain`).
- `cache`: a `PersistentVolumeClaim` for an `FsCASBackend` dir, **or** a `values.yaml` toggle to an external S3/R2 endpoint (the `CASBackend` interface, `cas-backend.ts:25`, makes this a config swap, not a code change).
- `values.yaml` knobs: `replicas`, `worker.minReplicas/maxReplicas`, `cache.backend: fs|s3|r2`, `auth.token`, `insights.store: sqlite|postgres`.

The k8s/vx layering is the honest boundary: **k8s scales pods up/down; vx's coordinator decides which ready task each connected worker pulls.** vx is not a cluster scheduler (`distributed-ci-2026-06.md §13` non-goal "we're not building Kubernetes") — it rides on top of one.

## 9. Cross-package boundary guard

A new `tests/package-boundaries.test.ts` (sibling to `module-boundaries.test.ts`), run as part of `bun src/bin.ts run ci`:

1. **Dependency direction.** Scan `packages/cloud/src/**/*.ts`: every import of vx must be the bare specifier `'@vzn/vx'` (the package's public `exports`), never a deep `'@vzn/vx/src/...'` or relative reach into core. **Fail** any deep import.
2. **No reverse dependency.** Scan `src/**/*.ts` (core): assert **zero** imports of `'@vzn/vx-cloud'` or any `packages/cloud/...` path. This is the owner's hard invariant ("cloud → core, never the reverse; core names no plugin"). A single offending import fails CI.
3. **Public-surface pin.** Snapshot the exact export set of `src/index.ts` (the §3.5 list). A narrowing (a cloud-needed symbol silently un-exported) fails — protecting cloud from a surprise break. A widening requires updating the snapshot (a deliberate decision, like the `CONTRACTED` ratchet in `module-boundaries.test.ts:40-48`).

The intra-core module matrix (`module-boundaries.test.ts`) is **unchanged** except: dropping `cli/coordinator.ts`/`worker.ts`/`serve.ts`/`dev.ts` removes core's `cli → orchestrator` consumers of the dist-protocol/serve symbols (those symbols are removed from `orchestrator/index.ts`'s re-export list, §6/§7). `worker-exec.ts` + `metrics.ts` **stay** in `orchestrator` (per §7), so the matrix's `orchestrator → exec`/`cache` edges are unaffected.

## 10. Migration cost, non-goals, risks

**Migration cost (honest):**

- **Public-API maintenance commitment.** The §3.5 surface becomes a **stable contract** vx must not break without a major bump. That's ~40 symbols vs today's ~8. This is real ongoing cost: every refactor of `prepareRun`/`computeTaskHash`/`Cache` shapes is now a potential cross-package break, caught by the §9 pin but requiring coordinated cloud updates. **This is the single biggest cost of the split** and the owner should accept it explicitly.
- **`worker-exec.ts` + `metrics.ts` stay in core** (§7) to avoid widening the `exec` surface and forcing `mcp` to move. Slight impurity (core ships a worker primitive + a metrics SQL layer it doesn't itself serve over HTTP) in exchange for a smaller public surface and an untouched module matrix.
- **`otel-emit.ts`**: today hardcoded in `run.ts:63-66`. Cleanest end-state is a tiny first-party `otelSink()` plugin. **But** that's a behavior change (OTel currently fires with zero config when the env var is set). **Recommend: leave `attachOtelEmit` in core for now** as a built-in eventSink (env-gated, exactly as today) and expose the `eventSink` capability for _new_ sinks. Converting OTel to a plugin is a follow-up, not a blocker — it keeps the split behavior-neutral.
- **Test relocation:** `tests/distributed*.test.ts`, `tests/serve*.test.ts`, the insights/metrics tests move to `packages/cloud/`. Core's `tests/plugin-e2e.test.ts` is rewritten against the new `VxPlugin` shape (the old observe-only `Plugin` is subsumed).

**Non-goals (this doc):**

- **No persistent multi-run coordinator** (deferred to Phase 5, §3.4).
- **No blob-CAS input shipping** in Phase 1 (deferred to Phase 6, §3.3 — the whole-checkout worker path moves as-is).
- **No multi-tenancy / auth / OAuth** (Phase 7).
- **No executor plugin protocol.** Tasks are shell strings (principle #3). Plugins hook backend/cache/sink only — never "how a task runs." This is load-bearing and explicitly off the table.
- **No auto-discovery of plugins.** Config-declared only (principle #1).
- **No new CLI subcommands from plugins.** The plugin surface contributes capabilities, not commands (owner's explicit "NO CLI from plugins").

**Risks:**

- **Core cold-start / dep-count regression.** Core today is ~19 deps (1 prod: `@anthropic-ai/sandbox-runtime`; the rest dev). The split must keep core's runtime deps ≤ 19 and cold-start untouched. **Mitigation:** all of cloud's heavier deps (the HTTP stack `serve.ts` may pull, any insights/Postgres driver, the embedded SPA) live in `packages/cloud/package.json` — **never** in core. The §9 guard's "no reverse dependency" rule enforces this structurally: core can't import cloud, so it can't pull cloud's deps. The boundary guard test is the cold-start protection.
- **The dashboard-leaves-core surprise.** Users running `vx run --ui` today lose it on upgrade. **Mitigation:** a deprecation note + a clear "install `@vzn/vx-cloud` for the dashboard" message where `--ui` used to be; document in the migration guide.
- **Plugin trust.** A `backend` plugin routes _all_ execution; a `cache` plugin serves _all_ artifacts. These are high-trust. **Mitigation:** same model as `vx.workspace.ts` itself (`extension-protocol-2026-06.md §12` — in-process plugins run with config-level trust; importing an untrusted plugin is on the user). The §5.1 error model fail-fast on a broken backend/cache (never silently degrade to local without telling the user).

## 11. Phasing

Each phase ships independent value and keeps `bun src/bin.ts run ci` green.

| Phase                                                         | Ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Independent value                                                                                                                                                                                                             | Risk                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **1 — Plugin API + the seam inversion (LEANEST)**             | The `VxPlugin` interface + `plugin-host.ts` (`resolveBackend`/`resolveCache`/`subscribeEventSinks`); `RunBackend` moves into `protocol.ts`; the three call sites (`cli/run.ts` backend, `prepare.ts` cache, `run.ts` sinks) consult plugins with fallback to today's defaults; `defineWorkspace({ plugins })` widened. **No code moves packages yet.**                                                                                                                                                                                                                                                                              | The extension points exist and are typed; today's behavior is byte-identical (no plugin → `localBackend` + env cache + terminal/otel sinks). The old observe-only `Plugin` is subsumed by `eventSink`.                        | Low — pure inversion at three seams, all with fallbacks.                                   |
| **2 — Create `@vzn/vx-cloud`; move the obvious service code** | New `packages/cloud` workspace member; move `serve.ts` (+ `/v1/*`, `/v1/graph`, WS submit), `coordinator.ts`, `worker.ts`, `coordinator-prepare.ts`, `ui-asset.ts`/`ui-server.ts`, `dev.ts`/`dev-client.ts`; the dist-protocol families (`worker:*`/`coord:*`, `WireTaskNode`/`WireOutcome`) move to `packages/cloud/src/protocol-dist.ts`; core's `ServerMessage`/`ClientMessage` narrow; core's CLI drops `serve/dev/coordinator/worker`; `@vzn/vx-cloud` gets its own `bin: vx-cloud`. Add `tests/package-boundaries.test.ts`. Expand `src/index.ts` to the §3.5 surface. `worker-exec.ts` + `metrics.ts` stay in core (public). | Clean package boundary; pure-core install is lean (no service, no dashboard). Cloud package builds + serves the dashboard + runs the existing ephemeral coordinator/worker.                                                   | Medium — the cross-package import churn; the boundary guard catches mistakes.              |
| **3 — The first-party `cloud()` plugin**                      | `packages/cloud/src/plugin.ts` exporting `cloud(opts)` contributing `backend` (submit to coordinator, owns `VX_SERVICE_URL`/serve-info discovery moved out of core), `cache` (cloud artifact store), `eventSink` (insights upload). Wired via `defineWorkspace({ plugins: [cloud()] })`.                                                                                                                                                                                                                                                                                                                                            | The whole owner story works end-to-end: declare the plugin, runs route to the local-or-hosted cloud, artifacts hit the cloud cache, events upload. Anyone can write a different plugin against the same `VxPlugin` interface. | Medium — proves the API is sufficient; may surface missing exports (caught by the §9 pin). |
| **4 — Docker / Helm "local or hosted"**                       | Reference `Dockerfile` + Helm chart shape (§8): coordinator `Service`, worker `Deployment` + HPA, shared CAS, collapsed-local mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Hosted deployability; the k8s-owns-pods / vx-owns-scheduling layering is real.                                                                                                                                                | Medium — infra, not core code.                                                             |
| **5 — Persistent coordinator** (deferred, §3.4)               | One global scheduler merging concurrent runs; in-flight dedup (`execution-service §6.1-2`); supersede-on-staleness. Cloud-internal only — core seam unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Multi-run efficiency; the always-on hosted coordinator.                                                                                                                                                                       | High — its own design doc.                                                                 |
| **6 — Blob-CAS input shipping** (deferred, §3.3)              | Submitter ships missing dirty-blob OIDs; worker materializes the declared input set (sparse git checkout for clean blobs, upload for dirty) via core's existing `CASBackend`/`Digest`/`GitFilesCache`.                                                                                                                                                                                                                                                                                                                                                                                                                              | Dirty-local + untrusted-worker execution; "rent a worker from anywhere."                                                                                                                                                      | High — the hardest piece; reuses built core abstractions.                                  |
| **7 — Multi-tenant / auth** (deferred)                        | Token model, per-org isolation, OAuth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The hosted SaaS.                                                                                                                                                                                                              | High — `vx-cloud-2026-06.md §5` had the shape (sans Cloudflare).                           |

**Phase 1 is the lean keystone:** it establishes the typed plugin API and inverts the three hardcoded hooks **without moving a single file across packages and without any distributed/k8s complexity** — pure behavior-neutral inversion with fallbacks. Everything else is mechanical relocation (Phase 2) and additive capability (Phase 3+).

## 12. Why this is the right move

- **It inverts exactly the three hooks that are vx-cloud-specific knowledge in core** (`VX_SERVICE_URL` + serve-info in `backend.ts`, `VX_REMOTE_CACHE_*` in `remote-cache-setup.ts`, hardcoded OTel in `run.ts`) — and nothing more. The surface is `backend | cache | eventSink`, minimal and driven by cloud's real needs, not a speculative everything-bus. Principle #3 is honored literally: plugins hook _where work routes / which cache / who observes_, never _how a task executes_.
- **Two of the three seams are already interfaces** (`RunBackend`, `CacheLayer`) and the third is already a fan-out bus. The design inverts _selection_, not _interface_ — which is why Phase 1 is behavior-neutral and small.
- **It keeps the dogfood invariant safe** (core stays at root `.`; `loadWorkspace` glob-mode and the `bun src/bin.ts run ci` gate are untouched) and **protects core's cold-start + 19-dep budget structurally** via the no-reverse-dependency boundary guard — cloud's heavy deps physically cannot leak into core.
- **It preserves shipped behavior** (zero-plugin Turbo-wire remote cache via env vars stays; OTel stays env-gated) while opening every seam to plugins — "best separation + plugin flexibility" without a breaking change to solo-dev ergonomics.
- **It reconciles the doc history honestly:** same Bun/Docker runtime as `vx-cloud-2026-06.md`'s 2026-06-21 directive (no Cloudflare resurrection), just a clean package + plugin boundary — and it owns the roadmap items `execution-service`/`distributed-ci` deferred, with the hard distributed bits (persistent coordinator, blob-CAS input shipping) explicitly fenced into later phases that reuse core's already-built `CASBackend`/`Digest`/git-OID infrastructure.

## 13. Open questions

- **OTel as plugin vs built-in.** §10 recommends leaving `attachOtelEmit` in core (env-gated) for behavior-neutrality, converting to an `otelSink()` plugin later. Decide whether to bite that bullet in Phase 3.
- **`metrics.ts` home.** §7 keeps it in core (pure, needed by `vx mcp`/`vx info`). If `mcp` ever moves to cloud, revisit.
- **Plugin precedence UX.** §5.4 logs a note when a plugin cache overrides env vars. Is a one-line note enough, or should a conflict be a hard error? (Lean: note — explicit-beats-ambient is the documented rule.)
- **Cloud plugin granularity.** Ship one `cloud()` contributing all three capabilities, or three composable plugins (`cloudBackend()`/`cloudCache()`/`cloudInsights()`)? Lean: one `cloud()` with option flags, plus document the composable pattern for users who want only the cache.
- **`@vzn/vx-cloud` version coupling.** Normal dep on a `@vzn/vx` range vs lockstep major versions. The §9 public-surface pin makes a range safe; decide the policy.
