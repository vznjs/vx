# @vzn/vx-history-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A server for the task timings a vx scheduler asks for, that you host. It
keeps one row per task, already the numbers the scheduler uses (duration,
CPU cores, peak memory), and merges each CI run's report into it: a
history, not a log. It speaks the [vx-history protocol](./PROTOCOL.md)
(`/v1`) on three backends that answer alike:

- **Bun**, with a SQLite file.
- **Cloudflare Workers**, with D1. It fits the free plan: an upload is one
  statement per 2 MB of reports, a row write per task; a query one read
  per 2 MB of hashes.
- **Docker**, the Bun server in an image.

`vxHistory()` ([`@vzn/vx-history`](https://github.com/vznjs/vx/tree/main/packages/vx-history))
points vx at it.

## CI tokens

Every request carries a CI job's own OIDC token, checked by `@vzn/vx-devtools`,
under the same `ALLOW` as [`@vzn/vx-cache-server`'s](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server#ci-tokens)
(`issuer:owner/repo:workflow` entries): a job of a workflow it names
writes its own branch, and any other job is refused. A row is the issuer,
repository, ref and task hash, stored plainly, and its numbers. A run
sends one query: its repository, the refs it reads (its branch, then the
branch it merges into, then the default branch) and every task hash;
the server answers each from the first ref that holds it. A token of
another repository than the query names is refused. `AUDIENCE` is the
`aud` a token must name: the origin clients reach the server at. On
Workers, unset, it is that origin (Cloudflare routes only the Worker's
own hostnames to it); on Bun and Docker it is required, since there the
origin is the request's `Host` header, which a client picks.
`READ_ACCESS=public` lets a query with no token read a repository
`ALLOW` names; it uploads nothing.

## On Bun

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' AUDIENCE=https://history.example.com bun packages/vx-history-server/src/bun.ts --db /var/lib/vx-history.sqlite --port 8080
```

`TIMING_DAYS` (default 30, whole days in decimal digits; on Workers a JSON number too)
is how long a task's row outlives its last report; the first upload of each day sweeps, whichever node or Workers
isolate takes it.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-history-server/Dockerfile -t vx-history-server .
docker run -p 8080:8080 -v vx-history:/data -e ALLOW='…' -e AUDIENCE=https://history.example.com vx-history-server
```

The database is `/data/vx-history.sqlite`.

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

## API

The same server as a `fetch` handler, over storage of your own
(`src/index.ts`):

- `createHistoryServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`. `ServerOptions` is
  `{ store, authorize, timingDays?, now? }`: `authorize` is
  `oidcTokenAuth` from `@vzn/vx-devtools`.
- `sqliteStore(db: Db)` is the `Store` over a SQLite `Db`
  (`{ all(sql, params), run(sql, params) }`), as bun:sqlite and D1 are.
  A `Store` merges `Report`s and reads `Timing`s, each of a `Repo`
  (`{ issuer, repository }`) and a ref.
- `WEIGHT` (0.3) and `RSS_DECAY` (0.9) are the merge's constants;
  `MAX_UPLOAD_TIMINGS`, `MAX_QUERY_HASHES` and `MAX_QUERY_REFS` its
  limits. A refusal is `errorJson` from `@vzn/vx-devtools`.
