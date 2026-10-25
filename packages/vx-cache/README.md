# @vzn/vx-cache

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

`vxCache()`: a remote cache for [`@vzn/vx`](https://vznjs.github.io/vx/)
CI jobs, on a server you host that speaks the vx-cache protocol, such as
[`@vzn/vx-cache-server`](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server).
The local cache stays first; the server is asked on a local miss, and
each miss's artifact is uploaded to it. Until it is on npm, import it
from a checkout of this repo:

```ts
// .vx/workspace.ts
import { vxCache } from '/path/to/vx/packages/vx-cache/src/index.ts'

export default { plugins: [vxCache({ url: 'https://cache.example.com' })] }
```

`vxCache({ url?, timeoutMs?, uploadTimeoutMs? })`:

- `url` is the server's base URL, or `VX_CACHE_URL`.
- `timeoutMs` (default 30 000) bounds each read and query, and
  `uploadTimeoutMs` (default 60 000) each upload.

## CI only

Every request carries the CI job's own OIDC token, and the server's
`TRUST` decides where the job writes: trusted, or its branch.

- On GitHub Actions the job's token is asked for the server's origin,
  and asked again before it ends. The job needs
  `permissions: id-token: write`; without it (`GITHUB_ACTIONS` is set
  but no token comes), the plugin warns and runs without the cache.
- On GitLab, name an `id_tokens` entry `VX_CACHE_TOKEN` with the
  server's origin as `aud`.

Off CI there is no token: the plugin says so once per run and the run
stays local. There is no local use for now.

A run that hands tasks to other jobs lends them its token (core's
`lend()`), and they read and write with it: a job started from another
workflow would carry a token that writes nowhere the run reads. A job
uses a lent token over its own and never lends one on.

A refused token is said once and turns the remote off for the run; a
refused write (a job that reads only) turns off writes alone. Any other
refusal is a warning naming the server's own words, and the task reads
as a miss.

Every read names exact keys, `{ scope, hash }`: one per ref the run
reads (its branch, then the branch it merges into, then the default
branch), and the first ref holding a hash answers it. A run that reads
no ref says so and stays local. The run asks the server's limits once
(`/v1/capabilities`) and checks in chunks of its `maxCheckKeys`. One or
two uploads waiting at once go as they are; more go as one batch of the
missing, checked first, within the limits the server named. While it
names none (said once), checks and uploads go one at a time: no limit
is guessed. An artifact over the server's upload limit is not sent: it
is said once.

Task timings are not this plugin's: `@vzn/vx-history` keeps them.

## API

- `vxCache(options?: VxCacheOptions)` is the plugin; `VxCacheOptions` is the options above.
- `VxCacheLayer` is its remote cache layer (core's `RemoteCacheLayer`),
  reading the refs in its `refs`.
- `resolveVxCacheConfig(options, env)` is the settings it runs with, or
  `undefined` with no URL, and `hasCiToken(env, lent)` whether a job has
  a token to send.
