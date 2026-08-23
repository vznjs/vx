# `@vzn/vx-reapi`

A vx **remote cache** backed by any server speaking Bazel's
[Remote Execution API](https://github.com/bazelbuild/remote-apis) — NativeLink,
BuildBuddy, Buildbarn, bazel-remote. Six mature server implementations, none of
which we had to write, because a REAPI server is deliberately dumb.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  // reapi BEFORE localCachePlugin so a remote hit is consulted first.
  plugins: [
    reapi({ endpoint: 'cache.example.com:443' }),
    localExecutorPlugin(),
    localCachePlugin(),
  ],
})
```

With no endpoint configured the plugin **declines** and costs nothing, so it is
safe to leave declared. `VX_REAPI_ENDPOINT` / `VX_REAPI_INSTANCE` configure it
from the environment.

## How a vx cache key becomes a REAPI entry

A CAS digest is the sha256 of the **content**, so it cannot be derived from a
vx cache key before the bytes exist — `has(key)` could never answer. The
ActionCache supplies the missing indirection:

| vx                   | REAPI                                                         |
| -------------------- | ------------------------------------------------------------- |
| cache key            | synthetic action digest — `sha256("vx-reapi-v1\0" + key)`     |
| artifact (`tar.zst`) | one CAS blob, referenced by the ActionResult's `output_files` |
| task duration        | `stdout_raw` on the ActionResult                              |
| cache miss           | `GetActionResult` → `NOT_FOUND`                               |

The `vx-reapi-v1` prefix does two jobs: it keeps vx keys out of the address
space of real Bazel action digests on a shared server, and it makes a future
change to this mapping **miss cleanly** rather than read bytes written under
different rules.

Servers may normalise an inline `stdout_raw` into a CAS blob and hand back a
`stdout_digest` instead (bazel-remote does). The read path accepts either.

## Bun and chunk size

`CHUNK_BYTES` is **128 KB and is not a throughput knob.** Bun's `node:http2`
client _hangs_ — it does not error — when a request carries more than one
message and any single message exceeds a threshold near the HTTP/2 stream
flow-control window. That threshold is a Bun implementation detail, not a
protocol constant, and it moved between releases: ~64 KB on Bun 1.3.x, between
192 and 256 KB on 1.4.0.

This package therefore requires **Bun ≥ 1.4** and refuses to start on anything
older with a named error, because the alternative is a wedged upload with
nothing for a user to act on. The full probe matrix is in
`docs/design/plugin-executor-reapi-2026-08.md` §14.

## Tests

`bun test` runs the unit suite anywhere. The round-trip suite needs a real
server:

```sh
docker run -d -p 19092:9092 buchgr/bazel-remote-cache:latest \
  --dir /data --max_size 1 --grpc_address 0.0.0.0:9092 --http_address 0.0.0.0:8080

VX_REAPI_TEST_ENDPOINT=127.0.0.1:19092 bun test
```

Without an endpoint those tests skip; CI sets `VX_REQUIRE_REAPI=1`, which turns
an absent endpoint into a failure so the suite cannot silently vanish.

## Not yet

Remote **execution** (the `executor` capability). Phase 1 is the cache only —
see the design doc for the phased plan.
