// Put `process.env` back to `saved` IN PLACE. Assigning a fresh object
// (`process.env = { ...saved }`) detaches it from the process environment:
// every later write in that test process lands on a plain object that
// `os.tmpdir()` and child spawns never read, so a later file's TMPDIR row
// saw the old directory (timeout-bounds.test.ts before user-error-classify
// in one shard, 2026-09-25).
export function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
