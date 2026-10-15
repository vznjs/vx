# Cache integrity: the cache server's job (2026-10)

**Status:** decided, nothing to build in vx. M, 2026-10-15 10:03 (via
EA): "Ok so signing is up to cache server to implement." This replaces
the per-run signing design merged earlier the same day (#3594). That
design is kept below, marked superseded.

## Decision

Cache integrity is the cache server's job. It works like npm trusted
publishing:

- **Writes.** When a CI job writes, it sends its OIDC token as the write
  credential. The token is fetched at request time with the server's
  own URL as its audience.
- **Server checks.** The server verifies the token against GitHub's or
  GitLab's public keys (JWKS). It checks `iss`, `aud` and `exp`, and
  checks the claims against the repo and workflows the user registered
  with it.
- **Token never stored.** The token authorizes one request and is
  dropped. It is never written into the cache or next to an entry.
- **Reads.** Readers trust the server, as with any trusted artifact
  store (M 10-14: the cache is trusted like GitLab artifacts).

## What vx ships

Nothing for this:

- no signing code;
- no core `remote(layer)` hook;
- no `signing` option in `@vzn/vx-ci`.

Core stays as it is: the token is the only boundary core knows, and
`access` on a remote still narrows what a run may do.

## Plugin side

If a cache plugin's server supports OIDC auth, the plugin may send the
CI token as its write credential, from its `cache(ctx)` hook. That is
the plugin's own choice, not core's. The plugin:

- fetches the token with its server's URL as the audience;
- refreshes it before `exp`;
- sends nothing, and prints nothing, when the job has no token
  (no GitHub `id-token: write`, no GitLab `id_tokens:`).

## What a server should check

This is guidance for whoever builds one, folded in from
`org/product/cache-service-oidc-provenance.md` §1 and M's questions of
2026-10-15. It is not vx code.

- **Default keys** accept writes only from the default branch or a
  protected ref, and from the registered workflow files
  (`job_workflow_ref` / `ci_config_ref_uri`).
- **Events.** Refuse writes when `event_name` is `pull_request_target`,
  `workflow_run` or `issue_comment`. Those events run on main's ref on a
  PR's behalf.
- **Other jobs** write only their own scope. On GitHub that is the PR
  number from `refs/pull/<n>/merge`. On GitLab it is the merge request
  (`ref_path` `refs/merge-requests/<iid>/head`), or project id plus
  branch, never the branch name alone.
- **Replay.** Each `jti` is accepted once.
- **Audit.** Each stored entry records the writer's run id and sha, so a
  bad run's entries can be found and purged.

## Why the stored-token designs were dropped

The superseded design below stored each run's token inside every entry,
so readers could verify the entry offline.

- **GitLab tokens cannot name a key.** `id_tokens` are fixed before the
  job starts, so the audience cannot carry the run's key. Readers cannot
  check `exp` days later either. So any main token copied out of the
  cache would vouch for any key: whoever can read the cache could sign
  anything as main.
- **M ruled that the signing token is never stored in the cache.**

A server that checks the token at write time has neither problem. The
token is live when it is checked, and it is never stored.

## What this does not cover

A compromised server or bucket can still serve wrong bytes. Readers
trust the store. Per-entry signatures that a reader verifies are the
only answer to that, and they are dropped for the reasons above.

---

## Superseded: per-run keys bound to the CI token (2026-10-15, 09:08 to 10:03)

Kept as the record. Dropped by M's 10:03 decision above.

### Problem

Today the cache token is the only boundary. Anyone who can write the store can poison
a hit for everyone who reads it: a PR job whose token can write, a leaked
token, a compromised bucket, or a server bug. Each of these replays wrong bytes under a green run, which
is the worst failure class vx has.

### M's calls

- Sign first; encrypt later.
- Sign each entry, with no run manifest: an entry is verifiable once it
  is uploaded, even if the run crashes after.
- Identity comes from CI OIDC only. There are no static keys or tokens. Laptops
  verify and read; they never write a signed entry.
- The signature is stored in the remote cache. There is no public log lookup,
  because a log would leak private repo names.
- It lives in `@vzn/vx-ci`, as `github()` and `gitlab()` side by side.
- Core gets one small seam on the remote path. A failed check is a miss,
  and the seam costs nothing when no plugin uses it.

### Why not Fulcio

The EA's sketch was one Sigstore Fulcio certificate per run. Public Fulcio
writes every certificate it issues to a public Certificate Transparency
log. The certificate names the repo and workflow, so it leaks a private
repo's name the same way Rekor would. Public Fulcio also trusts only
gitlab.com, not self-managed GitLab. A private Fulcio is a service the
user would have to run.

### Design: the CI token binds the key

The CI provider signs the binding itself, with no third party.

1. **Key.** On the first upload of a run, the plugin generates a
   throwaway ECDSA P-256 key pair (WebCrypto). The private key cannot be
   exported and never leaves the process.
2. **Binding.** The plugin asks the CI provider for an OIDC token whose
   audience is `vx-ci-sign:<base64url sha256 of the public key>`. The
   token is signed by GitHub or GitLab. It names the repo, ref, workflow,
   event, run and commit, and its audience names exactly this public key.
   No service accepts that audience, so the stored token works as a
   statement, not as a credential. It is also expired by the time anyone
   reads it.
   - GitHub: `ACTIONS_ID_TOKEN_REQUEST_URL&audience=…`. The workflow needs
     `permissions: id-token: write`.
   - GitLab: `id_tokens:` with that audience. Gate for the spike: confirm
     GitLab expands a CI variable in `aud`. Without that, GitLab signing
     waits; see Open points.
3. **Entry.** Each upload is signed locally, one ECDSA signature per
   entry. The signature travels in a header in front of the artifact
   bytes, in the remote copy only. The local store keeps the artifact
   unchanged.

```
"VXSIG1\n"                  7 bytes
u32 big-endian length L     header JSON size, at most 16 KiB
JSON { v: 1, jwt, key, sig, sha256, size }
artifact bytes              unchanged (`<hash>.tar.zst`, or a ctx.cache blob)
```

The signature covers
`vx-ci-entry-v1\0<wire key>\0<sha256 of the body>\0<size>`. Signing the
wire key means a valid entry copied under another key is refused. That
was the gap the plugins guide's own signed example closes the same way.

Per entry, the header costs about 1.5 KiB, mostly the token. Every entry
carries its own token and key, so each one verifies alone. There is no
certificate object to fetch first, and nothing is missing if the run
dies halfway.

### Reading

`get(key)` on the wrapped remote does the following:

1. Read only the header from the stream. If the magic is missing, the
   length is over the cap, or the JSON is bad, return `null`: a silent
   miss. An unsigned entry from before signing was turned on is also a
   miss, so turning signing on fails closed.
2. Verify the token. Check its signature against the issuer's JWKS, and
   check `iss`, and that `aud` equals `vx-ci-sign:` plus the sha256 of
   `key`. `exp` is not checked: the token is a statement made at signing
   time. Each distinct token is verified once per run (an in-memory memo).
   The JWKS is fetched once per run with a 2 s deadline, and kept on disk
   for 24 h so offline laptops still verify.
3. Check the identity (below). Then verify `sig` over the message. Any
   failure returns `null`, with no terminal output (M: no extra runtime
   warnings). The `github()` job summary counts refused entries.
4. Return the remaining body as a stream that is hashed as it passes. If
   the sha256 or size does not match at the end, the stream errors.
   Core's existing contract makes that a miss and stores nothing. The
   artifact was validly signed but then changed, so this is store
   corruption, and core's one existing download warning is right here.

`has` and `hasMany` pass straight through. An existence probe cannot
verify, so `--dry` may predict a remote hit that then fails the check
and becomes a miss.

### Who is trusted

The wire key is opaque: a scoped key is `xxh3(scope, key)`, so the
reader cannot tell which scope wrote an entry. Trust therefore follows
the reader's scope, not the entry's:

- **Every reader** trusts the default identity: same repo (by id, not
  name), a ref on the default branch (GitHub) or `ref_protected: true`
  (GitLab), an allowed event, and, when `workflows` is set, one of the
  pinned workflow files (`job_workflow_ref` / `ci_config_ref_uri`).
- **A scoped reader** also trusts its own scope's identity, as vx-ci
  derives the scope: `pr-<n>` trusts `refs/pull/<n>/merge` in the same
  repo, and `mr-<iid>` trusts that merge request (see (b)).

So a PR can poison only its own scope's reads, which it already controls.
It cannot reach main, another PR, or a laptop. A fork PR gets no
`id-token` permission on `pull_request`, so it cannot sign: its uploads
are skipped and its cache stays local.

### M's questions

**(a) No writes from `pull_request_target` or `workflow_run` jobs.** The
writer reads `event_name` from its own token, not from the environment.
For `pull_request_target`, `workflow_run` and `issue_comment` it reports
`access.write: false`, so core never even packs an upload. The reader
also refuses any token whose `event_name` is one of those, whatever its
ref. Today `githubCacheScope` only moves those events to a PR scope;
this makes them write nothing remote at all.

**(b) GitLab scope.** `gitlab()`'s scope is `mr-<iid>` for a
merge-request pipeline (`CI_MERGE_REQUEST_IID`, cross-checked against
the token's `ref_path`, `refs/merge-requests/<iid>/head`). Otherwise it
is `p<project_id>-<branch>`. It is never the branch name alone: branch
names repeat across forks and come back after a branch is deleted. The
reader checks `project_id` and `ref_path` from the token against the
scope. The spike confirms the claim names on gitlab.com and on one
self-managed instance.

**(c) A stolen main token.**

- _`jti` single use._ This only means something to a server that accepts
  the token as a credential: the future cache service (provenance note
  §1) records each `jti` and refuses a second use. Signing never uses the
  token as a credential, so there is nothing to replay there. A stolen
  token minted for one key binds only that key.
- _Workflow pinning._ `github({ signing: { workflows: ['.github/workflows/ci.yml'] } })`
  limits the default identity to those workflows, so another workflow
  with `id-token: write`, or a reusable workflow someone adds, cannot
  sign for main.
- _Audit and purge._ Every header carries the token, so every entry names
  its `run_id`, `run_attempt`, `sha`, workflow and actor. `vx-ci` exports
  `readSignature(bytes)` so a script can list or purge a run's entries in
  the bucket. `signing.distrust: ['run:<id>']` makes every reader on that
  commit refuse a run's entries at once, before anyone touches the bucket.

### Writing

- Only a job with an OIDC endpoint signs (GitHub
  `ACTIONS_ID_TOKEN_REQUEST_URL`, GitLab's token variable). Anywhere
  else, including every laptop, the wrapper reports `access.write: false`:
  no signed write, and no wasted pack.
- The key and token are made on the first `put`, once per run, with a
  5 s deadline. If that fails, the rest of the run uploads nothing,
  silently. The job summary says signing was off and why.
- A job whose own identity a default reader would refuse (not the
  default branch, a refused event, a workflow outside the pins) writes
  only under its own scope's keys. ScopedCache already does that for a
  scoped run. An unscoped run that fails the default identity gets
  `access.write: false`.
- Upload reads the file-backed body twice, once to hash and once to send.
  `new Blob([header, body])` stays file-backed, so nothing is held whole.
  Uploads already run off the critical path.
- `put` stays write-once, as core already enforces.

### Core seam

```ts
interface VxPlugin {
  /** Wrap each remote the workspace declares; return it unchanged to decline. */
  remote?(layer: RemoteCacheLayer, ctx: CacheContext): RemoteCacheLayer
}
```

`resolveCache` (`orchestrator/plugin-host.ts`) passes each remote from a
`cache` hook through every plugin's `remote` hook, in declared order,
before it reads `access` and builds the `LayeredCache`. That covers task
artifacts and `ctx.cache` blobs alike, because both use the same
`remotes`. Core checks the returned shape, as it does for `cache`, and
does no cryptography (10-13: "no seal in core"). The miss rules it needs
already exist: `get → null`, a body that errors, and `access.write: false`.
Cost:

- **No `remote` hook:** nothing.
- **A warm local hit:** nothing, because the wrapper is on the remote
  path only.
- **A remote hit:** one sha256 pass over the body, one P-256 verify, and
  one memoized token check per writing run.
- **An upload:** one extra read and sha256, and one P-256 sign.

The perf bench gets a remote-hit row with signing on, so the cost carries
a number before this ships.

`github()` returns `undefined` off Actions today. With `signing` set, it
returns a verify-only plugin there, so a laptop checks entries too. A
laptop with no vx-ci plugin reads the header as part of a corrupt
archive, which is a miss: forgetting the plugin fails closed.

### Reused from shared timings (#3580)

- Plugin-namespaced keys: the signature uses the entry's own key and
  adds no new keys.
- Write-once `put`.
- Silent degrade.
- A deadline on every network call: 5 s to mint, 2 s for the JWKS.
- The `ctx.ci` and branch facts.

### Tests (each red first)

- A body signed for key A, stored under key B, is a miss.
- A flipped body byte under a valid header errors the stream and stores
  nothing.
- A token whose `aud` names another key, or with a bad signature, a wrong
  `iss`, or another repo id: a miss, with no terminal line.
- A PR identity's entry is a miss for a default reader and a hit for
  that PR's own reader. It is a miss for another PR.
- `event_name: pull_request_target` or `workflow_run`: the writer reports
  `access.write: false`, and the reader refuses a token carrying either.
- `workflows` pin: a token from another workflow file is a miss.
- `distrust: ['run:42']`: entries of run 42 are misses.
- A laptop, with no OIDC endpoint, uploads nothing and verifies hits.
- No plugin with a `remote` hook: no wrapper call, which a spy shows.
  The local warm path makes no extra syscall
  (`tests/syscall-repeats.unsafe.test.ts`).
- A `ctx.cache` blob round-trips signed, and the timings import reads it.
- GitLab: an `mr-7` reader refuses an `mr-8` signer and a same-named
  branch from another project.

The tests use a local JWKS and an issuer stub. The live GitHub and
GitLab mints run in a CI job that has `id-token: write`.

### Residual risks

- **No signing-time proof.** Without a log or a timestamp, a key stolen
  from a running main job's memory can sign later. Stealing it needs code
  running inside that job, which could poison the cache directly anyway.
  The answer is audit by `run_id`, then `distrust` and purge. A later
  option is an RFC 3161 timestamp over the digest only, which names no
  repo.
- **JWKS rotation.** Entries signed under a key the issuer retires stop
  verifying. They become misses and get rebuilt. That is safe, and only
  slower.
- **GitHub Enterprise issuers** (`iss` with an enterprise slug) need the
  issuer as an option. Default: `https://token.actions.githubusercontent.com`.

### Open points (EA to raise with M)

- API names: the `remote` hook, the `signing` option and `distrust`.
  M names APIs himself.
- GitLab without variable expansion in `aud` has no way to bind a
  per-run key. Then GitLab signing waits for a server-side check (the
  cache service, provenance note §1) or a private Fulcio.

### Out of scope

Encryption (next). The cache service's OIDC auth (provenance note §1).
Purge tooling beyond `readSignature`.
