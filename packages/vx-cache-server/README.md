# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache server for vx that you host yourself, for CI jobs. It stores
task artifacts in one bucket and nothing else (no database), and speaks
the [vx-cache protocol](./PROTOCOL.md) (`/v1`). Three ways to run it
answer alike:

- **Bun**, with any S3-compatible bucket; any number of nodes share one.
- **Docker**, the same server as an image (`Dockerfile`).
- **Cloudflare Workers**, with R2.

`vxCache()`
([`@vzn/vx-cache`](https://github.com/vznjs/vx/tree/main/packages/vx-cache))
points `vx` at it.

## CI tokens

Every request names its issuer and repository by their hashes
(`vx-issuer`, `vx-repository`; `vxCache({ issuer, repository })`). A
CI job's carries its own OIDC token: there are no stored tokens
(`vxCache()` asks GitHub for it; on GitLab name an `id_tokens` entry
`VX_CACHE_TOKEN`). The token must be of the repository named, and it
decides where the job writes: its own branch's scope, never another's.

`ALLOW` says who may take part, the same string the DTE relay reads:
entries separated by spaces, each `issuer:owner/repo:workflow`. For
example:

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml https://gitlab.com:acme/web:.gitlab-ci.yml'
```

Only jobs of a workflow it names get in; any other job is refused. With
`ALLOW` empty, every request is refused. A job writes its branch's own
scope, which only runs of that branch read:

- A push writes its branch, so a run of `main` writes `main`.
- A pull request writes its merge ref, `refs/pull/<n>/merge`, never a
  branch: its work never reaches `main`'s runs, nor a branch a fork names.
- A merge queue's (`merge_group`) run (`refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`)
  writes its base branch, since queued code is about to land.
- A `pull_request_target` run writes nothing: it may run a fork's code.

`AUDIENCE` is the `aud` a token must name, by default the origin the
server is reached at, which is what `vxCache()` asks GitHub for.
`READ_ACCESS=public` lets a request with no token read a repository
`ALLOW` names (a developer's laptop): it writes nothing. Unset, a
request with no token is `401`.

## On Bun

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --port 8080
```

S3 settings are those Bun's S3 client reads (`S3_REGION` too). `AUDIENCE`
is read from the environment too. A node keeps no state of its own, so
any number of them serve one bucket behind a balancer.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-cache-server/Dockerfile -t vx-cache-server .
docker run -p 8080:8080 -e ALLOW='…' -e S3_BUCKET=… -e S3_ENDPOINT=… \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… vx-cache-server
```

With vx's other servers: [`compose.yaml`](https://github.com/vznjs/vx/blob/main/private/vx-servers/compose.yaml)
builds and runs all three (`docker compose up -d`).

## Limits

`MAX_CHECK_HASHES` (lookups, hashes × scopes, a check makes; default
500, 6 on Workers) and
`MAX_UPLOAD_BYTES` (default 100 MB, one artifact) set
the limits. Every `/v1/artifacts` answer, a refusal too, names them to
clients (`vx-max-*`), and
`GET /v1/capabilities` too.

## On Cloudflare Workers

From this directory, with `ALLOW` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the R2 bucket `wrangler.jsonc` names on the first deploy.
By default a check makes 6 lookups: a Worker request has 6 calls
waiting at once and queues the rest, so checks of 6 sent at once are
the fastest (from a GitHub runner, 134 hashes: 168 to 216 ms, against
1.9 s for one check of 134, 2026-10-25). Each lookup is one subrequest
(an R2 head), so a higher `MAX_CHECK_HASHES` must fit your plan's
subrequests a request, and `MAX_UPLOAD_BYTES` your plan's request body.
The server lowers neither. A download is read through the data center's cache: an
artifact never changes, so after R2 serves it once, that data center
answers it without R2 (free on every plan). Whether R2 holds an
artifact (a check, a `HEAD`, an upload's skip) is asked of R2 alone: the
data center's copy can outlive R2's, and a writer told "held" there
would skip an upload another data center then cannot read. An upload
drops the copy in the data center it reaches: R2 had let those bytes go.

## Expiry

The bucket's own lifecycle rule expires artifacts, by age since they
were written; the server runs no sweep. An artifact's object name is
`<issuer>/<repository>/<scope>/<hash>`, the first three each hashed (a
client sends a scope as its ref's hash, never the ref), so one rule
for the whole bucket is the one there is, for example 1 day:

```sh
bunx wrangler r2 bucket lifecycle add vx-cache all '' --expire-days 1
```

On S3 the same rule goes in the bucket's lifecycle configuration. A
main run that misses an expired artifact runs the task and stores it
again.

## API

The same server as a `fetch` handler, to mount in a server of your own,
over a bucket of your own (`src/index.ts`):

- `createCacheServer(options: ServerOptions)` returns
  `(req: Request) => Promise<Response>`. `ServerOptions` is
  `{ blobs, authorize, limits? }`: `blobs` is a `Blobs` bucket
  (`{ put(name, body, size), get(name), size(name) }`, `get` answering a
  `Blob`, `{ body, size }`), `authorize` an `Authorize`, which maps a
  request to its `Access` (`{ issuer, repository, write? }`: the token's issuer and
  repository name, which it reads, and the scope it may write) or throws, and `limits` any of `Limits`
  (`{ maxCheckHashes, maxUploadBytes }`) over
  `DEFAULT_LIMITS`.
- `blobName(issuer, repository, scope, hash)` is an artifact's object name,
  `<issuer>/<repository>/<scope>/<hash>`, issuer and repository each the first 128 bits
  of their SHA-256 in hex and `scope` the ref's hash as a client sends
  it (PROTOCOL.md § Keys), so no segment is a plain value.
- `ALLOW` and the CI token check are [`@vzn/vx-devtools`](https://github.com/vznjs/vx/tree/main/packages/vx-devtools)'s,
  the check every vx server shares.
- `SCOPE_HEADER` (`vx-scope`) and `LIMIT_HEADERS` are the header names
  (PROTOCOL.md).
