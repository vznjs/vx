# @vzn/vx-cache-server

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

A cache server for vx that you host yourself, for CI jobs. It stores
task artifacts in one bucket and nothing else (no database), and speaks
the [vx-cache protocol](./PROTOCOL.md) (`/v1`). Three ways to run it
answer alike:

- **Bun**, with any S3-compatible bucket; any number of nodes share one.
- **Docker**, the same server as an image (`Dockerfile`).
- **Cloudflare Workers**, with R2.

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
bun packages/vx-cache-server/src/bun.ts --port 8080
```

S3 settings are those Bun's S3 client reads (`S3_REGION` too). `AUDIENCE`
is read from the environment too. A node keeps no state of its own, so
any number of them serve one bucket behind a balancer.

## With Docker

From the repo root:

```sh
docker build -f packages/vx-cache-server/Dockerfile -t vx-cache-server .
docker run -p 8080:8080 -e TRUST='[…]' -e S3_BUCKET=… -e S3_ENDPOINT=… \
  -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… vx-cache-server
```

## Limits

`MAX_CHECK_KEYS` (default 500), `MAX_BATCH_ARTIFACTS` (default 100) and
`MAX_UPLOAD_BYTES` (default 100 MB, an upload's artifacts together) set
the limits. Every check names them to clients (`x-vx-max-*`), and
`GET /v1/capabilities` too.

## On Cloudflare Workers

From this directory, with `TRUST` filled in `wrangler.jsonc`:

```sh
bun install
bunx wrangler login
bunx wrangler deploy
```

Wrangler makes the R2 bucket `wrangler.jsonc` names on the first deploy.
It fits Workers' free plan: a request makes at most 1000 calls to R2, so
a check reads up to 990 keys and an upload or batch download carries up
to 330 artifacts (a higher setting is lowered, and capabilities say so);
a request body is at most 100 MB. R2's free plan holds 10 GB.

## Expiry

The bucket's own lifecycle rules expire artifacts, by age since they
were written; the server runs no sweep. A trusted artifact is
`trusted/<repo>/<hash>` and a branch's `branch/<repo>/<ref>/<hash>`, so
one rule per prefix keeps each its own time, for example 30 days and 7:

```sh
bunx wrangler r2 bucket lifecycle add vx-cache trusted trusted/ --expire-days 30
bunx wrangler r2 bucket lifecycle add vx-cache branches branch/ --expire-days 7
```

On S3 the same two rules go in the bucket's lifecycle configuration. A
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
  request to its `Access` (`{ repo, write?, trustedRef }`: the repository
  it reads, the scope it may write, and whether a ref is one a rule
  trusts) or throws, and `limits` any of `Limits`
  (`{ maxCheckKeys, maxBatchArtifacts, maxUploadBytes }`) over
  `DEFAULT_LIMITS`.
- `blobName(repo, scope, hash)` is an artifact's object name.
- `TRUST` and the CI token check are [`@vzn/vx-devtools`](https://github.com/vznjs/vx/tree/main/packages/vx-devtools)'s,
  the check every vx server shares.
- `SCOPE_HEADER` (`x-vx-scope`) and `LIMIT_HEADERS` are the header names
  (PROTOCOL.md).
