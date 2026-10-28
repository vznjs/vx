# vx-cache protocol, v1

An HTTP API for task artifacts. `@vzn/vx-cache-server` speaks it on Bun
and on Cloudflare Workers; any server that does can take its place.
Every route sits under `/v1`: a later version gets its own prefix, and a
server may serve both.

Turbo's routes (`/v8/artifacts`), under `/v1`:

| Route                       | What it does                             |
| --------------------------- | ---------------------------------------- |
| `GET /v1/artifacts/<hash>`  | one artifact's bytes                     |
| `HEAD /v1/artifacts/<hash>` | whether it is held, and its size         |
| `PUT /v1/artifacts/<hash>`  | one artifact's bytes                     |
| `POST /v1/artifacts`        | which of many hashes are held, and sizes |
| `GET /v1/capabilities`      | the server's limits                      |

Where it differs from Turbo: a read names its scopes (§ Keys), since an
artifact lives in its branch's scope; every request names its issuer
and repository by their hashes (§ Repository), so `teamId` and `slug`
are refused; there is no events route.

## Opaque strings

The server never reads a hash or an artifact's bytes. It only stores
them and compares hashes for equality, so a client may send them
encrypted (a keyed hash for names, a cipher for bytes). No ref goes on
the wire plain: a scope is its ref's hash (§ Keys), and the server
hashes the token's ref the same way to find where a write goes.

## Repository

Every request names its repository: `vx-issuer`, the hash (§ Keys) of
the CI issuer's URL as its tokens name it, no trailing slash
(`https://token.actions.githubusercontent.com`), and `vx-repository`,
the hash of its `org/name` there, lowercased. One missing or not a hash
is `400`. A token of another repository than the one named is `403`.

A server whose `READ_ACCESS` is `public` takes a request with no token
too: it reads a repository its rules name (another is `403`) and writes
nothing (`403`, `this request reads only`). Any other server answers a
request with no token `401`.

## Tokens

A request's `Authorization: Bearer <token>` is a CI job's OIDC token
(GitHub Actions, GitLab CI): there is no other. Its signature,
`RS256`, `exp` and `aud` (the server's own) are checked, and the token
alone decides what it reads and where it writes, by the server's
`ALLOW` (`issuer:owner/repo:workflow` entries):

- Its issuer and repository name (`repository` on GitHub, `project_path`
  on GitLab, `org/name`, any case) are the repository it reads and writes; one `ALLOW`
  does not name is `403`, and so is a job of a workflow it does not name
  (`job_workflow_ref`, GitLab's `ci_config_ref_uri`). A repository's artifacts are never another's.
- It writes its branch's scope: on GitHub a `pull_request` run's head
  branch (`refs/heads/<head_ref>`), a merge queue's (`merge_group`) run
  (`refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`, that exact form)
  its base branch (`refs/heads/<base>`), which its code is about to
  become, else its `ref`; on GitLab its `ref_path`.
- A `pull_request_target` run writes nothing (a write is `403`): its
  `head_ref` a fork names, and its `ref` is the base. Nor does a
  `pull_request` run whose head branch has its base branch's name (only
  a fork's can), nor a GitLab `merge_request_event` pipeline unless its
  `source_project_path` (GitLab 19.5+) names its own project: a fork's
  runs in the parent project with the fork's branch as its `ref_path`.

A bad token is `401`. A server with `ALLOW` empty refuses every
request: `401`, `the server admits no CI: set ALLOW`. A server that
cannot fetch the issuer's keys answers `502`: the token is not refused,
so a client keeps the remote for its next request.

## Keys

An artifact lives in one scope, and a key names both: `{ scope, hash }`.
`scope` is a ref's hash: the first 128 bits of the SHA-256 of its UTF-8
(`refs/heads/main`), 32 lowercase hex digits; a plain ref is `400`.
`GET` and `HEAD` name one scope in `vx-scope`; a check names
its scopes in its body.
`hash` is 1 to 128 hex digits. A read is exact: the server answers the scope named and no
other, so a client that wants its branch's work and then main's asks
for both. Every read names a scope.

An artifact is immutable. A server may expire one at any time: a
download after a check that held it may miss, which a client reads as a
miss.

`GET /v1/artifacts/<hash>` (as Turbo's `GET /v8/artifacts/<hash>`) with
`vx-scope: <scope>`: `200` with the bytes (`application/octet-stream`,
`Content-Length`, `Cache-Control: private, max-age=31536000, immutable`:
the bytes under a key never change), or `404`. `HEAD` is the same with
no bytes.

`POST /v1/artifacts` (Turbo's batch query) with `{ "hashes": [<hash>,
…], "scopes": [<scope>, …] }`, the scopes in the order to read them, up
to `maxCheckHashes` lookups (hashes × scopes): `{ "<hash>": { "size":
<bytes>, "scope": <scope> } | null, … }`, one per hash, naming the first
scope asked that holds it, which its download names. Each lookup is
exact, and its time does not grow with what a scope holds. Every
`/v1/artifacts` answer, a refusal too, names the server's limits, which
a client chunks its checks by, sending the chunks at once:

```
vx-max-check-hashes: 500
vx-max-upload-bytes: 100000000
```

`PUT /v1/artifacts/<hash>` (a token that writes, as Turbo's
`PUT /v8/artifacts/<hash>`), with `Content-Length`: the body is the
artifact's bytes, stored in the token's scope. One the scope already
holds keeps its bytes, answered before they are read. `204`; past
`maxUploadBytes`, `413`. A client may `check` first to skip what is
held.

Downloads and uploads go one artifact at a time, many at once: there is
no batch of either (2026-10-25: "use the put and get"). A batch's
bytes pass through the server's code, which on Workers costs CPU by the
byte (a 40 MB one ran out of it), and its artifacts arrive one after
another; a `GET`'s and a `PUT`'s bytes pass untouched, in parallel.

## Limits

An operator sets each; `GET /v1/capabilities` names them:

```json
{ "maxCheckHashes": 500, "maxUploadBytes": 100000000 }
```

A client keeps to the limits the server names.

## Errors

Every refusal is `{ code, message }`, `application/json`, its `message`
saying what to fix:

```json
{ "code": "forbidden", "message": "this request reads only" }
```

A JSON body without `Content-Type: application/json` is `400`; an unknown
route `404`; a route's wrong method `405` with `Allow`. Turbo's `teamId`
and `slug` query parameters are `400`: the token names the repository.
