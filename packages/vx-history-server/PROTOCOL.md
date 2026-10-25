# vx-history protocol, v1

An HTTP API for the task timings a scheduler asks for. It is a history,
not a log: a server keeps one row per task and scope, and folds each
report into it. `@vzn/vx-history-server` speaks it on Bun, on Cloudflare
Workers and as a Docker image; any server that does can take its place.

| Route                     | What it does                      |
| ------------------------- | --------------------------------- |
| `POST /v1/timings/upload` | a run's timings, once at its end  |
| `POST /v1/timings/query`  | each task's numbers, ready to use |
| `GET /v1/capabilities`    | the server's limits               |

## Tokens and scopes

Every request carries `Authorization: Bearer <token>`, a CI job's OIDC
token, checked as `@vzn/vx-devtools` checks it (the same rules as
vx-cache-server's `TRUST`): its issuer and repository id are what it
reads and writes; it writes its branch (`refs/heads/<branch>`), and one
on a ref a rule protects that matches no rule reads only. A scope is its
ref's hash: the first 128 bits of the SHA-256 of its UTF-8, 32 lowercase
hex digits; no ref goes on the wire plain, and the server hashes the
token's ref the same way for a write. A row is keyed by issuer,
repository id, scope and task hash, the first three stored hashed,
never plain.

## Upload

`POST /v1/timings/upload` (a token that writes) with
`{ "timings": [{ "hash", "durationMs", "cores"?, "rssBytes"? }] }`, up to
10 000, each task once: `204`. `hash` names the task's definition, a
string of up to 512 characters the server never reads. Each folds into
its row of the token's scope:

- `durationMs` and `cores`: `old × 0.7 + new × 0.3`. A median needs the
  samples and a mean never forgets; this follows a task that got slower
  within about three runs, and one outlier moves it 30%.
- `rssBytes`: `max(new, old × 0.9)`. A reservation needs the peak; the
  decay lets a task that shrank come down.
- `runs`: how many reports made the row.

The first report sets the row; one without `cores` or `rssBytes` keeps
the row's. A row not reported for `TIMING_DAYS` (30) is deleted.

## Query

`POST /v1/timings/query` with
`{ "scopes": [<hash of refs/heads/feature>, <hash of refs/heads/main>], "hashes": [ … ] }`,
1 to 8 scopes and up to 10 000 hashes: each hash's row in the first scope
named that holds one. A hash none holds is
absent. The numbers are the scheduler's as they are:

```json
{ "timings": { "3b0d…": { "durationMs": 4200, "cores": 1.8, "rssBytes": 310000000, "runs": 12 } } }
```

## Limits and errors

`GET /v1/capabilities`: `{ "maxUploadTimings": 10000, "maxQueryHashes": 10000, "maxQueryScopes": 8 }`.

Every refusal is `{ code, message }`, the message saying what to fix. A
JSON body without `Content-Type: application/json` is `400`, an unknown
route `404`, a route's wrong method `405` with `Allow`.
