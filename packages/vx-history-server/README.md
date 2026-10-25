# @vzn/vx-history-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A server for the task timings a vx scheduler asks for, that you host. It
keeps one row per task, already the numbers the scheduler uses (duration,
CPU cores, peak memory), and folds each CI run's report into it: a
history, not a log. It speaks the [vx-history protocol](./PROTOCOL.md)
(`/v1`) on three backends that answer alike:

- **Bun**, with a SQLite file.
- **Cloudflare Workers**, with D1. It fits the free plan: an upload is one
  statement, a row write per task; a query one read.
- **Docker**, the Bun server in an image.

`vxHistory()` ([`@vzn/vx-history`](https://github.com/vznjs/vx/tree/main/packages/vx-history))
points vx at it.

## CI tokens

Every request carries a CI job's own OIDC token, checked by `@vzn/vx-devtools`,
under `TRUST` rules as [`@vzn/vx-cache-server`'s](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server#ci-tokens):
a job matching a rule writes the trusted scope, any other of the
repository its branch's, another repository is refused. A branch's query
reads its own rows, then the trusted ones. `AUDIENCE` is the `aud` a
token must name, by default the origin the server is reached at.

## On Bun

```sh
TRUST='[…]' bun packages/vx-history-server/src/bun.ts --db /var/lib/vx-history.sqlite --port 8080
```

`TIMING_DAYS` (default 30) is how long a task's row outlives its last
report; the first upload of each day sweeps.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-history-server/Dockerfile -t vx-history-server .
docker run -p 8080:8080 -v vx-history:/data -e TRUST='[…]' vx-history-server
```

The database is `/data/vx-history.sqlite`.

## On Cloudflare Workers

From this directory, with `TRUST` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

## API

The same server as a `fetch` handler, over storage of your own
(`src/index.ts`):

- `createHistoryServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`. `ServerOptions` is
  `{ store, authorize, timingDays?, now? }`: `authorize` is an
  `Authorize` from `@vzn/vx-devtools`.
- `sqliteStore(db: Db)` is the `Store` over a SQLite `Db`
  (`{ all(sql, params), run(sql, params) }`), as bun:sqlite and D1 are.
  A `Store` folds `Report`s and reads `Timing`s.
- `WEIGHT` (0.3) and `RSS_DECAY` (0.9) are the fold's constants;
  `MAX_UPLOAD_TIMINGS` and `MAX_QUERY_HASHES` its limits; `errorJson`
  answers a refusal.
