# @vzn/vx-turbo-cache

The Turborepo remote cache plugin for [`@vzn/vx`](https://github.com/vznjs/vx): store vx artifacts in any server speaking Turbo's `/v8/artifacts` API — Vercel's hosted cache or a self-hosted implementation of the published OpenAPI spec (Bearer auth, `x-artifact-duration`, HMAC-SHA256 `x-artifact-tag` signatures). Zero dependencies.

The wire is theirs; the bytes are vx's own artifacts under vx's own keys. The server is storage — the other tool cannot read what vx stores there, and vx does not read its entries.

## Usage

Nothing is on by default. Declare the plugin in `vx.workspace.ts`, **before** the local cache so a remote hit is consulted first, and configure it explicitly:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { turboCache } from '@vzn/vx-turbo-cache'

export default defineWorkspace({
  plugins: [
    turboCache({
      apiUrl: 'https://cache.example.com',
      token: process.env.CACHE_TOKEN,
      teamSlug: 'acme',
      // Optional: sign uploads and verify downloads (Turbo's artifact signature).
      // signatureKey: process.env.CACHE_SIGNATURE_KEY, teamId: 'team_acme',
    }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

Every option falls back to the tool's own environment variable, so a self-hosted setup carries over unchanged; with nothing configured the plugin **declines** and the run stays local.

| Option            | Environment variable               | Meaning                                                                                |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `apiUrl`          | `TURBO_API`                        | base URL of the cache server                                                           |
| `token`           | `TURBO_TOKEN`                      | Bearer token on every request                                                          |
| `teamId`          | `TURBO_TEAMID`                     | `teamId` query parameter; required with `signatureKey`                                 |
| `teamSlug`        | `TURBO_TEAM`                       | `slug` query parameter                                                                 |
| `signatureKey`    | `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | HMAC-SHA256 key (≥ 32 bytes, used raw); a download whose tag does not verify is a miss |
| `timeoutMs`       | —                                  | HEAD/GET/POST deadline (default 30 s)                                                  |
| `uploadTimeoutMs` | —                                  | PUT deadline (default 60 s)                                                            |

The signature is Turbo's current scheme (`artifact-signature:v2`: prefix, hash, team id and body, each length-prefixed, under HMAC-SHA256, base64 in `x-artifact-tag`).

## Behaviour

- A remote error degrades to a **miss** and one warning; the run never fails because of the cache.
- A refused token (`401`/`403`) warns **once** and turns the layer off for the rest of the process.
- Policy (`--cache=remote:r`, …) is enforced by core's `LayeredCache`, which this plugin wraps — a read-only token pairs naturally with `remote:r`.

## Testing

`bun test` runs the wire against a strict in-memory implementation of the spec and a full `vx run` round trip (miss → upload → local wipe → restore from the server).
