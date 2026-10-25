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
a job writes its branch's scope, a ref a rule protects only a job
matching the rule, and another repository is refused. A query names its
scopes in order, each its ref's hash (no ref goes on the wire or into a
row plain): `vxHistory()` asks its branch's rows, then the default
branch's. Every request names its issuer and repository by their hashes
(`vx-issuer`, `vx-repository`), which a token must match. `AUDIENCE` is
the `aud` a token must name, by default the origin the server is reached
at. `READ_ACCESS=public` lets a query with no token read a repository
`TRUST` names; it uploads nothing.

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

With vx's other servers: [`compose.yaml`](https://github.com/vznjs/vx/blob/main/private/vx-servers/compose.yaml)
builds and runs all three (`docker compose up -d`).

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
  A `Store` folds `Report`s and reads `Timing`s, each of a `Repo`
  (`{ issuer, id }`, as the token names it, stored hashed) and a scope
  (a ref's hash).
- `WEIGHT` (0.3) and `RSS_DECAY` (0.9) are the fold's constants;
  `MAX_UPLOAD_TIMINGS`, `MAX_QUERY_HASHES` and `MAX_QUERY_SCOPES` its
  limits; `errorJson`
  answers a refusal.
