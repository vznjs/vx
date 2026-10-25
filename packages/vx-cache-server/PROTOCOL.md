# vx-cache protocol, v1

An HTTP API for task artifacts and run history. `@vzn/vx-cache-server`
speaks it on Bun and on Cloudflare Workers; any server that does can take
its place. Every route sits under `/v1`: a later version gets its own
prefix, and a server may serve both.

## Opaque strings, plain numbers

The server never reads a string a client sends. It only stores it and
compares it for equality: artifact keys, run ids, task names, artifact
bytes. A client may send them encrypted (a keyed hash for names, a cipher
for bytes) and the server works the same. Numbers (sizes, durations,
times, exit codes) stay plain so the server can sort and query them.
Refs in `Vx-Read-Scopes` stay plain too: the server matches them against
CI tokens, which name them anyway.

## Tokens

Every request carries `Authorization: Bearer <token>`. A read token reads;
a write token also writes, always to the **trusted** scope. A missing or
unknown token is `401`; a write by a read token `403`.

## Scopes

An artifact or run lives in one scope. A read walks the refs named in
`Vx-Read-Scopes`, in order, then the trusted scope, and the first scope
that holds a key answers it. The header is an RFC 8941 list of strings,
each `refs/...`, at most 8:

```
Vx-Read-Scopes: "refs/heads/feature", "refs/heads/main"
```

Absent, a read sees the trusted scope only. Any other value is `400`.

## Artifacts

A key is 1 to 128 of `[A-Za-z0-9_-]`. An artifact is immutable.

| Request                    | Answer                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD /v1/artifacts/<key>` | `200` with `Content-Length` and `Vx-Duration`, or `404`. Reads no blob.                                                                                              |
| `GET /v1/artifacts/<key>`  | `200` with the bytes (`application/octet-stream`), `Content-Length` and `Vx-Duration`, or `404`.                                                                     |
| `PUT /v1/artifacts/<key>`  | The bytes, with `Content-Length` (`411` without) and `Vx-Duration`. `201` stored; `200` already held (the stored bytes stay, the body is not read); `413` too large. |
| `POST /v1/artifacts/query` | `{ "keys": [<key>, …] }`, up to 1000 → `{ "artifacts": { <key>: { "size", "durationMs" } } }`, held keys only.                                                       |

`Vx-Duration` is how long the task that made the artifact took, in whole
milliseconds; a PUT without it stores 0.

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

Every refusal is `application/problem+json` (RFC 9457), with `status` and
a `detail` saying what to fix:

```json
{ "type": "about:blank", "title": "Forbidden", "status": 403, "detail": "this token reads only" }
```

A JSON body without `Content-Type: application/json` is `415`; an unknown
route `404`; a route's wrong method `405` with `Allow`. A HEAD answers the
status alone.
