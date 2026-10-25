# vx-cache protocol, v1

An HTTP API for task artifacts. `@vzn/vx-cache-server` speaks it on Bun
and on Cloudflare Workers; any server that does can take its place.
Every route sits under `/v1`: a later version gets its own prefix, and a
server may serve both.

| Route                               | What it does                              |
| ----------------------------------- | ----------------------------------------- |
| `GET /v1/artifacts/download/<hash>` | one artifact's bytes                      |
| `POST /v1/artifacts/download`       | many artifacts' bytes in one answer       |
| `PUT /v1/artifacts/<hash>`          | one artifact's bytes                      |
| `POST /v1/artifacts/check`          | which exact keys are held, and their size |
| `GET /v1/capabilities`              | the server's limits                       |

## Opaque strings

The server never reads a hash or an artifact's bytes. It only stores
them and compares hashes for equality, so a client may send them
encrypted (a keyed hash for names, a cipher for bytes). No ref goes on
the wire plain: a scope is its ref's hash (§ Keys), and the server
hashes the token's ref the same way to find where a write goes.

## Tokens

Every request carries `Authorization: Bearer <token>`, a CI job's OIDC
token (GitHub Actions, GitLab CI): there is no other. Its signature,
`RS256`, `exp` and `aud` (the server's own) are checked, and the token
alone decides what it reads and where it writes, by the server's trust
rules:

- Its issuer and repository id (`repository_id` on GitHub, `project_id`
  on GitLab) are the repository it reads and writes; one no rule names
  is `403`. A repository's artifacts are never another's.
- It writes its branch's scope: on GitHub a pull request's head branch
  (`refs/heads/<head_ref>`), else its `ref`; on GitLab its `ref_path`.
- A ref a rule names (`refs/heads/main`) is protected: a token on it that
  matches no rule reads only (a write is `403`), so main's runs never
  read a write they did not make.

A missing or bad token is `401`. A server with no rules refuses every
request: `401`, `the server trusts no CI: set TRUST`.

## Keys

An artifact lives in one scope, and a key names both: `{ scope, hash }`.
`scope` is a ref's hash: the first 128 bits of the SHA-256 of its UTF-8
(`refs/heads/main`), 32 lowercase hex digits; a plain ref is `400`.
`hash` is 1 to 128 hex digits. A read is exact: the server answers the scope named and no
other, so a client that wants its branch's work and then main's asks
for both keys. Every read names a scope.

An artifact is immutable. A server may expire one at any time: a
download after a check that held it may miss, which a client reads as a
miss.

`GET /v1/artifacts/download/<hash>` with `x-vx-scope: <scope>`: `200`
with the bytes (`application/octet-stream`, `Content-Length`), or `404`.

`POST /v1/artifacts/check` with `{ "keys": [{ "scope", "hash" }, …] }`,
up to `maxCheckKeys`: `{ "sizes": [<size> | null, …] }`, one per key in
the order sent. Every answer names the server's limits, which a client
batches by:

```
x-vx-max-check-keys: 500
x-vx-max-batch-artifacts: 100
x-vx-max-upload-bytes: 100000000
```

`POST /v1/artifacts/download` with the same `{ "keys": […] }`, up to
`maxBatchArtifacts`: an `application/vnd.vx-cache.batch` body. Its first
line is JSON naming each held key with its size, in the order asked,
and its bytes follow in that order; a key it does not name is not held:

```
{"artifacts":[{"scope":"f921bd05e68b03740c450e565e0e6173","hash":"8f1c","size":4200}]}\n
<4200 bytes>
```

`PUT /v1/artifacts/<hash>` (a token that writes, as Turbo's
`PUT /v8/artifacts/<hash>`), with `Content-Length`: the body is the
artifact's bytes, stored in the token's scope. One the scope already
holds keeps its bytes, answered before they are read. `204`; past
`maxUploadBytes`, `413`. A client may `check` first to skip what is
held.

Uploads go one artifact at a time: there is no batch upload. A batch's
bytes pass through the server's code to be split, which on Workers costs
CPU by the byte (a 40 MB one ran out of it), while a `PUT`'s reach the
bucket untouched.

## Limits

An operator sets each; `GET /v1/capabilities` names them:

```json
{ "maxCheckKeys": 500, "maxBatchArtifacts": 100, "maxUploadBytes": 100000000 }
```

A backend may lower one to what it can serve: Workers' free plan makes
1000 calls to R2 a request and takes a 100 MB body.

## Errors

Every refusal is `{ code, message }`, `application/json`, its `message`
saying what to fix:

```json
{ "code": "forbidden", "message": "this token reads only" }
```

A JSON body without `Content-Type: application/json` is `400`; an unknown
route `404`; a route's wrong method `405` with `Allow`. Turbo's `teamId`
and `slug` query parameters are `400`: the token names the repository.
