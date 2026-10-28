# vx-history protocol, v1

An HTTP API for the task timings a scheduler asks for. It is a history,
not a log: a server keeps one row per task and ref, and folds each
report into it. `@vzn/vx-history-server` speaks it on Bun, on Cloudflare
Workers and as a Docker image; any server that does can take its place.

| Route                     | What it does                      |
| ------------------------- | --------------------------------- |
| `POST /v1/timings/upload` | a run's timings, once at its end  |
| `POST /v1/timings/query`  | each task's numbers, ready to use |
| `GET /v1/capabilities`    | the server's limits               |

## Repositories and tokens

A row is keyed by the issuer (the CI issuer's URL, no trailing slash),
the repository (`org/name` there, lowercased), the ref
(`refs/heads/main`) and the task's definition hash, each stored plainly.

A request's `Authorization: Bearer <token>` is a CI job's OIDC token,
checked as `@vzn/vx-devtools` checks it (the same `ALLOW` as
vx-cache-server's): a repository, or a workflow, `ALLOW` does not name
is `403`. A token writes its own ref (`refs/heads/<branch>`; a
`pull_request` run its merge ref, `refs/pull/<n>/merge`, never its
`head_ref`; a `merge_group` run,
`refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`, its base branch); a
`pull_request_target` run reads only, and so does a GitLab merge request pipeline whose `source_project_path` (GitLab 19.5+)
does not name its own project. A query names its
repository; a token of another is `403`. A server whose `READ_ACCESS`
is `public` takes a query with no token for a repository `ALLOW` names;
an upload with none is `403`.

## Upload

`POST /v1/timings/upload` (a token that writes) with
`{ "timings": [{ "hash", "durationMs", "cores"?, "rssBytes"? }] }`, up to
10 000, each task once: `204`. `hash` names the task's definition, a
string of up to 512 characters the server never reads. Each folds into
its row of the token's repository and ref:

- `durationMs` and `cores`: `old × 0.7 + new × 0.3`. A median needs the
  samples and a mean never forgets; this follows a task that got slower
  within about three runs, and one outlier moves it 30%.
- `rssBytes`: `max(new, old × 0.9)`. A reservation needs the peak; the
  decay lets a task that shrank come down.
- `runs`: how many reports moved the row.

A report that would not move the row (`durationMs` and `cores` within
5%, no new `rssBytes` peak) is not written, unless the row is a day old:
each write costs, and the fold would move it under 1.5%.

The first report sets the row; one without `cores` or `rssBytes` keeps
the row's. A row not reported for `TIMING_DAYS` (30) is deleted.

## Query

One request a run: `POST /v1/timings/query` with
`{ "issuer", "repository", "refs": ["refs/heads/feature", "refs/heads/main"], "hashes": [ … ] }`,
1 to 8 refs and up to 10 000 hashes: each hash's row in the first ref
named that holds one. A hash none holds is absent. The numbers are the
scheduler's as they are:

```json
{ "timings": { "3b0d…": { "durationMs": 4200, "cores": 1.8, "rssBytes": 310000000, "runs": 12 } } }
```

## Limits and errors

`GET /v1/capabilities`: `{ "maxUploadTimings": 10000, "maxQueryHashes": 10000, "maxQueryRefs": 8 }`.
A server takes both at their limits, each hash 512 characters: an
upload body up to 7 120 000 bytes, a query's up to 6 010 000. Past
that, `413`.

Every refusal is `{ code, message }`, the message saying what to fix. A
JSON body without `Content-Type: application/json` is `400`, an unknown
route `404`, a route's wrong method `405` with `Allow`.
