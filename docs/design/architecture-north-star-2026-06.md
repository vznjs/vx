# Architecture north star — the unified vision

Status: synthesis proposal (2026-06-20). Reads the four
companion proposals together — `distributed-ci-2026-06.md`,
`vx-cloud-2026-06.md`, `extension-protocol-2026-06.md`,
`predictive-execution-2026-06.md` — and answers: _what does vx look
like at the end of this arc, and what does each step buy us?_

## 1. The end-state vision (one screen)

> **vx is the fastest, most open task runner in existence.**
>
> A single binary, OSS, that runs locally with zero infra and scales
> with one config flip into a self-hosted (or hosted) team execution
> and observability platform. Every internal event is on a typed
> serializable bus; every surface — terminal output, web UI, IDE
> plugin, MCP server, CI annotator, cloud uploader — is a subscriber
> on that bus. Tasks are content-addressed, executions are fungible,
> caches are layered (local → remote → speculative), and the
> scheduler learns from history to keep getting faster every week.
>
> One protocol from `vx run` to `vx serve` to `vx cloud`. One
> contract third parties can extend. One trajectory: ship the OSS
> reference impl of every layer first; let the hosted product fund
> the development; let the community own the moat.

## 2. The architectural spine

Six layers, each independently rewritable, each with a versioned
contract:

```
┌────────────────────────────────────────────────────────────────┐
│ 6.  Surfaces (subscribers)                                     │
│     Terminal • Web UI • TUI • MCP • Cloud uploader • Plugins    │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ WireEvent + RunState (serializable)
                              │
┌────────────────────────────────────────────────────────────────┐
│ 5.  Event substrate                                            │
│     bus + reducer + devframe surface (off-thread capable)       │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ Logger calls
                              │
┌────────────────────────────────────────────────────────────────┐
│ 4.  Orchestrator                                               │
│     run() = prepare → graph → schedule → execute                │
│     • predictive scheduling (history-aware priority)             │
│     • in-flight dedup (shared across submissions)                │
│     • watch + supersede (continuation across input changes)      │
└────────────────────────────────────────────────────────────────┘
                              ▲                ▲
                              │                │
                       RunBackend          CacheLayer
                              │                │
┌────────────────────────────────────────────────────────────────┐
│ 3.  Execution backends                                         │
│     localBackend • serviceBackend • coordinator (distributed)    │
└────────────────────────────────────────────────────────────────┘
                              │                │
┌────────────────────────────────────────────────────────────────┐
│ 2.  Cache layers                                               │
│     local (SQLite + tar.zst) • remote (Turbo wire + HMAC)        │
└────────────────────────────────────────────────────────────────┘
                              │
┌────────────────────────────────────────────────────────────────┐
│ 1.  Exec primitives                                            │
│     Bun.spawn • sandbox (SRT / bwrap) • env / paths              │
└────────────────────────────────────────────────────────────────┘
```

What ships today: 1, 2, 3 (mostly), 4 (sans predictive), 5 (partial),
6 (terminal + bridge UI + MCP planned). The proposals fill out the
gaps and extend each layer.

## 3. The decisive design rules (carve them in stone)

These are what make the whole stack composable. They are NOT
negotiable as the system grows.

### 3.1 Content addressing is the only identity

Every task has a hash (the v22 pure-input key). The hash is the
identity. Two tasks with the same hash are interchangeable. A worker
producing artifact `<hash>` satisfies every consumer of `<hash>`.
Once `<hash>` exists in any cache layer, no one re-executes it.

This is why distributed exec works, why in-flight dedup works, why
remote caches work, why the hosted layer can be appended without
correctness risk.

### 3.2 The event stream is the protocol

Every observation goes through the bus. The terminal renderer is a
subscriber. The cloud uploader is a subscriber. The web UI is a
subscriber. The MCP server is a subscriber. We do not add "side
channels" to the orchestrator; we add subscribers.

This is why extensibility works without API breakage — third parties
hook into a serializable contract, not into orchestrator internals.

### 3.3 Fail-safe to local, never block

Every external dependency degrades to local:

- Remote cache down → cache miss, run continues.
- Coordinator down → fall back to in-process scheduling.
- Cloud uploader down → events queue locally, flush later.
- Subscriber wedged → drop it, run continues.

The local path is _the_ path. Everything else is overlay.

### 3.4 Shell is the API for tasks

We do not define a "task SDK" with magic functions. A task is a
shell command. This is the boundary that lets us run any tool in any
language, sandboxed or not, on any worker, with stable semantics.

### 3.5 Validate at boundaries, trust the inside

`valibot` validates wire-deserialized data. In-process code trusts
its inputs. No defensive checks on internal paths; no double
validation.

## 4. How the proposals compose

The four companion proposals are not independent — each one's value
multiplies when the others land. The bow-tie diagram:

```
  vx-cloud (observability)  ─┐
                              │
  extension-protocol         ─┤
                              ├── all reuse: event substrate
  predictive-execution       ─┤   (+ HistoryTable from cloud)
                              │
  distributed-ci             ─┘
```

- **distributed-ci** depends on the event substrate (for streaming
  outputs back) and a remote cache (already shipped). It produces
  events that the cloud + extensions consume.
- **vx-cloud** is _the historical store_ of those events; it powers
  the HistoryTable that **predictive-execution** uses.
- **extension-protocol** is how third-party tools consume the cloud
  data and the live event stream.
- **predictive-execution** consumes history (from local or cloud)
  and feeds it back into scheduling — closing the learning loop.

Each individually delivers value:

- **distributed-ci alone** → free Nx-Cloud DTE for OSS users.
- **vx-cloud alone** → Nx Cloud / Turbo dashboards for OSS users.
- **extension-protocol alone** → ecosystem of community tools.
- **predictive-execution alone** → "the only task runner that learns."

Together: a closed-loop system where every run improves the next run.

## 5. The execution sequence (what to ship, in what order)

The ordering that maximizes value-per-week shipped:

```
┌─ Wave 1 (foundations): WHAT'S ALREADY SHIPPED
│  • RunBackend + serviceBackend ✓
│  • Event bus + busLogger + RunState reducer ✓
│  • Remote prefetch + in-flight dedup ✓
│  • vx serve + vx dev hub ✓
│  • Distributed cache (Turbo-wire-compatible + HMAC) ✓
│
├─ Wave 2 (THE NEXT 4 WEEKS):
│  • Predictive scheduling Phase A (HistoryTable revival)
│    └─ delivers immediately: vx info shows history
│  • Extension SDK Phase A (@vzn/vx-client TS)
│    └─ delivers immediately: subscribers work
│  • vx insights Phase A (local SPA over cache.db)
│    └─ delivers immediately: the deleted dashboard revived
│       on top of the substrate that makes it not crash
│
├─ Wave 3 (THE NEXT 6 WEEKS):
│  • Predictive Phase B (critical-path-from-history scheduler)
│  • Distributed CI Phase A-B (coordinator + multi-worker)
│  • Plugin API Phase D (defineWorkspace.plugins)
│  • MCP server (the agent surface, already roadmapped)
│
├─ Wave 4 (THE FOLLOWING QUARTER):
│  • Distributed CI Phase C-D (GitHub Actions composite,
│    capability labels, critical-path priority)
│  • vx cloud Phase B-C (data model + self-hosted backend)
│  • Predictive Phase D-E (bandit retry, regression detection)
│  • Extension Phase B-C-E (RPCs, drivers, ref plugins)
│
└─ Wave 5 (THE LONG ARC):
   • vx cloud Phase D-E (multi-tenant, hosted SaaS)
   • Distributed CI Phase E (signed manifests, sparse-clone workers)
   • Hosted execution (untrusted-worker model)
   • Web SPA (full devtool, replaces bridge mode)
```

The sequencing principle: **each wave delivers user-visible value
and unblocks the next wave.** Wave 2 is the lightest lift with the
highest immediate payoff — HistoryTable revival, the TS SDK, and a
local-only insights UI all leverage existing primitives.

## 6. The performance commitments

What we promise users:

1. **Cold runs**: ≤ Turbo on every reasonable workload (already
   true on the 300-pkg benchmark). Maintain forever.
2. **Warm runs**: ≤ 200ms summary-printed for a 1000-pkg full-cache
   run. Already true; maintain.
3. **CI scale-out**: 8-way matrix completes an N-task graph in
   `T(serial) / min(8, P)` time where P is the critical path.
   Requires Wave 4.
4. **Per-week speedup**: a project on vx with the predictive
   scheduler enabled gets 5-15% faster over 4 weeks of usage,
   without user changes. Requires Wave 2-3.
5. **Cache hit p50 latency**: ≤ 5ms local, ≤ 50ms remote. Already
   the bar; maintain.

These commitments go into `docs/comparison.md` as the **headline
table** at the top of the doc.

## 7. The DX commitments

What we promise users:

1. **Zero-install onboarding**: `bunx vx migrate` in any Turbo or Nx
   monorepo emits a working `vx.config.ts` + report. Already true.
2. **One-flag distributed**: `vx run --coordinator <url>` is the
   _only_ knob needed to go distributed. Workers join with `vx run
--worker <url>`. No YAML, no orchestration files.
3. **Live insights**: `vx insights` opens a browser to a UI of the
   user's runs. No login, no upload, no cloud account.
4. **Optional everything**: cloud, hosted, distributed, predictive,
   extensions — every one is opt-in. The local-only path stays
   stable forever.
5. **Agent-native**: an LLM can run `vx mcp` and use typed tools
   instead of parsing terminal output.

## 8. The openness commitments

What we promise _the ecosystem_:

1. **All protocols are SemVer-published**: wire schemas live in
   `protocol.ts`, validated by `valibot`, versioned.
2. **OSS reference impl for every layer**: cache server, cloud
   backend, coordinator, worker — all shipped from this repo.
3. **No vendor lock-in**: Turbo-wire-compatible cache means a team
   on Turbo can use our cache; a team on vx can use Turbo's cache.
4. **Plugin API is part of the public contract**: not "extensions"
   that break in 6 weeks.
5. **No hosted-only features**: if it ships on the SaaS, it ships
   in the self-hosted binary at the same version.

## 9. The competitive picture

| Capability                    | Turbo    | Nx (OSS) | Nx Cloud | vx (today) | vx (north star) |
| ----------------------------- | -------- | -------- | -------- | ---------- | --------------- |
| Local task graph + cache      | ✓        | ✓        | ✓        | ✓          | ✓               |
| Remote cache                  | ✓        | ✓        | ✓        | ✓          | ✓               |
| Distributed CI execution      | ✗        | ✗        | ✓ (paid) | partial    | ✓ (OSS)         |
| Web analytics                 | ✓ (paid) | ✗        | ✓ (paid) | ✗          | ✓ (OSS)         |
| Self-hostable analytics       | ✗        | ✗        | ✗        | ✗          | ✓               |
| Predictive scheduling         | ✗        | ✗        | ✗        | ✗          | ✓               |
| Public extension protocol     | ✗        | partial  | ✗        | ✗          | ✓               |
| Agent-native (MCP)            | ✗        | ✗        | ✗        | planned    | ✓               |
| Wire interop with competitors | ✗        | ✗        | ✗        | ✓ (Turbo)  | ✓               |
| Bun runtime (fast)            | ✗        | ✗        | ✗        | ✓          | ✓               |

The north star is a strict superset.

## 10. The risk picture (honest)

Three risks materially above zero:

### 10.1 Scope blowout

The single biggest threat. The proposals collectively describe
~6 months of work for a team. They're _individually_ shippable; the
risk is dilution — work in flight on too many fronts. Mitigation:
**Wave 2 first**, validate the substrate with HistoryTable + SDK +
local insights before any cloud work begins. Don't open multiple
big fronts.

### 10.2 The hosted business

Hosted requires real engineering (auth, billing, multi-tenancy) AND
real ops (uptime, on-call, support). We can ship the self-hosted
binary as Wave 4-5 and _defer_ hosted indefinitely. The OSS story
stands alone.

### 10.3 Plugin compat over time

Every API we expose becomes an obligation. Mitigation: SemVer the
wire. Major breaks are allowed at major-version boundaries; we
ship a `vx upgrade` tool that helps migrate. Same posture as Turbo
between 1.x and 2.x.

## 11. The non-goals (still)

Things we explicitly do not do:

- A general-purpose CI system. (We're a task runner; CI providers
  drive us.)
- A package manager. (Bun + pnpm cover this.)
- A language-level build tool. (esbuild + bun build cover JS;
  cargo/tsc/etc. cover the rest. We orchestrate them.)
- A code editor. (Our IDE story is plugins consuming the wire.)
- A scheduler for non-vx workloads. (Tasks are vx tasks.)

The discipline of not building these is what makes the system
coherent.

## 12. Recap — what we're really building

We're not "another task runner." We're building **the substrate for a
fast, observable, learning, distributed build system, with the OSS
reference impl of every layer**. The path:

1. The orchestrator is content-addressed and event-driven.
2. The event stream is the protocol.
3. Every surface is a subscriber on that protocol.
4. History closes the loop — the scheduler learns from itself.
5. Distributed execution is the same protocol on more workers.
6. Cloud observability is the same protocol persisted.
7. Extensions are first-class consumers, not afterthoughts.
8. Hosted is convenience; OSS is the product.

The order matters. The substrate has to exist before the surfaces
can ship. We've shipped most of the substrate; now we ship the
surfaces. Each one — local insights, distributed CI, predictive
scheduling, the SDK, the cloud — is a flagship feature that lands on
top of the same plumbing.

That's the next 6 months. Then the system funds itself.
