# @vzn/vx-nx-cache

The Nx self-hosted remote cache plugin for [`@vzn/vx`](https://github.com/vznjs/vx): store vx artifacts in any server implementing Nx's remote cache OpenAPI spec (`GET`/`PUT /v1/cache/{hash}`, Bearer auth, immutable records — a second write of a hash is `409`, which the plugin treats as done). Zero dependencies.

The wire is theirs; the bytes are vx's own artifacts under vx's own keys. The server is storage — the other tool cannot read what vx stores there, and vx does not read its entries.

## Usage

Nothing is on by default. Declare the plugin in `vx.workspace.ts`, **before** the local cache so a remote hit is consulted first, and configure it explicitly:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { nxCache } from '@vzn/vx-nx-cache'

export default defineWorkspace({
  plugins: [
    nxCache({ server: 'https://cache.example.com', accessToken: process.env.CACHE_TOKEN }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged; with nothing configured the plugin **declines** and the run stays local.

| Option        | Environment variable                       | Meaning                                        |
| ------------- | ------------------------------------------ | ---------------------------------------------- |
| `server`      | `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`       | base URL of the cache server                   |
| `accessToken` | `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Bearer token; omit for a server that runs open |
| `timeoutMs`   | —                                          | per-request deadline (default 30 s)            |

The Nx spec has no existence probe, so `has` (the `--dry` prediction and the prefetch pass) is a `GET` whose body the following `get` reuses — one transfer, not two. The wire carries no producing-task duration, so a remote hit reports none.

## Behaviour

- A remote error degrades to a **miss** and one warning; the run never fails because of the cache.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process.
- Policy (`--cache=remote:r`, …) is enforced by core's `LayeredCache`, which this plugin wraps — a read-only token pairs naturally with `remote:r`.

## Testing

`bun test` runs the wire against a strict in-memory implementation of the spec and a full `vx run` round trip (miss → upload → local wipe → restore from the server).
