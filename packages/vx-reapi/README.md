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

The stall is a RACE, not a boundary: 128 KB chunks pass hundreds of runs and
then wedge once (observed on CI, same Bun build). So the client **downgrades
adaptively** — a `DEADLINE_EXCEEDED` on a multi-message write retries once at
`SAFE_CHUNK_BYTES` with a warning, turning a lost coin-flip into a logged
retry instead of a failed task. The full probe matrix is in
`docs/design/plugin-executor-reapi-2026-08.md` §14.

## Repeat runs skip the worker

Every successful remote execution writes an execution record under the
task's vx key (`vx-reapi-exec-v1`), listing its outputs by digest plus
its stdout. A later run whose vx cache missed but whose key already has
a record skips the Merkle build, the upload pass and `Execute`
entirely: the outputs are already in the CAS, and stdout replays from
the record. `--force` bypasses it.

This matters most under `--download=none`, where deferral leaves no
local cache entry behind, so vx's own probe misses on every later run
and the record is what makes the second run cheap. Records are checked
against the CAS first (`FindMissingBlobs`) — the action cache and the
CAS evict independently, so a record that outlived its blobs falls
through to a real execution rather than "succeeding" with nothing.

An UPSTREAM's evicted blobs get the opposite answer, because there is
nothing to fall through to. When a dependency's outputs live only in
the CAS — vx grafts them by reference precisely because no local copy
exists — and those blobs are gone, the action cannot be built with the
inputs its key claims. vx fails the task and names the upstream rather
than shipping the action without them: a command that tolerates the
absence exits 0, and that successful-but-wrong result would be cached
under a key asserting those bytes were present. Which upstream bytes a
command actually reads is unknowable — that is what `dependsOn`
declares — so the refusal is the only sound reading, and it matches
what core does when a deferred producer cannot be materialised.
Re-run the upstream (`--force`) to repopulate the store.

Bringing a task's OWN outputs back gets the same treatment. Core's
contract is that once an executor returns, the declared outputs are on
disk, because the ordinary save path then tars whatever it finds — so
an output blob that cannot be fetched is a hole that would be cached
under a key claiming a complete build. Under a literal capture the
worker returns only what `output_paths` named, so every returned file
is a declared output and an unfetchable one fails the task. The
exception is a glob whose FIRST segment is a wildcard (`*.js`): it has
no REAPI spelling, so it is sent as `''` — whole-working-directory
capture — and inputs and undeclared siblings come back too. Those
cannot be told apart from real outputs, so a missing blob there only
warns; prefer a literal first segment (`dist/*.js`) when you want the
stricter check.

## Downloads are verified

Every blob read — ByteStream and batch alike, compressed or not — is
re-hashed with the negotiated digest function and length-checked against
the digest it was requested under. Bytes that don't match are refused with
a named integrity error instead of being written into the local
content-addressed store: a corrupt or poisoned remote degrades to a miss
(the cache invariant), never to wrong bytes under a trusted name. Uploads
were always server-verified; this is the mirror on the read side, the same
check Bazel's client performs.

## Deadlines: a wedged server degrades, it does not hang

Every cache-path call (unary RPCs, ByteStream transfers) carries a gRPC
deadline — `callTimeoutMs`, default 30 s. This is what turns a **wedged**
server — accepts TCP, never answers — into an error the cache layer degrades
to a MISS; without it the first probe would hang the whole run, and "errors
degrade to a miss" is vacuous when the call never returns. `DEADLINE_EXCEEDED`
is deliberately not retried (one deadline, not deadline × retries).

Execution streams (`Execute`/`WaitExecution`) are **not** bounded by it:
queueing behind a busy worker pool is legitimate and unbounded. A wedged
server still cannot reach `Execute`, because the deadline-bounded
`GetCapabilities` call runs first and fails.

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

- **Digest negotiation** — SHA256 by default (the universal baseline; the
  Merkle encoders must hash with the SAME function as every upload, so
  auto-upgrading would mix functions inside one action). Another function is
  an explicit `negotiate({ digestFunction: 'SHA512' })`, and one the server
  did not advertise is refused rather than uploading blobs it will reject.
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

Verified end-to-end against a live NativeLink scheduler + worker: input tree
uploaded, QUEUED → EXECUTING → COMPLETED streamed, stdout returned inline,
declared outputs materialised byte-correct, and the worker attributed. Every
hand-rolled encoder AND decoder is pinned byte-for-byte against protobufjs
over the same vendored protos — the decoder tests exist because a wrong field
number parses garbage without ever erroring (`tests/encoding.test.ts`).

One environmental note for NativeLink specifically: its official image is
distroless, so a worker inside it has no `/bin/sh` and cannot run any vx task.
`tests/helpers/nativelink.md` has the three-command busybox rehost.

## node_modules: install as an action

REAPI workers are stateless, and vx deliberately treats `node_modules` as
ambient environment rather than a cache input — so a remote task cannot see
the packages a build needs. The answer is the design doc's §7.4 recipe,
`exec.remote: 'only'`:

```ts
install: {
  exec: { command: 'pnpm install --frozen-lockfile', remote: 'only' },
  cache: {
    inputs: { files: ['package.json', 'pnpm-lock.yaml'] },
    outputs: { files: ['node_modules/**'] },
  },
},
build: {
  dependsOn: ['install'],
  exec: { command: 'tsc -p .' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
},
```

What actually happens, all verified live against a NativeLink scheduler +
worker (`tests/vx-run-e2e.test.ts`):

- `install` executes **on a worker** — so platform binaries build for the
  worker's platform, not the laptop's — and runs once per lockfile change,
  ever: repeats are satisfied from an execution record the plugin keeps under
  the task's vx cache key.
- Its outputs **never land on the submitter's disk**: not materialised, not
  restored, and the local `node_modules` a dev installed is never cleaned.
- A dependent task's input tree grafts the install outputs **by reference**
  (per-file digests from the execution record; whole directories as
  re-canonicalised REAPI `Tree`s), so the bytes flow worker→CAS→worker and
  never transit the submitter. The graft applies ONLY to outputs that exist
  nowhere locally: when an upstream's outputs are materialised on this
  machine, **local disk is truth** — two machines racing a nondeterministic
  miss can leave the artifact store and the execution record holding
  results of different executions under one pure-input key, and a worker
  fed the record would see bytes this machine's own tasks do not.
- With **no remote executor declared**, `install` is a local no-op and
  dependents use whatever the machine has ambient — a laptop run behaves
  exactly as it did before the field existed.

The execution record lives under `sha256("vx-reapi-exec-v1\0" + key)` — a
second AC namespace beside the artifact mapping, listing outputs file-by-file
with workspace-relative paths.
