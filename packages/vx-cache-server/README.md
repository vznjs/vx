# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache and run-history server for vx that you host yourself. It stores
task artifacts and each run's task timings, and speaks the
[vx-cache protocol](./PROTOCOL.md) (`/v1`): Turbo's remote cache API
for artifacts, under `/v1`, plus run history. Two backends answer alike:

- **Bun**, with any S3-compatible bucket for artifacts and a SQLite file
  for the rest, or Postgres for any number of nodes behind one balancer.
- **Cloudflare Workers**, with R2 for artifacts and D1 for the rest.

It is not on npm yet. `vxCache()`
([`@vzn/vx-cache`](https://github.com/vznjs/vx/tree/main/packages/vx-cache))
points `vx` at it.

## Tokens

`TOKENS` lists who may read and write, space separated: `read:<sha256>`
or `write:<sha256>`, each the SHA-256 of a token. A write token stores to
the trusted scope. The list holds hashes, so it is no secret:

```sh
token=$(openssl rand -hex 32)
printf %s "$token" | sha256sum   # → write:<this hash> in TOKENS
```

## CI tokens

With `TRUST` set, a CI job sends its own OIDC token instead of a stored
secret (`vxCache({ oidc: true })` on GitHub; on GitLab an `id_tokens`
entry named `VX_CACHE_TOKEN`). The token decides where the job writes:

- A job matching a rule writes the trusted scope, which every run reads.
- Any other job of the same repository writes its branch's own scope:
  a pull request's runs reuse each other's work, never main's runs.
- A job of another repository is refused.

`TRUST` is a JSON list of rules. Each names the issuer (`iss`), the
repository's id (`repository_id` on GitHub, `project_id` on GitLab), the
refs it trusts (`ref`, `ref_path` on GitLab) and any other claim the
trusted job's token holds. A value is a string (`*` matches anything) or a
list of them; `ns` keeps a repository apart (default `default`, the static
tokens' own):

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
TOKENS="write:<sha256> read:<sha256>" \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --db /var/lib/vx-cache.sqlite --port 8080
```

S3 settings are those Bun's S3 client reads (`S3_REGION` too). `TRUST`
and `AUDIENCE` are read from the environment too.

A SQLite file serves one node. For many, give each the same bucket and
one Postgres, `--db postgres://user:pass@host:5432/db`, through Bun's own
client. A node keeps no state of its own: an upload writes a blob no
other write names and commits it with one insert, so racing uploads of a
hash keep one whole artifact, and nodes sweeping at once each take other
rows.
`MAX_ARTIFACT_BYTES` caps an artifact (default 100 MB).

## On Cloudflare Workers

From this directory, with `TOKENS` or `TRUST` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the D1 database and the R2 bucket that `wrangler.jsonc`
names on the first deploy.

It fits Workers' free plan:

- An artifact is one request; a run's existence check is one
  `POST /v1/artifacts` for up to 1000 hashes. HEAD reads only D1.
- An artifact is one D1 row and a run is one row, its tasks a JSON column,
  with no index beyond each primary key: D1's free plan counts every row
  written, index rows too, 100 000 a day.
- A history query reads the newest 100 runs, and D1, not the Worker,
  parses their tasks, so the Worker stays inside its 10 ms of CPU.
- A request body is at most 100 MB on the free plan, which is the default
  `MAX_ARTIFACT_BYTES`. R2's free plan holds 10 GB.

## Eviction

What outlives its retention is deleted, by age since it was written:
artifacts of the trusted scope after `TRUSTED_DAYS` (default 30), of a
branch's scope after `BRANCH_DAYS` (default 7), and runs after `RUN_DAYS`
(default 90). A read does not keep an artifact: counting reads would cost
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
  `{ blobs, store, authorize, maxArtifactBytes?, now? }`: `blobs` is a
  `Blobs` bucket (`{ put(name, body, size), get(name), delete(name) }`),
  `store` a `Store`, `authorize` an `Authorize`, which maps a request
  to its `Access` (`{ ns, write? }`: the namespace it reads, and the scope
  it may write) or throws; `maxArtifactBytes` caps a PUT (default 100 MB)
  and `now` is the clock, for tests.
- `parseTrust(json)` reads `TRUST` into `TrustRule`s, and `oidcAuth(options)`
  checks a CI token against them. Its `OidcOptions` are `trust` (the
  rules), `audience` (the `aud`; default the origin a request reached),
  `fetchJson` (reads an issuer's keys) and `now` (the clock, for tests).
  `anyAuth(tokens, oidc)` sends a JWT bearer to `oidc`, any other to
  `tokens`.
- `parseTokens(list)` reads `TOKENS` into a map, and `tokenAuth(tokens)`
  makes the `Authorize` that checks a bearer token against it.
- A `Store` is the database the server asks: `init()`, then reads and
  inserts of `ArtifactRow`s (`NewArtifact` adds the namespace and time)
  and `RunRow`s (`NewRun` adds the tasks), history `samples`, and the
  sweep's `takeExpired` and `dropRuns`; each write one statement, so
  nodes share it.
- `sqliteStore(db)` is the `Store` over a SQLite `Db`
  (`{ all(sql, params), run(sql, params), batch(statements) }`), as
  bun:sqlite and D1 are; `postgresStore(url)` the one over Postgres, which
  many nodes share.
- `evict(store, blobs, retention, now?)` deletes what outlived its
  `Retention` (`{ trustedDays, branchDays, runDays }`), and
  `retentionFrom(env)` reads it from `TRUSTED_DAYS`, `BRANCH_DAYS` and
  `RUN_DAYS`.
- `DURATION_HEADER` (`x-artifact-duration`) and `READ_SCOPES_HEADER`
  (`x-artifact-read-scopes`) are the header names (PROTOCOL.md).
