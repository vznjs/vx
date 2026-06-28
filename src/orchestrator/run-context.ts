// Per-run context capture for the Tier-3 `invocations` header row:
// git (commit / branch / dirty), CI provider, and host/os/arch. All
// probes are best-effort — a missing git binary, a non-repo cwd, or an
// unset env degrades each field to null and NEVER throws. Telemetry must
// not be able to fail a build.

import os from 'node:os'

export interface GitContext {
  /** `git rev-parse HEAD`, or null outside a repo / on failure. */
  commitSha: string | null
  /** `git rev-parse --abbrev-ref HEAD`, or null. */
  branch: string | null
  /** True if `git status --porcelain` was non-empty; null on failure. */
  dirty: boolean | null
}

export interface CiContext {
  ci: boolean
  /** Which CI matched: 'github' | 'gitlab' | 'buildkite' | 'circleci'
   *  | 'generic' (bare `CI`), or null when no CI env is present. */
  provider: string | null
}

export interface HostContext {
  host: string | null
  os: string
  arch: string
}

/**
 * One short `git` spawn per run (not per task), behind try/catch.
 * `git rev-parse HEAD --abbrev-ref HEAD` returns the commit on line 1
 * and the branch on line 2 in a SINGLE invocation — half the spawns of
 * two separate `rev-parse` calls. `dirty` is NOT probed here: the run's
 * `GitFilesCache` populate already ran `git status --porcelain` for
 * input enumeration, so the orchestrator passes that aggregate in
 * (`dirty`) rather than paying for a second status spawn. Pass
 * `dirty: null` when unavailable. Each field degrades to null
 * independently — telemetry never fails a run.
 */
export function captureGitContext(workspaceRoot: string, dirty: boolean | null = null): GitContext {
  let commitSha: string | null = null
  let branch: string | null = null
  try {
    const proc = Bun.spawnSync({
      cmd: ['git', '-C', workspaceRoot, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const lines = new TextDecoder().decode(proc.stdout).trim().split('\n')
      const sha = lines[0]?.trim()
      const br = lines[1]?.trim()
      if (sha) commitSha = sha
      if (br) branch = br
    }
  } catch {
    // git unavailable / non-repo: both fields stay null.
  }
  return { commitSha, branch, dirty }
}

// Recognized CI env vars in match-priority order. The first whose value
// is truthy (present and not '0'/'false') decides the provider; a bare
// `CI` is the generic fallback.
const CI_PROVIDERS: ReadonlyArray<[envVar: string, provider: string]> = [
  ['GITHUB_ACTIONS', 'github'],
  ['GITLAB_CI', 'gitlab'],
  ['BUILDKITE', 'buildkite'],
  ['CIRCLECI', 'circleci'],
  ['CI', 'generic'],
]

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * Detect a CI environment + which provider. `ci=true` if any recognized
 * var is truthy; `provider` names the most-specific match (a specific
 * provider beats the generic `CI`).
 */
export function detectCi(env: NodeJS.ProcessEnv | Record<string, string | undefined>): CiContext {
  for (const [varName, provider] of CI_PROVIDERS) {
    if (isTruthy(env[varName])) return { ci: true, provider }
  }
  return { ci: false, provider: null }
}

/** Host name (null on failure) + platform + arch. */
export function captureHostContext(): HostContext {
  let host: string | null = null
  try {
    const h = os.hostname()
    host = h.length > 0 ? h : null
  } catch {
    host = null
  }
  return { host, os: process.platform, arch: process.arch }
}
