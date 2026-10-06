// Per-run context capture for the Tier-3 `invocations` header row:
// git (commit / branch / dirty), CI provider, and host/os/arch. All
// probes are best-effort — a missing git binary, a non-repo cwd, or an
// unset env degrades each field to null and NEVER throws. Telemetry must
// not be able to fail a build.
//
// Cost: HEAD read from `.git` on every run (`captureGitContext`), plus
// `refs/remotes/origin/HEAD` and the enumeration's `remote.origin.url`
// only when a plugin declares the `telemetry` capability — nobody else
// needs those fields. Each falls back to a `git` spawn where the files or
// the enumeration cannot answer.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executablePath, ulid, xxh3hex } from '../util/index.js'

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
export function captureGitContext(
  workspaceRoot: string,
  dirty: boolean | null = null,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): GitContext {
  let commitSha: string | null = null
  let branch: string | null = null
  // Read `.git` directly first: HEAD plus one ref file (or packed-refs) is
  // ~0.1 ms, where the spawn below is ~8 ms — on EVERY run, including a
  // 60 ms warm one. The spawn stays as the fallback for whatever the reader
  // does not understand (a ref format this code has not seen, a gitdir it
  // cannot resolve), so an unusual repo is slower, never wrong.
  const direct = readHeadDirect(workspaceRoot)
  if (direct !== null) {
    branch = direct.branch ?? ciBranch(env)
    return { commitSha: direct.commitSha, branch, dirty }
  }
  try {
    const proc = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        '-C',
        workspaceRoot,
        'rev-parse',
        'HEAD',
        '--abbrev-ref',
        'HEAD',
      ],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const lines = new TextDecoder().decode(proc.stdout).trim().split('\n')
      const sha = lines[0]?.trim()
      const br = lines[1]?.trim()
      if (sha) commitSha = sha
      // `--abbrev-ref HEAD` answers the literal string `HEAD` when nothing is
      // checked out. Recording that verbatim INVENTS a branch: every detached
      // run shares a pseudo-branch "HEAD", which is how `actions/checkout`
      // leaves a pull_request build. The trust boundary (`branch ===
      // defaultBranch`) means it is at least never mistaken for trunk, but
      // every PR collapses into one scope — so one PR's timings feed another's
      // baseline, cross-branch regression detection counts them as a single
      // branch, and a consumer grouping runs by branch reads "HEAD".
      if (br && br !== 'HEAD') branch = br
    }
  } catch {
    // git unavailable / non-repo: both fields stay null.
  }
  // A detached CI checkout still knows the branch it came from; the provider
  // says so even though git cannot. Same most-reliable-first ladder as
  // `captureDefaultBranch`, and consulted only when git had no answer — an
  // attached branch is ground truth for what this working tree IS, so a stale
  // exported variable must never relabel it.
  branch ??= ciBranch(env)
  return { commitSha, branch, dirty }
}

/**
 * `HEAD`'s commit and branch from the `.git` files, or null when anything
 * about the layout is unfamiliar (the caller then spawns git). Handles a
 * `.git` directory, a `.git` FILE (`gitdir: …` — a linked worktree, whose
 * refs live under `commondir`), a symbolic HEAD, a detached HEAD, loose refs
 * and `packed-refs`. A reftable repository is always null.
 */
function readHeadDirect(
  workspaceRoot: string,
): { commitSha: string; branch: string | null } | null {
  try {
    const dirs = refDirsOf(workspaceRoot)
    if (dirs === null) return null
    const { gitDir, commonDir } = dirs
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const SHA = /^[0-9a-f]{40,64}$/
    if (SHA.test(head)) return { commitSha: head, branch: null }
    const ref = /^ref:\s*(refs\/heads\/(.+))$/.exec(head)
    if (ref === null) return null
    const refPath = ref[1]!
    const branch = ref[2]!
    for (const base of [gitDir, commonDir]) {
      const loose = path.join(base, refPath)
      if (fs.existsSync(loose)) {
        const sha = fs.readFileSync(loose, 'utf8').trim()
        return SHA.test(sha) ? { commitSha: sha, branch } : null
      }
    }
    const packed = path.join(commonDir, 'packed-refs')
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        if (line.endsWith(` ${refPath}`)) {
          const sha = line.slice(0, line.length - refPath.length - 1)
          return SHA.test(sha) ? { commitSha: sha, branch } : null
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * The git dir and common dir behind `workspaceRoot` when its refs are files
 * this code reads: a `.git` directory or a `.git` FILE (`gitdir: …`, a linked
 * worktree, whose shared refs live under `commondir`). Null for a reftable
 * repository (`git init --ref-format=reftable`, git 2.45): HEAD names
 * `refs/heads/.invalid` and the refs live in `reftable/`, so the files say
 * nothing true. A leftover `packed-refs` there was read as the answer.
 * Throws when there is no `.git` at the root (a workspace in a subdirectory).
 */
function refDirsOf(workspaceRoot: string): { gitDir: string; commonDir: string } | null {
  let gitDir = path.join(workspaceRoot, '.git')
  const st = fs.statSync(gitDir)
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))
    if (m === null) return null
    gitDir = path.resolve(workspaceRoot, m[1]!.trim())
  }
  let commonDir = gitDir
  const commonFile = path.join(gitDir, 'commondir')
  if (fs.existsSync(commonFile)) {
    commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim())
  }
  if (
    fs.existsSync(path.join(gitDir, 'reftable')) ||
    fs.existsSync(path.join(commonDir, 'reftable'))
  ) {
    return null
  }
  return { gitDir, commonDir }
}

/**
 * `refs/remotes/origin/HEAD`'s target from the files, as `git symbolic-ref
 * --short` names it (`origin/main`): `undefined` when the files cannot say
 * (no `.git` at the root, reftable), null when there is no such symbolic
 * ref. A symbolic ref is never packed, so a missing file is git's answer
 * too.
 */
function readOriginHeadDirect(workspaceRoot: string): string | null | undefined {
  try {
    const dirs = refDirsOf(workspaceRoot)
    if (dirs === null) return undefined
    const file = path.join(dirs.commonDir, 'refs', 'remotes', 'origin', 'HEAD')
    if (!fs.existsSync(file)) return null
    const ref = /^ref:\s*refs\/remotes\/(.+)$/.exec(fs.readFileSync(file, 'utf8').trim())
    return ref === null ? undefined : ref[1]!
  } catch {
    return undefined
  }
}

/**
 * The branch a CI provider says this checkout came from, or null.
 *
 * On a GitHub pull_request `GITHUB_REF_NAME` is `<n>/merge` — the merge ref,
 * not a branch anyone works on — so `GITHUB_HEAD_REF` (the contributor's
 * actual branch, set only for pull_request events) has to win.
 */
function ciBranch(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null {
  for (const key of ['GITHUB_HEAD_REF', 'GITHUB_REF_NAME', 'CI_COMMIT_REF_NAME']) {
    const v = env[key]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
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

  // The file first, as `captureGitContext` reads HEAD: a spawn here was
  // ~8 ms of every run a telemetry plugin is declared in.
  let ref = readOriginHeadDirect(workspaceRoot)
  if (ref === undefined) {
    ref = null
    try {
      const proc = Bun.spawnSync({
        cmd: [
          executablePath('git'),
          '-C',
          workspaceRoot,
          'symbolic-ref',
          '--short',
          'refs/remotes/origin/HEAD',
        ],
        stdout: 'pipe',
        stderr: 'ignore',
      })
      if (proc.exitCode === 0) ref = new TextDecoder().decode(proc.stdout).trim()
    } catch {
      // git unavailable / no remote HEAD ref: null.
    }
  }
  if (ref === null) return null
  // `refs/remotes/origin/HEAD` → `origin/main`; strip the remote prefix.
  const slash = ref.indexOf('/')
  const name = slash >= 0 ? ref.slice(slash + 1) : ref
  return name.length > 0 ? name : null
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
 * The URL comes from the run's own `git var -l` when it has one, else one
 * `git` spawn behind try/catch; call sites gate on telemetry being active
 * so a plain run never pays it. Never throws.
 */
export function captureWorkspaceIdentity(
  workspaceRoot: string,
  /**
   * `remote.origin.url` as the run's enumeration read it (`git var -l`, the
   * same merged config): null when it has none. Undefined asks git.
   */
  originUrl?: string | null,
): WorkspaceIdentity {
  const base = workspaceRoot.replace(/\/+$/, '').split('/').pop() || 'workspace'
  try {
    let url = originUrl ?? ''
    if (originUrl === undefined) {
      const proc = Bun.spawnSync({
        // `config --get`, NOT `remote get-url`: get-url applies insteadOf
        // rewrites, so two developers mirroring the same repo through
        // different proxies would derive different workspace ids. The raw
        // configured URL is the identity.
        cmd: [executablePath('git'), '-C', workspaceRoot, 'config', '--get', 'remote.origin.url'],
        stdout: 'pipe',
        stderr: 'ignore',
      })
      if (proc.exitCode === 0) url = new TextDecoder().decode(proc.stdout)
    }
    url = url.trim()
    if (url.length > 0) {
      const normalized = normalizeRemoteUrl(url)
      const name = normalized.split('/').pop() || base
      return { id: xxh3hex(normalized), name }
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
