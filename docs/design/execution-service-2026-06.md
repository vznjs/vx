# Execution as a backend — `vx serve` and the client/service split

Status: foundation shipped 2026-06-17. Owner ask: "one process doing all
the work; each run informs it what to run and subscribes; a later run
joins in-flight work; treat vx as a service with clients; in the future
connect to a hosted service."

## 1. The idea

Execution becomes a **pluggable backend**, exactly as the cache is local
or remote behind one `CacheLayer`. `vx run` resolves a `RunBackend` and
submits a `RunRequest`; it neither knows nor cares whether the work runs
in-process or is delegated to a service. The service (`vx serve`) hosts
the same `run()` the CLI uses and streams results back.

```
vx run ──RunRequest──▶ resolveBackend ──▶ ┌ localBackend  (in-process run())
                                          └ serviceBackend ──ws──▶ vx serve ──▶ run()
        ◀──WireEvents + RunResult─────────────────────────────────┘
```

The transport is **WebSocket** (Bun-native server + client, zero deps),
so the identical protocol serves a local service today or a hosted
`wss://` one later — execution joins the cache as something with a local
and a remote implementation behind one interface.

## 2. Why a backend interface (not a special case)

The win is isolation. `vx run`'s body is now:

```
const backend = await resolveBackend(cwd)
const result = await backend.run(optionsToRequest(opts))
```

Everything that varies — in-process vs delegated, local vs hosted, the
renderer — lives behind `RunBackend`. New backends (a pooled worker, a
remote-execution cluster) slot in without touching the CLI or the
renderer. Each piece is independently rewritable/removable:

- `protocol.ts` — pure wire types + `RunOptions⇄RunRequest`. No transport.
- `wire-render.ts` — the inverse of `wireForwarder`: rebuild node-shaped
  objects from `WireEvent`s and drive a normal `Logger`. A delegated run
  renders identically to a local one **with the terminal renderer
  untouched** — it just receives reconstructed nodes. Delete this file and
  only the delegated-render path is affected.
- `serve.ts` — the service. Swap Bun.serve for anything; the protocol
  is the contract.
- `backend.ts` — the two backends + the resolver.

## 3. Correctness invariants

- **Fail-safe to local.** `resolveBackend` returns `localBackend()` on any
  doubt — no service, unreachable health probe, stale `.vx/serve.json`,
  parse error. A service can never block, slow, or break a run by being
  misconfigured or down. (The health probe has a hard 300 ms timeout.)
- **Local is byte-identical.** `localBackend` calls `run()` exactly as
  before; all 834 existing tests pass through it unchanged. The whole
  service path is additive.
- **The service never breaks the run.** Server-side `run()` uses a silent
  logger and `handleSignals: false` (the service owns signals). A client
  that vanishes mid-run doesn't abort the server-side run; a `send` that
  throws is swallowed.
- **Render sink is injectable.** `serviceBackend(origin, sink?)` — the CLI
  uses a `defaultLogger`; tests inject a capturing logger. (Hardcoding the
  logger caused a real cross-test hang via its status-region ticker — the
  injectable sink is both the fix and the cleaner design.)

## 4. The wire protocol

`RunRequest` is the serializable subset of `RunOptions` (drops `log` /
`bus` / `handleSignals` — host-side concerns). `WireEvent` is the event
stream (`task:start` carries the full `TaskView` so a consumer rebuilds
the run incrementally — no upfront table). Messages are enveloped:

```
client → service:  { t: 'run', request }
service → client:  { t: 'event', event } | { t: 'result', result } | { t: 'error', message }
```

`wireForwarder` projects bus events to `WireEvent`s; the caller frames
them (NDJSON for the `vx dev` unix socket, enveloped JSON for `serve`).
`/health` is the liveness probe `resolveBackend` checks before delegating.

## 5. Discovery + the hosted hook

- Local: `vx serve` writes `.vx/serve.json` (`{ origin, pid }`); the client
  reads it, health-checks, derives the ws URL.
- Hosted (the future, hook in place today): `VX_SERVICE_URL=<origin>`
  short-circuits to a service backend pointed at any origin — the same
  client code, a different URL + (later) auth header. The remote-cache
  token/HMAC model is the auth story to reuse.

## 6. Deliberately deferred (the roadmap this unlocks)

The foundation is the backend split + a working local service. The
features that make it compelling layer on top, each its own step:

1. **In-flight dedup — the killer feature.** A global
   `Map<taskHash, Promise<TaskOutcome>>` on the service: a second run that
   wants a task already executing **joins** it instead of re-running
   ("listen from the middle"). We already have the key (the task hash) and
   have proven the exact pattern (remote-prefetch's `inflight` map). This
   is the reason the service is worth it.
2. **One global scheduler.** Today each delegated run gets its own
   scheduler/worker pool (N clients → N pools = oversubscription). A single
   service-wide work queue with a fairness policy fixes this and enables
   (1).
3. **Watch + staleness.** The service watches files and auto-submits
   affected runs. Mid-run file changes → **continue-and-supersede**: the
   in-flight result is cache-valid for its input hash (never wasted), the
   new hash schedules fresh work, the UI marks the old run superseded.
   Content-addressing makes "stale" a label, not a correctness problem.
4. **One service, both roles.** `vx serve` (execute) and `vx dev`
   (observe) converge — the service hosts the devframe UI as a subscriber
   to its own event stream. Today they're separate concerns by design
   (clean isolation); unification is additive.
5. **Hosted execution.** Generalize auth + cwd/env mapping; the client is
   already transport-agnostic.

## 7. Known limits (today)

- **No dedup / global scheduler yet** — concurrent delegated runs each run
  a full scheduler. Documented; (1)+(2) above.
- **Persistent tasks over delegation** — a delegated dev server runs in the
  service and is SIGTERMed at graph end (not kept foreground). Delegation
  targets build/test; run persistent tasks locally for now.
- **Env/cwd** — the service uses its own process env and the request's
  cwd; correct for a local same-user service, a mapping concern for hosted.
- **`--ui` stays a local one-shot** — superseded by `vx serve` + the
  converged UI (item 4), kept for now.
