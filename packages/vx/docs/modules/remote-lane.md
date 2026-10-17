# `src/cache/remote-lane.ts` — one declared remote, as `LayeredCache` reaches it

## Purpose

Everything about one remote that does not depend on the others: what the
run lets it do, the boundary its answers cross, its upload pool and its
warnings. `LayeredCache` builds one lane per declared remote and owns the
order, the local store and provenance.

## Public surface

```ts
export interface ResolvedRemote {
  readonly remote: RemoteCacheLayer
  readonly plugin?: string // the plugin that supplied it: its keychain is what `open` reads
  read: boolean // the run's remote read; cleared when `open` throws
  write: boolean // the same for writes
  readonly onError?: (err: Error) => void // default: stderr
}

export type RemoteOp = 'probe' | 'download' | 'upload'

export class RemoteLane {
  constructor(resolved: ResolvedRemote, traffic: RemoteTraffic, remote?: RemoteCacheLayer) // remote: a BranchScope's view
  get read(): boolean // `resolved.read`, read live
  get write(): boolean
  has(hash: string): Promise<boolean> // a failure is false
  hasMany(hashes: readonly string[]): Promise<Set<string> | null> // records the rest absent
  get(hash: string): Promise<{ body: Blob | Response; durationMs?: number } | null>
  upload(hash, durationMs, body: () => { body: Blob; release? }, tally): void
  drain(): Promise<void>
  stop(): void // no upload starts; drain and reads stop waiting
  get whenStopped(): Promise<void> // settles at stop()
  close(): void // says the held-back repeats
  report(op: RemoteOp, subject: string | { batch: string }, err: unknown): void
}
```

## Rules

- **Never throws.** A throw, a malformed answer (a `body` that is not a
  `Blob` or `Response`, a `hasMany` that is not a `Set` or `null`) is a
  miss, reported once per failure class (see layered-cache.md, "What a
  failure says").
- **Absences are its own.** A batch probe records the hashes this remote
  lacks; a later `get` of one skips the round-trip. A sibling's answer
  never marks this remote.
- **Uploads**: at most 4 at once per remote, FIFO; `body()` is asked
  when the job starts, so a queued job holds no bytes; each landed or
  failed upload is tallied on the local cache's `uploads`.
- `ResolvedRemote` is also what a plugin's `ctx.cache` and the run store
  walk (`plugin-cache.md`), so all three gate a remote the same way.

## Tests

`tests/layered-cache.test.ts` (one remote: shapes, warnings, uploads)
and `tests/resolve-cache.test.ts` (declared order, several remotes over
one local store).
