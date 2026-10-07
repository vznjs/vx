// Which repository a workspace is, so its checkouts share one store under
// `~/.vx/<id>` and other repositories keep theirs: Nx 23.2's
// `~/.nx/<id>` (`utils/workspace-id.js`, `utils/git-utils.js`), ported
// rule for rule (owner, 2026-10-06: "do exactly like nx"), minus the Nx
// Cloud id. Read from the `.git` files; git is asked only when they cannot
// settle it (no parseable remote, an `include`, an `insteadOf`).

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

/**
 * 16 hex of sha256 of the repo key, sha256(`<identity>#<workspace path in
 * the repo>`). The identity is the remote's `host/owner/repo` in lower
 * case, so ssh, https and token URLs agree; with no remote, the sorted
 * first root commit; null for a shallow clone with no remote and outside
 * git: those share nothing.
 */
export async function repoIdOf(root: string): Promise<string | null> {
  const located = locateGitDir(root)
  if (located === null) return null
  const identity =
    (await remoteIdentity(root, located.commonDir)) ?? (await firstCommit(located.commonDir, root))
  if (identity === null) return null
  const rel = path.relative(located.gitRoot, path.resolve(root)).split(path.sep).join('/')
  const key = sha256(`${identity}#${rel}`)
  return sha256(key).slice(0, 16)
}

const sha256 = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex')

interface GitDir {
  gitRoot: string
  commonDir: string
}

/** The repository `dir` is in: walk up to a `.git`; null past one not ours. */
function locateGitDir(dir: string): GitDir | null {
  let current = path.resolve(dir)
  for (;;) {
    const at = gitDirAt(current)
    if (at !== undefined) return at
    const up = path.dirname(current)
    if (up === current) return null
    current = up
  }
}

/** Undefined with no `.git` here (walk on); null for one vx will not read. */
function gitDirAt(dir: string): GitDir | null | undefined {
  const dotGit = path.join(dir, '.git')
  let entry
  try {
    entry = statSync(dotGit)
  } catch {
    return undefined
  }
  if (entry.isDirectory()) {
    // A `.git` planted in a world-writable ancestor (`/tmp`) must not name
    // the repository of everything under it: git's own shape and owner checks.
    if (!existsSync(path.join(dotGit, 'HEAD')) || !existsSync(path.join(dotGit, 'objects'))) {
      return null
    }
    return ownedRealDir(dotGit) ? { gitRoot: dir, commonDir: dotGit } : null
  }
  if (entry.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readOwnedFile(dotGit) ?? '')
    if (pointer === null) return null
    const gitDir = path.resolve(dir, pointer[1]!.trim())
    const shared = readOwnedFile(path.join(gitDir, 'commondir'))?.trim()
    const commonDir = shared ? path.resolve(gitDir, shared) : gitDir
    return ownedRealDir(commonDir) ? { gitRoot: dir, commonDir } : null
  }
  return undefined
}

const ownUid = (): number | undefined => process.getuid?.()

function ownedRealDir(p: string): boolean {
  try {
    const st = lstatSync(p)
    return st.isDirectory() && (ownUid() === undefined || st.uid === ownUid())
  } catch {
    return false
  }
}

/** A regular file of ours, read without following a link or blocking on a FIFO. */
function readOwnedFile(p: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || (ownUid() !== undefined && st.uid !== ownUid())) return null
    return readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The remote's identity from the config file, else from `git remote -v`
 * when the file cannot settle it: a remote none of whose urls parse (a
 * rewrite may live in a file vx does not read, as Nx asks git), or
 * remotes git could read from `config.worktree`.
 */
async function remoteIdentity(root: string, commonDir: string): Promise<string | null> {
  const config = readOwnedFile(path.join(commonDir, 'config'))
  const remotes = config === null ? null : parseGitConfigRemotes(config)
  if (remotes !== null) {
    const picked = pickRemote(remotes)
    // A remote-less repo with nothing to pull one from elsewhere spawns
    // nothing: git would answer the same, and that spawn was a cost per run.
    if (picked !== null || (remotes.length === 0 && !worktreeConfigOn(config!))) return picked
  }
  return pickRemote(await remotesFromGit(root))
}

/** `extensions.worktreeConfig` set: git reads `config.worktree` too. */
function worktreeConfigOn(contents: string): boolean {
  let inExtensions = false
  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inExtensions = /^\[\s*extensions\s*\]/i.test(line)
      continue
    }
    const m = /^worktreeconfig\s*(?:=\s*(\S*))?/i.exec(line)
    if (inExtensions && m !== null && !/^(false|no|off|0)$/i.test(m[1] ?? 'true')) return true
  }
  return false
}

function pickRemote(urls: [string, string][]): string | null {
  const found = new Map<string, string>()
  let first: string | null = null
  for (const [name, url] of urls) {
    const info = parseRemoteUrl(url)
    if (info !== null && !found.has(name)) {
      found.set(name, info)
      first ??= info
    }
  }
  const picked = found.get('origin') ?? found.get('upstream') ?? found.get('base') ?? first
  return picked === null ? null : picked.toLowerCase().replace(/\/+$/, '')
}

/**
 * Remote name → url pairs in file order, or null when the file cannot be
 * answered for whole: an `include`, a `url "…"` rewrite, or a value git
 * would unescape or cut at a comment.
 */
export function parseGitConfigRemotes(contents: string): [string, string][] | null {
  const remotes: [string, string][] = []
  const seen = new Set<string>()
  let remote: string | null = null
  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const close = line.indexOf(']')
      const section = (close === -1 ? line.slice(1) : line.slice(1, close)).trim()
      if (/^include(If)?\b/i.test(section) || /^url\s+"/i.test(section)) return null
      remote = /^remote\s+"(.*)"$/i.exec(section)?.[1] ?? null
      continue
    }
    if (remote === null) continue
    const eq = line.indexOf('=')
    if (eq === -1 || line.slice(0, eq).trim().toLowerCase() !== 'url') continue
    const value = line.slice(eq + 1).trim()
    if (/[#;\\]/.test(value)) return null
    const url = value.replace(/^"(.*)"$/, '$1')
    if (url.includes('"')) return null
    // `remote.<name>.url` is multi-valued; git fetches from the first.
    if (!seen.has(remote)) {
      seen.add(remote)
      remotes.push([remote, url])
    }
  }
  return remotes
}

async function remotesFromGit(root: string): Promise<[string, string][]> {
  const out = await git(root, ['remote', '-v'])
  if (out === null) return []
  const pairs: [string, string][] = []
  for (const line of out.split('\n')) {
    const m = /^(\w+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (m !== null) pairs.push([m[1]!, m[2]!])
  }
  return pairs
}

/** `host/owner/repo` for the four url shapes Nx reads; null for the rest. */
export function parseRemoteUrl(url: string): string | null {
  const u = url.trim()
  const m =
    /^git@([^:]+):([^/]+)\/(.+?)(\.git)?$/.exec(u) ??
    /^https?:\/\/[^@]+@([^/]+)\/([^/]+)\/(.+?)(\.git)?$/.exec(u) ??
    /^https?:\/\/([^@/]+)\/([^/]+)\/(.+?)(\.git)?$/.exec(u)
  if (m !== null) return `${m[1]}/${m[2]}/${m[3]}`
  const ssh = /^ssh:\/\/[^@]+@([^:/]+)(:[0-9]+)?\/([^/]+)\/(.+?)(\.git)?$/.exec(u)
  return ssh === null ? null : `${ssh[1]}/${ssh[3]}/${ssh[4]}`
}

/**
 * The sorted-first root commit, so every clone agrees; null when shallow.
 * Shallow is git's own test, a `shallow` file in the common dir: asking
 * `rev-parse` cost a spawn on every run of a repo with no remote.
 */
async function firstCommit(commonDir: string, root: string): Promise<string | null> {
  if (existsSync(path.join(commonDir, 'shallow'))) return null
  const roots = await git(root, ['rev-list', '--max-parents=0', 'HEAD'])
  return roots?.split(/\r?\n/).filter(Boolean).sort()[0] ?? null
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return code === 0 ? out : null
  } catch {
    return null
  }
}
