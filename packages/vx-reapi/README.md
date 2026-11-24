# `@vzn/vx-reapi`

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-reapi/> · source: <https://github.com/vznjs/vx>

A vx **remote cache** backed by any server that speaks Bazel's
[Remote Execution API](https://github.com/bazelbuild/remote-apis) (REAPI).

- NativeLink, BuildBuddy, Buildbarn and bazel-remote are mature servers you
  can use.
- vx needs no server of its own: a REAPI server is deliberately dumb.

```sh
bun add -d @vzn/vx @vzn/vx-reapi
```

```ts
// .vx/workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { reapi } from '@vzn/vx-reapi'

export default defineWorkspace({
  // Reads try the local cache first, then the remote; a remote hit is copied to local.
  plugins: [reapi({ endpoint: 'grpcs://cache.example.com:443' })],
})
```

**Who writes the remote.** Off CI, a run reads the remote and does not write
it, unless its policy names the remote.

- The execution record (see below) follows the same policy.
- A run that does not read the remote replays no record. One that does not
  write it records none under the task's key.
- Give the write credential only to the default branch's CI.
- Give a read-only one to laptops and pull request jobs.
- The server's token is the boundary (`docs/security.md` § Cache
  poisoning).
- A server that refuses a save's `UpdateActionResult` (`PERMISSION_DENIED`,
  `UNIMPLEMENTED`) is taken at its word for the run.
- Later saves in that run fail the same way, without uploading.

**Declining.** With no endpoint configured (or a blank one) the plugin
**declines** and costs nothing. So it is safe to leave declared.

**Settings.** The plugin reads no environment variable: every setting is an
option. Name a value from CI in `.vx/workspace.ts`
(`endpoint: process.env.REAPI_ENDPOINT`).

- An `endpoint` is `host[:port]`, with an optional `grpc(s)://` or
  `http(s)://` scheme. A trailing `/` is dropped.
- It may also be a gRPC resolver target: `unix:`, `unix-abstract:`, `dns:`,
  `ipv4:` or `ipv6:`.
- Any other endpoint is refused at startup, with a line naming the setting.
- So is a TLS endpoint at an IP address, since Bun's TLS refuses an IP as
  the server name.
- Name the server by host name instead, or use `grpc://` for plaintext.
- `execute: true` turns on remote execution (see below). It is off by
  default.
- `execute` is a boolean: a string (`process.env.X`) is refused.
- `instanceName`, like the endpoint, is trimmed, and a blank one is unset.
- `headers` adds gRPC metadata to every call. A hosted server's API key goes
  there: `headers: { 'x-buildbuddy-api-key': process.env.BB_KEY! }`.
- A header name gRPC metadata cannot carry (a space, a `-bin` suffix) is
  refused at startup.
- So is a header or `platform` value that is no string (an unset variable),
  once an endpoint is set. With no endpoint, the plugin declines.
- `toolName` and `toolVersion` (default `vx`, `0.0.0`) fill each call's
  `RequestMetadata.tool_details`.
- `correlatedInvocationsId` groups several runs as one build in a server's
  UI.

**TLS.** TLS is on unless you ask for it off. A bare `host:port`, a
`grpcs://` or `https://` endpoint, and a `dns:`/`ipv4:`/`ipv6:` target all
use it.

- Plaintext takes a `grpc://` or `http://` endpoint, or `tls: false`.
- A `unix:` or `unix-abstract:` socket is plaintext; `tls: true` turns TLS
  on for it.
- TLS uses the system roots unless told otherwise.
- A server behind a private CA takes `tlsCertificate`, a PEM file of that
  CA.
- A server that asks for mutual TLS takes `tlsClientCertificate` and
  `tlsClientKey`.
- Any of those three turns TLS on, unless `tls: false` is set.
- A file that cannot be read is refused at startup, naming the setting.

**Exports.** The package exports `reapi`, `ReapiPluginOptions`,
`ReapiRemoteCache` and its `ReapiOptions`. The wire client, the Merkle
encoders and the executor are internal.

- `ReapiRemoteCache` is the layer class behind `reapi()`, for a workspace
  that composes cache layers by hand.
- `ReapiOptions` is the connection as the plugin resolves it: the same
  fields, with the PEM text itself in place of the files.
- Those fields are `tlsCaPem`, `tlsClientCertPem` and `tlsClientKeyPem`.
- `ReapiOptions` also has `onWarn`, for a degraded-but-recovered call.
- `reapi()` refuses those four options: it reads the files, and warns
  through vx.

## How a vx cache key becomes a REAPI entry

A CAS digest is the sha256 of the **content**. So it cannot be derived from
a vx cache key before the bytes exist, and `has(key)` could never answer.
The ActionCache supplies the missing step:

| vx                   | REAPI                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cache key            | synthetic action digest — `sha256("vx-reapi-v1\0" + key)`                                                                                                              |
| artifact (`tar.zst`) | one CAS blob, referenced by the ActionResult's `output_files`                                                                                                          |
| task duration        | `stdout_raw` on the ActionResult                                                                                                                                       |
| cache miss           | `GetActionResult` → `NOT_FOUND`                                                                                                                                        |
| cache hit            | `GetActionResult` asking for stdout and the artifact inline: a server that honours it (bazel-remote, up to ~1 MiB) answers a small hit in one round trip               |
| cache save           | an artifact up to 256 KiB is read once and goes in one `BatchUpdateBlobs`, unprobed; a larger one is probed with `FindMissingBlobs` and streamed only if missing       |
| stored key           | kept: the save writes no `UpdateActionResult`, unless core says the stored bytes did not read back (`replace`); then the blob is sent unprobed and the entry rewritten |

The `vx-reapi-v1` prefix does two jobs:

- It keeps vx keys out of the address space of other clients' real action
  digests on a shared server.
- It makes a future change to this mapping **miss cleanly**, rather than
  read bytes written under different rules.

Servers may turn an inline `stdout_raw` into a CAS blob, and hand back a
`stdout_digest` instead (bazel-remote does). The read path accepts either.

## Bun and chunk size

`chunkBytes` sets the size of each message in an upload. It defaults to
**65535, and it is not a throughput knob.**

```ts
reapi({ endpoint: 'grpcs://cache.example.com:443', chunkBytes: 128 * 1024 })
```

- Bun's `node:http2` client _hangs_, with no error, past a size ceiling.
- That happens when a request carries more than one message and any single
  message exceeds a ceiling that **the server's flow-control behaviour
  decides**.
- So **Bun >= 1.4.4** is required (core's own minimum, the package's
  `engines.bun`).
- The plugin refuses to start on anything older, with a named error. The
  alternative is a wedged upload with nothing for you to act on.
- 65535 is the one size with no dependence on the peer: the RFC 7540
  default initial window, which every peer must honour with no
  `WINDOW_UPDATE` at all (`SAFE_CHUNK_BYTES`).
- A larger `chunkBytes` is still accepted, as above.

<details><summary>Details</summary>

- Go's gRPC servers grow their window dynamically (a `WINDOW_UPDATE` then a
  `SETTINGS` raise), and Bun mishandles the tail of that sequence.
- A `node:http2` server, which does not do that, accepts 4 MB writes
  happily.
- See Bun [#30342](https://github.com/oven-sh/bun/issues/30342) and
  [#26915](https://github.com/oven-sh/bun/issues/26915).
- Those are largely fixed by
  [#31584](https://github.com/oven-sh/bun/pull/31584).
- That fix _raised_ the ceiling from ~64 KB on Bun 1.3.x to ~216 KB on 1.4.0,
  rather than make the hang go away.
- Measured on Bun 1.4.2: 128 KB stalled a 1 MiB write against bazel-remote
  in 2 of 12 fresh runs, each costing the call's 30 s deadline.
- 65535 stalled in none, and costs ~51% on a 32 MiB upload (390 → 590 ms on
  loopback).
- The stall is a RACE, not a boundary. So above the safe size the client
  **downgrades adaptively**.
- A deadline on a multi-message write retries once at `SAFE_CHUNK_BYTES`,
  with a warning.
- That turns a lost coin-flip into a logged retry instead of a failed task.
- The deadline counts in either spelling: the client's own
  `DEADLINE_EXCEEDED`, or the `CANCELLED` a grpc-go server sends.
- A grpc-go server such as bazel-remote sends `CANCELLED` when the call's
  `grpc-timeout` runs out first.
- A `CANCELLED` before the deadline is the server's own, and is not
  retried.
- The full probe matrix is in
  `packages/vx/docs/design/plugin-executor-reapi-2026-08.md` §14.

</details>

## Repeat runs skip the worker

Every successful remote execution writes an execution record under the
task's vx key (`vx-reapi-exec-v2`). A later run whose key already has a
record skips the work entirely.

- The record lists the task's outputs by digest, plus its stdout and stderr.
- Each stream is inline up to 64 KiB, and a CAS blob past it.
- The record is written while the outputs come down.
- A later run whose vx cache missed, but whose key has a record, skips the
  Merkle build, the upload pass and `Execute`.
- The outputs are already in the CAS, and both streams replay from the
  record, as a vx hit replays them.
- `--force` bypasses the record, as does a policy that does not read the
  remote (`--cache-policy=remote:`).

This matters most under `--cache-download=none`. There, deferral leaves no
local cache entry behind, so vx's own probe misses on every later run. The
record is what makes the second run cheap.

<details><summary>Details</summary>

- A run core does not save (`--no-cache`, a read-only policy, a tainted
  upstream) records under a key only this run's executor knows.
- So does a run whose policy does not write the remote (a run off CI,
  `--cache-policy=remote:r`).
- Its dependants in this run graft from that record, and no later run
  replays it as the task's hit.
- A `v1` record kept no stderr and is never read. Its key executes once
  more and writes a `v2` one.
- A record with a non-zero exit code is no record either, and the task
  executes. vx writes none, but the action cache is the server's.
- A dependant whose upstream's outputs exist only as such a record is
  refused.
- Records are checked against the CAS first (`FindMissingBlobs`, the
  outputs and any stream blob).
- The action cache and the CAS evict independently. So a record that
  outlived its blobs falls through to a real execution.
- It never "succeeds" with nothing.
- The replay itself is a cache read too. A transport failure reading the
  record, a stream or any output warns and executes.
- Before executing, it removes whatever the half-done replay created.
- Core cleaned the outputs once, before the replay, and the real run's
  result must not inherit them.
- The probe sees a Tree by its own digest, not the blobs inside it. So one
  of those gone is caught by the replay.
- Under any capture shape that fails the replay, and the task executes.
- A fresh result under a whole-tree capture still only warns, since the
  capture holds more than the outputs.

</details>

**Inputs are held to the key.** The input tree is read after the key was
taken, so each file's bytes are held to the git blob id the key hashed for
it.

- A file edited, removed or replaced by a directory in between (an edit
  mid-run under `vx watch`) still runs.
- But its execution is not recorded under a key that no longer describes
  it.
- Recording it would replay the edited outputs on every machine after the
  file was restored.
- The input root holds exactly the files the key hashed.
- Core keys no package file. So a project's `package.json` is in the root
  only as a listed input (`@vzn/vx-lockfile` lists it on every cached task).
- A file over 1 MiB is hashed as it streams past, and held by path, not its
  bytes.
- So an action's inputs cost a buffer, not their size, while it waits on
  the upload.
- The upload reads such a file again, and refuses it if its bytes no longer
  carry the digest. The task fails, saying which file changed.
- So a rewrite mid-run is never stored under the old digest
  (`tests/big-inputs.test.ts`).

**An upstream's evicted blobs fail the task.** There is nothing to fall
through to, so vx fails the task and names the upstream. Re-run the
upstream (`--force`) to fill the store again.

<details><summary>Details</summary>

- A dependency's outputs may live only in the CAS: vx grafts them by
  reference because no local copy exists.
- If those blobs are gone, the action cannot be built with the inputs its
  key names.
- vx does not ship the action without them. A command that tolerates the
  absence exits 0.
- That successful-but-wrong result would be cached under a key asserting
  those bytes were present.
- Which upstream bytes a command reads is unknowable; that is what
  `dependsOn` declares. So the refusal is the only sound reading.
- It matches what core does when a deferred producer cannot be
  materialised.
- An upstream with no record at all, and its outputs nowhere on this
  machine, is refused the same way.
- That is an upstream whose outputs the local index lists but are gone, or
  a deferred result no record could hold.

</details>

**Outputs meet core's rule.** Once the outputs land, they meet core's rule
here, as a run here does (`missingOutputs`).

- A literal the execution never wrote fails the task (`outputsMissing`).
- So does no declared output at all.
- This holds on a record's replay too.

**A task's own outputs.** Once an executor returns, core's contract says the
declared outputs are on disk. So an output blob that cannot be fetched
fails the task.

<details><summary>Details</summary>

- The ordinary save path tars whatever it finds after the executor returns.
- So a missing output blob is a hole that would be cached under a key that
  stands for a complete build.
- Under a literal capture, the worker returns only what `output_paths`
  named. So every returned file is a declared output, and an unfetchable
  one fails the task.
- The exception is a glob whose FIRST segment is a wildcard (`*.js`). It
  has no REAPI spelling, so it is sent as `''`: whole working directory
  capture.
- Then inputs and undeclared siblings come back too. They cannot be told
  apart from real outputs, so a missing blob there only warns.
- Unless a declared glob names that blob: that is a hole in a declared
  output, and fails the task under either shape.
- Inline output bytes are checked against their digest like fetched ones.
  A mismatch is fetched.
- A capture cut at a wildcard holds more than the outputs.
- For example, `src/*.gen.js` is sent as `src`, and the worker returns the
  sources beside the generated files.
- Only what a declared glob names, or what sits under a directory it names,
  is written back. The rest stays as it is on disk.
- Writing all of it would put the worker's copy of the sources over yours,
  losing an edit made while the action ran.
- A directory a literal glob names is written whole.
- Where a write really lands, after the result's own links are placed, must
  be declared too.
- Otherwise a declared link to `.git/hooks` and a declared directory under
  it could write a hook.

</details>

## The existence probe confirms the artifact, not just the entry

`has()` is what `vx run --dry` uses to predict hit or miss. It reads the
ActionCache entry, and also checks that the artifact blob is still in the
CAS.

- The second call is needed, because servers disagree.
- Measured against both: bazel-remote checks an ActionResult's referenced
  blobs and hides a dangling entry, while NativeLink serves it.
- Without the check, a plan would report `cache hit (remote)` for a task
  that then executes for real.
- The check costs one extra round trip, and only for a PREDICTED HIT. A
  miss still answers in a single call.

## Downloads are verified

Every blob read is hashed again and length-checked against the digest it
was requested under. Bytes that do not match are refused with a named
integrity error.

- This covers ByteStream and batch reads alike, compressed or not, using
  the negotiated digest function.
- Refused bytes are never written into the local content-addressed store.
- So a corrupt or poisoned remote degrades to a miss (the cache invariant),
  never to wrong bytes under a trusted name.
- An execution whose outputs or logs do not come down as the server named
  them (other bytes, a wrong size, a blob the CAS lacks) is given back to
  vx, which runs it here and says so once:

`[vx] <task>: plugin '@vzn/vx-reapi' (executor 'vx/reapi') gave it back: its outputs or logs could not be fetched as the server named them: … — running it here`

- A task placed `exec.remote: 'only'` fails with that reason instead.
- Uploads are verified by the server; this is the mirror on the read side.

<details><summary>Details</summary>

- A streamed read (the cache artifact) is hashed as its bytes pass.
- On a mismatch it errors at its end with core's `CorruptArtifactError`.
- So the hit is a miss, and the rebuild's save replaces the entry and its
  blob.
- One corrupt entry costs one rebuild, not one on every run.
- The size is held as the bytes arrive. A body past its digest's size is
  refused at the byte that passes it.
- A zstd reply is decoded no further than that size.
- A batch entry for a digest not asked for is dropped.

</details>

**Paths are held to the workspace.** A verified blob still lands where the
server's ActionResult says, so its paths must stay in the workspace.

<details><summary>Details</summary>

These are refused before anything is written through them:

- an output path or Tree name that climbs out (`..`, absolute)
- a link whose target leaves the workspace, read as the OS follows it,
  through the links the result placed
- a directory that resolves out through a link
- a file or link that lands, through a link, where no declared glob names

More rules:

- A link standing at an output file is replaced, never written through.
- A Tree file's setuid and setgid bits are dropped.
- A Tree may name one subtree many times.
- A result whose Trees together expand to more paths than the file system
  has free inodes is refused before anything is written.
- So is a Tree holding a path past `PATH_MAX` (4096 bytes; 1024 on macOS).
- A glob's matches are recorded each as a Tree of its own. A subtree named
  under many names is encoded once.
- A capture past the free inodes or `PATH_MAX` is recorded whole, unsplit.

</details>

## Artifacts stream

How an artifact is sent depends on its size:

- Up to 256 KiB, it is read whole and sent in one batch, with no probe
  first.
- Up to the batch limit (about 4 MiB), it is read whole once, probed with
  `FindMissingBlobs`, and those bytes are sent.
- Past that, the cache layer never holds an artifact whole.
- There, `put` digests the file-backed `Blob` vx hands it in one pass over
  its stream, then asks `FindMissingBlobs`.
- It uploads from a second pass, read `chunkBytes` at a time as the
  ByteStream write drains.
- The upload is identity-encoded, since the artifact is zstd already.
- `get` returns the ByteStream read as a `Response`. Each message is taken
  from the call as vx writes the previous one to disk.

## Deadlines: a wedged server degrades, it does not hang

Every call carries a deadline. A server that is DOWN is no problem: that is
an instant `UNAVAILABLE`, which the cache layer degrades to a miss.

- The risk is a server that accepts TCP and never answers.
- Without a deadline, no error ever happens, and the first probe hangs the
  whole run.

There are TWO deadlines, and the split matters:

| option          | covers                                                                                | default                      |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------- |
| `metaTimeoutMs` | Capabilities, GetActionResult, UpdateActionResult, FindMissingBlobs, QueryWriteStatus | `min(callTimeoutMs, 15 000)` |
| `callTimeoutMs` | ByteStream transfers, Batch{Read,Update}Blobs, Split/SpliceBlob                       | `30 000`                     |

- A control-plane message is small and bounded: a healthy server answers in
  single-digit milliseconds.
- A bulk transfer is size-proportional and can be slow.
- Capturing a `node_modules` tree is what pushes real deployments to raise
  `callTimeoutMs` into the minutes.
- With one knob for both, headroom for that upload would also give every
  metadata probe the same minutes before it can degrade.
- Each deadline, `executeTimeoutMs` and `queueTimeoutMs` among them, must be
  a positive number of ms up to 2147483647.
- A longer timer fires at once, so anything else is refused at the
  `reapi()` call.

<details><summary>Details</summary>

- This is not hypothetical. A NativeLink instance has degraded into
  answering every ActionCache MISS in 3 ms and every HIT never.
- It had idle CPU and nothing in its logs, and a restart with identical
  on-disk data cleared it.
- With a single 180 s deadline, every task burned three minutes on a lookup
  before failing.
- With the split, the probe gives up in 15 s and the run executes again.

</details>

What the run prints is one line per kind of failure:

`[vx] plugin '@vzn/vx-reapi': probe <key> at <endpoint> failed: 4 DEADLINE_EXCEEDED: …`.

- Core's layered cache names the request, the vx key and the server, since
  a gRPC status carries none of them.
- A later request that fails with the same status is counted, not repeated.
- The run then ends with
  `[vx] plugin '@vzn/vx-reapi': N more requests failed the same way: …`.

**Execution streams.** Execution streams are deliberately NOT bounded by
either deadline: queueing behind a busy worker pool is legitimate.

- A wedged server still cannot reach Execute, because the deadline-bounded
  Capabilities call runs first.
- `queueTimeoutMs`, when set, bounds the wait for a worker.
- Unset, the task's own `exec.timeout` bounds the queue as it bounds the
  run, and the task fails as timed out.
- With neither, the wait is unbounded.

<details><summary>Details</summary>

- With no EXECUTING within `queueTimeoutMs`, the Execute stream is closed
  and the operation is cancelled with `Operations.CancelOperation`.
- The cancel is one attempt on `metaTimeoutMs`.
- A server that refuses it, or lacks the service, may still run the action,
  and its result lands in the action cache. That refusal is a warning.
- The task is then given back to vx, which runs it here and says so once:

`[vx] <task>: plugin '@vzn/vx-reapi' (executor 'vx/reapi') gave it back: no worker started the action within queueTimeoutMs (…ms); its operation was cancelled — running it here`

- A task placed `exec.remote: 'only'` fails with that reason instead.
- A stream that drops with a transient status, or ends cleanly before its
  operation is done, attaches again with `WaitExecution`.
- It does not run the action again.
- Only attaches that deliver no operation spend the budget: the fourth such
  in a row fails the task.
- A stream that delivered one (a proxy cutting a long, progressing action)
  starts the count over. So a long action survives any number of cuts.
- The wait before each new attach grows per cut in a row: 100, 400, 1600,
  then 5000 ms.
- It starts over once a stream advances the stage or stays open 10 s.
- If `WaitExecution` answers NOT_FOUND, the server lost the operation, as a
  restart does.
- Then nothing is left running to attach to, and the action is executed
  again on the same budget.
- Past the budget, the task fails and the operation is cancelled, so the
  action does not run on unwatched.
- An Execute answered FAILED_PRECONDITION means inputs the server lacks:
  evicted after `FindMissingBlobs`, or never stored.
- Then the plugin uploads them again and executes once more, without asking
  `FindMissingBlobs`.
- It uploads the blobs its `PreconditionFailure` names MISSING, else every
  input.
- A second FAILED_PRECONDITION fails the task.
- Once a worker reports EXECUTING, the task's `exec.timeout` bounds the
  wait. With none set, `executeTimeoutMs` does (10 minutes by default).
- The bound holds across a new attach. Firing during the backoff between a
  dropped stream and its `WaitExecution`, it ends the task there.
- It is also what ends a server that answers EXECUTING and hangs up on
  every attach.
- Past it, the operation is cancelled too (a refused cancel is a warning).
- The run stopping (Ctrl-C, an embedder's abort) or the task's
  `exec.timeout` closes the stream and cancels the operation with
  `CancelOperation`.
- An action not yet submitted is then not sent.
- A record replay, an upstream record read or the upload under way stops
  there too, and writes nothing after.
- What a replay already created is taken back, so a retry starts clean.
- The task then ends as a killed local one does (exit 143, `SIGTERM`).
- Past `exec.timeout`, it is `failed (timed out)`, with its key in
  `vx last`.

</details>

**Retries.** A ByteStream Read, like every unary call, retries UNAVAILABLE,
RESOURCE_EXHAUSTED and INTERNAL three times (100, 400 and 1600 ms) before
it counts as failed.

<details><summary>Details</summary>

- A streamed read (the artifact of a remote hit) spends the same budget
  across the whole blob.
- A cut after bytes have reached the reader opens the Read again at
  `read_offset` = what the reader has.
- The digest is checked over the joined bytes as before.
- INTERNAL is on the list because it is how the gRPC client reports a call
  cut in transit.
- That is the RST_STREAM(INTERNAL_ERROR) a proxy sends when the server
  behind it goes away, or a stream that ends with no gRPC status.
- The same three statuses attach a dropped execution stream again.
- A server that stays down pays that backoff once.
- After a call spends its retries on UNAVAILABLE, the cache path's calls
  (unary, Read, Write) give up at their first UNAVAILABLE.
- They do so until the server answers again. So a refused port costs a
  five-task run 2.6 s, not 24.
- A status the server answers with and no retry heals (PERMISSION_DENIED on
  Execute, a refused upload) fails the task.
- The failure is a line naming the task and the status, never a vx
  "internal error".

</details>

**Record reads.** A failed RECORD read is never a failed task. The record
lookup is a shortcut past the worker.

- A transport error there means "no usable record". The task executes
  normally, with a warning naming why.
- The UPSTREAM record reads are the deliberate exception: they decide
  whether a dependency's bytes exist at all.
- Carrying on past a failure there is how an action runs without its inputs
  and caches the result.
- A fresh execution's stdout or stderr that cannot be read, or whose blob
  the CAS no longer holds, fails the task naming the digest.
- No record is written then: those streams are the task's result, not a
  shortcut.

## Tests

`bun test` runs the unit suite anywhere. The round-trip suites need real
servers, which `vx run @vzn/vx-reapi#test` brings with Docker:

- `test.bun.live.cache` runs bazel-remote on `:19092`.
- `test.bun.live.exec` runs NativeLink on `:51051`.
- Both run in the foreground until the run ends.
- CI runs them in the Linux DTE run, where they start on the agent that
  runs `test.bun.live`.
- Without an endpoint those tests skip.
- `test.bun.live` sets `VX_REQUIRE_REAPI=1` and `VX_REQUIRE_REAPI_EXEC=1`.
  They turn an absent endpoint into a failure, so the suites cannot
  silently vanish.

## Protocol coverage

All **14 RPCs** across the five services, not a working subset:

| Service                     | RPCs                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `Execution`                 | `Execute`, `WaitExecution`                                                                     |
| `ActionCache`               | `GetActionResult`, `UpdateActionResult`                                                        |
| `ContentAddressableStorage` | `FindMissingBlobs`, `BatchUpdateBlobs`, `BatchReadBlobs`, `GetTree`, `SplitBlob`, `SpliceBlob` |
| `Capabilities`              | `GetCapabilities`                                                                              |
| `ByteStream`                | `Read`, `Write`, `QueryWriteStatus`                                                            |

Protocol features in use, not only reachable:

- **Digest negotiation**: SHA256 by default, the universal baseline. The
  plugin offers no other.
- The Merkle encoders must hash with the SAME function as every upload, so
  upgrading on its own would mix functions inside one action.
- **zstd compression**: `compressed-blobs/zstd/…` resource names on
  ByteStream, and `compressor: ZSTD` on batch updates.
- zstd is on only when `supported_compressors` says so.
- **`RequestMetadata`** in the well-known binary header: tool name and
  version, action id, correlated invocations id.
- That is how a server groups an action's dozens of CAS and AC calls into
  one build in its UI.
- **Inline stdout/stderr** on `ExecuteRequest`, sparing two CAS round trips
  per finished action.
- A failed execution status that carries a partial result (a worker past
  its timeout) still prints what the command wrote.
- **Execution stages**: `QUEUED` / `EXECUTING` / `COMPLETED` decoded from
  `ExecuteOperationMetadata`. So you can tell a queued action from a hung
  one.
- **`Action.platform`** (v2.2) alongside `Command.platform` for older
  servers.
- **`NodeProperties`**: `unix_mode` and `mtime` on tree nodes.
- A mode (and `is_executable`) lands as its permission bits minus the
  process umask.
- **Output directories** via the `Tree` blob an
  `OutputDirectory.tree_digest` addresses.
- **Output symlinks**, including a v2.0 server's `output_file_symlinks` /
  `output_directory_symlinks` when it sends only those.
- A tree's small files are fetched together across its directories
  (`BatchReadBlobs`, 64 MiB at a time), not one call per directory.
- The result's own output files are fetched 64 MiB at a time too.
- **Upload minimality**: `FindMissingBlobs` first, split so no request
  passes a 4 MiB message.
- Then batched blobs while they fit the server's budget, and ByteStream
  beyond it.

## Remote execution

Remote execution is off by default. It changes where your build runs, which
a plugin should not switch on merely by being configured for caching:

```ts
reapi({
  endpoint: 'grpcs://grpc.example.com:443',
  execute: true,
  platform: { 'container-image': 'docker://alpine:3.20', OSFamily: 'Linux' },
  capacity: 64, // concurrent remote tasks; becomes the scheduler's pool
})
```

- A cache-only server (bazel-remote advertises `exec_enabled: false`) makes
  the plugin **decline the executor with a warning**.
- It does not submit work that will never be answered.
- Only cacheable tasks are eligible. A task with no `cache: true` has no
  described inputs, so a worker would run it against an empty input root.
- A cacheable task's root holds its declared input files and its
  upstreams' declared outputs.
- An upstream with no `cache` runs on this machine and leaves no record, so
  its outputs ship from this disk.
- A file it writes outside its declared `outputs` never reaches the worker.

<details><summary>Details</summary>

- This is verified end-to-end against a live NativeLink scheduler and
  worker.
- The input tree uploaded, QUEUED → EXECUTING → COMPLETED streamed, stdout
  came back inline, and the worker was attributed.
- Declared outputs were materialised byte-correct.
- Every hand-rolled encoder AND decoder is pinned byte-for-byte against
  protobufjs over the same vendored protos.
- The decoder tests exist because a wrong field number parses garbage
  without ever erroring (`tests/encoding.test.ts`).
- NativeLink's official image is distroless, so a worker inside it has no
  `/bin/sh` and cannot run any vx task.
- `tests/helpers/nativelink.md` has the three-command busybox rehost.

</details>

## node_modules: install as an action

REAPI workers are stateless, and vx treats `node_modules` as ambient
environment rather than a cache input. So a remote task cannot see the
packages a build needs.

The answer is the design doc's §7.4 recipe, `exec.remote: 'only'`:

```ts
install: {
  exec: { command: 'bun install --frozen-lockfile', remote: 'only' },
  inputs: { files: ['package.json', 'bun.lock'] },
  outputs: { files: ['node_modules/**'] },
  cache: true,
},
build: {
  dependsOn: ['install'],
  exec: { command: 'vite build' },
  inputs: { files: ['src/**', 'vite.config.*'] }, outputs: { files: ['dist/**'] }, cache: true,
},
```

What happens, all verified live against a NativeLink scheduler and worker
(`tests/vx-run-e2e.test.ts`):

- `install` executes **on a worker**, so platform binaries build for the
  worker's platform, not the laptop's.
- It runs once per lockfile change, ever: repeats are met from an execution
  record the plugin keeps under the task's vx cache key.
- Its outputs **never land on the submitter's disk**: not materialised, not
  restored.
- The local `node_modules` a developer installed is never cleaned.
- A dependent task's input tree grafts the install outputs **by
  reference**: per-file digests from the execution record.
- Whole directories go as re-canonicalised REAPI `Tree`s. So the bytes flow
  worker → CAS → worker, and never pass through the submitter.
- With **no remote executor declared**, `install` is a local no-op.
  Dependents use whatever the machine has ambient.
- So a laptop run behaves exactly as it did before the field existed.

<details><summary>Details</summary>

- The graft applies ONLY to outputs that exist nowhere locally.
- When an upstream's outputs are materialised on this machine, **local disk
  is truth**.
- Two machines racing a nondeterministic miss can leave the artifact store
  and the execution record holding different executions' results.
- Both sit under one pure-input key. A worker fed the record would see
  bytes this machine's own tasks do not.
- An upstream that writes inside `install`'s directory (a `prisma generate`
  into `node_modules/.prisma`) is merged into it: the worker sees both.
- A DECLARED input file under a grafted directory is replaced by the graft,
  with a warning.
- The execution record lives under `sha256("vx-reapi-exec-v2\0" + key)`.
- That is a second AC namespace beside the artifact mapping. It lists
  outputs file by file, with workspace-relative paths.

</details>

## What the worker's environment contains

An action's `Command` carries exactly two of vx's three environment lists.
They are sorted by name, as the proto requires, so equivalent Commands hash
alike.

- **`exec.env.define`**: literal `name: value` pairs from the task config.
- They read the same on every machine, so they are safe in the action
  identity. They are already in the vx cache key.
- **`inputs.env`**: the values this machine resolved for those names.
- They are sent for each name the task's local child would get too (it is
  also in `exec.env.passThrough`).
- They are in the vx cache key by definition, so a change to one already
  produces a different action.
- A name unset here, or one the config only tracks, is left out of the
  `Command`. So the worker sees what a local run would.
- Shipping a tracked-only value would run the worker on something a local
  run never saw, under the same key.
- A `define` wins over an `inputs.env` entry of the same name: it is the
  more explicit statement of intent.

Colour is the one exception. The action gets the `FORCE_COLOR` and
`NO_COLOR` the local child sees, so a remote entry holds the same bytes a
local one does.

- That is this machine's values, or vx's own `FORCE_COLOR=1`.
- vx sets `FORCE_COLOR=1` unless the task sees a `FORCE_COLOR` or a
  non-empty `NO_COLOR`.

Nothing else crosses. **`exec.env.passThrough` does not reach a remote
worker**, and neither does the essential allowlist (`PATH`, `HOME`,
`TMPDIR`, …).

Those are the submitting machine's resolved environment, and the worker
has its own. Two reasons, and both matter:

- Host values in the `Command` would enter the action digest. So a laptop
  and a CI runner would never share a remote entry.
- That is the same reason the vx key excludes them.
- A `Command` blob lives in the CAS, and `passThrough` is where secrets go.
- A token written to a shared content-addressed store is readable by anyone
  who can name its digest.

So a task that needs a value on a worker must do one of two things:

- `define` it (a config literal)
- list it in both `inputs.env` and `exec.env.passThrough` (a host value,
  keyed, and seen by a local run the same way)

Keep a task whose command reads a `passThrough` secret local, with
`exec: { remote: false }`.
