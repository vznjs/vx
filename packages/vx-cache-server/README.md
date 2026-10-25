# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache server for vx that you host yourself, for CI jobs. It stores
task artifacts and the timings a scheduler needs (each task's duration,
CPU cores and peak memory), and speaks the
[vx-cache protocol](./PROTOCOL.md) (`/v1`). Two backends answer alike:

- **Bun**, with any S3-compatible bucket for artifacts and a SQLite file
  for the rest, or Postgres for any number of nodes behind one balancer.
- **Cloudflare Workers**, with R2 for artifacts and D1 for the rest.

It is not on npm yet. `vxCache()`
([`@vzn/vx-cache`](https://github.com/vznjs/vx/tree/main/packages/vx-cache))
points `vx` at it.

## CI tokens

Every request carries a CI job's own OIDC token: there are no stored
tokens (`vxCache()` asks GitHub for it; on GitLab name an `id_tokens`
entry `VX_CACHE_TOKEN`). The token's repository is what it reads and
writes, and the token decides where the job writes:

- A job matching a rule writes the trusted scope, which every run reads.
- Any other job of the same repository writes its branch's own scope:
  a pull request's runs reuse each other's work, never main's runs.
- A job of another repository is refused.

`TRUST` is a JSON list of rules. Each names the issuer (`iss`), the
repository's id (`repository_id` on GitHub, `project_id` on GitLab), the
refs it trusts (`ref`, `ref_path` on GitLab) and any other claim the
trusted job's token holds. A value is a string (`*` matches anything) or a
list of them. With `TRUST` empty, every request is refused. For example:

```json
[
  {
    "iss": "https://token.actions.githubusercontent.com",
    "repository_id": "123456789",
    "event_name": ["push", "merge_group"],
    "ref": ["refs/heads/main", "refs/heads/gh-readonly-queue/main/*"],
    "ref_protected": "true"
  },
  {
    "iss": "https://gitlab.com",
    "project_id": "4567",
    "ref_path": "refs/heads/main",
    "ref_protected": "true",
    "pipeline_source": ["push", "schedule"]
  }
]
```

Name `event_name`: `pull_request_target` and `issue_comment` runs carry
main's `ref` while running a pull request's code. A merge queue's runs
write trusted before their code lands; queued code is approved code.
`AUDIENCE` is the `aud` a token must name, by default the origin the
server is reached at, which is what `vxCache()` asks GitHub for.

## On Bun

```sh
TRUST='[…]' \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --db /var/lib/vx-cache.sqlite --port 8080
```

S3 settings are those Bun's S3 client reads (`S3_REGION` too). `AUDIENCE`
is read from the environment too.

A SQLite file serves one node. For many, give each the same bucket and
one Postgres, `--db postgres://user:pass@host:5432/db`, through Bun's own
client. A node keeps no state of its own: an upload writes a blob no
other write names and commits it with one insert, so racing uploads of a
hash keep one whole artifact, and nodes sweeping at once each take other
rows.
`MAX_UPLOAD_BYTES` caps an upload, its artifacts together (default
100 MB). Every check names it and the batch size to clients
(`x-vx-max-*`), and `GET /v1/capabilities` names every limit.

## On Cloudflare Workers

From this directory, with `TRUST` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the D1 database and the R2 bucket that `wrangler.jsonc`
names on the first deploy.

It fits Workers' free plan:

- A run's existence check is one `POST /v1/artifacts/check` for up to
  1000 hashes, and reads only D1. An upload carries up to 100 artifacts
  and the timings that ride along.
- An artifact is one D1 row and a timing one row, with no index beyond
  each primary key: D1's free plan counts every row written, index rows
  too, 100 000 a day.
- A timings query reads about twice `limit` rows per task and scope.
- A request body is at most 100 MB on the free plan, which is the default
  `MAX_UPLOAD_BYTES`. R2's free plan holds 10 GB.

## Eviction

What outlives its retention is deleted, by age since it was written:
artifacts of the trusted scope after `TRUSTED_DAYS` (default 30), of a
branch's scope after `BRANCH_DAYS` (default 7), and timings after
`TIMING_DAYS` (default 30). A read does not keep an artifact: counting reads would cost
D1 a row write per hit. A main run that misses an evicted artifact runs
the task and stores it again.

On Workers a daily Cron Trigger sweeps (`wrangler.jsonc`; the free plan
has five); on Bun the server sweeps at start and every hour. One sweep
deletes up to 800 artifacts, and the next goes on.

## API

The same server as a `fetch` handler, to mount in a server of your own,
over storage of your own (`src/index.ts`):

- `createCacheServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`. `ServerOptions` is
  `{ blobs, store, authorize, maxUploadBytes?, now? }`: `blobs` is a
  `Blobs` bucket (`{ put(name, body, size), get(name), delete(name) }`),
  `store` a `Store`, `authorize` an `Authorize`, which maps a request
  to its `Access` (`{ repo, write?, trustedRef }`: the repository it
  reads, the scope it may write, and whether a ref is one a rule trusts)
  or throws; `maxUploadBytes` caps an upload (default 100 MB) and `now`
  is the clock, for tests.
- `TRUST` and the CI token check are [`@vzn/vx-devtools`](https://github.com/vznjs/vx/tree/main/packages/vx-devtools)'s,
  the check every vx server shares.
- A `Store` is the database the server asks: `init()`, then reads and
  inserts of artifact rows (`ArtifactRow`, `{ key, scope, size }`; a
  `NewArtifact` adds `repo` and `created_at`) and of `Timing`s
  (`{ hash, durationMs, cores, rssBytes }`), `dropArtifact` (a row a
  read found with no blob, so the next job writes it again), and the
  sweep's `takeExpired` and `dropTimings`; each write one statement, so
  nodes share it.
- `sqliteStore(db)` is the `Store` over a SQLite `Db`
  (`{ all(sql, params), run(sql, params), batch(statements) }`), as
  bun:sqlite and D1 are; `postgresStore(url)` the one over Postgres, which
  many nodes share.
- `evict(store, blobs, retention, now?)` deletes what outlived its
  `Retention` (`{ trustedDays, branchDays, timingDays }`), and
  `retentionFrom(env)` reads it from `TRUSTED_DAYS`, `BRANCH_DAYS` and
  `TIMING_DAYS`.
- `READ_SCOPES_HEADER` (`x-artifact-read-scopes`) is the header name
  (PROTOCOL.md).
