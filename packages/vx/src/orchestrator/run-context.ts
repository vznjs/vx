// Per-run context for the `invocations` header row: git (commit, branch,
// dirty), CI provider, host/os/arch. Best-effort: a missing git, non-repo cwd
// or unset env makes a field null, never a throw. Telemetry must not fail a
// build.
//
// Cost: HEAD read from `.git` every run; `origin/HEAD` and `remote.origin.url`
// only with a `telemetry` plugin. Each falls back to a `git` spawn when the
// files cannot answer.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  envFlagOn,
  executablePath,
  gitEnv,
  ignoreDir,
  relPosix,
  ulid,
  xxh3hex,
} from '../util/index.js'
import { resolveSetting } from '../settings.js'
import { branchCacheScope, cacheScopeEnvError, isCacheScope } from '../workspace/index.js'
import { VERSION } from '../version.js'
import type { RunContextRecord } from './telemetry.js'

export interface GitContext {
  /** `git rev-parse HEAD`, or null outside a repo / on failure. */
  commitSha: string | null
  /** The branch HEAD names (`refs/heads/` stripped), with or without a commit; null when detached. */
  branch: string | null
  /** True if `git status --porcelain` was non-empty; null on failure. */
  dirty: boolean | null
}

export interface CiContext {
  ci: boolean
  /** Which CI matched: 'github' | 'gitlab' | 'buildkite' | 'circleci'
   *  | 'generic' (bare `CI`), or null when no CI env is present. */
  provider: string | null
  /** The provider's page for this run (a GitHub Actions run, a GitLab pipeline). */
  runUrl?: string
  /** The pull or merge request number this run builds. */
  change?: string
  /** The workflow or pipeline name. */
  pipeline?: string
  /** The job (or step) within it. */
  job?: string
  /** 1 on a first run, 2 on its first re-run. */
  attempt?: number
}

export interface HostContext {
  host: string | null
  os: string
  arch: string
}

/**
 * One `git` spawn per run: `rev-parse HEAD --symbolic-full-name HEAD` gives
 * commit and ref in one call. The full name, not `--abbrev-ref`: a tag named
 * like the branch made it `heads/main` (vercel/turborepo#13882). `dirty` comes
 * from the run's own `git status` (pass null when unknown). Each field degrades
 * to null alone.
 */
export function captureGitContext(
  workspaceRoot: string,
  dirty: boolean | null = null,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): GitContext {
  let commitSha: string | null = null
  let branch: string | null = null
  // Read `.git` directly first: ~0.1 ms against the spawn's ~8 ms, on every
  // run. The spawn is the fallback for anything unfamiliar, so an unusual repo
  // is slower, never wrong.
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
        '--symbolic-full-name',
        'HEAD',
      ],
      env: gitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const lines = new TextDecoder().decode(proc.stdout).trim().split('\n')
      const sha = lines[0]?.trim()
      const br = lines[1]?.trim()
      if (sha) commitSha = sha
      // A detached HEAD answers `HEAD`. Recorded, every detached run (a
      // pull_request checkout) shares a pseudo-branch: never trunk, but all PRs
      // collapse into one scope and feed each other's baselines.
      if (br?.startsWith('refs/heads/')) branch = br.slice('refs/heads/'.length)
    } else {
      // No commit yet: `rev-parse HEAD` fails, yet HEAD already names the
      // branch the first commit lands on (`git branch --show-current`).
      branch = unbornBranch(workspaceRoot)
    }
  } catch {
    // git unavailable / non-repo: both fields stay null.
  }
  // A detached CI checkout still knows its branch from the provider. Consulted
  // only when git had none: an attached branch is ground truth, and a stale
  // variable must never relabel it.
  branch ??= ciBranch(env)
  return { commitSha, branch, dirty }
}

/** The branch HEAD names, asked of git only after `rev-parse HEAD` failed. */
function unbornBranch(workspaceRoot: string): string | null {
  const proc = Bun.spawnSync({
    cmd: [executablePath('git'), '-C', workspaceRoot, 'symbolic-ref', '--quiet', 'HEAD'],
    env: gitEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const ref = proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : ''
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
}

/**
 * `HEAD`'s commit and branch from `.git` files, or null on anything unfamiliar
 * (the caller spawns git). Handles a `.git` dir or file (a linked worktree,
 * refs under `commondir`), symbolic and detached HEAD, loose refs and
 * `packed-refs`. Reftable is always null.
 */
function readHeadDirect(
  workspaceRoot: string,
): { commitSha: string | null; branch: string | null } | null {
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
    // Neither a loose nor a packed ref: the branch has no commit yet.
    return { commitSha: null, branch }
  } catch {
    return null
  }
}

/**
 * The git dir and common dir behind `workspaceRoot` when its refs are files
 * this reads. Null for reftable (git 2.45): HEAD names `refs/heads/.invalid`,
 * so the files say nothing true, and a leftover `packed-refs` was read as the
 * answer. Throws with no `.git` at the root.
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
 * The branch a CI provider says this checkout came from, or null. On a GitHub
 * pull_request `GITHUB_REF_NAME` is `<n>/merge`, so `GITHUB_HEAD_REF` wins.
 */
function ciBranch(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null {
  for (const key of ['GITHUB_HEAD_REF', 'GITHUB_REF_NAME', 'CI_COMMIT_REF_NAME']) {
    const v = env[key]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

/**
 * The default (trunk) branch: a run on it is trunk, anything else is branch
 * work whose timings must not pollute the shared baseline. Most reliable first:
 * 1. GitLab `CI_DEFAULT_BRANCH`.
 * 2. GitHub Actions: the event payload's `repository.default_branch`.
 * 3. `git symbolic-ref --short refs/remotes/origin/HEAD`, without `origin/`.
 *    Null when none resolve; consumers then count all runs. Never throws.
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
        env: gitEnv(),
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

/**
 * Detect a CI environment + which provider. `ci=true` if any recognized
 * var is truthy; `provider` names the most-specific match (a specific
 * provider beats the generic `CI`).
 */
export function detectCi(env: NodeJS.ProcessEnv | Record<string, string | undefined>): CiContext {
  for (const [varName, provider] of CI_PROVIDERS) {
    if (envFlagOn(env[varName])) return { ci: true, provider, ...ciLinks(provider, env) }
  }
  return { ci: false, provider: null }
}

type CiLinks = Pick<CiContext, 'runUrl' | 'change' | 'pipeline' | 'job' | 'attempt'>

/** Where a dashboard links back to: each provider's own documented variables. */
function ciLinks(provider: string, env: Record<string, string | undefined>): CiLinks {
  const v = (k: string): string | undefined => (env[k] === '' ? undefined : env[k])
  const n = (raw: string | undefined, plus = 0): number | undefined => {
    const x = raw === undefined ? NaN : Number(raw)
    return Number.isInteger(x) && x >= 0 ? x + plus : undefined
  }
  let links: Record<string, string | number | undefined>
  switch (provider) {
    case 'github': {
      const server = v('GITHUB_SERVER_URL') ?? 'https://github.com'
      const repo = v('GITHUB_REPOSITORY')
      const id = v('GITHUB_RUN_ID')
      links = {
        runUrl: repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined,
        // `refs/pull/<n>/merge` on a pull_request event; a merge queue's
        // run, `refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>`.
        change: /^refs\/(?:pull\/(\d+)\/|heads\/gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$)/
          .exec(v('GITHUB_REF') ?? '')
          ?.slice(1)
          .find((x) => x !== undefined),
        pipeline: v('GITHUB_WORKFLOW'),
        job: v('GITHUB_JOB'),
        attempt: n(v('GITHUB_RUN_ATTEMPT')),
      }
      break
    }
    case 'gitlab':
      links = {
        runUrl: v('CI_PIPELINE_URL'),
        change: v('CI_MERGE_REQUEST_IID'),
        pipeline: v('CI_PIPELINE_NAME'),
        job: v('CI_JOB_NAME'),
      }
      break
    case 'buildkite': {
      const pr = v('BUILDKITE_PULL_REQUEST')
      links = {
        runUrl: v('BUILDKITE_BUILD_URL'),
        // `false` when the build is not for one.
        change: pr !== undefined && /^\d+$/.test(pr) ? pr : undefined,
        pipeline: v('BUILDKITE_PIPELINE_SLUG'),
        job: v('BUILDKITE_LABEL'),
        // Counts re-runs from 0.
        attempt: n(v('BUILDKITE_RETRY_COUNT'), 1),
      }
      break
    }
    case 'circleci':
      links = {
        runUrl: v('CIRCLE_BUILD_URL'),
        // The PR's URL, ending in its number.
        change: /\/(\d+)$/.exec(v('CIRCLE_PULL_REQUEST') ?? '')?.[1] ?? v('CIRCLE_PR_NUMBER'),
        job: v('CIRCLE_JOB'),
      }
      break
    default:
      return {}
  }
  return Object.fromEntries(Object.entries(links).filter(([, x]) => x !== undefined))
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
  /** The origin remote, normalized (`github.com/org/repo`); absent without one. */
  repository?: string
  /** The root inside its git work tree, POSIX, `.` at the top; absent outside git. */
  path?: string
}

/** Where `root` sits in the work tree whose `.git` is nearest above it. */
function workTreePath(root: string): string | undefined {
  const abs = path.resolve(root)
  for (let dir = abs; ;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return relPosix(dir, abs) || '.'
    }
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/**
 * Normalize a remote URL so every checkout of a repository derives the same id:
 * scp, ssh and https forms reduce to `github.com/o/r`. No credential survives:
 * userinfo ends at the last `@` before the path (a password may hold `@`), and
 * query and fragment are dropped.
 */
export function normalizeRemoteUrl(raw: string): string {
  let s = raw.trim().toLowerCase()
  const hadProtocol = /^[a-z+]+:\/\//.test(s)
  s = s.replace(/^[a-z+]+:\/\//, '') // protocol
  s = s.replace(/[?#].*$/s, '') // ?query, #fragment
  // user[:pass]@; scp shorthand has no password, and its path follows a `:`.
  s = s.replace(hadProtocol ? /^[^/]*@/ : /^[^@/]+@/, '')
  // Strip a `:port` (protocol form only; scp has none), or
  // `ssh://host:2222/o/r` and `https://host/o/r` derived different ids. Gated
  // on `hadProtocol` so a numeric scp segment is not taken for a port.
  if (hadProtocol) s = s.replace(/:\d+(\/|$)/, '$1')
  s = s.replace(/:/, '/') // scp-style host:path
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  return s
}

/**
 * Stable workspace identity (telemetry v2):
 * 1. the normalized origin URL, hashed (same id on every machine);
 * 2. no remote: a salt persisted at `<root>/.vx/cache/workspace-id`;
 * 3. unwritable: the root path. The URL comes from the run's `git var -l`, else
 *    one spawn; callers gate on telemetry. Never throws.
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
  const at = workTreePath(workspaceRoot)
  const where = at === undefined ? {} : { path: at }
  try {
    let url = originUrl ?? ''
    if (originUrl === undefined) {
      const proc = Bun.spawnSync({
        // `config --get`, not `remote get-url`: get-url applies insteadOf
        // rewrites, so mirrors through different proxies would derive different
        // ids.
        cmd: [executablePath('git'), '-C', workspaceRoot, 'config', '--get', 'remote.origin.url'],
        env: gitEnv(),
        stdout: 'pipe',
        stderr: 'ignore',
      })
      if (proc.exitCode === 0) url = new TextDecoder().decode(proc.stdout)
    }
    url = url.trim()
    if (url.length > 0) {
      const normalized = normalizeRemoteUrl(url)
      const name = normalized.split('/').pop() || base
      return { id: xxh3hex(normalized), name, repository: normalized, ...where }
    }
  } catch {
    // git unavailable — fall through to the salt.
  }
  try {
    const saltPath = path.join(workspaceRoot, '.vx', 'cache', 'workspace-id')
    let salt: string
    try {
      salt = fs.readFileSync(saltPath, 'utf8').trim()
      if (salt.length === 0) throw new Error('empty')
    } catch {
      salt = ulid()
      fs.mkdirSync(path.dirname(saltPath), { recursive: true })
      fs.writeFileSync(saltPath, salt + '\n')
    }
    try {
      // On every capture: a salt an older vx wrote may sit unignored.
      ignoreDir(path.dirname(saltPath))
    } catch {
      // read-only: the salt is still the identity
    }
    return { id: xxh3hex(salt), name: base, ...where }
  } catch {
    return { id: xxh3hex(workspaceRoot), name: base, ...where }
  }
}

/**
 * The run's branch: `run.branch` (the flag given, else `VX_RUN_BRANCH`,
 * else the workspace's), else HEAD's, else the CI provider's for a
 * detached checkout. What run history records and a forecast reads first.
 */
export function currentBranch(
  workspaceRoot: string,
  workspace?: unknown,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const set = resolveSetting('run.branch', workspace, flag, env).value as string | undefined
  return set ?? captureGitContext(workspaceRoot, null, env).branch
}

/**
 * The cache scope a branch checkout reads, from `.git` files alone:
 * `<owner>/<repo>:<branch>`, the tracked branch (`branch.<name>.merge` on its
 * remote) else its own name on `origin`. None on the default branch, a detached
 * HEAD or with no remote URL. CI writes that scope (`github()`), so a laptop
 * reads its branch's CI entries.
 */
export function localBranchScope(
  workspaceRoot: string,
  baseBranch: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const head = readHeadDirect(workspaceRoot)
  if (head === null || head.branch === null) return undefined
  const config = gitConfigSections(workspaceRoot)
  const own = config.get(`branch "${head.branch}"`)
  const name = own?.get('merge')?.replace(/^refs\/heads\//, '') ?? head.branch
  const url = config.get(`remote "${own?.get('remote') ?? 'origin'}"`)?.get('url')
  const repo = url === undefined ? undefined : repoOfUrl(url)
  if (repo === undefined) return undefined
  const trunk = trunkBranch(workspaceRoot, baseBranch, env)
  if (trunk === null ? name === 'main' || name === 'master' : name === trunk) return undefined
  return branchCacheScope(repo, name)
}

/**
 * The default branch a cache reads: `baseBranch`, else
 * `captureDefaultBranch`'s, else the first existing of `origin/main`,
 * `origin/master`, `main`, `master`: a creator's clone has no `origin/HEAD`,
 * and a feature branch there read none of CI's main entries.
 */
function trunkBranch(
  workspaceRoot: string,
  baseBranch: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const named = baseBranch ?? captureDefaultBranch(env, workspaceRoot)
  if (named !== null) return named
  const order = [
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ]
  const have = existingRefs(workspaceRoot, order)
  const found = order.find((r) => have.has(r))
  return found === undefined ? null : found.slice(found.lastIndexOf('/') + 1)
}

/** Which of `refs` exist, from the `.git` files, else from one git spawn. */
function existingRefs(workspaceRoot: string, refs: readonly string[]): Set<string> {
  try {
    const dirs = refDirsOf(workspaceRoot)
    if (dirs !== null) {
      const packed = path.join(dirs.commonDir, 'packed-refs')
      const packedRefs = new Set(
        fs.existsSync(packed)
          ? fs
              .readFileSync(packed, 'utf8')
              .split('\n')
              .map((line) => line.slice(line.indexOf(' ') + 1))
          : [],
      )
      return new Set(
        refs.filter(
          (r) =>
            packedRefs.has(r) ||
            fs.existsSync(path.join(dirs.gitDir, r)) ||
            fs.existsSync(path.join(dirs.commonDir, r)),
        ),
      )
    }
  } catch {
    // no `.git` at the root: ask git.
  }
  try {
    const proc = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        '-C',
        workspaceRoot,
        'for-each-ref',
        '--format=%(refname)',
        '--end-of-options',
        ...refs,
      ],
      env: gitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode === 0) return new Set(new TextDecoder().decode(proc.stdout).split('\n'))
  } catch {
    // git unavailable: none.
  }
  return new Set()
}

/**
 * The refs a remote reads, in order: a plugin's (`setBranch`, `github()` and
 * `gitlab()` on CI), else git's: the checked-out branch, then the default
 * (`trunkBranch`). A remote plugin keys or scopes its entries by them (`scope`
 * on turboCache/nxCache); core keys nothing by them.
 */
export function cacheRefs(
  workspaceRoot: string,
  baseBranch: string | undefined,
  pluginRefs: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (pluginRefs !== undefined) return [...pluginRefs]
  const head = (b: string | null | undefined) => (b == null ? undefined : `refs/heads/${b}`)
  // `{}`: a detached HEAD names no branch here, not CI's (a plugin's job).
  const own = head(
    (readHeadDirect(workspaceRoot) ?? captureGitContext(workspaceRoot, null, {})).branch,
  )
  const trunk = head(trunkBranch(workspaceRoot, baseBranch, env))
  return [...new Set([own, trunk].filter((r): r is string => r !== undefined))]
}

/**
 * The repository's path on its host (`owner/repo`; a GitLab subgroup's
 * `group/sub/repo` whole, as `gitlab()` names it); undefined for a local path.
 */
function repoOfUrl(url: string): string | undefined {
  const parts = normalizeRemoteUrl(url).split('/')
  return parts.length < 3 ? undefined : parts.slice(1).join('/')
}

/** `.git/config`'s sections, each a key → value map (last wins); empty when it cannot be read. */
function gitConfigSections(workspaceRoot: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  try {
    const dirs = refDirsOf(workspaceRoot)
    if (dirs === null) return sections
    let at: Map<string, string> | undefined
    for (const raw of fs.readFileSync(path.join(dirs.commonDir, 'config'), 'utf8').split('\n')) {
      const line = raw.trim()
      const section = /^\[\s*(\w+)(?:\s+"(.*)")?\s*\]$/.exec(line)
      if (section !== null) {
        const key = section[2] === undefined ? section[1]! : `${section[1]} "${section[2]}"`
        at = sections.get(key) ?? new Map()
        sections.set(key, at)
        continue
      }
      const kv = /^(\w+)\s*=\s*(.*)$/.exec(line)
      if (kv !== null) at?.set(kv[1]!.toLowerCase(), kv[2]!.trim())
    }
  } catch {
    // no config to read: no remote, so no scope.
  }
  return sections
}

/**
 * The run's cache scope: `VX_CACHE_SCOPE` (empty: none), else a plugin's
 * (`setBranch`, `github()` on Actions; null: the plugin named the run trusted),
 * else, with a cache plugin to share it, the branch's from git. Undefined: no
 * scope. It keys plugin entries only.
 */
export function resolveCacheScope(
  workspaceRoot: string,
  pluginScope: string | null | undefined,
  hasRemote: boolean,
  baseBranch: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const named = env['VX_CACHE_SCOPE']
  if (named !== undefined) {
    if (named === '') return undefined
    if (!isCacheScope(named)) throw cacheScopeEnvError(named)
    return named
  }
  if (pluginScope === null) return undefined
  return pluginScope ?? (hasRemote ? localBranchScope(workspaceRoot, baseBranch, env) : undefined)
}

export interface TelemetryRunContextArgs {
  runId: string
  /** The invocation, already masked. */
  command: string
  requestedTasks: readonly string[]
  cachePolicy: string
  concurrency: number
  flow: RunContextRecord['flow']
  git: GitContext
  ci: CiContext
  host: HostContext
  workspaceRoot: string
  /** `remote.origin.url` as the run's enumeration read it; see `captureWorkspaceIdentity`. */
  originUrl: string | null | undefined
}

/**
 * The run-context record telemetry sinks receive: the invocation header's
 * git/CI/host data shaped as the export contract. Paid only when a sink can
 * exist: the workspace identity may write `.vx/cache/workspace-id`.
 */
export function telemetryRunContext(a: TelemetryRunContextArgs): RunContextRecord {
  const ws = captureWorkspaceIdentity(a.workspaceRoot, a.originUrl)
  const { ci } = a
  return {
    runId: a.runId,
    vxVersion: VERSION,
    command: a.command,
    requestedTasks: [...a.requestedTasks],
    cachePolicy: a.cachePolicy,
    concurrency: a.concurrency,
    flow: a.flow,
    commitSha: a.git.commitSha,
    branch: a.git.branch,
    defaultBranch: captureDefaultBranch(process.env, a.workspaceRoot),
    dirty: a.git.dirty,
    ci: ci.ci,
    ciProvider: ci.provider,
    ...(ci.runUrl !== undefined ? { ciRunUrl: ci.runUrl } : {}),
    ...(ci.change !== undefined ? { ciChange: ci.change } : {}),
    ...(ci.pipeline !== undefined ? { ciPipeline: ci.pipeline } : {}),
    ...(ci.job !== undefined ? { ciJob: ci.job } : {}),
    ...(ci.attempt !== undefined ? { ciAttempt: ci.attempt } : {}),
    host: a.host.host,
    os: a.host.os,
    arch: a.host.arch,
    workspaceId: ws.id,
    workspaceName: ws.name,
    ...(ws.repository !== undefined ? { repository: ws.repository } : {}),
    ...(ws.path !== undefined ? { workspacePath: ws.path } : {}),
  }
}
