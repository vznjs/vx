# Cache trust scopes — design

> **Status:** Phase 1 SHIPPED (2026-07-03) — see the decision log entry + the
> security review (`docs/design/security-review-2026-07.md`). Phases 2-3
> (cross-workspace buckets, signed CI claims) remain proposals.
>
> **Owner directive:** "Make sure our cache is segregated as well to avoid CVE
> pollutions."
>
> **Builds on / inherits (NOT re-litigated here):**
>
> - The SHIPPED serve platform (decision log 2026-07-03): bearer auth
>   (`authorized()`), `/v1/meta`, multi-workspace `IngestStore`, the flat
>   `/v8/artifacts/:hash` store, unix socket. This is a new consumer + a
>   routing change on the artifact store, not a change to the analytics side.
> - HMAC artifact signing (`VX_REMOTE_CACHE_SIGNATURE_KEY`, Turbo-compatible)
>   — orthogonal, kept, discussed in §7.
> - `captureWorkspaceIdentity` (telemetry v2) — the stable workspace id is
>   reused as the cross-workspace bucket, NOT re-derived.
> - distributed-execution-2026-07 §6 — the correctness law is unaffected
>   (no key change; only _where_ bytes land moves). §8 covers the agent path.

## 1. What we're solving

A real supply-chain attack class: an **untrusted** writer places bytes that a
**trusted** reader later restores and executes. It has two independent axes,
and both matter:

1. **Cross-repo pollution (multi-tenant).** Repo A and repo B point at one
   shared cache endpoint. Today the serve's artifact store is ONE flat dir
   behind ONE bearer, and the store ignores the Turbo `?teamId/slug` tenancy
   params. Any writer with the token can PUT under any hash any reader will
   GET.
2. **Within-repo fork-PR pollution.** One repo, but a fork pull-request CI job
   is untrusted (external contributor). It computes the exact cache keys the
   protected-branch build will use — the key derivation is deterministic and
   an OSS repo's inputs are public — and writes a malicious artifact under
   them. The protected build restores it and runs it. This is the
   GitHub-Actions-cache-poisoning CVE class.

The **HMAC tag does not close either gap.** Signing proves _these bytes match
this hash under the shared key_ — it says nothing about _whether the writer was
trusted_. If the signing key is shared across the two contexts (it is, when
they share config), a poisoner signs valid tags. Signing is integrity
_within_ a trust scope; it is not the trust boundary.

**Precedent to copy.** GitHub Actions cache is scoped by ref: a PR branch's
cache is readable by that PR, the default branch's cache is readable by PRs,
but a PR's cache is **never** restorable by the default branch. Asymmetric,
one-directional read. That is exactly the model below. Nx Cloud ships a
read-only access token (safe to commit) for PRs + a read-write token (secret)
for `main`; Turbo/Vercel scope the cache per team + support read-only
(`TURBO_REMOTE_ONLY`). vx's tiers are a superset of the "read-only PR token"
pattern.

## 2. Access pattern

- **Solo dev, local cache only:** no serve, no remote, one implicit scope.
  Must be byte-identical and zero-overhead to today (the perf + simplicity
  rule). Nothing below touches this path.
- **One team, one shared serve, trusted-only:** a single token, everyone with
  it is trusted. Must behave exactly like today (single-tenant), plus its
  existing flat artifacts keep hitting.
- **One repo with fork PRs:** the common CI shape. Protected builds (a few per
  day) read+write the shared cache; PR builds (many, bursty) read the shared
  cache for speed but must not be able to write into it.
- **Multiple repos, one hosted serve:** each repo isolated from the others'
  writes. Lower frequency, further off — Phase 2.

The dominant, highest-value case is the fork PR. Phase 1 targets it.

## 3. Options considered (briefly)

**Where the boundary lives** — the load-bearing call:

- **(A) Fold a scope into the cache KEY** (reader requests `key(…,scope)`, a
  foreign scope's poison never matches). _Rejected as the boundary._ Against a
  **deliberate** attacker it is security theatre: if the scope is a public
  value (a tier string, or the workspace id derived from the public git
  remote), the attacker folds the same value and computes the same key. It
  only defends against _accidental_ collisions — which the existing key
  already prevents (`workspaceFingerprint` + `taskId` are folded, so two
  genuinely different repos don't collide). A _secret_ folded scope would work
  but is a shared secret = a per-scope token by another name, and baking it
  into the key means rotating it nukes the entire cache. It would also change
  `CACHE_VERSION`, break the _legitimate_ asymmetric read (a fork PR reading
  the trusted cache would derive a different key and miss it), and cost the
  solo-dev path a bump for zero benefit.
- **(B) Scope the SERVER path + authenticate the scope from the token.** The
  store lives at `<dir>/artifacts/<scope>/<hash>`; the token the request
  carries determines which scope it may read/write, server-enforced. _Chosen._
  It is a real boundary (an untrusted token cannot write the trusted scope no
  matter what key it computes), needs **no key change**, and preserves the
  legitimate one-directional read (untrusted → trusted).

**How the server authenticates the scope** — per-scope tokens vs a signed CI
claim (the serve verifies an OIDC/JWT from GitHub/GitLab and derives trust).
_Chosen: per-scope tokens._ It matches Turbo/Nx exactly, needs no new verifier
or per-CI-provider trust config, and rides the bearer machinery the serve
already has. Signed-CI-claims are a strictly-later refinement (§10).

## 4. Recommendation

Segregation is a **server-path + per-tier-token** concern. **The cache key does
not change; `CACHE_VERSION` stays v24.** A scope is `<bucket>/<tier>`:

- **`tier`** ∈ {`trusted`, `untrusted`} — the fork-PR axis. Fixed literals.
- **`bucket`** — the cross-repo axis. Defaults to `default`; Phase 2 sets it
  to the `captureWorkspaceIdentity` id, derived server-side from the token.

Both segments are **server-derived from the authenticated token**, never
client-supplied (the store ignores a client's `?teamId/slug/ws` claim for
routing, exactly as it ignores tenancy today). The client tells the server its
scope only by _which token it presents_.

### 4.1 The rights matrix

| context (tier)                   | read `trusted` | read `untrusted` | write `trusted` | write `untrusted` |
| -------------------------------- | -------------- | ---------------- | --------------- | ----------------- |
| protected / `main` (**trusted**) | ✓              | ✗                | ✓               | —                 |
| fork PR (**untrusted**)          | ✓              | ✓                | ✗               | ✓                 |

The two cells that make it a boundary:

- **trusted NEVER reads untrusted** — the poison is never consumed by a
  trusted build.
- **untrusted NEVER writes trusted** — the poison can never enter the trusted
  scope.

The two cells that make it _fast and useful_:

- **untrusted reads trusted** — PRs are warm off `main`'s cache (the headline
  win; the whole reason not to just make PRs cacheless).
- **untrusted read/writes untrusted** — a PR's own multi-task run and re-runs
  are warm within its own scope. Blast radius of an untrusted poison is
  confined to `untrusted`, which by definition never feeds a trusted build.

Concretely the server routes by tier:

- **GET/HEAD, trusted token:** look in `<bucket>/trusted/` only.
- **GET/HEAD, untrusted token:** look in `<bucket>/untrusted/` first, then
  fall through to `<bucket>/trusted/`. (Both are things this context may
  consume: its own writes + the trusted baseline.)
- **PUT, trusted token:** write `<bucket>/trusted/`.
- **PUT, untrusted token:** write `<bucket>/untrusted/`.

Same content-addressed hash can exist in both tiers as two separate files —
that is fine and expected (they are byte-equal when the key genuinely matches;
they diverge only when someone poisoned one, which the routing already
quarantines).

### 4.2 How a run learns its tier (client side)

The **token is the authority** — the server derives the tier from it. The
client only needs to (a) present the right token for its context and (b) apply
a safety floor. Resolution ladder:

1. **`VX_CACHE_TRUST=trusted|untrusted`** (or `cloud({ trust })`) — explicit
   override, always wins.
2. **CI fork-PR auto-detect** → `untrusted`:
   - GitHub: `GITHUB_EVENT_NAME` is `pull_request`/`pull_request_target` AND
     the head repo ≠ base repo — read `GITHUB_EVENT_PATH` JSON,
     `pull_request.head.repo.fork === true` or
     `head.repo.full_name !== GITHUB_REPOSITORY`.
   - GitLab: `CI_MERGE_REQUEST_SOURCE_PROJECT_ID !==
CI_MERGE_REQUEST_PROJECT_ID`.
   - Best-effort, never throws; an internal same-repo PR stays `trusted`
     (trusted collaborator — keep full cache), a fork is `untrusted`.
3. **Default `trusted`** — a normal run, a protected branch, local dev.

Given the resolved tier, the client picks its token and a policy floor:

- `trusted` → present `VX_REMOTE_CACHE_TOKEN`, full policy.
- `untrusted` → present `VX_REMOTE_CACHE_PR_TOKEN` if set (the read-trusted /
  write-untrusted token); else fall back to the normal token **but force
  `remoteWrite=false`** — so even a misconfigured fork PR that somehow holds
  the trusted token cannot write trusted. This gives the Nx/Turbo
  "PR is read-only" default for free when no PR token is configured.

The security does not _depend_ on the client resolution — a lying client still
cannot beat the server's token→scope map. Client detection just yields safe
defaults and a warning.

### 4.3 Why fork PRs can't just steal the trusted token

The elegant part: on GitHub, **fork PRs cannot read repo secrets.** The
trusted token is a secret; `main` has it, fork PRs don't. So _secret
availability is already the trust boundary_ — the server-side tiering makes
that boundary explicit and enforced rather than incidental. The
`VX_REMOTE_CACHE_PR_TOKEN` (read-trusted / write-untrusted) is deliberately
**safe to expose** (worst case: junk in the `untrusted` scope, which never
feeds trusted) — commit it or inject it into PR jobs, exactly as Nx documents
committing its read-only token.

## 5. Concrete spec

### 5.1 Artifact store — `packages/cloud/src/artifact-store.ts`

Introduce a `Scope` and a `Principal`:

```ts
type Tier = 'trusted' | 'untrusted'
interface Principal {
  tier: Tier
  bucket: string // 'default' in Phase 1; a workspace id in Phase 2
}
```

Paths become scope-nested (tag + duration sidecars move under the scope dir):

```
<ingestDir>/artifacts/<bucket>/<tier>/<hash>.tar.zst
<ingestDir>/artifacts/<bucket>/<tier>/<hash>.tag
<ingestDir>/artifacts/<bucket>/<tier>/<hash>.duration
```

`handle(req, hash, principal)` derives the read list + write scope from the
principal (per §4.1) and routes:

- `readScopes(p)` = `p.tier === 'untrusted' ? [untrusted, trusted] : [trusted]`
  (both under `p.bucket`).
- `writeScope(p)` = `<p.bucket>/<p.tier>`.
- GET/HEAD iterate `readScopes` in order, first hit wins.
- PUT writes exactly `writeScope`.

`has(hash, readScopes)` becomes scope-aware (used by the dist scheduler prune,
§8). `bucket`/`tier` are server-derived so not a client traversal vector, but
validate both against a safe-token regex anyway (defense in depth); `hash`
keeps today's `HASH_RE`.

**Legacy migration (boot, once).** Mirror `IngestStore.migrateLegacyStore`: if
flat `<dir>/artifacts/*.tar.zst` (+ sidecars) exist, move them into
`<dir>/artifacts/default/trusted/`. Existing single-tenant deployments keep
their warm cache and their single token maps to `trusted`. Pre-alpha, one
rename, loud log.

### 5.2 Serve token config + auth — `packages/cloud/src/cli/serve.ts`

Generalize the single `expectedDigest` into a small principal table:

- `--token <T>` / `VX_CLOUD_TOKEN` → `{ digest(T), tier: 'trusted', bucket:
'default' }` (back-compat; existing deployments become trusted).
- **New** `--pr-token <U>` / `VX_CLOUD_PR_TOKEN` → `{ digest(U), tier:
'untrusted', bucket: 'default' }`.
- No token configured → **open serve**: every request is
  `{ tier: 'trusted', bucket: 'default' }` (byte-identical to today).
- **Unix socket** request → `{ tier: 'trusted', bucket: 'default' }` (the 0600
  socket is the local owner; already privileged).

`authorized()` returns the matched `Principal | null` instead of a bool
(null → 401). Thread the principal into `artifacts.handle(req, hash,
principal)`. `/v1/*` analytics reads accept any valid principal (unchanged —
they are not the poisoning surface).

`/v1/meta` advertises the capability so environments/clients can tell PR tokens
are honored: add `trustTiers: true` alongside `artifacts: true`.

### 5.3 Client trust resolution — `src/orchestrator/remote-cache-setup.ts`

### + `src/orchestrator/run-context.ts`

- New `detectForkPr(env): boolean` in `run-context.ts` (§4.2 signals),
  best-effort, never throws. Sits beside `detectCi`.
- New `resolveCacheTrust(env): Tier` — `VX_CACHE_TRUST` override →
  `detectForkPr` → default `trusted`.
- `wrapWithRemoteCache` picks the token + policy floor per §4.2. **The
  `RemoteCache` wire is unchanged** — it just carries a different bearer. No
  scope on the wire; the token is the scope claim.

### 5.4 Plugin — `packages/cloud/src/plugin.ts`

`cloud()` cache rung mirrors the same resolution: add `cachePrToken` option +
`VX_REMOTE_CACHE_PR_TOKEN` fallback, resolve trust, select token + floor
`remoteWrite`. The environment rung (`activeEnvironment`) can carry an
optional `prToken` on the `EnvironmentEntry` for the connected-serve story.

### 5.5 Distributed execution — `dist/submit.ts`, `dist/scheduler.ts`, serve WS

Agents write to the **submission's scope**:

- The submit/agent WS upgrades are already bearer-gated; record the connection's
  `Principal` on the socket (from `authorized()`).
- The submitter passes its resolved tier token as `VX_REMOTE_CACHE_TOKEN` for
  the self-agent + remote agents (it already sets these env vars). Agent PUTs
  land in the tier the token authorizes — server-enforced, no protocol field
  needed.
- `DistScheduler` prune becomes scope-aware: a task is "already warm, don't
  dispatch" iff `store.has(hash, readScopes(submissionPrincipal))` — a trusted
  submission prunes on `trusted/<hash>`; an untrusted one prunes on
  `untrusted` ∪ `trusted`.
- No `CACHE_VERSION`/key change means distributed-execution §6's
  save-under-the-full-run-key induction is untouched; only the destination
  scope moves.

## 6. Interaction with existing pieces

- **CACHE_VERSION / the key:** UNCHANGED (v24). The scope is a server path +
  token concern. Solo-dev local cache byte-identical. No optional key section
  (rejected in §3 — a public folded scope is theatre, a secret one is a token
  in disguise).
- **HMAC signing:** kept, orthogonal — integrity _within_ a scope. Single
  shared key across tiers is fine: an untrusted reader verifying a trusted
  artifact succeeds (same key), and trusted never reads untrusted, so no
  cross-tier verification arises. Per-tier signing keys would be redundant with
  the server path boundary — out of scope.
- **`?teamId/slug`:** remains the cross-tenant lever for **third-party** Turbo
  servers (Vercel, ducktors) — vx can't path-scope those, so their tenancy is
  their concern and vx already sends the params. vx's own serve keeps ignoring
  them for routing and uses the token instead.
- **`cloud()` environments:** an `EnvironmentEntry` may carry a `prToken`;
  otherwise the env token is the trusted token.
- **vx agents:** §5.5 — agents write the submission's scope; the token carries
  it.

## 7. Local default (zero-config, zero-overhead)

A solo dev with a local cache has ONE implicit scope and never touches tiers:

- `Cache` (local SQLite) is **unchanged** — no scope column, no tier, no path
  change. `resolveCacheTrust` is only consulted inside `wrapWithRemoteCache` /
  the plugin cache rung, which only run when a remote is configured.
- `detectForkPr` is one env read, only on the remote-configured path.
- An open serve (no tokens) is single-scope `trusted` and behaves exactly like
  today, including the legacy flat→`default/trusted` migration so existing
  artifacts keep hitting.

Only a shared/remote cache with a configured PR token (or a detected fork PR)
pays anything, and that cost is a directory level + one env read.

## 8. What's out of scope

- Full RBAC, per-user ACLs, arbitrary scope hierarchies.
- Encryption at rest.
- Signed-CI-claim trust (OIDC/JWT from the CI provider) — a later, stronger
  alternative to per-tier tokens (§10).
- Per-PR sub-partitioning of the `untrusted` scope (so PR-A can't poison PR-B).
  Default is a shared `untrusted` scope (matches Turbo/Nx PR caches);
  §10 sketches an optional `VX_CACHE_SCOPE_ID`.
- Per-tier signing keys.
- Retrofitting third-party Turbo servers with tiering (their tenancy is
  `teamId`, unchanged).

## 9. Open questions

1. **Untrusted → untrusted blast radius.** Two different fork PRs share the
   `untrusted` scope, so PR-A can poison PR-B. Within the untrusted boundary
   (no trusted context affected), so acceptable by default and matches
   Turbo/Nx. Worth an optional `VX_CACHE_SCOPE_ID` (PR number / branch) that
   sub-partitions `untrusted/<scopeId>/` when a team wants PR isolation?
2. **Internal same-repo PRs.** Defaulted `trusted` (trusted collaborator, keep
   full cache). Some orgs treat every PR as untrusted — is the
   `VX_CACHE_TRUST` override enough, or is a serve-side "all PRs untrusted"
   policy knob wanted?
3. **Phase 2 bucket authentication.** Per-workspace tokens are the clean map
   (token→bucket). Does the hosted story want a token _prefix_ scheme or a
   token→bucket table file? Deferred with Phase 2.

## 10. Phasing

- **Phase 1 (this doc, build now): trusted/untrusted tiers, single bucket.**
  The fork-PR defense end to end: store path `default/<tier>/`, `--pr-token`,
  principal-aware auth + routing, client trust resolution + fork detection,
  the dist prune scope, legacy migration. Ships the whole CVE-class fix.
- **Phase 2: cross-workspace buckets.** `bucket = workspaceId`, derived
  server-side from per-workspace tokens; the multi-tenant hosted story. Reuses
  the exact `<bucket>/<tier>/<hash>` layout — Phase 1 already writes
  `default/…`, Phase 2 only changes how `bucket` is chosen.
- **Phase 3 (optional): signed CI claims** replace/augment per-tier tokens for
  auto-provisioned trust; `VX_CACHE_SCOPE_ID` sub-partitioning.

## 11. Implementation surface (Phase 1)

Ordered so the developer can build directly. **No core `src/cache/` key or
schema change; `CACHE_VERSION` stays v24; no SCHEMA bump.**

1. **`packages/cloud/src/artifact-store.ts`** — `Tier`/`Principal`/`Scope`
   types; scope-nested `artifactPath/tagPath/durationPath(scope, hash)`;
   `readScopes`/`writeScope` helpers; `handle(req, hash, principal)` routing
   (GET/HEAD fall-through, PUT single-scope); `has(hash, readScopes)`;
   scope-segment validation; boot `migrateLegacyFlatStore()` (flat →
   `default/trusted/`).
2. **`packages/cloud/src/cli/serve.ts`** — principal table (`--token` trusted,
   `--pr-token`/`VX_CLOUD_PR_TOKEN` untrusted, socket→trusted, open→trusted);
   `authorized()` returns `Principal | null`; thread principal into
   `artifacts.handle`; record the connection principal on run/agent WS data;
   `/v1/meta` `trustTiers: true`; `parseServeArgs` `--pr-token`.
3. **`src/orchestrator/run-context.ts`** — `detectForkPr(env): boolean`
   (GitHub/GitLab, never throws), exported through `orchestrator/index.ts`.
4. **`src/orchestrator/remote-cache-setup.ts`** — `resolveCacheTrust(env)`;
   token selection (`VX_REMOTE_CACHE_PR_TOKEN`) + `remoteWrite=false` floor for
   untrusted-without-PR-token. `RemoteCache` wire unchanged.
5. **`packages/cloud/src/plugin.ts`** — `cachePrToken` option +
   `VX_REMOTE_CACHE_PR_TOKEN`; mirror the trust resolution in the cache rung;
   optional `prToken` on `EnvironmentEntry` (`environments.ts`).
6. **`packages/cloud/src/dist/{submit,scheduler}.ts`** — pass the tier token to
   agents; scope-aware prune via `store.has(hash, readScopes(principal))`.

Tests:

- **artifact-store** (`packages/cloud/tests/artifact-store.test.ts`): trusted
  PUT→`trusted/`; untrusted PUT→`untrusted/`; untrusted GET falls through to
  `trusted/`; **the poisoning guard, both directions** — write
  `untrusted/<hash>`, a trusted GET returns 404 (never the untrusted bytes);
  and untrusted GET of a `trusted/<hash>` succeeds (warm PR); scope validation;
  legacy flat→`default/trusted` migration.
- **serve auth** (`serve.test.ts`): `--pr-token` → untrusted principal;
  `--token` → trusted; unknown token → 401; socket → trusted; open serve →
  single trusted scope; `/v1/meta` advertises `trustTiers`.
- **trust resolution** (`remote-cache-setup.test.ts` / `run-context.test.ts`):
  `VX_CACHE_TRUST` override; GH fork PR → untrusted; GH internal PR → trusted;
  push → trusted; non-CI → trusted; untrusted + no PR token → `remoteWrite`
  off.
- **e2e** (`orchestrator-remote` / a cloud e2e): an untrusted run writes an
  artifact; a trusted run for the SAME key re-executes (does not restore it);
  an untrusted run DOES restore a trusted artifact. The headline correctness
  law, pinned both directions.
- **no key change:** existing key-derivation byte-identity tests are the guard
  (no new fold, no bump).

## 12. Why this is the right move

- **It is a real boundary, not theatre.** The untrusted token cannot write the
  trusted scope regardless of what key it computes — server-enforced — which is
  the only thing that stops a _deliberate_ poisoner. A folded public scope
  does not.
- **The cache key never changes.** `CACHE_VERSION` stays v24, the solo-dev path
  is byte-identical, and the legitimate asymmetric read (fork PR warms off
  `main`) is preserved — all of which a key-fold would break.
- **It copies a proven, understood model** — GitHub Actions' ref-scoped cache
  and Nx/Turbo's read-only PR token — so users already know the shape and the
  attack it stops.
- **Zero-config, zero-overhead by default.** Tiers only exist when a PR token
  is configured or a fork PR is detected; everything else is exactly today,
  including existing warm artifacts (migrated in place).
- **It composes cleanly with what shipped** — signing stays as within-scope
  integrity, `teamId/slug` stays as third-party tenancy, vx agents write the
  submission's scope via the token they already carry, and Phase 2's
  cross-workspace story is the same `<bucket>/<tier>` layout with `bucket`
  chosen from a per-workspace token.
