# vx-cache protocol, v1

An HTTP API for task artifacts. `@vzn/vx-cache-server` speaks it on Bun
and on Cloudflare Workers; any server that does can take its place.
Every route sits under `/v1`: a later version gets its own prefix, and a
server may serve both.

| Route                               | What it does                              |
| ----------------------------------- | ----------------------------------------- |
| `GET /v1/artifacts/download/<hash>` | one artifact's bytes                      |
| `POST /v1/artifacts/download`       | many artifacts' bytes in one answer       |
| `POST /v1/artifacts/upload`         | 1 to `maxBatchArtifacts` artifacts        |
| `POST /v1/artifacts/check`          | which exact keys are held, and their size |
| `GET /v1/capabilities`              | the server's limits                       |

## Opaque strings

The server never reads a hash or an artifact's bytes. It only stores
them and compares hashes for equality, so a client may send them
encrypted (a keyed hash for names, a cipher for bytes). Refs stay plain:
the server matches them against CI tokens, which name them anyway.

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
`scope` is a ref, `refs/...` (up to 500 characters). `hash` is 1 to 128
hex digits. A read is exact: the server answers the scope named and no
other, so a client that wants its branch's work and then main's asks
for both keys. Every read names a scope.

An artifact is immutable. A server may expire one at any time: a
download after a check that held it may miss, which a client reads as a
miss.

`GET /v1/artifacts/download/<hash>` with `x-vx-scope: <ref>`, the ref's
UTF-8 percent-encoded (`encodeURI`), as a header carries bytes and a
branch name any UTF-8: `200` with the bytes (`application/octet-stream`,
`Content-Length`), or `404`.

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
{"artifacts":[{"scope":"refs/heads/main","hash":"8f1c","size":4200}]}\n
<4200 bytes>
```

`POST /v1/artifacts/upload` (a token that writes),
`Content-Type: application/vnd.vx-cache.batch` with `Content-Length`: a
line naming 1 to `maxBatchArtifacts` artifacts, each hash once, then
their bytes. They go to the token's scope:

```
{"artifacts":[{"hash":"8f1c","size":4200}]}\n
<4200 bytes>
```

An artifact the write's scope already holds keeps its bytes, and its bytes here are skipped; when every one is held the
server answers before reading them. `204`. Together they are at most
`maxUploadBytes` (`413` past it). A `Content-Length` that is not the
line's bytes and the sizes it names is `400`.

A client sends one or two uploads waiting at once as they are, and asks
`check` before an upload of more, sending only what is missing. It
batches only within the limits a check named, and before one has, not at
all.

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
