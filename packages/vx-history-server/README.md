# @vzn/vx-history-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A server you host for the task timings a vx scheduler asks for.

- It keeps one row per task, already the numbers the scheduler uses:
  duration, a slow run, CPU cores, peak memory.
- It merges each CI run's report into that row: a history, not a log.
- It also keeps the flaky record every CI machine shares: only the cache
  keys that failed, each with a flaky flag.
- So a run retries a task that flaked on another machine.

It speaks the [vx-history protocol](./PROTOCOL.md) (`/v1`) on three
backends that answer alike:

- **Bun**, with a SQLite file.
- **Cloudflare Workers**, with D1, on the free plan. A run of up to
  about 8 000 tasks fits.
- **Docker**, the Bun server in an image.

<details>
<summary>Details: why about 8 000 tasks fit the Workers free plan</summary>

- An upload is one statement per 666 KB of timings and two per 666 KB of
  outcomes.
- That is because D1 binds a string of up to 2 MB, and a character may
  be 3 bytes.
- A query is two reads per 666 KB of hashes.
- The free plan's 50 queries a request fit PROTOCOL.md's largest upload:
  10 000 tasks with 512-character hashes.
- That upload is 41 statements, or 50 with a new isolate's setup and the
  day's sweep.
- The free plan's 10 ms of CPU is the tighter limit.
- Parsing and checking an upload took about 1.1 ms per 1 000 tasks with
  their outcomes, measured on Bun. Miniflare models neither limit.

</details>

`vxHistory()` ([`@vzn/vx-history`](https://github.com/vznjs/vx/tree/main/packages/vx-history))
points vx at it.

## CI tokens

Every request carries a CI job's own OIDC token, checked by
`@vzn/vx-devtools`.

- It uses the same `ALLOW` as
  [`@vzn/vx-cache-server`'s](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server#ci-tokens):
  `issuer:owner/repo:workflow` entries.
- A job of a workflow `ALLOW` names writes its own branch. Any other job
  is refused.
- `ALLOW` names repositories, not ids: if an owner is renamed and someone takes the old name, their jobs get in. Update `ALLOW` when you rename an owner or repository.
- A row is the issuer, repository, ref and task hash, stored plainly,
  and its numbers.
- A run sends one query: its repository, the refs it reads and every
  task hash.
- The refs it reads are its branch, then the branch it merges into, then
  the default branch.
- The server answers each hash from the first ref that holds it.
- A token of another repository than the query names is refused.
- `READ_ACCESS=public` lets a query with no token read a repository
  `ALLOW` names. It uploads nothing.

`AUDIENCE` is the `aud` a token must name: the origin clients reach the
server at.

- A URL is read as its origin. A value that is no URL stops the server.
- On Workers, unset, it is that origin. Cloudflare routes only the
  Worker's own hostnames to it.
- On Bun and Docker it is required. There the origin is the request's
  `Host` header, which a client picks.

## On Bun

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' AUDIENCE=https://history.example.com bun packages/vx-history-server/src/bun.ts --db /var/lib/vx-history.sqlite --port 8080
```

`--db` is the SQLite file, made if absent. One it cannot open, or whose
`timings`, `outcomes` or `sweeps` table another tool made, stops the
server at start, naming the file.

`TIMING_DAYS` is how long a task's row outlives its last report.

- The default is 30.
- It is whole days in decimal digits. On Workers a JSON number works
  too.
- The first upload of each day sweeps, whichever node or Workers isolate
  takes it.
- An upload the file cannot take fails `500` with SQLite's reason, and
  reads go on: a full or read-only disk, or a write lock another process
  holds past 1 s. vx warns and the run goes on.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-history-server/Dockerfile -t vx-history-server .
docker run -p 8080:8080 -v vx-history:/data -e ALLOW='…' -e AUDIENCE=https://history.example.com vx-history-server
```

The database is `/data/vx-history.sqlite`.

The image runs as `bun` and reports healthy once it answers on port 8080 inside the container: publish another port with `-p`, not `--port`.

With vx's other servers: [`compose.yaml`](https://github.com/vznjs/vx/blob/main/private/vx-servers/compose.yaml)
builds and runs all three (`docker compose up -d`).

## On Cloudflare Workers

From this directory, with `ALLOW` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

The Worker reads its D1 database as the binding `DB`, as `wrangler.jsonc`
names it.

- A statement D1 fails with an error Cloudflare says to retry ("Network
  connection lost", an object reset) is sent up to three times, as the
  cache server asks R2 again.
- A write retried that had landed counts once: a row already written at
  that write's time is left.
- Each upload a server takes gets its own time, so two in one
  millisecond each count, on one node or two (each node rounds to its own
  residue of 1,024 ms; two share one 1 in 1,024).
- A database whose `timings`, `outcomes` or `sweeps` table another tool
  made fails each request 500, saying so, and is left as it was.

## API

The same server as a `fetch` handler, over storage of your own
(`src/index.ts`):

- `createHistoryServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`.
- `ServerOptions` is `{ store, authorize, timingDays?, now? }`.
  `authorize` is `oidcTokenAuth` from `@vzn/vx-devtools`.
- `sqliteStore(db: Db)` is the `Store` over a SQLite `Db`, as bun:sqlite
  and D1 are.
- A `Db` is `{ all(sql, params), run(sql, params) }`.
- A `Store` merges `Report`s, keeps `Outcome`s and reads `Timing`s.
- Each is of a `Repo` (`{ issuer, repository }`) and a ref.
- `WEIGHT` (0.3) and `RSS_DECAY` (0.9) are the merge's constants.
- `MAX_UPLOAD_TIMINGS`, `MAX_QUERY_HASHES` and `MAX_QUERY_REFS` are its
  limits.
- A refusal is `errorJson` from `@vzn/vx-devtools`.
