# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache server for vx that you host yourself, for CI jobs.

- It stores task artifacts in one bucket and nothing else: no database.
- It speaks the [vx-cache protocol](./PROTOCOL.md) (`/v1`).

Three ways to run it answer alike:

- **Bun**, with any S3-compatible bucket; any number of nodes share one.
  The bucket is required: there is no local-disk mode.
- On one machine, run an S3-compatible store such as MinIO beside it.
- **Docker**, the same server as an image (`Dockerfile`).
- **Cloudflare Workers**, with R2.

`vxCache()`
([`@vzn/vx-cache`](https://github.com/vznjs/vx/tree/main/packages/vx-cache))
points `vx` at it.

## CI tokens

Each CI job proves who it is with its own OIDC token. There are no
stored tokens.

- Every request names its issuer and repository by their hashes
  (`vx-issuer`, `vx-repository`; `vxCache({ issuer, repository })`).
- `vxCache()` asks GitHub for the token. On GitLab, name an `id_tokens`
  entry `VX_CACHE_TOKEN`.
- The token must be of the repository named.
- The token decides where the job writes: its own branch's scope, never
  another's.

`ALLOW` says who may take part. It is the same string the DTE relay
reads: entries separated by spaces, each `issuer:owner/repo:workflow`.
For example:

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml https://gitlab.com:acme/web:.gitlab-ci.yml'
```

- Only jobs of a workflow it names get in; any other job is refused.
- `ALLOW` names repositories, not ids: if an owner is renamed and someone takes the old name, their jobs get in. Update `ALLOW` when you rename an owner or repository.
- With `ALLOW` empty, the server does not start. A Worker refuses every
  request instead.
- Two CIs' tokens are read: GitHub Actions' issuer, and GitLab's
  (gitlab.com or your own instance).
- Any other issuer is read as a GitLab instance. So a Buildkite, CircleCI
  or Jenkins token, which carries no `project_path`, is refused.
- Those jobs read with `READ_ACCESS=public` and write nothing.

A job writes its branch's own scope, which only runs of that branch
read:

- A push writes its branch, so a run of `main` writes `main`.
- A pull request writes its merge ref, `refs/pull/<n>/merge`, never a
  branch.
- So a pull request's work never reaches `main`'s runs, nor a branch a
  fork names.
- A merge queue's (`merge_group`) run writes its base branch, since
  queued code is about to land. Its ref is
  `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`.
- A `pull_request_target`, `issue_comment` or `workflow_run` run writes
  nothing: it may run a fork's code.

`AUDIENCE` is the `aud` a token must name: the origin clients reach the
server at, such as `https://cache.example.com`.

- It is what `vxCache()` asks GitHub for.
- A URL is read as its origin: `https://cache.example.com/v1` is
  `https://cache.example.com`.
- A value that is no URL stops the server.
- On Workers, unset, it is that origin: Cloudflare routes only the
  Worker's own hostnames to it.
- On Bun and Docker it is required. There the origin is the request's
  `Host` header, which a client picks.

`READ_ACCESS=public` lets a request with no token read a repository
`ALLOW` names, such as from a developer's laptop. It writes nothing.
Unset, a request with no token is `401`.

## On Bun

You start the server with your bucket and your `ALLOW`:

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' \
AUDIENCE=https://cache.example.com \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --port 8080
```

- `S3_BUCKET` is required: without it the server does not start.
- S3 settings are those Bun's S3 client reads (`S3_REGION` too).
- A node keeps no state of its own, so any number of them serve one
  bucket behind a balancer.
- A read the bucket answers `500` or `503` (`SlowDown`) is asked up to
  three times, as the Worker asks R2.
- A read the bucket still refuses is `502`, naming the bucket's reason,
  such as `403 RequestTimeTooSkewed` (fix the node's clock) or
  `503 SlowDown`. vx reads it as a miss and runs the task.
- A download the bucket cuts short fails as a transfer, never a whole
  artifact. An upload it fails midway stores nothing.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-cache-server/Dockerfile -t vx-cache-server .
docker run -p 8080:8080 -e ALLOW='…' -e AUDIENCE=https://cache.example.com -e S3_BUCKET=… -e S3_ENDPOINT=… \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… vx-cache-server
```

With vx's other servers: [`compose.yaml`](https://github.com/vznjs/vx/blob/main/private/vx-servers/compose.yaml)
builds and runs all three (`docker compose up -d`).

## Limits

Two variables set the limits, for example `MAX_UPLOAD_BYTES=200000000`.

- `MAX_CHECK_HASHES` is the lookups a check makes, hashes × scopes.
  Default 500, or 6 on Workers.
- `MAX_UPLOAD_BYTES` is the size of one artifact. Default 100 MB.
- Each is written in decimal digits. On Workers a JSON number works too.
- Every `/v1/artifacts` answer, a refusal too, names them to clients
  (`vx-max-*`). So does `GET /v1/capabilities`.

## On Cloudflare Workers

From this directory, with `ALLOW` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

- Wrangler makes the R2 bucket `wrangler.jsonc` names on the first
  deploy. The Worker reads it as the binding `BLOBS`.
- The deploy clears any cron: the Worker has no `scheduled()`.
- A read R2 answers "try again" (10001, 10058) is asked up to three
  times before the request fails `502`.

<details>
<summary>Details: lookups and plan limits</summary>

- By default a check makes 6 lookups. A Worker request has 6 calls
  waiting at once and queues the rest.
- So checks of 6 sent at once are the fastest. From a GitHub runner, 134
  hashes took 168 to 216 ms, against 1.9 s for one check of 134.
- Each lookup is one subrequest (an R2 head). A higher
  `MAX_CHECK_HASHES` must fit your plan's subrequests per request.
- `MAX_UPLOAD_BYTES` must fit your plan's request body. The server
  lowers neither.

</details>

<details>
<summary>Details: downloads and the data center's cache</summary>

- A download is read through the data center's cache. An artifact never
  changes, so after R2 serves it once, that data center answers it
  without R2. This is free on every plan.
- The copy is a second read of R2, begun once the client has its bytes:
  one reader of an object at a time.
- A download under 1 MiB a second, or one the client left, is logged
  with its time.
- Whether R2 holds an artifact (a check, a `HEAD`, an upload's skip) is
  asked of R2, never of that copy.
- The copy can outlive R2's. A writer told "held" there would skip an
  upload another data center then cannot read.
- An upload drops the copy in the data center it reaches: R2 had let
  those bytes go.

</details>

Set `EXPIRY_DAYS` to the bucket's lifecycle rule (below), and R2's
"held" is kept in the data center's cache too. A repeat check or `HEAD`
in that data center then skips R2.

<details>
<summary>Details: how <code>EXPIRY_DAYS</code> marks work</summary>

- An upload, R2's answer to a lookup, or a download R2 serves marks the
  artifact held, in the background.
- The mark lasts until the rule may drop the artifact, counted from its
  upload.
- Only "held" is kept: a miss always asks R2, so a later upload is never
  hidden.
- An upload's skip always asks R2, never a mark. A client uploads only
  what its check missed, which no mark holds, so this costs no head a
  mark saved.
- Unset, every lookup asks R2.
- A larger value than the rule is wrong: a mark would outlive the
  artifact.
- After you delete artifacts by hand, a mark may still answer a check
  "held". vx then misses the download and runs the task.
- That miss drops the mark, and the task's upload is stored again.

</details>

## Expiry

The bucket's own lifecycle rule expires artifacts, by age since they
were written. The server runs no sweep. One age rule covers the bucket,
for example 1 day:

```sh
bunx wrangler r2 bucket lifecycle add vx-cache all '' --expire-days 1
```

- On S3 the same rule goes in the bucket's lifecycle configuration.
- A main run that misses an expired artifact runs the task and stores it
  again.
- An artifact's object name is `<issuer>/<repository>/<ref>/<hash>`.
- The first three parts are each hashed: SHA-256, its first 128 bits,
  32 hex digits. So a bucket's listing names no host, repository or
  branch.
- Deleting one branch's prefix still prunes that branch alone. A
  folder's name is `printf %s refs/heads/main | sha256sum | cut -c1-32`.

## API

The same server as a `fetch` handler, to mount in a server of your own,
over a bucket of your own (`src/index.ts`):

- `createCacheServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`.
- `ServerOptions` is `{ blobs, authorize, limits? }`.
- `blobs` is a `Blobs` bucket:
  `{ put(name, body, size), get(name), size(name, bucket?) }`.
  - `get` answers a `Blob`, `{ body, size }`.
  - `size` with `bucket` is the bucket's own answer, never one the
    backend kept: an upload's skip.
  - A backend that keeps no answer ignores `bucket`.
- `authorize` is an `Authorize`. It maps a request to its `Access`, or
  throws.
  - `Access` is `{ issuer, repository, write? }`: the token's issuer and
    repository name, which it reads, and the scope it may write.
- `limits` is any of `Limits` (`{ maxCheckHashes, maxUploadBytes }`)
  over `DEFAULT_LIMITS`.
- `blobName(issuer, repository, scope, hash)` is an artifact's object
  name, `<issuer>/<repository>/<ref>/<hash>`. It is async.
  - The first three parts are each their `hashPart`: SHA-256's first 128
    bits in hex.
  - `scope` is the encoded ref as a client sends it (PROTOCOL.md § Keys),
    hashed plain.
- `ALLOW` and the CI token check are
  [`@vzn/vx-devtools`](https://github.com/vznjs/vx/tree/main/packages/vx-devtools)'s,
  the check every vx server shares.
- `SCOPE_HEADER` (`vx-scope`) and `LIMIT_HEADERS` are the header names
  (PROTOCOL.md).
