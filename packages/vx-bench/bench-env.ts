// The environment every harness hands the runners it times: the caller's,
// minus what changes the runtime under test. A shell that exports
// `BUN_OPTIONS=--smol` (this container's did, 2026-09-27) shrank vx's heap
// in every timed run: 1,000 packages warm, median 351 ms against 334 with
// it unset, A/A 336 (15 interleaved rounds).
// `VX_CACHE_DIR` keeps vx's whole cache in the workspace's `.vx/cache`, which
// every harness wipes for a cold run; the default shares entries through the
// user's store, where a wiped workspace still hits.
export function benchEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VX_CACHE_DIR: '.vx/cache',
    ...extra,
  }
  delete env['BUN_OPTIONS']
  return env
}
