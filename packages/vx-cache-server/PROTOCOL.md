# vx-cache protocol, v1

An HTTP API for task artifacts and the timings a scheduler needs.
`@vzn/vx-cache-server` speaks it on Bun and on Cloudflare Workers; any
server that does can take its place. Every route sits under `/v1`: a
later version gets its own prefix, and a server may serve both.

| Route                               | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `GET /v1/artifacts/download/<hash>` | one artifact's bytes                                 |
| `POST /v1/artifacts/download`       | many artifacts' bytes in one answer                  |
| `POST /v1/artifacts/upload`         | 1 to 100 artifacts, and timings riding along         |
| `POST /v1/artifacts/check`          | which of up to 1000 hashes are held, and their sizes |
| `POST /v1/timings/upload`           | a run's timings no upload carried                    |
| `POST /v1/timings/query`            | each task's newest timings                           |
| `GET /v1/capabilities`              | the server's limits                                  |

## Opaque strings, plain numbers

The server never reads a string a client sends. It only stores it and
compares it for equality: artifact hashes, task hashes, artifact bytes. A
client may send them encrypted (a keyed hash for names, a cipher for
bytes) and the server works the same. Numbers (sizes, durations, cores,
bytes) stay plain so the server can sort and query them. Refs in
`x-artifact-read-scopes` stay plain too: the server matches them against
CI tokens, which name them anyway.

## Tokens

Every request carries `Authorization: Bearer <token>`, a CI job's OIDC
token (GitHub Actions, GitLab CI): there is no other. Its signature,
`RS256`, `exp` and `aud` (the server's own) are checked, and the token
alone decides what it reads and where it writes, by the server's trust
rules:

- Its repository id (`repository_id` on GitHub, `project_id` on GitLab)
  is the repository it reads and writes; one no rule names is `403`. A
  repository's artifacts and timings are never another's.
- A token that matches one of its repository's rules writes **trusted**.
- Any other writes its branch's scope: on GitHub a pull request's head
  branch (`refs/heads/<head_ref>`), else its `ref`; on GitLab its
  `ref_path`. A branch a rule trusts (`refs/heads/main`) is never one:
  such a token reads only (a write is `403`), so main's runs never read
  an untrusted write.

A missing or bad token is `401`. A server with no rules refuses every
request: `401`, `the server trusts no CI: set TRUST`.

## Scopes

An artifact or timing lives in one scope. A read walks the refs named in
`x-artifact-read-scopes`, in order, then the trusted scope, and the first
scope that holds a hash answers it. A ref a trust rule names
(`refs/heads/main`) is read as trusted. The header is an RFC 8941 list of
strings, each `refs/...` in printable ASCII and at most 255 long, at
most 8:

```
x-artifact-read-scopes: "refs/heads/feature", "refs/heads/main"
```

Absent, a read sees the trusted scope only. Any other value is `400`.

## Artifacts

A hash is 1 to 128 hex digits. An artifact is immutable. A server may
evict one at any time: a download after a check that held it may miss,
which a client reads as a miss.

`GET /v1/artifacts/download/<hash>`: `200` with the bytes
(`application/octet-stream`, `Content-Length`), or `404`.

`POST /v1/artifacts/check` with `{ "hashes": [<hash>, …] }`, up to 1000:
`{ <hash>: { "size" } | null }`, one entry per hash. Every answer names
the server's batch limits, which a client batches by:

```
x-vx-max-batch-artifacts: 100
x-vx-max-upload-bytes: 100000000
```

`POST /v1/artifacts/download` with `{ "hashes": [<hash>, …] }`, up to
100: an `application/vnd.vx-cache.batch` body. Its first line is JSON
naming each held artifact, in the order asked, and its bytes follow in
that order; a hash it does not name is not held:

```
{"artifacts":[{"hash":"8f1c","size":4200},{"hash":"a07e","size":12}]}\n
<4200 bytes><12 bytes>
```

`POST /v1/artifacts/upload` (a token that writes) takes the same shape,
`Content-Type: application/vnd.vx-cache.batch` with `Content-Length`: a
line naming 1 to 100 artifacts, each hash once, then their bytes. The
line may carry `timings` (below), up to 1000, which the server keeps
first. An artifact the write's scope or the trusted scope already holds
keeps its bytes, and its bytes here are skipped; when every one is held
the server answers before reading them. `204`. Together they are at most
`x-vx-max-upload-bytes` (`413` past it). A
`Content-Length` that is not the line's bytes and the sizes it names is
`400`.

A client sends one or two uploads waiting at once as they are, and asks
`check` before an upload of more, sending only what is missing. It
batches only within the limits a check named, and before one has, not at
all.

## Timings

What a scheduler learns from one run of a task that succeeded: its
duration, the CPU cores it kept busy on average and its peak memory. A
task is named by a hash of its definition (opaque to the server):

```json
{ "hash": "3b0d…", "durationMs": 4200, "cores": 1.8, "rssBytes": 310000000 }
```

`hash` is a string of up to 512 characters, `durationMs` and `rssBytes`
whole numbers, `cores` a number; `cores` and `rssBytes` are optional.

`POST /v1/timings/upload` (a token that writes) with
`{ "timings": [ … ] }`, up to 20 000: `204`. The server stamps each with
the time it arrived.

`POST /v1/timings/query` with `{ "hashes": [<hash>, …], "limit"?: <n> }`
(up to 1000 hashes, `limit` 1 to 20, default 5): each hash's newest
timings, at most `limit`, trusted first, then the read refs in order. A
hash none holds answers `[]`.

```json
{ "timings": { "3b0d…": [{ "durationMs": 4200, "cores": 1.8, "rssBytes": 310000000 }] } }
```

## Limits

`GET /v1/capabilities` names every limit, for a reader that wants them
all; a run reads the two it batches by off its checks and never asks:

```json
{
  "maxBatchArtifacts": 100,
  "maxUploadBytes": 100000000,
  "maxUploadTimings": 1000,
  "maxCheckHashes": 1000,
  "maxTimingsUploaded": 20000,
  "maxQueryHashes": 1000,
  "maxQueryLimit": 20
}
```

`maxUploadBytes` is the backend's own: on Workers at most what fits a
100 MB body, on Bun what `MAX_UPLOAD_BYTES` says.

## Errors

Every refusal is `{ code, message }`, `application/json`, its `message`
saying what to fix:

```json
{ "code": "forbidden", "message": "this token reads only" }
```

A JSON body without `Content-Type: application/json` is `400`; an unknown
route `404`; a route's wrong method `405` with `Allow`. Turbo's `teamId`
and `slug` query parameters are `400`: the token names the repository.
