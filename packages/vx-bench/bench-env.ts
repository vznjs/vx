// The environment every harness hands the runners it times: the caller's,
// minus what changes the runtime under test. A shell that exports
// `BUN_OPTIONS=--smol` (this container's did, 2026-09-27) shrank vx's heap
// in every timed run: 1,000 packages warm, median 351 ms against 334 with
// it unset, A/A 336 (15 interleaved rounds).
export function benchEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  delete env['BUN_OPTIONS']
  return env
}
