# @vzn/vx-cache

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

`vxCache()` is a remote cache for [`@vzn/vx`](https://vznjs.github.io/vx/) runs. It talks to a server you host that speaks the vx-cache protocol, such as [`@vzn/vx-cache-server`](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server).

The local cache stays first. The server is asked on a local miss, and each miss's artifact is uploaded to it.

```sh
bun add -d @vzn/vx-cache
```

```ts
// .vx/workspace.ts
import { vxCache } from '@vzn/vx-cache'

export default {
  plugins: [
    vxCache({
      url: 'https://cache.example.com',
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
    }),
  ],
}
```

The options are `vxCache({ url?, issuer, repository, timeoutMs?, uploadTimeoutMs?, retries?, headers? })`:

- `url` is the server's base URL (`https://cache.example.com`, without `/v1`), or `VX_CACHE_URL`.

  It must be `https://`, with no blanks around it. Every request carries the CI token, so `http://` is taken only to this machine (`127.0.0.1`, `::1`, `localhost`).

  It takes no `?query` or `#fragment`: each route is appended to it. The option is checked when the config loads, `VX_CACHE_URL` when a run opens the cache.

- `issuer` (the CI issuer's URL, as its tokens name it) and `repository` (`org/name` there) are required: nothing guesses them.

  Every request names both by their hashes (`vx-issuer`, `vx-repository`), and the server refuses a token of another repository.

- `retries` (default 2, 0 to 10) is how many times a request is sent again, 1 s, 2 s, … apart. That covers an answer of 5xx or 429, or a connection reset.

  GitHub's OIDC endpoint is asked again the same way. A reset connection is that request's loss alone.

- `timeoutMs` (default 30 000) bounds each read and query. `uploadTimeoutMs` (default 60 000) bounds each upload.

  Each is ms above 0 and up to 2³¹−1 (the longest a timer holds), or `vxCache()` refuses it.

- `headers` are sent on every request to the server, for a proxy in front of it, such as a Cloudflare Access service token:

  ```ts
  headers: { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }
  ```

  An unset value is left out. `authorization`, `content-type`, `content-length` and the `vx-*` names stay the request's own: setting one is refused.

  A redirect is not followed, since it would carry the headers on. It fails the request, naming where it pointed.

  A DTE worker sends the headers too, so give its job the same secrets.

<details><summary>Details</summary>

A request that finds no server turns the remote off for the run, said once, while the server answered nothing else.

Finding no server means every try refused its connection, or its host has no address or route: no network, a mistyped url. A lookup told to try again is tried once more.

A download is bounded by `timeoutMs` until its answer. Then it must bring at least 1 MiB a second over each `timeoutMs`.

An upload must send at least 1 MiB a second over each `uploadTimeoutMs`, then be answered within one.

So a big artifact still moving is not cut off, and one trickling or stalled is. That fails the transfer, said as any cache error.

A read or check the server does not answer within `timeoutMs` is asked once more.

Unanswered again, while the server answered nothing else, it is said once and turns the remote off for the run, reads and writes: the next would wait as long.

So a server that takes the connection and never answers costs twice `timeoutMs`.

</details>

## Tokens

A CI job's requests carry its own OIDC token. The server's `ALLOW` decides whether the job gets in, and the job writes its own branch.

- On GitHub Actions the job's token is asked for the server's origin, and asked again before it ends.

  After a 5xx, a 429 or no answer from GitHub it is asked again, three tries in all, before the remote turns off.

  The job needs `permissions: id-token: write`, which sets `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.

  Without it (`GITHUB_ACTIONS` is set but no token comes), the plugin warns and the job reads only.

- On GitLab, name an `id_tokens` entry `VX_CACHE_TOKEN` with the server's origin as `aud`.

  Without it (`GITLAB_CI` is set but no token comes), the plugin warns and the job reads only.

- Other CIs (Buildkite, CircleCI, Jenkins) have no token the server takes. Their jobs read only, as a laptop does, from a server whose `READ_ACCESS` is `public`.

Off CI a run reads only: core writes no remote there. With no token it reads from a server whose `READ_ACCESS` is `public`.

A laptop whose cache policy names the remote (`cache.policy`, `--cache-policy`) is let write by core. It uploads only with a token the server takes, such as a CI job's `VX_CACHE_TOKEN`. With none it uploads nothing, said once a run.

Any other server refuses the first read, said once, and the run stays local.

A run that hands tasks to other jobs lends them its token (core's `lend()`), and they read and write with it.

A job started from another workflow would carry a token that writes nowhere the run reads.

A job uses a lent token over its own. It never lends one on, nor any once its remote is off for the run.

An upload answered with a 5xx or a 429, or whose connection reset, is sent again, three tries in all. A PUT names its hash, so a second one stores the same bytes.

A download is asked again the same way, so one reset connection is no miss. In a distributed run a read that fails fails the run.

An artifact is immutable on the server: one that did not read back (corrupt) is not replaced.

Its re-run's upload is not sent and not counted as landed; a DTE worker is not told it did.

The run says once that this machine's copy is not sent over it, so a task that needs it fails.

The remote misses the key until the bucket's lifecycle rule expires it (`@vzn/vx-cache-server`'s Expiry).

A download that ends short of the size the server names (`vx-size`) is a transfer that failed, not a corrupt artifact: a miss, asked again next run.

vx keeps a download only once it reads back whole and checks out, so a bad one, altered, cut short or no artifact at all, restores no output file and leaves no cache entry: the task runs as a miss.

Some errors turn the remote off for the run. Each is said once (the run's, counted on no task), while the server answered nothing else:

- a refused token;
- a read with no answer in time, twice running;
- a request that found no server: every try refused, or no address or route for its host.

A refused write (a job that reads only) turns off writes alone.

Any other refusal is a warning naming the server's own words, and the task reads as a miss.

A token the request sent (the job's OIDC token, a lent one, `VX_CACHE_TOKEN`) that those words or any error quote is written `***`.

### Branches and limits

A run reads its own branch first, then the branch it merges into, then the default branch. Each is a ref, sent as a scope.

Every read names scopes, each a ref, percent-encoded. A check names the run's refs in order, and the first ref holding a hash answers it.

The default branch is `baseBranch`, else `origin/HEAD`'s, else the first of `origin/main`, `origin/master`, `main`, `master` that exists, as `--affected` finds its base.

On CI, `github()` or `gitlab()` from `@vzn/vx-ci` names the refs, so declare it too. Without it, a run reads git's branch and the default branch only.

A download names the ref its check answered. One the check has not answered yet names them all in one request.

A ref longer than a scope may be (512 characters, percent-encoded) is said and not read; the others are.

A run that reads no ref says so and stays local.

The server is asked nothing until a check, a download or an upload. So a run the local cache answers sends it no request.

<details><summary>Details</summary>

The server's limits are not asked apart. Each `/v1/artifacts` answer names them, a refusal's too, and no limit is guessed.

A check before any answer goes whole. One refused for its size is sent again, once, in chunks of the `maxCheckHashes` lookups its refusal names, all at once.

So a server restarted with lower limits costs one check a round-trip, not the run its reads.

A run reading more refs than one check takes (Workers' default is 6) spreads each hash's scopes over several.

Each upload is one artifact by `PUT`, as many at once as core's `cache.concurrency.upload` lets (64 to 96 by default).

Its bytes reach the bucket untouched by the server's code. A batch, split by that code, ran out of Workers' CPU.

An artifact over the server's upload limit is not sent: it is said.

Before any answer has named the limits, the first such upload is sent and refused `413`, which names them. It is said the same way, never a failed upload.

An answer is read no further than its use: 64 KiB for a token, 1 KiB a hash for a check, a refusal's first 2 KiB.

A longer one is refused, so a server's endless answer cannot fill memory.

</details>

Task timings are not this plugin's: `@vzn/vx-history` keeps them.

## API

- `vxCache(options: VxCacheOptions)` is the plugin; `VxCacheOptions` is the options above.
- `VxCacheLayer` is its remote cache layer (core's `RemoteCacheLayer`), reading the refs in its `refs`.
- `resolveVxCacheConfig(options, env)` is the settings it runs with (`ResolvedVxCacheConfig`: every option set, `headers` checked), or `undefined` with no URL.
- `hasCiToken(env, lent)` says whether a job has a token to send.
