# `layered-cache.ts` — local + remote cache composition

## Purpose

Wraps the v10 local `Cache` with a `RemoteCache` and exposes the same
public surface as `Cache`. The orchestrator doesn't know which layer
it's talking to.

- **Read-through**: try local; on miss, fetch from remote, materialize
  into local, return.
- **Write-through with async upload**: write to local synchronously,
  then pack + PUT to remote in the background. Remote errors are
  logged, not thrown — the task already succeeded; failed uploads
  shouldn't fail the user's run.

## Public surface

```ts
export class LayeredCache implements CacheLayer {
  constructor(local: CacheLayer, remote: RemoteCache, options?: LayeredCacheOptions)
  // CacheLayer methods — see docs/modules/cache.md.
}

export interface LayeredCacheOptions {
  onRemoteError?: (err: Error) => void
  onRemoteHit?: (hash: string, bytes: number) => void
}
```

`LayeredCache` accepts a `CacheLayer` (not a concrete `Cache`) as the
local layer, so future layerings (local → regional → global) can stack
without churn.

## Read path

1. `local.get(hash)` — return immediately on hit.
2. `remote.get(hash)` — `null` on miss; suppress errors and return `null`.
3. On remote hit:
   - `unpackArchive(body, stage)` into a temp dir.
   - Read `meta.json` from the stage.
   - List `outputs/` files; call `local.save()` with the stage as
     `projectDir`. This populates the local cache for next time.
   - Return the now-local entry (via `local.get(hash)`).

## Write path

1. `local.save(args)` — synchronous, succeeds before we touch network.
2. Stage `meta.json` + `outputs/<rel paths>` into a temp dir.
3. `packAndDiscard(stage)` → tar.gz bytes.
4. `remote.put(hash, bytes, { durationMs })`.

Any failure in steps 2-4 is caught and routed through
`onRemoteError` (defaults to `process.stderr.write`). The task is
considered fully saved as soon as step 1 returns.

## Delegation

`key / recordRun / stats / prune / restoreOutputs / close` are pure
delegations to the local `Cache`. The remote layer doesn't participate
in cache identity, run history, or eviction — those are workspace-
local concerns.

## What this does NOT do

- No HMAC validation (we send `x-artifact-tag` on PUT if configured;
  we don't verify the one we receive).
- No pre-signed URLs (v2 of the remote-cache design).
- No write-batching or retry on transient errors. v1 fire-and-forget.
- No event posting (`POST /v8/artifacts/events`).

## Tests

`src/layered-cache.test.ts` spins a real in-process `Bun.serve()`
server and asserts:

- `save()` writes local + uploads to remote
- `save()` doesn't fail when the remote rejects
- `get()` returns local without touching remote when local hits
- `get()` falls back to remote, materializes into local, then future
  reads are local hits
- `get()` returns `null` when both miss
- `get()` suppresses remote errors
- `key()` matches `local.key()`
- `stats / recordRun / prune` delegate to local

## Replacing this module

Most likely replacement: **a layered cache with a different topology**
(e.g., local → regional → global). Keep the public methods stable and
the orchestrator doesn't change. Or add metadata-only HEAD-style
prefetching before bulk GET — would need extending `RemoteCache.has`
into the read path here.

To remove the remote layer entirely, the orchestrator's
`wrapWithRemoteCache` returns the local `Cache` unchanged when env
vars aren't set.
