# Security review — 2026-07

> **Status:** the verified findings below are REMEDIATED on `main` (see the
> commit trail in each section). This document is the durable record of the
> adversarial audit and what shipped for it.
>
> **Owner directive:** "Do a full security audit as well. Implement all no
> questions asked. Make sure our cache is segregated to avoid CVE pollutions."

## Method

A 15-agent adversarial sweep across five attack surfaces (cache artifact
extraction/ingestion, serve HTTP/WS auth + network exposure, distributed-
execution trust, cache-key integrity + trust segregation, config
eval/command exec/secrets), followed by an independent **refute pass** on each
critical/high — every finding had to survive a skeptic trying to prove it
wrong before it was accepted. Findings are ranked by verified exploitability,
not by the reporter's initial severity.

## Threat model (what a vx deployment must resist)

- **A — malicious artifact:** a poisoned/compromised remote cache (or a MITM)
  serves bytes a victim restores + executes.
- **B — untrusted writer:** a fork-PR CI job (untrusted external contributor)
  reaches a shared serve and poisons a key a trusted build later consumes.
- **C — network exposure:** the local dev serve is reachable by a LAN attacker
  or driven cross-origin by a page the developer merely visits.
- **D/E — config/secrets:** an untrusted checkout runs code at config-eval; a
  shared/leaked `cache.db` leaks declared secrets.

## Verified findings + remediation

### CRITICAL — Unauthenticated RCE: serve bound 0.0.0.0, no token by default

`vx-cloud serve` bound all interfaces and, with no `--token`, authorized every
request. The `run` WS channel executes arbitrary workspace tasks
(`executeRequest` → `run()` over an attacker-supplied `cwd`/`tasks`), so any
host on the LAN got remote code execution. **Verified REAL.**

**Fixed** (`5a30d15`): bind `127.0.0.1` by default (`--host` / `VX_CLOUD_HOST`
to override); refuse a non-loopback bind unless a token is set. A tokenless
serve is now only reachable from the local machine.

### CRITICAL — Drive-by CSRF → RCE via cross-origin WebSocket (CSWSH)

The WS upgrade did no `Origin` validation. WebSocket handshakes are not gated
by the same-origin policy, so a page the developer visits could open
`ws://localhost:4321`, send `{t:'run'}`, and execute tasks on the dev machine
— drive-by RCE, in the documented default (no token) config. **Verified
REAL.**

**Fixed** (`5a30d15`): gate the run/agent WS upgrades and the SSE streams on
the `Origin` header. A CLI client sends no Origin (allowed); a same-origin
browser is allowed; every other cross-origin browser handshake is refused.
`--allow-origin` / `VX_CLOUD_ALLOW_ORIGIN` allow-lists a hosted dashboard on
another origin.

### HIGH — Artifact PUT reachable with no auth (open mode) → cache poisoning

In the open default the `/v8/artifacts` PUT and `/v1/agents` registration were
reachable unauthenticated; an untrusted writer could place a malicious
`<hash>.tar.zst` a trusted run later restores + executes. **Verified REAL.**

**Fixed** (`5a30d15` + `24af48f`): the privileged surfaces are unreachable
without a token when the serve is on a network (loopback default + non-loopback
requires a token), and trust scopes (below) make even an authenticated
untrusted writer unable to reach the trusted scope.

### HIGH — Cache keyspace had no trust/tenant scoping

One flat store behind one bearer: any token holder could PUT any hash any
reader would GET, across workspaces and across the fork-PR trust boundary. The
HMAC tag proves byte-integrity _within_ a shared key, not producer trust — it
does not close this. **Verified REAL.**

**Fixed** (`24af48f`): server-path trust scopes
(`docs/design/cache-trust-scopes-2026-07.md`, Phase 1). The store is
partitioned by `<bucket>/<tier>`, server-derived from the token. Untrusted
writes land in `untrusted/` and never feed a trusted read; untrusted can never
write `trusted/`. Client-side `detectForkPr` + `resolveCacheTrust` pick safe
defaults (fork PR → untrusted; no PR token → read-only). CACHE_VERSION
unchanged.

### MEDIUM — Artifact store PUT: no immutability, silent overwrite

PUT `rename()`'d over any existing artifact with no content check, so an
authenticated writer could replace a legitimate entry. **Verified REAL**
(downgraded from high: requires holding a valid token).

**Fixed** (`24af48f`): artifacts are immutable — a re-PUT of an existing hash
is refused (409). A content-addressed key genuinely re-derived is byte-equal,
so a legitimate re-PUT loses nothing; a poisoning overwrite is blocked.

### MEDIUM — Unbounded artifact download + zstd decompression (OOM DoS)

`RemoteCache.get` read the whole body via `arrayBuffer()` with no cap, and
both decompress sites expanded the entire artifact in memory with no ceiling —
a small "zstd bomb" from a malicious/compromised remote OOMs any victim taking
a hit. **Verified REAL.**

**Fixed** (`431cf89`): cap the compressed download (bounded streaming read,
aborts past 512 MB) and the decompressed output — read the zstd frame's
declared content size and refuse a bomb before allocating; refuse a sizeless
frame over the untrusted ingest boundary; ceiling at 2 GiB. Degrades to a
cache miss.

### HIGH — Secret env / runtime output / argv stored PLAINTEXT in cache.db

`entry_inputs` folded the raw env value / runtime-command output / argv into
its `hash` column, so any reader of `cache.db` (a shared CI cache dir, a
co-located dashboard, a leaked file) recovered every secret declared in
`cache.inputs.env` or passed after `--`. (Filed against `Config eval` surface;
not separately refuted but confirmed against code.)

**Fixed** (`431cf89`): capture a digest (`xxh3hex`), never the value — the
diff only needs change-detection, which a digest preserves losslessly. The
cache key folds the plaintext separately and is unchanged.

### LOW — extractOutputs followed a symlinked PARENT directory

The containment check was lexical, so a pre-existing symlinked ancestor under
the output tree (planted in the repo or by a dependency postinstall) let a
poisoned entry escape on write. **Verified REAL** (defense-in-depth: needs a
planted symlink AND a poisoned artifact).

**Fixed** (`431cf89`): realpath the parent dir and require it to stay inside
the realpath'd base before writing.

## Findings examined and NOT actioned (with reason)

- **Agent/artifact consumed with "zero verification" → poisoning (filed
  CRITICAL).** The refute pass found the critical framing **wrong**: the store
  is not a content-addressed-digest store (the hash is a cache KEY, not a
  content digest), so "address==content" is not an unenforced invariant. The
  real exposure is the untrusted-writer axis, which the trust scopes close.
  Adjusted to low; no separate action.
- **Self-asserted `commitSha` at agent registration (filed HIGH).** Refuted:
  this is the accepted Nx-Agents same-checkout trust model; a submitter cannot
  verify output correctness without re-executing (the whole point of
  distribution). Per-agent credentials (vs one shared bearer) are legitimate
  future hardening for multi-tenant serve, tracked below — not a fix as filed.

## Accepted residual risks (documented, not bugs)

- **`?token=` in the query string** for WS/EventSource: browser transports
  can't set an `Authorization` header, so the query token is required for the
  live dashboard. It can leak via logs/Referer; the header form stays canonical
  everywhere else. Mitigated by loopback-default + the Origin gate.
- **Config eval runs `vx.config.ts` as code** on load: running a task runner in
  an untrusted checkout already implies trusting its config, same as Turbo/Nx.
  Out of scope for sandboxing here.
- **`untrusted → untrusted` blast radius:** two fork PRs share the `untrusted`
  scope, so PR-A can poison PR-B — within the untrusted boundary, never
  affecting a trusted build. Optional per-PR sub-partitioning is a trust-scopes
  Phase-3 knob.
- **Compound-command grandchildren** still orphan on a hard programmatic kill
  (no cgroups); single external commands are `exec`-wrapped so the common case
  is clean. Shared by every non-cgroup runner.

## Follow-up hardening (tracked, not blocking)

- Per-agent credentials instead of one shared bearer, before any multi-tenant
  hosted serve (trust-scopes Phase 2 buckets ride this).
- Signed CI claims (OIDC/JWT) as a stronger alternative to per-tier tokens
  (trust-scopes Phase 3).
- `authorized()` is an allow-by-exemption gate; keep new privileged routes
  behind an explicit gated list as they're added.
