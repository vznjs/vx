// The environment every harness hands the runners it times: the caller's,
// minus what changes the runtime under test. A shell that exports
// `BUN_OPTIONS=--smol` (this container's did, 2026-09-27) shrank vx's heap
// in every timed run: 1,000 packages warm, median 351 ms against 334 with
// it unset, A/A 336 (15 interleaved rounds).
// `VX_CACHE_DIR` keeps vx's whole cache in the workspace's `.vx/cache`, which
// every harness wipes for a cold run; the default shares entries through the
// user's store, where a wiped workspace still hits.
// Git runs on its defaults: this container's ~/.gitconfig sets
// `core.checkstat=minimal` and `core.trustctime=false`, under which vx
// rightly trusts no index OID and hashes every input from disk; that alone
// made the 8,002-task nothing-changed run 4.0 s against 2.0 s (2026-10-10).
export function benchEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VX_CACHE_DIR: '.vx/cache',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  }
  delete env['BUN_OPTIONS']
  return env
}
