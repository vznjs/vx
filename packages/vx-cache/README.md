# @vzn/vx-cache

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

`vxCache()`: a remote cache for [`@vzn/vx`](https://vznjs.github.io/vx/)
runs, on a server you host that speaks the vx-cache protocol, such as
[`@vzn/vx-cache-server`](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server).
The local cache stays first; the server is asked on a local miss, and
each miss's artifact is uploaded to it.

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

`vxCache({ url?, issuer, repository, timeoutMs?, uploadTimeoutMs?, headers? })`:

- `url` is the server's base URL (`https://cache.example.com`, without `/v1`), or `VX_CACHE_URL`.
  It must be `https://`: every request carries the CI token, so `http://`
  is taken only to this machine (`127.0.0.1`, `::1`, `localhost`).
- `issuer` (the CI issuer's URL, as its tokens name it) and `repository`
  (`org/name` there) are required: nothing guesses them. Every request
  names both by their hashes (`vx-issuer`, `vx-repository`), and the
  server refuses a token of another repository.
- `timeoutMs` (default 30 000) bounds each read and query, and
  `uploadTimeoutMs` (default 60 000) each upload. A download is bounded
  the same way until its answer, then must bring at least 1 MiB a second
  over each `timeoutMs`: a big artifact still coming in is not cut off,
  and one trickling in is. Each is ms above 0 and up to 2³¹−1 (the
  longest a timer holds), or `vxCache()` refuses it.
- `headers` are sent on every request to the server, for a proxy in
  front of it, such as a Cloudflare Access service token:
  `headers: { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }`. An
  unset value is left out; `authorization`, `content-type`, `content-length`
  and the `vx-*` names stay the request's own (setting one is refused). A
  redirect is not followed (it would carry them on): it fails the
  request, naming where it pointed. A DTE
  worker sends them too, so give its job the same secrets.

## Tokens

A CI job's requests carry its own OIDC token, and the server's `ALLOW`
decides whether the job gets in; it writes its own branch.

- On GitHub Actions the job's token is asked for the server's origin,
  and asked again before it ends; after a 5xx, a 429 or no answer
  from GitHub it is asked again, three tries in all, before the remote
  turns off. The job needs
  `permissions: id-token: write`, which sets
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`;
  without it (`GITHUB_ACTIONS` is set but no token comes), the plugin
  warns and the job reads only.
- On GitLab, name an `id_tokens` entry `VX_CACHE_TOKEN` with the
  server's origin as `aud`; without it (`GITLAB_CI` is set but no
  token comes), the plugin warns and the job reads only.

With no token (off CI) a run reads only and uploads nothing, from a
server whose `READ_ACCESS` is `public`; any other server refuses the
first read, said once, and the run stays local.

A run that hands tasks to other jobs lends them its token (core's
`lend()`), and they read and write with it: a job started from another
workflow would carry a token that writes nowhere the run reads. A job
uses a lent token over its own and never lends one on, nor any once
its remote is off for the run.

A refused token is said once and turns the remote off for the run; a
refused write (a job that reads only) turns off writes alone. Any other
refusal is a warning naming the server's own words, and the task reads
as a miss.

Every read names scopes, each a ref's hash (no ref goes on the wire
plain). A check names the run's refs in order (its branch, then the
branch it merges into, then the default branch; on CI `github()` or
`gitlab()` from `@vzn/vx-ci` names them, so declare it too: without it
a run reads git's branch and the default branch only), and the first ref
holding a hash answers it; its download names that ref. A run that reads
no ref says so and stays local. The run asks the server's limits once
(`/v1/capabilities`) and checks in chunks of its `maxCheckHashes`
lookups, all at once; a run reading more refs than one check takes
(Workers' default is 6) spreads each hash's scopes over several. It
keeps to the limits each `/v1/artifacts` answer names, a refusal's too,
so a server restarted with lower ones refuses one check, not the run's. Each
upload is one artifact by `PUT`, up to four at once: its bytes reach the
bucket untouched by the server's code (a batch, split by that code, ran
out of Workers' CPU). While the server names no limits (said once),
checks go one hash at a time: no limit is guessed. An artifact over the server's upload limit is not sent: it
is said once. An answer is read no further than its use: 64 KiB for the
capabilities or a token, 512 bytes a hash for a check, a refusal's first
2 KiB; a longer one is refused, so a server's endless answer cannot fill
memory.

Task timings are not this plugin's: `@vzn/vx-history` keeps them.

## API

- `vxCache(options: VxCacheOptions)` is the plugin; `VxCacheOptions` is the options above.
- `VxCacheLayer` is its remote cache layer (core's `RemoteCacheLayer`),
  reading the refs in its `refs`.
- `resolveVxCacheConfig(options, env)` is the settings it runs with
  (`ResolvedVxCacheConfig`: every option set, `headers` checked), or
  `undefined` with no URL, and `hasCiToken(env, lent)` whether a job has
  a token to send.
