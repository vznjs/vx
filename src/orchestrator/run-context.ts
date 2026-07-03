// Per-run context capture for the Tier-3 `invocations` header row:
// git (commit / branch / dirty), CI provider, and host/os/arch. All
// probes are best-effort — a missing git binary, a non-repo cwd, or an
// unset env degrades each field to null and NEVER throws. Telemetry must
// not be able to fail a build.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ulid, xxh3hex } from '../util/index.js'

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

/**
 * Best-effort: is this run a FORK pull-request CI job (an untrusted external
 * contributor)? Used to pick the untrusted cache tier so a fork PR can't
 * poison the trusted cache. Never throws; an internal same-repo PR is NOT a
 * fork (trusted collaborator, keep the full cache).
 *
 * - GitHub: event is `pull_request` / `pull_request_target` AND the head repo
 *   differs from the base repo. `pull_request.head.repo.fork` in the event
 *   JSON is authoritative; a full_name mismatch is the fallback.
 * - GitLab: the MR source project differs from the target project.
 */
export function detectForkPr(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  // GitLab: source ≠ target project ⇒ fork MR.
  const glSrc = env['CI_MERGE_REQUEST_SOURCE_PROJECT_ID']
  const glTgt = env['CI_MERGE_REQUEST_PROJECT_ID']
  if (isTruthy(glSrc) && isTruthy(glTgt) && glSrc !== glTgt) return true

  // GitHub: only a pull_request event can be a fork PR.
  const ghEvent = env['GITHUB_EVENT_NAME']
  if (ghEvent === 'pull_request' || ghEvent === 'pull_request_target') {
    const eventPath = env['GITHUB_EVENT_PATH']
    if (isTruthy(eventPath)) {
      try {
        const payload = JSON.parse(fs.readFileSync(eventPath as string, 'utf8')) as {
          pull_request?: { head?: { repo?: { fork?: boolean; full_name?: string } } }
        }
        const head = payload.pull_request?.head?.repo
        if (head?.fork === true) return true
        const repo = env['GITHUB_REPOSITORY']
        if (typeof head?.full_name === 'string' && isTruthy(repo) && head.full_name !== repo) {
          return true
        }
      } catch {
        // unreadable/malformed payload — fall through to not-a-fork
      }
    }
  }
  return false
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

export interface WorkspaceIdentity {
  /** Stable 16-hex id — same for every checkout of the same repo. */
  id: string
  /** Human name for switchers/badges: the repo (or root dir) basename. */
  name: string
}

/**
 * Normalize a git remote URL so every checkout of the same repository
 * derives the SAME workspace id: `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r`, and `https://github.com/o/r.git` all
 * reduce to `github.com/o/r`.
 */
export function normalizeRemoteUrl(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z+]+:\/\//, '') // protocol
  s = s.replace(/^[^@/]+@/, '') // user[:pass]@
  s = s.replace(/:(\d+\/)/, '/$1') // :port/ → /
  s = s.replace(/:/, '/') // scp-style host:path
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  return s
}

/**
 * Stable workspace identity for the multi-workspace server story
 * (telemetry schema v2). Derivation ladder:
 *   1. git remote origin URL, normalized → xxh3 (same id from any
 *      machine's checkout of the same repo);
 *   2. no remote → a salt persisted at `<root>/.vx/workspace-id` (the
 *      checkout keeps a stable identity across runs; `.vx/` is already
 *      gitignored infrastructure);
 *   3. unwritable `.vx/` → the root path itself (stable per machine).
 * One `git` spawn behind try/catch; call sites gate on telemetry being
 * active so a plain run never pays it. Never throws.
 */
export function captureWorkspaceIdentity(workspaceRoot: string): WorkspaceIdentity {
  const base = workspaceRoot.replace(/\/+$/, '').split('/').pop() || 'workspace'
  try {
    const proc = Bun.spawnSync({
      // `config --get`, NOT `remote get-url`: get-url applies insteadOf
      // rewrites, so two developers mirroring the same repo through
      // different proxies would derive different workspace ids. The raw
      // configured URL is the identity.
      cmd: ['git', '-C', workspaceRoot, 'config', '--get', 'remote.origin.url'],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const url = new TextDecoder().decode(proc.stdout).trim()
      if (url.length > 0) {
        const normalized = normalizeRemoteUrl(url)
        const name = normalized.split('/').pop() || base
        return { id: xxh3hex(normalized), name }
      }
    }
  } catch {
    // git unavailable — fall through to the salt.
  }
  try {
    const saltPath = path.join(workspaceRoot, '.vx', 'workspace-id')
    let salt: string
    try {
      salt = fs.readFileSync(saltPath, 'utf8').trim()
      if (salt.length === 0) throw new Error('empty')
    } catch {
      salt = ulid()
      fs.mkdirSync(path.dirname(saltPath), { recursive: true })
      fs.writeFileSync(saltPath, salt + '\n')
    }
    return { id: xxh3hex(salt), name: base }
  } catch {
    return { id: xxh3hex(workspaceRoot), name: base }
  }
}
