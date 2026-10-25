# vx-cache protocol, v1

An HTTP API for task artifacts and run history. `@vzn/vx-cache-server`
speaks it on Bun and on Cloudflare Workers; any server that does can take
its place. Every route sits under `/v1`: a later version gets its own
prefix, and a server may serve both.

The artifact routes are Turbo's remote cache API
([spec](https://turborepo.com/api/remote-cache-spec)) under `/v1` in place
of `/v8`: the same routes, headers, bodies and status codes. Only what
that API cannot say is ours: run history, CI tokens and read scopes.
§ Where it differs from Turbo lists every difference and why.

## Opaque strings, plain numbers

The server never reads a string a client sends. It only stores it and
compares it for equality: artifact hashes, run ids, task names, artifact
bytes. A client may send them encrypted (a keyed hash for names, a cipher
for bytes) and the server works the same. Numbers (sizes, durations,
times, exit codes) stay plain so the server can sort and query them.
Refs in `x-artifact-read-scopes` stay plain too: the server matches them against
CI tokens, which name them anyway.

## Tokens

Every request carries `Authorization: Bearer <token>`. A read token reads;
a write token also writes, always to the **trusted** scope. A missing or
unknown token is `401`; a write by a read token `403`.

A bearer that is a JWT is a CI job's OIDC token (GitHub Actions, GitLab
CI). Its signature, `RS256`, `exp` and `aud` (the server's own) are
checked, and the token alone decides where it writes, by the server's
trust rules:

- A token of a repository no rule names is `403`.
- A token that matches one of its repository's rules writes **trusted**.
- Any other writes its branch's scope: on GitHub a pull request's head
  branch (`refs/heads/<head_ref>`), else its `ref`; on GitLab its
  `ref_path`. A branch a rule trusts (`refs/heads/main`) is never one:
  such a token reads only, so main's runs never read an untrusted write.

## Scopes

An artifact or run lives in one scope. A read walks the refs named in
`x-artifact-read-scopes`, in order, then the trusted scope, and the first scope
that holds a key answers it. The header is an RFC 8941 list of strings,
each `refs/...`, at most 8:

```
x-artifact-read-scopes: "refs/heads/feature", "refs/heads/main"
```

Absent, a read sees the trusted scope only. Any other value is `400`.

## Artifacts

A hash is 1 to 128 hex digits. An artifact is immutable. A server may
evict one at any time: a `GET` after a `HEAD` or a query that held it may
be `404`, which a client reads as a miss. `teamId` and `slug` query
parameters are taken and ignored: the token names the namespace.

| Request                     | Answer                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD /v1/artifacts/<hash>` | `200` with `Content-Length`, `x-artifact-duration` and, when stored, `x-artifact-sha` and `x-artifact-dirty-hash`; or `404`. Reads no blob.                                                                                        |
| `GET /v1/artifacts/<hash>`  | `200` with the bytes (`application/octet-stream`), those headers and, when stored, `x-artifact-tag`; or `404`.                                                                                                                     |
| `PUT /v1/artifacts/<hash>`  | The bytes, with `Content-Length` (`400` without) and optional `x-artifact-duration`, `x-artifact-tag` (at most 600), `x-artifact-sha`, `x-artifact-dirty-hash`. `202` with `{ "urls": [<this artifact's URL>] }`; `413` too large. |
| `POST /v1/artifacts`        | `{ "hashes": [<hash>, …] }`, up to 1000 → `{ <hash>: { "size", "taskDurationMs", "tag"? } \| null }`, one entry per hash.                                                                                                          |
| `GET /v1/artifacts/status`  | `{ "status": "enabled" }`.                                                                                                                                                                                                         |
| `POST /v1/artifacts/events` | Turbo's list of cache events: `200`, and dropped.                                                                                                                                                                                  |

`x-artifact-duration` is how long the task that made the artifact took,
in whole milliseconds; a PUT without it stores 0. A second PUT of a hash
already held answers `202` too, and the stored bytes stay.

## Run history

A run is one record: its tasks are a list inside it.

`POST /v1/runs` (write token) stores a run in the token's scope: `201`, or
`200` when that run (same `id` and `startedAt`) is already held.

```json
{
  "id": "01JB…",
  "startedAt": 1729850000000,
  "durationMs": 61000,
  "tasks": [
    {
      "task": "app#build",
      "key": "8f1c…",
      "durationMs": 4200,
      "exitCode": 0,
      "cached": false,
      "startedAt": 120
    }
  ]
}
```

`id` and `task` are strings of up to 512 characters, `key` a key; the
times are whole milliseconds (`startedAt` of the run since the epoch). A
task's `key`, `exitCode`, `cached` and `startedAt` are optional; other
fields are dropped. The body is at most 1 MiB and 20 000 tasks.

`GET /v1/runs?limit=<n>` (1 to 100, default 20) lists the newest runs in
the read scopes: `{ "runs": [{ "id", "scope", "startedAt", "durationMs",
"taskCount", "failedCount" }] }`. A failed task has a non-zero `exitCode`.

`POST /v1/tasks/query` with `{ "tasks": [<task>, …], "limit"?: <n> }` (up
to 1000 tasks, `limit` 1 to 20, default 5) answers each task's newest
records among the newest 100 runs in the read scopes:

```json
{
  "tasks": {
    "app#build": [
      {
        "run": "01JB…",
        "scope": "trusted",
        "key": "8f1c…",
        "durationMs": 4200,
        "exitCode": 0,
        "cached": false,
        "startedAt": 120
      }
    ]
  }
}
```

A task no run holds answers `[]`.

## Errors

Every refusal is Turbo's spec's `Error`, `application/json`, its
`message` saying what to fix:

```json
{ "code": "forbidden", "message": "this token reads only" }
```

A JSON body without `Content-Type: application/json` is `400`; an unknown
route `404`; a route's wrong method `405` with `Allow`. A HEAD answers the
status alone.

## Where it differs from Turbo

Each is where Turbo's API cannot say what vx needs:

- **`/v1`, not `/v8`.** Our own versioning: this protocol is not Vercel's
  API at version 8.
- **`x-artifact-read-scopes`.** Turbo has one shared scope; vx keeps a
  branch's writes apart from main's (§ Scopes). A client that sends no
  header reads the trusted scope, as with Turbo.
- **CI OIDC tokens and `403` on a write.** Turbo leaves tokens to the
  server; ours decide where a write lands (§ Tokens).
- **Run history**, `/v1/runs` and `/v1/tasks/query`: Turbo has none.
- **`413`** for an artifact over the server's limit: Turbo's spec names no
  limit, and Workers' free plan takes a body of at most 100 MB.
- **At most 1000 hashes per batch query**, and a hash at most 128 long:
  the spec sets no bound, and a request must have one.
- **Events are dropped**: vx keeps run history instead.
