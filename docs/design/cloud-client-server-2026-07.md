# vx-cloud client/server model — environments, connect, auth — design

> **Status:** proposal (2026-07-02)
>
> **Builds on / updates:**
>
> - **Builds on** `core-cloud-split-2026-06.md` — the package split, the `VxPlugin` capabilities, and the "same artifact, local or hosted" shape are all assumed. Nothing here reopens them.
> - **Builds on** `observability-architecture-2026-06.md` — the telemetry capability + `RunSummaryRecord` push into the serve's own `IngestStore` is the data path this doc routes to a _chosen_ server.
> - **Updates** the 2026-06-28 serve-info decision — the per-user advertisement stays the LOCAL auto-detect mechanism; this doc adds the explicit-connection layer _above_ it for remote servers.
> - **Partially revisits (Phase 2 only, not Phase 1)** the 2026-06-28 "`cloud()`'s backend DECLINES when no service is configured" rule — see §7.3. Phase 1 does not touch it.

## 1. What we're solving

Owner directive (verbatim intent): _"vx cloud needs to work like Arcane (the Docker management app). It should be a client that connects to a server, so it can be run locally against the local env. And it should be possible to deploy an orchestrator service remotely, and vx cloud remotely connects them together and used like Nx Cloud. But also locally it should be possible to send data via OTel or some native things. It needs to be flexible remote and local."_

What exists today:

- **Local mode already works, zero-config.** `vx-cloud serve` advertises itself per-user (`serve-info.ts`); the `cloud()` plugin auto-detects it and pushes every run's `RunSummaryRecord` to `<origin>/v1/ingest`. Start the serve, open the dashboard, done.
- **Remote mode exists only as raw env vars.** Point `VX_CLOUD_INGEST_URL` (telemetry) / `VX_SERVICE_URL` (delegation) / `VX_REMOTE_CACHE_*` (cache) at a deployed serve. Works, but there is no persistence, no named servers, no `connect` verb, no way to switch — every shell needs exports, every developer copies URLs around.
- **No auth anywhere.** `POST /v1/ingest` accepts any body from anyone; the WS run delegation executes arbitrary shell on the serve's machine for any connector; the `/v1/*` analytics are world-readable. Fine on localhost; disqualifying for a shared deployment.
- **No server identity.** A dashboard pointed at two serves looks identical; `/version` leaks the workspace path but not a name.

The missing piece is the **client-side connection layer**: named server environments (docker-context-style), a `connect` verb that validates and persists, a resolution precedence the plugin consults lazily, and a bearer token both ends honor. That is Phase 1. The Nx-Cloud-like remote _orchestration_ (workers executing your graph) mostly exists as scaffolding (ephemeral coordinator + worker) and is deliberately roadmap, not this increment (§7).

## 2. Conceptual model

Two roles, one wire:

| Role       | Concrete artifact                                                                             | Responsibilities                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLIENT** | the `cloud()` plugin inside every `vx run`; the `vx-cloud` CLI (`connect`/`env`/`disconnect`) | decide _which server_ this run talks to (precedence, §4.4); push the run summary to it; optionally delegate execution to it; manage the per-user environment list                  |
| **SERVER** | `vx-cloud serve` (same binary local or Docker/Helm)                                           | ingest pushed summaries into its own SQLite store; serve the dashboard + `/v1/*` analytics; accept WS run delegation; (roadmap) host the artifact store + a persistent coordinator |

**Local mode** — the Arcane "manages the local env out of the box" half: the serve runs on the dev machine, is found via the per-user serve-info advertisement, needs no config, no token, no environment entry. Unchanged by this doc.

**Remote mode** — the Arcane "add a remote environment" half: a serve is deployed on a shared box (`docker run … vx-cloud serve --token …`). Clients CONNECT to it explicitly, once: `vx-cloud connect https://vx.corp.example --token …`. From then on every `vx run` on that machine pushes there, and the CLI can switch between named servers.

### 2.1 The one structural decision: environments live CLIENT-side

Arcane's literal model is a server-side registry — the server connects out to agents on remote hosts. That inverts for vx and is **rejected**: vx runs originate on developer machines and CI runners the server cannot reach into; the data flow is client-push (already shipped as the telemetry capability), not server-pull. The correct precedent is **`docker context` / kubeconfig**: a per-user, client-side list of named servers with one active, env vars overriding for CI. The server stays passive — it identifies itself (`/v1/meta`, §6.1) and validates tokens; it holds no client registry.

What survives from the Arcane framing: one server binary hosting the UI; the local environment working with zero setup; remote environments added by an explicit connect; the UI telling you which server you're looking at.

## 3. Access pattern

What actually gets called, how often:

| Call                                                                | Frequency                                                                            | Cost budget                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| environment resolution (plugin `telemetry()` / `backend()` consult) | ≤2× per `vx run`, only when the capability is consulted and opts/env vars are absent | **at most ONE memoized fs read** of `environments.json` per process (same class as today's one `serve-info` read); zero network |
| `POST /v1/ingest` with bearer                                       | 1× per run, at run end, never-fail, 5s-bounded                                       | unchanged; +1 header                                                                                                            |
| `vx-cloud connect` / `env ls                                        | use                                                                                  | rm`                                                                                                                             | human-interactive, rare | may probe `/health` + `/v1/meta` with short timeouts |
| serve auth check                                                    | every request when a token is set                                                    | one constant-time compare; zero when no token configured                                                                        |

The hard invariant restated: **a plain `vx run` with no cloud config (no env vars, no environments file, no local serve) stays zero-overhead** — both capabilities decline after one ENOENT `readFileSync` (memoized) + the existing serve-info read. No network I/O is ever added to the decline path.

## 4. Environments (docker-context-like)

### 4.1 The file

Per-user client config, owned entirely by `@vzn/vx-cloud` (core never reads it):

```
$VX_CLOUD_CONFIG                                   # exact-path override (tests / exotic setups)
  else $XDG_CONFIG_HOME/vx-cloud/environments.json
  else ~/.config/vx-cloud/environments.json
```

Note the split from `serve-info.json` is deliberate: serve-info is _runtime state_ (lives in `$XDG_RUNTIME_DIR`, auto-cleared on logout, written by the server); environments are _durable user config_ (live in `$XDG_CONFIG_HOME`, written by the CLI). Different lifecycles, different dirs.

**Format (versioned — the on-disk-format rule):**

```json
{
  "version": 1,
  "active": "team",
  "environments": {
    "team": { "url": "https://vx.corp.example", "token": "vxc_…" },
    "staging": { "url": "https://vx-staging.corp.example", "token": "vxc_…", "delegate": true }
  }
}
```

- `version` — readers reject unknown versions. The **plugin** treats a bad/unknown/malformed file as absent (warn once, decline — a corrupt config file must never fail a run); the **CLI** hard-errors with the path (the user is present to fix it).
- `active` — the name of the current environment. One top-level pointer, not a per-entry `default` flag: two defaults are structurally impossible. `VX_CLOUD_ENV=<name>` overrides the pointer per-shell (the `DOCKER_CONTEXT` analog) without touching the file.
- `environments` — map keyed by name (`[a-z0-9._-]+`). Entry fields: `url` (required, validated `new URL`), `token?` (bearer), `delegate?` (default `false` — whether the backend capability may route _execution_ here, §4.5).
- File mode `0600`, directory `0700`, enforced on every write (it holds tokens, §5.2).

### 4.2 New module: `packages/cloud/src/environments.ts`

Light by construction — `node:fs/os/path` only, importable from the lean `@vzn/vx-cloud/plugin` subpath exactly like `serve-info.ts`:

```ts
export interface CloudEnvironment {
  name: string
  url: string
  token?: string
  delegate?: boolean
}

export function environmentsPath(): string // the 3-step path resolution
export function readEnvironmentsFile(): EnvironmentsFile | undefined // uncached; CLI use (hard-errors surface here)
export function activeEnvironment(): CloudEnvironment | undefined
// MEMOIZED per process (one fs read ever, shared by telemetry + backend consults).
// VX_CLOUD_ENV > file.active; unknown name / bad file → undefined, never throws.
export function writeEnvironmentsFile(file: EnvironmentsFile): void // atomic write + chmod 600
```

The memo is the laziness guarantee the directive asks for: the plugin's two capability consults share one cached read, and the read happens only after the option/env-var rungs of the ladder came up empty — i.e. never in a fully env-var-configured CI run.

### 4.3 CLI verbs (all in new `packages/cloud/src/cli/env.ts`, dispatched by `bin.ts`)

```
vx-cloud connect <url> [--name <n>] [--token <t>] [--delegate] [--no-use]
vx-cloud env ls
vx-cloud env use <name>
vx-cloud env rm <name>
vx-cloud disconnect
```

- **`connect`** — the handshake: (1) `GET <url>/health` (2s timeout; unreachable → error, nothing persisted); (2) `GET <url>/v1/meta` (§6.1) for the server's name (used as the default `--name` fallback ahead of the URL hostname) and its `auth` mode — if the server requires a token and none was given, error with the fixit _before_ persisting; (3) if a token was given, verify it with one authenticated `GET /v1/runs?limit=1` (expect 200, not 401); (4) persist the entry + set it `active` (skip activation with `--no-use`). Re-`connect` on an existing name with the same URL updates in place (the re-auth flow); a different URL under an existing name errors unless `--force`.
- **`env ls`** — table: name, url, `delegate` flag, ACTIVE marker, and a live reachability + server-name column (parallel `/health`+`/v1/meta` probes, 1s timeout, `unreachable` on failure). The local auto-detected serve is shown as a synthetic first row `(local)` when its advertisement is alive, so the full picture is one command.
- **`env use <name>`** — set `active`. **`env rm <name>`** — delete (clearing `active` if it pointed there). **`disconnect`** — clear `active` only (entries + tokens survive; local auto-detect becomes the effective fallback again).

### 4.4 Resolution precedence — telemetry push

Consulted inside `cloud()`'s `telemetry()` capability, first match wins:

| #   | Source                                                                                | Who it serves                                                                                                   |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | `cloud({ ingestUrl, ingestToken })` plugin options                                    | workspace-pinned config in `vx.workspace.ts`                                                                    |
| 2   | `VX_CLOUD_INGEST_URL` / `_TOKEN` env (legacy `_INSIGHTS_` aliases kept)               | CI, Docker, per-shell overrides — **env beats the active environment**, matching `DOCKER_HOST` > active context |
| 3   | **active named environment** → `<url>/v1/ingest` + its token                          | the connected developer machine (NEW)                                                                           |
| 4   | local serve auto-detect (serve-info + `pidAlive`, unchanged incl. the self-pid guard) | zero-config local dashboard                                                                                     |
| 5   | decline                                                                               | plain run, zero overhead                                                                                        |

### 4.5 Resolution precedence — backend delegation

| #   | Source                                                 | Note                                                                                                                |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `cloud({ serviceUrl })` option                         | unchanged                                                                                                           |
| 2   | `VX_SERVICE_URL` env                                   | unchanged                                                                                                           |
| 3   | **active named environment, ONLY if `delegate: true`** | NEW; the token rides the WS upgrade (§5.3)                                                                          |
| 4   | decline                                                | **Phase 1 keeps the 2026-06-28 rule: no local serve auto-detect for execution** (§7.3 makes it Phase 2, coherently) |

Why `delegate` is opt-in per environment and not implied by `connect`: delegation executes the run **on the server** against `request.cwd` — only correct when the server shares the filesystem (local serve) or holds an identical checkout at the same path (a shared build box). For the common remote case (analytics server) implicit delegation would fail every run with a confusing missing-workspace error. Connecting for the dashboard must never silently move execution. `--delegate` at connect time (or editing the file) is the explicit opt-in, and the existing `resolveBackend` fail-safe (unreachable → local, 300ms probe) still applies on top.

Cache (`VX_REMOTE_CACHE_*`) is **deliberately not** in the environment entry for Phase 1 — today's serve hosts no artifact endpoint, so there is nothing for it to point at. It joins the environment when the serve grows `/v8/artifacts` (§7.4 roadmap), which is what makes `connect` a true one-URL Nx-Cloud-style setup.

### 4.6 Plugin changes (exact)

`packages/cloud/src/plugin.ts`:

- `ingestUrlOf()`/token resolution extends with rung 3: `activeEnvironment()` (memoized read) before `detectLocalIngestUrl()`. ~15 LOC.
- `backend()` extends with rung 3: after the `serviceUrl`/env check fails, `activeEnvironment()`; if `delegate === true`, lazy-import `resolveBackend` and pass the env's url + token. Still declines with no probe when nothing is configured. ~15 LOC.
- `CloudIngestSink` unchanged (already carries an optional bearer).

No change to `setup()` (environment URLs are validated at `connect` time, not per run — a run never pays validation for config it may not use).

## 5. Auth

### 5.1 Server side (`serve.ts`)

- New `--token <t>` flag / `VX_CLOUD_TOKEN` env (flag wins). **No token configured → fully open, byte-identical to today** (localhost default stays zero-friction).
- When set, every request **except `/health` and `/v1/meta`** requires `Authorization: Bearer <t>`: all `/v1/*` reads, `/version` (it leaks the workspace path — it moves behind the token), `/v1/ingest`, `/events`, `/stream`, and the **WS upgrade** (checked before `srv.upgrade(req)`). Failure → 401 JSON (`WWW-Authenticate: Bearer`), or a refused upgrade.
- Browser transports can't set headers on `EventSource`/`WebSocket`, so `?token=<t>` is accepted as an equivalent for `/events`, `/stream`, and the WS upgrade only. (Accepted cost: tokens can appear in server-side logs for those three endpoints; the header form is canonical everywhere else.)
- Comparison is constant-time: SHA-256 both sides, `crypto.timingSafeEqual` (fixed length, no early exit).
- CORS `Access-Control-Allow-Headers` gains `Authorization` (the SPA on a foreign origin must be able to send it).
- One helper `authorized(req: Request, url: URL): boolean` at the top of `fetch()` — a single gate, not per-route checks.

Exemptions rationale: `/health` stays open for probes/k8s; `/v1/meta` is the identity handshake `connect` needs _before_ the user has proven a token, and it carries no secrets and no workspace path.

### 5.2 Client side

- Tokens live in `environments.json` (mode `0600`, dir `0700`) — the kubeconfig/`~/.docker/config.json` precedent. `env ls` never prints tokens.
- The ingest sink and `serviceBackend` send `Authorization: Bearer` when the resolved source carries a token (ingest already does; the WS path is new).

### 5.3 `serviceBackend` token plumbing

`packages/cloud/src/cli/backend.ts`: `serviceBackend(origin, sink?, token?)` — Bun's client `WebSocket` accepts a `headers` option, so the bearer rides the upgrade request. `resolveBackend` gains the same optional token param, threaded from the plugin's environment rung. ~15 LOC.

### 5.4 Deferred (explicitly)

Multiple tokens / per-user identity, token scopes (read-only vs ingest vs delegate), token issuance/rotation (`vx-cloud token create`), OAuth/SSO, org multi-tenancy, OS-keychain storage, TLS (a reverse proxy's job — serve stays plain HTTP behind it). Single shared bearer per server is the whole Phase 1 story; it matches what `ducktors/turborepo-remote-cache`-class deployments do and is enough for a trusted team.

## 6. UI implications

### 6.1 Server identity: new `GET /v1/meta`

```json
{ "v": 1, "name": "corp-ci", "vx": "0.x.y", "auth": "token", "startedAt": 1751443200000 }
```

- `name`: `--name` flag > `VX_CLOUD_NAME` > `os.hostname()`. Runtime identity, not persisted.
- `auth`: `"token" | "open"` — drives the `connect` handshake and the SPA's token prompt.
- Auth-exempt (§5.1); deliberately excludes the workspace path (`/version` keeps that, behind the token). A new endpoint rather than extending `/version` because the two have opposite auth postures.

### 6.2 Dashboard

- **Environment badge** in the shell header: the server `name` + origin from `/v1/meta`, so two open dashboards are distinguishable at a glance. Fetched once per origin.
- **Token support in `api.ts`**: a `vx-ui:token` localStorage signal beside the existing `vx-ui:origin`; `getJson` adds the `Authorization` header; the `EventSource`/WS URLs append `?token=`. A 401 anywhere surfaces the token prompt in the existing connection settings.
- `serveCmd` startup print gains the name: `vx serve: API  http://…  (corp-ci)`.

### 6.3 CLI output

`vx-cloud env ls` (§4.3) is the client-side mirror: every named server + the synthetic `(local)` row, with active marker, reachability, and the server's self-reported name.

## 7. Remote orchestration — what exists, the honest gaps, the increment

### 7.1 Exists today

- **WS run delegation on serve**: submit a `RunRequest`, the serve executes `run()` in-process against `request.cwd`, streams `WireEvent`s back, shares an `inflight` dedup map across concurrent delegated runs. Rendering is byte-identical client-side via `createWireRenderer`.
- **Ephemeral coordinator** (`coordinator.ts`): builds the graph via `prepareForCoordinator`, hashes each node (content-addressed assignment), fans `task:assign` to WS workers, reassigns stranded tasks on worker drop, drains and exits when the graph completes.
- **Stateless worker** (`worker.ts`): hello/pull/execute/report loop over `workerExecute`; assumes a full identical workspace checkout.

### 7.2 Honest gap list (why this is not Nx Cloud yet)

| Gap                                                                                                                                                                                                     | Severity                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Coordinator is **per-run ephemeral** — no persistent global scheduler, no queueing/fairness across runs, no run history of its own                                                                      | blocks "always-on service"                            |
| **No input shipping** — workers need the whole checkout at the same path; dirty working trees and untrusted workers are unsupported (the blob-CAS/git-OID sketch in `core-cloud-split §3.3` is unbuilt) | blocks "rent a worker"                                |
| **Workers don't touch the cache** — every assigned task executes (`cacheSource: 'miss'`), outputs are not uploaded anywhere; no artifact flow back to the submitter                                     | blocks correctness of distributed builds with outputs |
| Coordinator/worker have **no auth** and are a separate port/process from serve — not reachable through the one connected URL                                                                            | blocks shared deployment                              |
| Delegated runs **don't land in the ingest store** (the serve's own pid-guard declines the self-push), so the dashboard misses them                                                                      | blocks the delegation UX                              |
| No multi-tenancy, no per-org stores                                                                                                                                                                     | blocks SaaS                                           |

### 7.3 The increment now — deliberately minimal

**Phase 1 ships NO orchestration work.** The minimal shippable slice of "used like Nx Cloud" is the **analytics half**: a deployed serve + environments + `connect` + tokens = every developer's and CI's runs aggregated in one authenticated team dashboard. That is real, immediate value on top of code that already works, and it's what the environment layer enables by itself.

**Phase 2** makes _delegation_ coherent as one unit (and only then): (a) restore local-serve auto-detect for the backend — one fs read + `pidAlive` gate, the 300ms health probe firing only when a live advertisement exists, so the no-serve decline path stays zero-network (this consciously narrows the 2026-06-28 "backend always declines unconfigured" rule; the cost gate is what makes the revisit honest); (b) delegated runs must self-ingest — the serve records the summary of runs it executes into its own `IngestStore`. (b) needs the one small core change on this whole roadmap: an additive, observe-only `RunOptions.telemetrySinks?: readonly TelemetrySink[]` (~10 LOC in `run.ts`/`telemetry-host.ts`) so an embedder can attach a sink without a workspace plugin; the alternative — the serve re-deriving a `RunSummaryRecord` from `RunSummary` outcomes — duplicates ~60 LOC of summary construction and drifts. Decision deferred to Phase 2's own review; Phase 1 needs neither.

**Phases 3+** are the true Nx-Cloud roadmap, in order of value: serve-hosted artifact store (`/v8/artifacts`, Turbo wire, CAS-dir/volume backing — this is what makes `connect` configure the remote _cache_ too, the single highest-value remote feature); then the persistent coordinator + queueing (own design doc, per `core-cloud-split §3.4`); then blob-CAS input shipping (`§3.3`); then multi-tenancy. Not designed here — listed so nobody mistakes Phase 1 for them.

## 8. Local export flexibility — otel() + cloud() coexistence

Confirmed: **no changes needed.** The telemetry capability is additive by design — `subscribeTelemetry` collects sinks across _all_ declared plugins into one crash-isolated `TelemetrySource`; `otel()` (OTLP traces/metrics, streaming records) and `cloud()` (one summary POST) already run side-by-side from the repo's own `vx.workspace.ts`. Their flushes run in parallel (`Promise.all`), so end-of-run latency is the max, not the sum. Each declines independently when unconfigured, and the environments rung slots into `cloud()`'s ladder without touching `otel()` or core's telemetry host. A developer can therefore simultaneously: push to the team serve (active environment), trace to a local Jaeger (`OTEL_EXPORTER_OTLP_ENDPOINT`), and keep the terminal output untouched. Users needing two ingest targets at once declare `cloud({ ingestUrl })` twice with explicit options — supported today, not a goal to sugar.

## 9. Isolation review

**Core (`src/`): ZERO changes in Phase 1.** No new exports, no new options, no config reads. The environment layer lives entirely behind the already-shipped plugin capabilities; the package-boundaries guard is untouched. (The single candidate core change on the whole roadmap is Phase 2's `RunOptions.telemetrySinks`, §7.3 — additive, observe-only, decided then.)

### 9.1 File-by-file (Phase 1)

| File                                                                  | Change                                                                                 | Est. size |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------- |
| `packages/cloud/src/environments.ts`                                  | NEW — path resolution, versioned read/write, `activeEnvironment()` memo, chmod 600     | ~140 LOC  |
| `packages/cloud/src/cli/env.ts`                                       | NEW — `connectCmd`, `envCmd` (ls/use/rm), `disconnectCmd` + parsers + handshake        | ~200 LOC  |
| `packages/cloud/src/cli/bin.ts`                                       | dispatch `connect`/`env`/`disconnect`; help text                                       | ~25 LOC   |
| `packages/cloud/src/plugin.ts`                                        | environment rung in the ingest + backend ladders; token threading                      | ~40 LOC   |
| `packages/cloud/src/cli/serve.ts`                                     | `--token`/`--name` + envs, `authorized()` gate, `/v1/meta`, CORS header, startup print | ~80 LOC   |
| `packages/cloud/src/cli/backend.ts`                                   | `token?` param on `serviceBackend`/`resolveBackend`, WS auth header                    | ~15 LOC   |
| `packages/cloud/src/index.ts`                                         | export the environments API + types                                                    | ~6 LOC    |
| `packages/cloud/ui/src/api.ts` + shell component                      | token signal + header, `/v1/meta` badge                                                | ~60 LOC   |
| docs (`packages/cloud/README`, self-hosting guide, `vx-cloud --help`) | connect/env/auth sections                                                              | prose     |

### 9.2 Test plan

- `packages/cloud/tests/environments.test.ts` — path precedence (`VX_CLOUD_CONFIG` > XDG > home), versioned round-trip, mode 0600 asserted, malformed/unknown-version → plugin-path returns undefined (no throw) while CLI-path errors, `VX_CLOUD_ENV` override, memo = exactly one fs read across two consults (fs spy).
- `packages/cloud/tests/env-cli.test.ts` — `connect` against a real started serve (validates, persists, activates; server-requires-token without one → error, nothing persisted; wrong token → 401 error, nothing persisted); dead URL → no write; `use`/`rm`/`disconnect` semantics; `env ls` renders the `(local)` synthetic row against a live advertisement.
- `packages/cloud/tests/serve.test.ts` (extend) — token gate: 401 on `/v1/*`+ingest+`/version` without/with-wrong bearer, 200 with; `?token=` accepted on `/events` + WS upgrade; `/health` + `/v1/meta` open; no-token serve byte-identical (existing suites re-run under it); `/v1/meta` shape + name resolution.
- `packages/cloud/tests/plugin.test.ts` (extend) — precedence: env var beats active environment beats serve-info; active environment's token lands on the ingest POST (mock server asserts the header); `delegate: false` environment never touches the backend; `delegate: true` routes with the bearer on the upgrade; nothing configured → both capabilities decline, zero sinks (the perf invariant pin).
- UI: manual e2e over CDP per house practice (badge renders against a named serve; 401 → token prompt → data loads).

## 10. Alternatives considered (briefly)

- **Server-side agent registry (literal Arcane)** — rejected §2.1: the data flow is client-push; the server can't reach dev machines.
- **Workspace-level connection (`cloud({ ingestUrl })` in `vx.workspace.ts`) as THE mechanism** — rejected as the _only_ mechanism: it's committed and team-shared, so it can't carry personal tokens or per-developer choices; it stays as precedence rung 1 for workspace-pinned deployments.
- **Env-var-only (status quo)** — rejected: right for CI (and kept as rung 2), unusable ergonomics for humans across shells and reboots.
- **Reusing `serve-info.json`'s runtime dir for environments** — rejected: runtime state vs durable config; `$XDG_RUNTIME_DIR` is cleared on logout, which is correct for advertisements and wrong for connections.
- **Separate credentials file (token split from config)** — rejected for now: one 0600 file is the kubeconfig-grade posture; a split adds ceremony without a threat-model change. Keychain is the real upgrade, deferred.
- **Per-entry `default: true` flags** (as sketched in the directive) — rejected in favor of one top-level `active` pointer: mutually-exclusive flags across entries are a representable-invalid-state bug waiting to happen.
- **Extending `/version` instead of `/v1/meta`** — rejected: `/version` leaks the workspace path and belongs behind the token; identity must be pre-auth. Opposite auth postures ⇒ two endpoints.
- **Implicit delegation on connect** — rejected §4.5: silently moving execution to a box without your checkout breaks every run; `--delegate` is the explicit opt-in.

## 11. Non-goals (this doc)

- No persistent coordinator, no queueing, no worker/cache integration, no input shipping — §7.2's gaps stay gaps; §7.3 fences the roadmap.
- No multi-user auth, scopes, rotation, OAuth, or multi-tenancy (§5.4).
- No TLS in serve (reverse proxy's job).
- No core changes in Phase 1; no new core CLI flags ever (delegation config is a plugin/env concern).
- No server-side client registry or "push config to clients".
- No change to the otel plugin or the telemetry contract (`TELEMETRY_SCHEMA_VERSION` stays 1; the push body is unchanged — only _where_ it goes gains a rung).

## 12. Phased plan

| Phase                                                           | Ships                                                                                                                                                                                             | Status                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **1 — environments + connect + auth + badge** (shippable today) | `environments.ts`, `connect`/`env`/`disconnect`, the two precedence ladders in `cloud()`, `serve --token/--name`, `/v1/meta`, the auth gate, WS bearer, UI badge + token field, tests + docs (§9) | this doc's deliverable |
| **2 — coherent local delegation**                               | backend local-serve auto-detect (cost-gated, revisits the 2026-06-28 decline rule) + serve self-ingest of delegated runs (needs the one core `RunOptions.telemetrySinks` decision)                | roadmap, own review    |
| **3 — serve-hosted artifact store**                             | `/v8/artifacts` on serve (Turbo wire, CAS/volume), environments feed `cache` — `connect` becomes one-URL cache + analytics                                                                        | roadmap                |
| **4 — persistent coordinator + queueing**                       | the always-on global scheduler (`core-cloud-split §3.4`)                                                                                                                                          | own design doc         |
| **5 — CAS input shipping, multi-tenancy**                       | `core-cloud-split §3.3` + org tokens                                                                                                                                                              | own design doc         |

## 13. Why this is the right move

- **It adds the one missing layer (named, persistent, authenticated connections) without touching core** — the plugin capabilities shipped in June already carry everything; Phase 1 is ~500 LOC of cloud-package code plus tests.
- **The precedence ladder degrades exactly along the flexibility axis the owner asked for**: workspace-pinned > CI env vars > connected server > zero-config local > nothing — each rung independently useful, each cheaper than the one above it, ending at the preserved zero-overhead decline.
- **It picks the model that matches the shipped data flow** (client-push, docker-context-style client config) instead of force-fitting Arcane's server-pull registry.
- **Auth lands where the risk is** (shared deployments) at zero cost where it isn't (no token → byte-identical localhost behavior).
- **It refuses to overreach on orchestration**: the honest gap list (§7.2) is written down, the delegation footguns are fenced behind explicit opt-ins, and the Nx-Cloud heavy lifting stays in clearly-owned later phases rather than leaking half-built into this one.

## 14. Open questions

- **Phase 2's self-ingest mechanism** — `RunOptions.telemetrySinks` (small core addition) vs serve-side summary reconstruction (cloud-only duplication). Lean: the core addition; decide at Phase 2.
- **Token format** — opaque string today; a `vxc_` prefix convention would help secret scanners. Cheap, decide at implementation.
- **`env ls` probe default** — always probe (1s worst-case per unreachable env, parallel) vs `--probe` opt-in. Lean: always, with the timeout.
- **Should `connect` also write `VX_REMOTE_CACHE_*` guidance** once Phase 3 lands, or auto-wire the cache rung silently? Lean: auto-wire via the environment entry, with `env ls` showing which capabilities the server advertises in `/v1/meta`.
