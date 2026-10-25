# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache and run-history server for vx that you host yourself. It stores
task artifacts and each run's task timings, and speaks the
[vx-cache protocol](./PROTOCOL.md) (`/v1`). Two backends answer alike:

- **Bun**, with any S3-compatible bucket for artifacts and a SQLite file
  for the rest.
- **Cloudflare Workers**, with R2 for artifacts and D1 for the rest.

It is not on npm yet. The `vxCache()` plugin that points `vx` at it comes
next; until then it is the server and its protocol.

## Tokens

`TOKENS` lists who may read and write, space separated: `read:<sha256>`
or `write:<sha256>`, each the SHA-256 of a token. A write token stores to
the trusted scope. The list holds hashes, so it is no secret:

```sh
token=$(openssl rand -hex 32)
printf %s "$token" | sha256sum   # → write:<this hash> in TOKENS
```

## On Bun

```sh
TOKENS="write:<sha256> read:<sha256>" \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --db /var/lib/vx-cache.sqlite --port 8080
```

S3 settings are those Bun's S3 client reads (`S3_REGION` too).
`MAX_ARTIFACT_BYTES` caps an artifact (default 100 MB).

## On Cloudflare Workers

From this directory, with `TOKENS` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the D1 database and the R2 bucket that `wrangler.jsonc`
names on the first deploy.

It fits Workers' free plan:

- An artifact is one request; a run's existence check is one
  `POST /v1/artifacts/query` for up to 1000 keys. HEAD reads only D1.
- An artifact is one D1 row and a run is one row, its tasks a JSON column,
  with no index beyond each primary key: D1's free plan counts every row
  written, index rows too, 100 000 a day.
- A history query reads the newest 100 runs, and D1, not the Worker,
  parses their tasks, so the Worker stays inside its 10 ms of CPU.
- A request body is at most 100 MB on the free plan, which is the default
  `MAX_ARTIFACT_BYTES`. R2's free plan holds 10 GB.
