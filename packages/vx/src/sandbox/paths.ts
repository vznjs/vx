// Path helpers the sandbox modules share: canonical forms (the policy
// matches real paths), the task-relative absolutizer the strace pass uses,
// and the prefix test.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { braceAlternatives } from '../util/index.js'

/**
 * The wildcard alphabet of a GRANT — what decides whether a declared read or
 * write path is scanned for its matches or mounted as the path it names.
 * Deliberately smaller than `BUN_GLOB_WILDCARDS` (util/paths.ts, `Bun.Glob`'s
 * own set), which also counts `{}`: a grant's braces are expanded before
 * (`grantAlternatives`), so `write: ['g/{a,b}.txt']` arrives as two
 * LITERALS, each gets a placeholder file and is widened to its directory
 * like any other file-shaped grant — measured ok, and pinned in
 * `tests/sandbox-lifecycle.unsafe.test.ts`. A brace that reaches here was
 * escaped and names itself. Counting it would move such a grant into the
 * scan, which finds nothing before the task has written, and turn a
 * working grant into `Read-only file system`. The two
 * predicates answer different questions: whether a declaration must be
 * MATCHED against other declarations (495; `GLOB_WILDCARDS`), and whether a
 * grant can be mounted (here).
 * Item 577 gave each question one spelling.
 */
export const MOUNT_WILDCARDS = /[*?[\]]/

/**
 * The grants one declared grant stands for: its braces expanded as a task
 * glob's are (`braceAlternatives`), and in one that names a path, each
 * escaped brace or comma read as itself. Kept as written, `read:
 * ['c{a,b}']` named a literal `c{a,b}` no project holds and granted
 * nothing, with no word; and the Linux sandbox drops a grant holding a
 * backslash, so `c\{a,b\}` was refused. A pattern keeps its escapes for
 * the scan, which reads a bare brace as alternation.
 */
export function grantAlternatives(grant: string): string[] {
  return braceAlternatives(grant).map((g) =>
    isMountableLiteral(g)
      ? g.replace(/\\(.)/g, (escaped, c: string) => ('{},'.includes(c) ? c : escaped))
      : g,
  )
}

/**
 * Linux: `dir` is under `/dev`, which the sandbox mounts afresh after
 * every bind (SRT's `--dev /dev`, which also skips any grant there), so a
 * project there is gone from the task's view and bwrap fails to remount
 * it. No grant can bring it back.
 */
function replacedBySandbox(dir: string): boolean {
  return process.platform === 'linux' && atOrUnder(dir, '/dev')
}

/**
 * Why no sandboxed task can run with its project at `dir` (its real path),
 * or null: `why` names the cause, `rest` what follows and the fix. A run
 * refuses each such task; the doctor says the sandbox is unavailable there.
 */
export function unmountable(dir: string): { why: string; rest: string } | null {
  const rename = ' — rename the directory, or run the task without exec.sandbox'
  // Linux mounts each path by name; macOS reads one as a pattern.
  if (process.platform !== 'linux' && /[[\]*?]/.test(dir))
    return {
      why: 'holds [, ], * or ?, which the macOS sandbox reads as a pattern, not a name',
      rest: rename,
    }
  // The runtime reports a refused touch one line per record: a path holding
  // a line break arrived split, and an undeclared write to the project's own
  // file was judged as outside it, with the wrong hint.
  if (/[\n\r]/.test(dir))
    return {
      why: "holds a line break, which the sandbox runtime's reports cannot carry",
      rest: `, so a refused touch is misreported${rename}`,
    }
  // Bun's realpath throws ENOENT on a path holding a backslash, and SRT
  // mounts no path it cannot resolve: the task saw no project and ran in
  // $HOME.
  if (process.platform === 'linux' && dir.includes('\\'))
    return {
      why: 'holds a backslash, which the Linux sandbox cannot resolve',
      rest: `, so it mounts none of the project${rename}`,
    }
  // Asked here, not left to bwrap: its "Can't remount" reads as a mount
  // race, so the task ran twice and failed with no word of the cause.
  if (replacedBySandbox(dir))
    return {
      why: 'is under /dev, which the Linux sandbox replaces with its own',
      rest: ', so it mounts none of the project — move the workspace out of /dev, or run the task without exec.sandbox',
    }
  return null
}

/**
 * Directories whose names hold a wildcard and are names, not patterns: a
 * sandboxed project under `packages/[legacy]/` (its own and the
 * workspace's, both spellings). A grant spelled under one is read from past
 * it, so `[legacy]` is never a class of six letters. Added once per run by
 * `sandboxRequestFor`; never removed (a set of names, not state).
 */
const nameDirs = new Set<string>()

/** Record `dir` as a name `wildcardAt` reads past (Linux: the sandbox mounts it by name). */
export function nameDir(dir: string): void {
  if (MOUNT_WILDCARDS.test(dir)) nameDirs.add(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir)
}

/** The longest named directory `p` is at or under, or ''. */
export function namedHead(p: string): string {
  let head = ''
  for (const d of nameDirs) if (d.length > head.length && atOrUnder(p, d)) head = d
  return head
}

/** The index of a grant's first wildcard past any named directory (`nameDir`), or -1. */
export function wildcardAt(grant: string): number {
  if (!MOUNT_WILDCARDS.test(grant)) return -1
  const head = namedHead(grant)
  const at = grant.slice(head.length).search(MOUNT_WILDCARDS)
  return at === -1 ? -1 : head.length + at
}

/**
 * An absolute pattern as `Bun.Glob` must read it: a named directory's
 * wildcards escaped, so `packages/[legacy]/*.log` matches in `[legacy]`.
 */
export function globOf(pattern: string): Bun.Glob {
  const head = namedHead(pattern)
  return new Bun.Glob(
    head === '' ? pattern : head.replace(/[*?[\]{}\\]/g, '\\$&') + pattern.slice(head.length),
  )
}

/** True when a grant names one path the sandbox can mount, rather than a pattern to scan. */
export function isMountableLiteral(grant: string): boolean {
  return wildcardAt(grant) === -1
}

/**
 * The one path a grant names, or undefined for a pattern. A grant whose
 * only brackets are escaped (`out/\[id\]`) names `out/[id]` as surely as a
 * literal does, though it is still scanned and matched as a glob.
 */
export function namedPath(grant: string): string | undefined {
  if (isMountableLiteral(grant)) return grant
  const escaped = /\\([[\]])/g
  return isMountableLiteral(grant.replace(escaped, '')) ? grant.replace(escaped, '$1') : undefined
}

/**
 * Canonicalize a path with realpath, tolerating paths that don't exist
 * yet: resolve the longest existing ancestor and re-append the rest.
 *
 * Why: the sandbox policy matches on canonical paths (macOS seatbelt
 * evaluates real vnode paths), and SRT's own normalization refuses to
 * canonicalize bare symlinked roots like `/tmp` → `/private/tmp` (its
 * boundary check only whitelists `/tmp/<child>` forms). Without this,
 * `allowWrite: ['/tmp']` silently never matches on macOS.
 */
export function toRealPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(toRealPath(parent), path.basename(p))
  }
}

export function absolutize(p: string, cwd?: string): string {
  if (path.isAbsolute(p)) return p
  return path.resolve(cwd ?? process.cwd(), p)
}

/**
 * `p` is `dir` or below it, by path: a sibling sharing `dir`'s name prefix
 * is not, and `/` already ends in the separator.
 */
export function atOrUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

export function isUnderAny(abs: string, allow: Set<string>): boolean {
  if (allow.has(abs)) return true
  for (const a of allow) {
    if (atOrUnder(abs, a)) return true
  }
  return false
}

export function unique(arr: readonly string[]): string[] {
  return [...new Set(arr)]
}

/** `allow.localBinding` grants loopback: `true`, or a non-empty port list. */
export function localBindingOn(c: { localBinding?: boolean | readonly number[] }): boolean {
  return c.localBinding === true || (Array.isArray(c.localBinding) && c.localBinding.length > 0)
}

/**
 * The host loopback ports a `network` list names (`localhost:4173`,
 * `127.0.0.1:4173`, `[::1]:4173`): a client reaches them directly, never
 * through the proxy (`NO_PROXY`, and every browser skips a proxy for
 * loopback), so on Linux each is relayed into the task's namespace.
 */
export function loopbackPorts(network: true | readonly string[] | undefined): number[] {
  if (!Array.isArray(network)) return []
  const ports = new Set<number>()
  for (const d of network) {
    const m = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i.exec(d)
    if (m !== null) ports.add(Number(m[1]))
  }
  return [...ports]
}

/**
 * Whether a sandboxed task may read `file`: it lies under no denial (the
 * rest of the host is mounted read-only), or under a read grant, a write
 * grant or a baseline read, by its canonical path. A path no grant holds
 * under a denial is not there inside the sandbox, which the shell reports
 * as "not found": a PATH search is a stat, which the trace does not stop on.
 */
export function sandboxReads(
  sandbox: {
    readonly baseAllowRead: readonly string[]
    readonly baseDenyRead: readonly string[]
    readonly config: {
      readonly allowRead: readonly string[]
      readonly allowWrite: readonly string[]
      /** Denies the whole host, not only `baseDenyRead`: only a grant reads. */
      readonly hermetic?: boolean
    }
  },
  file: string,
): boolean {
  const real = toRealPath(file)
  const under = (g: string): boolean => atOrUnder(real, toRealPath(g))
  return (
    (sandbox.config.hermetic !== true && !sandbox.baseDenyRead.some(under)) ||
    [...sandbox.baseAllowRead, ...sandbox.config.allowRead, ...sandbox.config.allowWrite].some(
      under,
    )
  )
}
