# @vzn/vx-cache

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

`vxCache()`: a remote cache for [`@vzn/vx`](https://vznjs.github.io/vx/)
on a server you host that speaks the vx-cache protocol, such as
[`@vzn/vx-cache-server`](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server). The local cache
stays first; the server is asked on a local miss, and each miss's
artifact is uploaded to it. It is not on npm yet.

```ts
// .vx/workspace.ts
import { vxCache } from '@vzn/vx-cache'

export default { plugins: [vxCache({ url: 'https://cache.example.com' })] }
```

`vxCache({ url?, token?, timeoutMs?, uploadTimeoutMs? })`:

- `url` is the server's base URL, or `VX_CACHE_URL`.
- `token` is the bearer token every request carries, or `VX_CACHE_TOKEN`.
  A read token reads; a write token also uploads.
- `timeoutMs` (default 30 000) bounds each read and query, and
  `uploadTimeoutMs` (default 60 000) each upload.

With no URL or no token the plugin declines and the run stays local, so it
is safe to leave declared. A refused token is said once and turns the
remote off for the run; a read token's refused upload turns off uploads
alone. Any other refusal is a warning naming the server's own words, and
the task reads as a miss.

Every read names the run's refs in `Vx-Read-Scopes` (its branch, then
the branch it merges into), so a server that keeps branches apart answers
from the closest one first. One existence query covers up to 1000 keys.

## API

- `vxCache(options?: VxCacheOptions)` is the plugin; `VxCacheOptions` is the options above.
- `VxCacheLayer` is its remote cache layer (core's `RemoteCacheLayer`),
  and `resolveVxCacheConfig(options, env)` the settings it runs with, or
  `undefined` when it declines.
