# @vzn/vx-cache

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

`vxCache()`: a remote cache for [`@vzn/vx`](https://vznjs.github.io/vx/)
on a server you host that speaks the vx-cache protocol, such as
[`@vzn/vx-cache-server`](https://github.com/vznjs/vx/tree/main/packages/vx-cache-server). The local cache
stays first; the server is asked on a local miss, and each miss's
artifact is uploaded to it. Until it is on npm, import it from a
checkout of this repo:

```ts
// .vx/workspace.ts
import { vxCache } from '/path/to/vx/packages/vx-cache/src/index.ts'

export default { plugins: [vxCache({ url: 'https://cache.example.com' })] }
```

`vxCache({ url?, token?, timeoutMs?, uploadTimeoutMs?, history? })`:

- `url` is the server's base URL, or `VX_CACHE_URL`.
- `token` is the bearer token every request carries, or `VX_CACHE_TOKEN`.
  A read token reads; a write token also uploads.
- `timeoutMs` (default 30 000) bounds each read and query, and
  `uploadTimeoutMs` (default 60 000) each upload.
- `history` (default `true`) keeps the run history on the server: see
  below. `false` leaves the order and the server's runs alone.

With no URL or no token the plugin declines and the run stays local, so it
is safe to leave declared. A refused token is said once and turns the
remote off for the run; a read token's refused write turns off writes
alone. Any other refusal is a warning naming the server's own words, and
the task reads as a miss.

Every read names the run's refs in `Vx-Read-Scopes` (its branch, then
the branch it merges into), so a server that keeps branches apart answers
from the closest one first. One existence query covers up to 1000 keys.

## Run history

After a CI run, `vxCache()` writes its task timings to the server
(`POST /v1/runs`): each task's duration, exit code, key and whether it was
cached. A cache hit records the duration of the run that produced it,
the time the task costs when it runs. A run off CI writes nothing.

Every run asks the server for each task's newest timings in its read
scopes (`POST /v1/tasks/query`) and orders ready tasks by the longest
remaining chain, as `@vzn/vx-schedule-history` does with local history.
The run never waits for that answer: it starts on core's own order and
re-ranks the tasks not yet started when the timings land. A failed run's
timing is left out.

## API

- `vxCache(options?: VxCacheOptions)` is the plugin; `VxCacheOptions` is the options above.
- `VxCacheLayer` is its remote cache layer (core's `RemoteCacheLayer`),
  and `resolveVxCacheConfig(options, env)` the settings it runs with, or
  `undefined` when it declines. Its `putRun(run)` writes a run, and
  `medians(tasks)` reads each task's median duration.
- `RunTask` is one task of a written run.
