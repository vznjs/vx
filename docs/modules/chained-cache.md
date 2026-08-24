# `src/cache/chained-cache.ts` — several declared cache layers, in order

## Purpose

When more than one plugin contributes a `cache` layer, `resolveCache`
(`plugin-host.ts`) chains them in declaration order instead of picking one.

## Rules

- **Lookup walks the layers** (`get` / `has` / `prefetch`) until one
  answers; the answering layer is remembered per hash.
- **Save reaches every layer**, in order — but a layer whose `local` handle
  an EARLIER layer already saved to gets `skipLocalWrite`: the shared
  artifact is packed and written once, and the later layer does only its
  remote upload (two remote plugins over one local handle would otherwise
  pack every miss twice).
- **Restore goes to the layer that answered** (`restoreOutputs`,
  `outputsPath`) — an entry's artifact lives wherever it was found.
- **The first layer owns the run index** (`recordRun*`, `stats`, `prune`,
  `ingest`, `hashFile`, `isOutputsCurrent`), so a run is recorded once.
- `hasRemote` is true when any layer has a remote. `remoteHasMany` marks
  each ANSWERING layer's own complement absent (its own truth) and returns
  the union only when every remote layer answered — a partial union is
  `null`, because the caller treats a non-null answer as authoritative for
  the whole chain and would poison a layer that cannot batch with a
  sibling's negatives (its later lazy `get` would then skip a real remote
  hit). `markRemoteAbsent` / `drainUploads` / `close` reach every layer.

## The subsume rule

A layer exposes `local` when it wraps the host's local handle
(`LayeredCache.local`). `resolveCache` drops a bare local layer that another
declared layer already wraps, so `[remote(), localCachePlugin()]` resolves to
the remote plugin's layered cache alone instead of writing the local store
twice — with no edit to the remote plugin.

## Tests

`tests/chained-cache.test.ts`; `two declared cache plugins: a run saves into
BOTH stores` in `tests/plugin-capabilities.test.ts`.
