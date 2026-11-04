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

/**
 * Whether a `VX_REQUIRE_*` gate is armed: set, and not empty, `0` or
 * `false` (any case). The one rule every gate reads, so a gate cannot
 * disagree with the others about what "set" means.
 */
export function envFlag(name: string): boolean {
  const v = process.env[name]
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * The variables that mark a CI, each of which turns vx's colour on
 * (ui/theme.ts): a test of the colour decision off CI drops them all, as
 * the runner it runs on sets `CI` itself.
 */
export function dropCi(env: Record<string, string | undefined>): void {
  for (const name of [
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TF_BUILD',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
  ])
    delete env[name]
}
