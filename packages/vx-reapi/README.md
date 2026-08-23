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

`chunkBytes` defaults to **128 KB and is not a throughput knob.** Bun's
`node:http2` client _hangs_ — it does not error — when a request carries more
than one message and any single message exceeds a ceiling that **the server's
flow-control behaviour decides**. Go's gRPC servers grow their window
dynamically (a `WINDOW_UPDATE` then a `SETTINGS` raise) and Bun mishandles the
tail of that sequence; a `node:http2` server, which does not do it, accepts
4 MB writes happily.

See Bun [#30342](https://github.com/oven-sh/bun/issues/30342) and
[#26915](https://github.com/oven-sh/bun/issues/26915), largely fixed by
[#31584](https://github.com/oven-sh/bun/pull/31584) — which is why the ceiling
_rose_ from ~64 KB on Bun 1.3.x to ~216 KB on 1.4.0 rather than the hang going
away. Hence **Bun >= 1.4** is required, and the plugin refuses to start on
anything older with a named error: the alternative is a wedged upload with
nothing for a user to act on.

**If uploads wedge against your server**, drop to the one size with no
peer-dependence — 65535, the RFC 7540 default initial window every peer must
honour with no `WINDOW_UPDATE` at all:

```ts
import { reapi, SAFE_CHUNK_BYTES } from '@vzn/vx-reapi'

reapi({ endpoint: '…', chunkBytes: SAFE_CHUNK_BYTES })
```

128 KB is measured safe against bazel-remote; it is **unverified** against
NativeLink, BuildBuddy and Buildbarn. The full probe matrix is in
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

## Protocol coverage

All **14 RPCs** across the five services, not a working subset:

| Service                     | RPCs                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `Execution`                 | `Execute`, `WaitExecution`                                                                     |
| `ActionCache`               | `GetActionResult`, `UpdateActionResult`                                                        |
| `ContentAddressableStorage` | `FindMissingBlobs`, `BatchUpdateBlobs`, `BatchReadBlobs`, `GetTree`, `SplitBlob`, `SpliceBlob` |
| `Capabilities`              | `GetCapabilities`                                                                              |
| `ByteStream`                | `Read`, `Write`, `QueryWriteStatus`                                                            |

Protocol features in use, not just reachable:

- **Digest negotiation** — picks the strongest function the server advertises
  and this runtime can compute (BLAKE3 → SHA512 → SHA384 → SHA256), and
  refuses a function the server did not advertise rather than uploading blobs
  it will reject.
- **zstd compression** — `compressed-blobs/zstd/…` resource names on
  ByteStream and `compressor: ZSTD` on batch updates, enabled only when
  `supported_compressors` says so.
- **`RequestMetadata`** in the well-known binary header (tool name/version,
  action id, correlated invocations id) — how a server groups an action's
  dozens of CAS/AC calls into one build in its UI.
- **Inline stdout/stderr** on `ExecuteRequest`, sparing two CAS round trips
  per finished action.
- **Execution stages** — `QUEUED` / `EXECUTING` / `COMPLETED` decoded from
  `ExecuteOperationMetadata`, so a queued action is distinguishable from a
  hung one.
- **`ExecutionPolicy.priority`**, **`ResultsCachePolicy.priority`**,
  **`Action.salt`**, and **`Action.platform`** (v2.2) alongside
  `Command.platform` for older servers.
- **`NodeProperties`** — `unix_mode` and `mtime` on tree nodes.
- **Output directories** via the `Tree` blob an `OutputDirectory.tree_digest`
  addresses, plus **output symlinks**.
- **Upload minimality** — `FindMissingBlobs` first, then batched blobs while
  they fit the server's budget and ByteStream beyond it.

## Remote execution

Off by default. Remote execution changes where a user's build runs, which is
not something a plugin should switch on merely by being configured for
caching:

```ts
reapi({
  endpoint: 'grpc.example.com:443',
  execute: true,
  platform: { 'container-image': 'docker://alpine:3.20', OSFamily: 'Linux' },
  capacity: 64, // concurrent remote tasks; becomes the scheduler's pool
})
```

A cache-only server (bazel-remote advertises `exec_enabled: false`) makes the
plugin **decline the executor with a warning** rather than submit work that
will never be answered. Only cacheable tasks are eligible — a task with no
`cache` block has no described inputs, so a worker would run it against an
empty input root.
