// Per-run context capture for the Tier-3 `invocations` header row:
// git (commit / branch / dirty), CI provider, and host/os/arch. All
// probes are best-effort — a missing git binary, a non-repo cwd, or an
// unset env degrades each field to null and NEVER throws. Telemetry must
// not be able to fail a build.
//
// Cost: ONE git spawn (`captureGitContext`) on every run, plus two more
// (`captureWorkspaceIdentity`, `captureDefaultBranch`) only when a plugin
// declares the `telemetry` capability — nobody else needs those fields.

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

/**
 * The repository's DEFAULT (trunk) branch — the axis that separates a
 * mainline run from a PR / feature-branch experiment. A run whose `branch`
 * equals this is a trunk run; everything else is branch work whose timings
 * must NOT pollute the shared scheduling baseline (owner 2026-07-14: "I can
 * be experimenting on a branch increasing task time for all later on… don't
 * count their times into main"). Resolution ladder, most-reliable first:
 *   1. GitLab: `CI_DEFAULT_BRANCH` (the project's configured default).
 *   2. GitHub Actions: the event payload's `repository.default_branch`
 *      (present on push AND pull_request events) — one best-effort JSON read.
 *   3. Local / other: `git symbolic-ref --short refs/remotes/origin/HEAD`,
 *      stripping the `origin/` prefix.
 * Returns null when none resolve (a detached checkout with no remote HEAD, a
 * non-repo cwd) — the consumer then counts ALL runs, so an undetectable
 * default never regresses today's behavior. Never throws.
 */
export function captureDefaultBranch(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  workspaceRoot: string,
): string | null {
  const gitlab = env['CI_DEFAULT_BRANCH']
  if (typeof gitlab === 'string' && gitlab.trim().length > 0) return gitlab.trim()

  const eventPath = env['GITHUB_EVENT_PATH']
  if (typeof eventPath === 'string' && eventPath.length > 0) {
    try {
      // Only a regular file. A character device (`/dev/zero`) never reaches
      // EOF, so readFileSync would spin forever — "never throws" is not the
      // same as "never hangs", and a run must not wedge on a stray env var.
      if (!fs.statSync(eventPath).isFile()) throw new Error('not a regular file')
      const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
        repository?: { default_branch?: unknown }
      }
      const dflt = payload.repository?.default_branch
      if (typeof dflt === 'string' && dflt.trim().length > 0) return dflt.trim()
    } catch {
      // unreadable / malformed payload — fall through to git.
    }
  }

  try {
    const proc = Bun.spawnSync({
      cmd: ['git', '-C', workspaceRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const ref = new TextDecoder().decode(proc.stdout).trim()
      // `refs/remotes/origin/HEAD` → `origin/main`; strip the remote prefix.
      const slash = ref.indexOf('/')
      const name = slash >= 0 ? ref.slice(slash + 1) : ref
      if (name.length > 0) return name
    }
  } catch {
    // git unavailable / no remote HEAD ref: null.
  }
  return null
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
 * The untrusted per-PR cache partition — a stable identity for THIS pull
 * request, so one fork PR's untrusted cache writes are isolated from another's
 * (no cross-PR pollution or leakage). `VX_CACHE_SCOPE` overrides; otherwise
 * derived from the CI PR context (GitHub PR number, GitLab MR iid, else the
 * head branch). Returns undefined outside a PR (the serve then falls back to a
 * shared untrusted scope). Never throws — sanitized to one safe path segment.
 */
export function resolveCacheScope(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128)
  const override = env['VX_CACHE_SCOPE']
  if (isTruthy(override)) return safe(override as string)
  // GitHub: a pull_request run has GITHUB_REF = refs/pull/<n>/merge.
  const ref = env['GITHUB_REF']
  const m = typeof ref === 'string' ? /^refs\/pull\/(\d+)\//.exec(ref) : null
  if (m) return `pr-${m[1]}`
  const headRef = env['GITHUB_HEAD_REF']
  if (isTruthy(headRef)) return `gh-${safe(headRef as string)}`
  // GitLab merge request.
  const iid = env['CI_MERGE_REQUEST_IID']
  if (isTruthy(iid)) return `mr-${safe(iid as string)}`
  return undefined
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
  const hadProtocol = /^[a-z+]+:\/\//.test(s)
  s = s.replace(/^[a-z+]+:\/\//, '') // protocol
  s = s.replace(/^[^@/]+@/, '') // user[:pass]@
  // A `:port` only appears in a protocol-form URL (`ssh://host:2222/path`); the
  // scp shorthand `host:path` has no port. STRIP it (the old code reinserted it
  // as a path segment, so `ssh://host:2222/o/r` and `https://host/o/r` — the
  // SAME repo — derived different workspace ids). Gated on `hadProtocol` so a
  // scp path whose first segment is numeric isn't mistaken for a port.
  if (hadProtocol) s = s.replace(/:\d+(\/|$)/, '$1')
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
