# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache server for vx that you host yourself, for CI jobs. It stores
task artifacts in one bucket and nothing else (no database), and speaks
the [vx-cache protocol](./PROTOCOL.md) (`/v1`). Three ways to run it
answer alike:

- **Bun**, with any S3-compatible bucket; any number of nodes share one.
  The bucket is required: there is no local-disk mode (on one machine,
  run an S3-compatible store such as MinIO beside it).
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
`ALLOW` empty, the server does not start (a Worker refuses every request). A job writes its branch's own
scope, which only runs of that branch read:

- A push writes its branch, so a run of `main` writes `main`.
- A pull request writes its merge ref, `refs/pull/<n>/merge`, never a
  branch: its work never reaches `main`'s runs, nor a branch a fork names.
- A merge queue's (`merge_group`) run (`refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`)
  writes its base branch, since queued code is about to land.
- A `pull_request_target`, `issue_comment` or `workflow_run` run writes
  nothing: it may run a fork's code.

`AUDIENCE` is the `aud` a token must name: the origin clients reach the
server at (`https://cache.example.com`), which is what `vxCache()` asks
GitHub for. A URL is read as its origin (`https://cache.example.com/v1`
is `https://cache.example.com`); one that is no URL stops the server. On Workers, unset, it is that origin: Cloudflare routes only
the Worker's own hostnames to it. On Bun and Docker it is required, since
there the origin is the request's `Host` header, which a client picks.
`READ_ACCESS=public` lets a request with no token read a repository
`ALLOW` names (a developer's laptop): it writes nothing. Unset, a
request with no token is `401`.

## On Bun

```sh
ALLOW='https://token.actions.githubusercontent.com:acme/app:ci.yml' \
AUDIENCE=https://cache.example.com \
S3_BUCKET=vx-cache S3_ENDPOINT=https://s3.example.com \
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
bun packages/vx-cache-server/src/bun.ts --port 8080
```

`S3_BUCKET` is required: without it the server does not start. S3 settings are those Bun's S3 client reads (`S3_REGION` too). A node keeps no state of its own, so
any number of them serve one bucket behind a balancer.

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

`MAX_CHECK_HASHES` (lookups, hashes × scopes, a check makes; default
500, 6 on Workers) and
`MAX_UPLOAD_BYTES` (default 100 MB, one artifact) set
the limits, each in decimal digits (on Workers, a JSON number too). Every `/v1/artifacts` answer, a refusal too, names them to
clients (`vx-max-*`), and
`GET /v1/capabilities` too.

## On Cloudflare Workers

From this directory, with `ALLOW` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the R2 bucket `wrangler.jsonc` names on the first deploy;
the Worker reads it as the binding `BLOBS`.
By default a check makes 6 lookups: a Worker request has 6 calls
waiting at once and queues the rest, so checks of 6 sent at once are
the fastest (from a GitHub runner, 134 hashes: 168 to 216 ms, against
1.9 s for one check of 134, 2026-10-25). Each lookup is one subrequest
(an R2 head), so a higher `MAX_CHECK_HASHES` must fit your plan's
subrequests a request, and `MAX_UPLOAD_BYTES` your plan's request body.
The server lowers neither. A download is read through the data center's cache: an
artifact never changes, so after R2 serves it once, that data center
answers it without R2 (free on every plan). Whether R2 holds an
artifact (a check, a `HEAD`, an upload's skip) is asked of R2, never
of that copy: it can outlive R2's, and a writer told "held" there would
skip an upload another data center then cannot read. An upload drops
the copy in the data center it reaches: R2 had let those bytes go.
A read R2 answers "try again" (10001, 10058) is asked up to three
times before the request fails `502`. The deploy clears any cron: the
Worker has no `scheduled()`.

Set `EXPIRY_DAYS` to the bucket's lifecycle rule (below) and R2's
"held" is kept in the data center's cache too: an upload, R2's
answer to a lookup, or a download R2 serves marks the artifact held,
in the background, until the rule may drop it, counted from its upload. A repeat check or `HEAD` in that data center then
skips R2. Only "held" is kept: a miss always asks R2, so a later
upload is never hidden. An upload's skip always asks R2, never a
mark: a client uploads only what its check missed, which no mark
holds, so this costs no head a mark saved. Unset, every lookup asks R2. A larger value
than the rule is wrong: a mark would outlive the artifact. After
deleting artifacts by hand, a mark may still answer a check "held";
vx then misses the download and runs the task, the miss drops that
mark, and the task's upload is stored again.

## Expiry

The bucket's own lifecycle rule expires artifacts, by age since they
were written; the server runs no sweep. An artifact's object name is
`<issuer>/<repository>/<ref>/<hash>`, each a readable folder
(`https%3A%2F%2Ftoken.actions.githubusercontent.com/acme%2Fapp/refs%2Fheads%2Fmain/<hash>`),
so deleting one branch's prefix prunes that branch alone. One age rule
covers the bucket, for example 1 day:

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
  (`{ put(name, body, size), get(name), size(name, bucket?) }`, `get` answering a
  `Blob`, `{ body, size }`, `size` with `bucket` the bucket's own answer,
  never one the backend kept: an upload's skip; a backend that keeps none ignores it), `authorize` an `Authorize`, which maps a
  request to its `Access` (`{ issuer, repository, write? }`: the token's issuer and
  repository name, which it reads, and the scope it may write) or throws, and `limits` any of `Limits`
  (`{ maxCheckHashes, maxUploadBytes }`) over
  `DEFAULT_LIMITS`.
- `blobName(issuer, repository, scope, hash)` is an artifact's object name,
  `<issuer>/<repository>/<scope>/<hash>`, issuer and repository each
  percent-encoded and `scope` the encoded ref as a client sends it
  (PROTOCOL.md § Keys), so a slash in any part never starts a folder.
- `ALLOW` and the CI token check are [`@vzn/vx-devtools`](https://github.com/vznjs/vx/tree/main/packages/vx-devtools)'s,
  the check every vx server shares.
- `SCOPE_HEADER` (`vx-scope`) and `LIMIT_HEADERS` are the header names
  (PROTOCOL.md).
