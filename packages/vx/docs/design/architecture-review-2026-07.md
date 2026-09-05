# Architecture review — simplify, DX, develop further (2026-07)

> **Status:** proposal (2026-07-03)
>
> Principal-architect review answering the owner's question: _"looking at
> the arch what would you simplify, improve and develop further? Take into
> account dev experience, their workflows, and context switching between CI
> and local."_ Three lenses: **Simplify**, **Improve DX / CI↔local**,
> **Develop further**. Every claim is checked against code (file:line).
> Reconciles with the shipped decision log and the 2026-07 consulting
> review; contradictions with prior decisions are called out explicitly in
> §7.

## 1. What we're solving

The core runner is in good shape (the consulting review's verdict holds:
strong scheduler/cache, clean module boundaries). The accretion is on the
**cloud/connection surface**. Since the June split, the "talk to a serve"
story has grown three capabilities (backend / cache / telemetry), three
discovery mechanisms (env vars / `environments.json` / `serve-info.json`),
and a matching set of env vars — each capability wired independently. The
result works, but a developer who wants "local dashboard + shared remote
cache + CI reporting" touches **three different URLs and three different
tokens for what is one server**, and there is no single command that
answers "where am I connected and what will this run do."

This review proposes a **smaller connection surface** and a **single
continuous local↔CI context**, plus a ranked list of the highest-leverage
next capabilities. It proposes **no rewrite** and preserves every shipped
behavior (the env vars stay as overrides; nothing silently changes).

## 2. Method & scope

Verified against: `packages/cloud/src/plugin.ts`,
`packages/cloud/src/{environments,serve-info}.ts`,
`packages/cloud/src/cli/{backend,env,agent,dev,bin}.ts`,
`src/orchestrator/{remote-cache-setup,options,metrics}.ts`,
`src/cli/{index,info,run,help}.ts`, `docs/architecture.md`, and the
2026-07 consulting review + `dev-flows-ci-agents-2026-07.md` +
`distributed-execution-2026-07.md`.

**In scope:** the connection/discovery surface, env-var sprawl, the
resolution ladders, `vx info`/doctor DX, the CI↔local workflow, and a
ranked "develop further" list.

**Out of scope** (owned elsewhere, referenced not duplicated): cache
trust-scopes (separate in-flight design), the persistent coordinator /
queueing (`distributed-execution-2026-07.md` KNOWN-OPEN §13), the P0
correctness items already tracked (`isOutputsCurrent`, restore-tier
assert), UI polish items (consulting review §7 P3), and any change to the
task-execution model ("shell is the API" is not up for revision).

---

## 3. Lens 1 — Simplify

### 3.1 The connection surface is one server described three times

`cloud()` contributes three capabilities, each with its own resolution
ladder and its own env vars, all ultimately pointing at the same
`vx-cloud serve`:

| Capability | URL env var (`plugin.ts`)      | Token env var (`plugin.ts`)                | Ladder location     |
| ---------- | ------------------------------ | ------------------------------------------ | ------------------- |
| backend    | `VX_SERVICE_URL` (`:128`)      | `VX_CLOUD_TOKEN` (`:221`, distribute path) | `plugin.ts:98–139`  |
| cache      | `VX_REMOTE_CACHE_URL` (`:194`) | `VX_REMOTE_CACHE_TOKEN` (`:148`)           | `plugin.ts:141–162` |
| telemetry  | `VX_CLOUD_INGEST_URL` (`:235`) | `VX_CLOUD_INGEST_TOKEN` (`:240`)           | `plugin.ts:164–189` |

Plus a fourth ladder inside `resolveBackend` (`cli/backend.ts:117–142`:
`serviceUrl` → `VX_SERVICE_URL` → `serve-info` → local) that the backend
capability delegates into, and `VX_CLOUD_URL` which today is read **only**
in the distribution target resolver (`plugin.ts:219`) as an alias for
`VX_SERVICE_URL`.

Each of the three ladders re-implements the same shape by hand:
`explicit option/env → activeEnvironment() → (serve-info) → decline`
(`plugin.ts:128–138`, `:146–161`, `:175–188`). They consult
`activeEnvironment()` (`environments.ts:142`) and `readServeInfo()`
(`serve-info.ts:68`) independently, with subtly different rungs (only
telemetry auto-detects the local serve; only cache runs the `/v1/meta`
artifacts probe; only backend gates on `delegate`).

**Cost of the status quo, concretely.** To run against one team serve
that does analytics + cache + delegation, CI must set:

```
VX_REMOTE_CACHE_URL=https://vx.corp   VX_REMOTE_CACHE_TOKEN=…
VX_CLOUD_INGEST_URL=https://vx.corp/v1/ingest   VX_CLOUD_INGEST_TOKEN=…
VX_SERVICE_URL=https://vx.corp   VX_CLOUD_TOKEN=…
```

Three URLs, three tokens, one server. Locally the `connect` model already
collapses this (one `vx-cloud connect <url> --token` writes one entry that
all three ladders read via `activeEnvironment()`) — but that path is
unavailable in CI (it writes `$XDG_CONFIG_HOME`, ephemeral on runners),
so CI is forced back onto the sprawl.

### 3.2 Recommendation: one connection concept + one resolver

Introduce a single shared **connection** — one base URL + one token —
consulted by all three capabilities, with the existing per-capability env
vars kept as **overrides** for the genuinely-split-server case.

**(a) One CI env pair.** Promote `VX_CLOUD_URL` + `VX_CLOUD_TOKEN` from the
distribute-only alias (`plugin.ts:219`) to the shared fallback rung for
all three capabilities. From one base origin derive: telemetry =
`<origin>/v1/ingest`, cache = `<origin>` (Turbo `/v8/artifacts` already
lives under the same origin — `serve.ts` hosts it there), backend =
`<origin>` (WS-derived). CI becomes:

```
VX_CLOUD_URL=https://vx.corp   VX_CLOUD_TOKEN=…   vx run ci
```

Same two pieces of information a developer already gives `vx-cloud
connect`. This is the "one connection concept" the owner asked for.

**(b) One resolver.** Extract a single
`resolveConnection(): Connection | undefined` into `plugin.ts` (or a light
sibling), returning `{ origin, token?, socket?, delegate, artifacts?,
source }`. Its ladder is the union that today is copy-pasted three times:

```
1. VX_CLOUD_URL (+ VX_CLOUD_TOKEN)          // CI: one pair
2. activeEnvironment()                        // dev: `connect` once
3. local serve-info (pid-alive)               // zero-config local dashboard
→ undefined  (decline — zero overhead, byte-identical to pre-plugin vx)
```

Each capability then becomes a thin endpoint derivation over the shared
connection, applying only its own gate:

| Capability | Uses the connection when…                                     | Endpoint            |
| ---------- | ------------------------------------------------------------- | ------------------- |
| telemetry  | always (it's observe-only, never changes a run)               | `/v1/ingest` / sock |
| cache      | `/v1/meta` advertises `artifacts:true` (existing probe)       | `/v8/artifacts`     |
| backend    | **delegate opt-in only** (env `delegate` flag / `--delegate`) | WS origin           |

**Safety preserved.** The backend gate is the load-bearing subtlety: a URL
alone must **not** move execution to the server (that would silently
relocate a dev's build when they only wanted a dashboard). This is already
the rule (`plugin.ts:119–138`, `environments.ts:26–29`); the resolver keeps
it — `VX_CLOUD_URL` enables cache + telemetry, but delegation still
requires the explicit opt-in. The precedence keeps specific env vars
winning, so `VX_REMOTE_CACHE_URL` pointed at a **separate** cache host
still overrides the unified connection for cache only.

**Migration.** Additive and backwards-compatible. Existing env vars keep
their exact meaning as capability-specific overrides (rung 0, above the
shared connection). No behavior changes for any workspace that sets the
old vars. New workspaces and CI use the one pair. Version sentinel:
`environments.json` already carries `ENVIRONMENTS_VERSION = 1`
(`environments.ts:18`) — no bump needed (the file shape is unchanged; this
is purely the env/resolver layer).

### 3.3 Keep all three discovery files — but layer them under the resolver

The three discovery mechanisms are **not** redundant; they have distinct,
correct lifecycles (documented at `environments.ts:5–12`,
`serve-info.ts:1–14`):

| Mechanism           | Lives in           | Written by      | Lifecycle           | Role                |
| ------------------- | ------------------ | --------------- | ------------------- | ------------------- |
| env vars            | process env        | the invoker/CI  | per-shell           | CI + override       |
| `environments.json` | `$XDG_CONFIG_HOME` | `connect`/`env` | durable             | dev's named servers |
| `serve-info.json`   | `$XDG_RUNTIME_DIR` | the serve       | auto-cleared/logout | local zero-config   |

**Do not collapse them.** The simplification is not fewer files — it's
**one resolver** that reads them in one place (§3.2b), so a capability
never again re-implements the ladder and the three can't drift on
precedence. The consulting review's TEST-1 (serve-info test clobbering)
is a symptom of ad-hoc reads scattered across modules; a single resolver
is where the `pinServeInfo()` guard naturally attaches.

### 3.4 `metrics.ts` — leave in place, keep the guard (do not churn)

`src/orchestrator/metrics.ts` is 1544 lines of SQL over cache-owned tables
(`runs`, `invocations`, `entry_inputs`), living in `orchestrator` rather
than `cache` (flagged CORE-9). Moving it across the dependency matrix is a
churn-heavy refactor with **zero behavior change**, and the schema-drift
risk it poses is already closed by the drift-guard test (every query runs
against a freshly-created schema in the gate). **Recommendation: do not
move it now.** This is the one place I explicitly recommend _against_ a
simplification the audit floated — the guard is the real fix; relocation
is cosmetic and would repeat the engagement's #1 finding (churn). Revisit
only if `cache` and `orchestrator` are being restructured for another
reason.

### 3.5 Vestigial / kill-or-commit surface

Confirmed dead-or-unreachable surface (nothing in the normal run path
depends on these — verified by grep for production callers):

| Surface                                    | Evidence                                                                                                                     | Recommend                                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vx dev` hub + `localDevBackend`           | `cli/dev.ts`, `cli/backend.ts:32`; unreachable in the shipped flow (CLOUD-6)                                                 | **Cut** unless the devframe UI is being revived. ~300 LOC + the `devframe` optional dep + `startUiServer` (CLOUD-10) go with it.                                             |
| `protocol-dist` JSON-RPC envelope adapters | test-only, ~90 LOC (CLOUD-11)                                                                                                | **Cut** until a transport consumes them (the shipped agents use `dist/` v1 = bare taskId, not this envelope).                                                                |
| `predictive` (`predict.ts`/`history.ts`)   | wired via `defineWorkspace({ predictive:true })` (`prepare.ts:264`); has a design doc now                                    | **Measure or delete.** Opt-in and documented, so lower-risk than when the audit flagged it — but still un-benchmarked. Run the bench once; keep only if it moves the number. |
| Retired verbs redirect noise               | core redirects `serve/dev/coordinator/worker` (`cli/index.ts:50–60`); cloud retires `coordinator`/`worker` (`bin.ts:93–104`) | **Keep** the redirects (they're good UX), but the count of retired-verb strings is a sign the service CLI churned — freeze it.                                               |

This is ~500 LOC of "archaeology" that reads as intentional API. Cutting it
is the cheapest legibility win in the tree.

### 3.6 Simplify — decision table

| #   | Simplification                                                  | Cost                                  | Migration                         |
| --- | --------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| S1  | One connection: `VX_CLOUD_URL`+`VX_CLOUD_TOKEN` feed all 3 caps | ~1 day; careful backend-delegate gate | additive; old vars = overrides    |
| S2  | One `resolveConnection()`; caps derive endpoints over it        | ~1 day; folds 4 ladders → 1           | internal; no external change      |
| S3  | Keep 3 discovery files, read them in one place                  | none (rides S2)                       | none                              |
| S4  | Do **not** relocate `metrics.ts` (guard suffices)               | none                                  | none                              |
| S5  | Cut `vx dev`/`localDevBackend`/`startUiServer`/`protocol-dist`  | lose the (unreachable) devframe hub   | remove verbs + `devframe` dep     |
| S6  | Measure-or-delete `predictive`                                  | one bench run                         | remove `predictive` field if flat |

---

## 4. Lens 2 — Improve DX + CI↔local context switching

### 4.1 The four real workflows (as they are today)

| Workflow                         | Today                                                                                               | Friction                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **A. Local + dashboard**         | `vx-cloud serve` once → `serve-info` advertised → `vx run` auto-pushes telemetry (`plugin.ts:185`)  | none — genuinely zero-config. This is the good path.                                                        |
| **B. Local + remote cache**      | `vx-cloud connect <url> --token` once; cache rung probes `/v1/meta` artifacts (`plugin.ts:156–161`) | fine, but connecting also routes telemetry to that env — no per-capability picture of where each thing goes |
| **C. CI reporting to the serve** | set `VX_REMOTE_CACHE_*` **and** `VX_CLOUD_INGEST_*` (§3.1)                                          | **the same server described twice**; no `connect` in CI                                                     |
| **D. Onboard a new repo**        | `vx migrate` → add `cloud()` to `vx.workspace.ts` → `connect`                                       | no scaffold for `vx.workspace.ts`; no copy-paste CI block                                                   |

The headline finding: **A dev sets the connection once locally (`connect`),
then sets it again — differently, twice over — in CI.** That is the
context switch the owner is pointing at. S1/S2 (§3) shrink "twice over" to
"the same one pair," which is the structural fix. The rest of this section
is the DX surface that makes the two contexts _feel_ like one.

### 4.2 Friction inventory (where you set / discover things more than once)

| Friction                                                             | Evidence                                                                                                          | Fix                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| One server needs 3 URLs + 3 tokens                                   | §3.1                                                                                                              | S1                                  |
| CI can't use `connect`; falls back to the sprawl                     | `environments.ts:57` writes `$XDG_CONFIG_HOME` (ephemeral)                                                        | S1 + D2 below                       |
| No single "where am I connected + what cache + what will run do"     | `vx info` is core-only facts (`cli/info.ts`); `env ls` is cloud-only (`env.ts:218`); prediction is `vx run --dry` | D1 (`vx status`)                    |
| Env vars silently override the active environment with no indication | `plugin.ts:175` (env beats `activeEnvironment()`)                                                                 | D1 shows effective resolution + why |
| `vx info` reports remote cache from `VX_REMOTE_CACHE_URL` only       | `cli/info.ts:51–52` — blind to `environments.json`                                                                | D1                                  |
| "Why no cache hit in CI?" has no terminal answer                     | `whyDidThisRerun`/`explainCacheKey` exist only as MCP RPCs (`mcp-rpc.ts:67,77`)                                   | D3 (`vx why`)                       |
| No copy-pasteable CI recipe                                          | `--report=markdown` exists (`cli/run.ts:425`) but is undocumented as a CI flow                                    | D2                                  |

### 4.3 D1 — a single `vx status` / doctor (respecting the split)

Today the picture is split across `vx info` (core), `vx-cloud env ls`
(cloud), and `vx run --dry` (prediction). Two shippable options:

- **Immediate (cheap, split-respecting):** `vx-cloud status` — one screen
  that runs the resolver (S2) and prints the **effective** connection per
  capability with reachability: `connected: team (https://vx.corp) [active]`,
  `telemetry → /v1/ingest ✓`, `cache → /v8/artifacts (artifacts:true) ✓`,
  `delegate: off`, and crucially _"env VX_REMOTE_CACHE_URL overrides active
  environment for cache"_ when an override is in play. This is `env ls`
  (`env.ts:218`) grown into a full doctor. No core change.

- **Elegant (medium):** add a tiny **`status` plugin capability** so the
  core `vx` binary can show the same screen. `cloud()` contributes its
  connection section; `vx status` aggregates core facts (`vx info`) +
  plugin sections. This gives the owner's literal ask — one `vx status`
  command — **without core importing cloud or learning cloud's file
  paths** (it stays a run-level plugin seam, consistent with
  backend/cache/telemetry). It is the only clean way to surface connection
  state under the core binary while honoring "no service concepts in core."

Recommend shipping `vx-cloud status` now and the `status` capability as the
follow-up. Neither computes a full plan; both point to `vx run --dry` for
"what will this run do" (a real prediction is a whole run's hashing — not
doctor-cheap).

### 4.4 D2 — make the CI story copy-pasteable

The CI primitives already exist and compose well; they're just
undocumented as a flow and split across two contexts:

- `vx lock` + `vx run --frozen` (reproducible configs).
- `vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY` — already the exact
  documented target in code (`cli/run.ts:425`).
- CI flow auto-detection already sets `output-logs=full` and captures the
  CI provider into the invocation header.

**Recommendation:** on a successful `vx-cloud connect`, print the exact CI
env block to paste (`VX_CLOUD_URL=… VX_CLOUD_TOKEN=…` per S1) — a
`--print-ci` affordance, ~10 LOC over `connectCmd` (`env.ts:126`). Plus a
docs page: "the same two values you `connect` with locally are the two env
vars you set in CI." This is the smallest change that makes local↔CI feel
like one context: **the same connection, expressed once as a durable file
locally and once as two env vars in CI.** No full workflow generator (that
is scope creep against the "explicit over magical" principle).

### 4.5 DX — decision table

| #   | Improvement                                                    | Value | Effort | Depends on |
| --- | -------------------------------------------------------------- | ----- | ------ | ---------- |
| D1a | `vx-cloud status` doctor (effective resolution + reachability) | high  | S      | S2         |
| D1b | `status` plugin capability → core `vx status`                  | high  | M      | S2, D1a    |
| D2  | `connect --print-ci` + CI recipe docs                          | high  | S      | S1         |
| D3  | `vx why <run?> <task>` at the terminal (see §5)                | high  | S      | —          |

---

## 5. Lens 3 — Develop further (ranked by DX value / effort)

Highest-leverage next capabilities given everything shipped — **not** a
rewrite. Ranked; the top three are "surface what already exists."

| Rank | Capability                            | Why it's high-leverage                                                                                                                                                                                                                         | Effort               | Notes / prereqs                                                |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------- |
| 1    | **`vx why <run?> <task>`**            | The field's #1 feature (cache-miss "why") already exists as `whyDidThisRerun`/`explainCacheKey` (`mcp-rpc.ts:67,77`) + `entry_inputs` diff — but only via MCP/dashboard. A plain terminal command is a near-pure surfacing of shipped queries. | S                    | reuse `metrics.ts` `cacheKeyDiff`; defaults to last run        |
| 2    | **PR-comment summaries**              | `--report=markdown` already emits the table (`cli/run.ts:425`). A documented `gh pr comment` recipe (and later a serve-side GitHub check) turns it into review-time signal.                                                                    | S (recipe) / L (app) | recipe now; app is P2                                          |
| 3    | **`vx status` doctor**                | §4.3 — collapses the three-command connection picture into one.                                                                                                                                                                                | S/M                  | S2                                                             |
| 4    | **watch ↔ serve integration**         | `vx watch` re-runs already (`cli/watch.ts`); streaming each cycle's events to a running serve makes the dashboard a live local devloop, not just a post-hoc log.                                                                               | M                    | rides the event bus + telemetry seam                           |
| 5    | **Predicted-cache overlay**           | Cockpit already fetches per-task predicted `cacheStatus` from `/v1/graph` and drops it (UI-7). "N/M will restore" pre-run, zero backend cost.                                                                                                  | S                    | UI-only                                                        |
| 6    | **Delegation self-ingest**            | delegated runs are invisible to the ingest store (CLOUD-4); the seam (`RunOptions.telemetrySinks`, `options.ts:125`) is already in place. Makes delegation + analytics compose.                                                                | M                    | own review; ~10 LOC core                                       |
| 7    | **Cache trust-scopes**                | prerequisite for safe shared-**write** remote cache with untrusted contributors (CI from forks).                                                                                                                                               | L                    | **separate in-flight design — referenced, not specified here** |
| 8    | **Persistent coordinator + queueing** | cross-run fairness / always-on service. Genuinely large; the shipped agents are session-scoped only.                                                                                                                                           | L                    | `distributed-execution-2026-07.md` §13; own design             |
| 9    | **Editor / LSP surface**              | config-time diagnostics, task hovers. Real, but low near-term ROI vs 1–6; the `defineProject` types already give editor typechecking.                                                                                                          | L                    | de-prioritize                                                  |

The pattern in the top five: **the data already exists** (queries, report,
predicted status, event bus). The leverage is in surfacing it at the
terminal / dashboard, not in new subsystems.

---

## 6. Reconciliation with the consulting review

This review **agrees with and does not re-open** the consulting review's
dispositions, with these relationships:

- Its P1 "kill-or-commit sweep" ≙ my §3.5. Same targets (`predictive`,
  `vx dev`, coordinator remnants, protocol-dist), same conclusion.
- Its "artifact store on serve makes connect one-URL" (P1) is the
  _server_ half; my S1/S2 are the _client_ half that makes that one URL
  reach all three capabilities. They compose.
- Its CLOUD-4 self-ingest is my Develop-further #6, unchanged.
- Its CORE-9 metrics.ts relocation: I go **further than defer** — I
  recommend explicitly _not_ relocating (§3.4), keeping the guard as the
  fix, because the move is churn the project can't afford.

## 7. Contradictions with shipped decisions (flagged explicitly)

The owner hates silent contradictions. Two places this review pushes
against a shipped decision:

1. **§3.4 vs "clean module placement."** The natural home for
   `metrics.ts` is the `cache` module (it reads cache-owned tables). I am
   recommending it **stay mis-placed** in `orchestrator`. Justification:
   the correctness risk (schema drift) is already covered by the
   drift-guard test; the only thing relocation buys is aesthetics, at the
   cost of a cross-matrix refactor — exactly the churn the process
   findings warn against. This is a deliberate reversal of "every module
   in its right place," justified by cost.

2. **§4.3b `status` plugin capability vs "no CLI in core / core is
   limited."** The core/cloud split (2026-06-27) put all service concepts
   in `vx-cloud`. A `status` capability lets the **core** `vx` binary
   render cloud connection state. This is _not_ a reversal of the split:
   core gains no service code and no knowledge of cloud's files — it gains
   one more run-level plugin hook (the exact seam backend/cache/telemetry
   already use), and `cloud()` fills it. If the owner considers even a
   read-only status hook a violation of "core is limited," the fallback is
   `vx-cloud status` alone (§4.3a), which respects the split fully. I
   recommend the capability but flag it as the one place I'm widening the
   core surface.

Also noted (drift, not contradiction): CLAUDE.md **Active workstreams #2**
still lists `--continue=<mode>` as pending, but it shipped
(`cli/run.ts:159–167`, `never|deps-ok|always`). Update the roadmap.

## 8. Non-goals

- **No new task-execution model.** "Shell is the API" stands; no executor
  plugins, no JS-function tasks.
- **No daemon.** `vx run` stays a fresh process. (The `vx dev` hub §3.5 is
  a devtools bridge, not an execution daemon; cutting it doesn't touch
  this.)
- **No collapsing the three discovery files** (§3.3) — they have distinct
  correct lifecycles; only their _readers_ unify.
- **No cache trust-scope design here** — referenced (§5 #7), owned by its
  own doc.
- **No UI rewrite** — the consulting review's verdict holds; UI items are
  the existing OPEN list.
- **No CACHE_VERSION / SCHEMA / TELEMETRY_SCHEMA bump** — nothing here
  touches key derivation, artifact bytes, or the wire contract. S1/S2 are
  env/resolver plumbing; D1–D3 are read-side surfacing.

## 9. Phased plan

**Phase 1 — connection unification (the structural fix).**

1. S2: extract `resolveConnection()` (fold the four ladders into one).
2. S1: `VX_CLOUD_URL`+`VX_CLOUD_TOKEN` as the shared rung; existing env
   vars become overrides; keep the backend-delegate gate.
3. Tests: one-pair CI resolves all three caps; specific-var override still
   wins; a bare `VX_CLOUD_URL` does **not** delegate; zero-overhead decline
   with nothing set (byte-identical to pre-plugin, per the plugin
   invariant).

**Phase 2 — DX surface (make it legible).** 4. D1a: `vx-cloud status` over the resolver (effective + reachability +
override reasons). 5. D2: `connect --print-ci` + a CI-recipe docs page. 6. D3: `vx why <run?> <task>` surfacing `metrics.ts` `cacheKeyDiff`.

**Phase 3 — cleanup + reach.** 7. S5/S6: cut `vx dev`/`localDevBackend`/`startUiServer`/`protocol-dist`;
bench-or-delete `predictive`. 8. D1b: `status` plugin capability → core `vx status` (owner sign-off on §7
point 2 first). 9. Develop-further #4/#5 (watch↔serve, predicted-cache overlay) as
independent increments.

Each phase is independently shippable and reversible; Phase 1 is the one
that pays for itself immediately (CI drops from three URL/token pairs to
one, and the resolver is where every future connection consult attaches).

## 10. Why this is the right move

- **It shrinks the thing that actually accreted** (the connection surface),
  not working core code. One concept — a base URL + token — replaces three
  descriptions of one server.
- **It makes local↔CI one context by construction:** the same two values
  you `connect` with are the two env vars CI sets; the resolver reads them
  the same way.
- **It's additive and reversible.** Every shipped env var keeps its
  meaning as an override; nothing silently changes; no format bump.
- **The top DX wins are surfacing, not building** — `vx why`, PR reports,
  predicted-cache overlay all already have their data.
- **It's honest about cost:** it declines the two churny "simplifications"
  (relocate `metrics.ts`, collapse the discovery files) and says why.
