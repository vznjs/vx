// What a sandboxed task was denied, as a report: the Linux strace pass
// (paired by pid, because a forking task interleaves its lines), the
// seatbelt record description, and the filters that keep only what the
// task's owner can act on — inside the project, minus the loopback denial
// no grant can avoid, minus what the task chose to ignore.

import path from 'node:path'
import { absolutize, atOrUnder, isUnderAny, localBindingOn, toRealPath } from './sandbox-paths.js'
import { bindableReads } from './sandbox-binds.js'
import type {
  ResolvedSandboxConfig,
  SandboxedRunArgs,
  SandboxViolation,
} from './sandbox-runtime.js'

/**
 * Parse a strace log for denied filesystem syscalls and convert each
 * one inside the workspace deny anchor (and not in allowRead) into a
 * SandboxViolation. Dedups by (syscall, abs-path) so a tool that
 * statx's the same missing path 10 times in a row produces one line.
 *
 * strace line shape (with -f):
 *   <pid> openat(AT_FDCWD, "<path>", <flags>) = -1 ENOENT (...)
 *   <pid> access("<path>", <mode>) = -1 EACCES (...)
 *   <pid> statx(AT_FDCWD, "<path>", <flags>, <mask>, ...) = -1 ENOENT (...)
 *
 * …but ONLY when the syscall completes without another traced process
 * interleaving. Under `-f` strace splits an interrupted call across two
 * lines and the result never appears next to the path:
 *   <pid> openat(AT_FDCWD, "<path>", <flags> <unfinished ...>
 *   <pid> <... openat resumed>)             = -1 ENOENT (...)
 * A single-line regex silently drops every one of those, so a task that
 * forks concurrent children reading undeclared files reported an
 * INCOMPLETE violation list — a sandboxed task that tripped would look
 * clean. We pair them by pid instead (a process has at most
 * one syscall in flight, so the pid is a sufficient key).
 *
 * We capture the first quoted-string argument as the path, a C string
 * (`cStringPath` decodes it). Paths that are relative resolve against the
 * task's cwd (set by Bun.spawn).
 */
const SYSCALLS = 'openat|access|statx|newfstatat'
const QUOTED = '"((?:[^"\\\\]|\\\\.)+)"'
const STRACE_DONE_RE = new RegExp(
  `^(\\d+)\\s+(${SYSCALLS})\\([^"]*${QUOTED}[^)]*\\)\\s*=\\s*-1\\s+(ENOENT|EACCES|EPERM)`,
)
const STRACE_UNFINISHED_RE = new RegExp(`^(\\d+)\\s+(${SYSCALLS})\\([^"]*${QUOTED}[^)]*<unfinished`)
const STRACE_RESUMED_RE = new RegExp(
  `^(\\d+)\\s+<\\.\\.\\. (${SYSCALLS}) resumed>.*?=\\s*-1\\s+(ENOENT|EACCES|EPERM)`,
)
/** A resumed call that SUCCEEDED — clears the pending entry, emits nothing. */
const STRACE_RESUMED_OK_RE = new RegExp(`^(\\d+)\\s+<\\.\\.\\. (${SYSCALLS}) resumed>`)
/**
 * An `openat` that succeeded, and not for writing alone: a read. Placed by
 * the path `-y` prints for the descriptor it returned; without one, only
 * from the cwd (`AT_FDCWD`) or by an absolute path.
 */
const READ_FLAGS = '(?![A-Z_|]*O_WRONLY)[A-Z_|]+'
const OPEN_READ_RE = new RegExp(
  `^(\\d+)\\s+openat\\((AT_FDCWD|\\d+)(?:<[^"]*>)?, ${QUOTED}, ${READ_FLAGS}[^)]*\\)\\s*=\\s*\\d+(?:<(.*)>)?$`,
)
const OPEN_READ_UNFINISHED_RE = new RegExp(
  `^(\\d+)\\s+openat\\((AT_FDCWD|\\d+)(?:<[^"]*>)?, ${QUOTED}, ${READ_FLAGS}.*<unfinished`,
)
const RESUMED_FD_RE = /resumed>.*\)\s*=\s*\d+(?:<(.*)>)?$/

/** Where a successful read opened: `-y`'s path, else the call's own when placeable. */
function readPath(dirfd: string, rawPath: string, opened: string | undefined): string | undefined {
  if (opened !== undefined) return cStringPath(opened)
  return dirfd === 'AT_FDCWD' || rawPath.startsWith('/') ? rawPath : undefined
}

const C_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, v: 11, f: 12, a: 7, b: 8 }

/**
 * The path a strace C string spells. strace escapes a quote, a backslash
 * and a control byte, and writes a non-ASCII byte as octal (`é` is
 * `\303\251`): read raw, `q"t.txt` was cut at `q\` and `é.txt` named
 * `\303\251.txt`, so the report and every `ignore` pattern missed the file.
 */
function cStringPath(raw: string): string {
  if (!raw.includes('\\')) return raw
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const next = raw[++i] ?? ''
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i, i + 3))?.[0]
    const hex = next === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 1, i + 3))?.[0] : undefined
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8))
      i += octal.length - 1
    } else if (hex !== undefined) {
      bytes.push(parseInt(hex, 16))
      i += hex.length
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** One denied syscall, however strace chose to lay it out. */
export interface DeniedCall {
  syscall: string
  rawPath: string
  errno: string
  /** A read that SUCCEEDED (`errno` empty): asked for by `deniedCalls`' `reads`. */
  read?: true
  /**
   * The directory a relative `rawPath` was opened from, when the trace
   * shows the process (or one it was forked from) changed into one; absent
   * where it never did, or where it lost track (`fchdir`).
   */
  dir?: string
}

// The calls that move a process's cwd, and the ones that make a process:
// a child starts in its parent's cwd as it was at the fork.
const CHDIR_DONE_RE = new RegExp(`^(\\d+)\\s+chdir\\(${QUOTED}\\)\\s*=\\s*0`)
const CHDIR_UNFINISHED_RE = new RegExp(`^(\\d+)\\s+chdir\\(${QUOTED} <unfinished`)
const CHDIR_RESUMED_RE =
  /^(\d+)\s+<\.\.\. chdir resumed>.*?=\s*(-?\d+)(?:\s+(ENOENT|EACCES|EPERM))?/
// A denied `chdir` is a denied read of the directory: `cd src` into a
// directory no grant holds failed with no line of the trace's own, and
// `cd src || …` passed and cached.
const CHDIR_DENIED_RE = new RegExp(
  `^(\\d+)\\s+chdir\\(${QUOTED}\\)\\s*=\\s*-1\\s+(ENOENT|EACCES|EPERM)`,
)
const FCHDIR_RE = /^(\d+)\s+(?:fchdir\(\d+\)|<\.\.\. fchdir resumed>.*?)\s*=\s*0/
const FORK = '(?:clone3?|v?fork)'
const FORK_DONE_RE = new RegExp(`^(\\d+)\\s+${FORK}\\(.*\\)\\s*=\\s*(\\d+)$`)
const FORK_UNFINISHED_RE = new RegExp(`^(\\d+)\\s+${FORK}\\(.*<unfinished`)
const FORK_RESUMED_RE = new RegExp(`^(\\d+)\\s+<\\.\\.\\. ${FORK} resumed>.*?=\\s*(\\d+)$`)

/** What a process did, in order, as far as its cwd and its denials go. */
type Op = { chdir: string } | { lost: true } | { call: number }

/**
 * Walk the trace, pairing `<unfinished ...>` with its `<... resumed>` line.
 * Given the task's starting `cwd`, also follow each process's `chdir` and
 * forks, so a denial of `secret.txt` after `cd src` is `src/secret.txt`:
 * resolved against the starting cwd, it named a file that does not exist
 * and no `ignore` pattern for the real one matched. Resolved after the
 * whole pass: a `vfork` child's lines come before its parent's
 * `resumed` line names it. (`-y` names the directory on every line, but
 * cost 40% on 2,000 opens; this costs a stop per process.)
 *
 * Exported for testing: this is the security-relevant half of the Linux
 * detector, and a synthetic trace pins the split-line shapes deterministically
 * where an end-to-end run only produces them when strace happens to interleave.
 */
export function deniedCalls(text: string, cwd?: string, reads = false): DeniedCall[] {
  const pending = new Map<
    string,
    { syscall: string; rawPath: string; read?: true; dirfd?: string }
  >()
  const out: DeniedCall[] = []
  const ops = new Map<string, Op[]>()
  // A clone with CLONE_FS (every thread) shares its creator's cwd, so a
  // `chdir` by either moves both: such a pid keeps the creator's list.
  const sharing = new Map<string, string>()
  const owner = (pid: string): string => sharing.get(pid) ?? pid
  const opsOf = (pid: string): Op[] => {
    let list = ops.get(owner(pid))
    if (list === undefined) ops.set(owner(pid), (list = []))
    return list
  }
  const parent = new Map<string, { pid: string; at: number }>()
  const forking = new Map<string, { at: number; shared: boolean }>()
  const forked = (from: string, child: string, at: number, shared: boolean): void => {
    // Shared only while the child has done nothing of its own yet.
    if (shared && !ops.has(child)) sharing.set(child, owner(from))
    else parent.set(child, { pid: owner(from), at })
  }
  const chdirring = new Map<string, string>()
  const denied = (pid: string, call: DeniedCall): void => {
    opsOf(pid).push({ call: out.length })
    out.push(call)
  }
  for (const line of text.split('\n')) {
    // Most lines are opens that succeeded: two substring tests skip them.
    const opener =
      line.includes('= -1') || line.includes('<unfinished') || line.includes('resumed>')
    if (!opener) {
      if (reads && line.includes('openat(')) {
        const m = OPEN_READ_RE.exec(line)
        if (m !== null) {
          const at = readPath(m[2]!, cStringPath(m[3]!), m[4])
          if (at !== undefined)
            denied(m[1]!, { syscall: 'openat', rawPath: at, errno: '', read: true })
          continue
        }
      }
      if (
        cwd !== undefined &&
        (line.includes('chdir(') || line.includes('fork(') || line.includes('clone'))
      )
        follow(line)
      continue
    }
    const done = STRACE_DONE_RE.exec(line)
    if (done?.[2] !== undefined && done[3] !== undefined && done[4] !== undefined) {
      denied(done[1]!, { syscall: done[2], rawPath: cStringPath(done[3]), errno: done[4] })
      continue
    }
    const unfinished = STRACE_UNFINISHED_RE.exec(line)
    if (
      unfinished?.[1] !== undefined &&
      unfinished[2] !== undefined &&
      unfinished[3] !== undefined
    ) {
      pending.set(unfinished[1], {
        syscall: unfinished[2],
        rawPath: cStringPath(unfinished[3]),
        ...(reads && OPEN_READ_UNFINISHED_RE.test(line) ? { read: true as const } : {}),
        ...(reads ? { dirfd: OPEN_READ_UNFINISHED_RE.exec(line)?.[2] ?? 'AT_FDCWD' } : {}),
      })
      continue
    }
    const resumedOk = STRACE_RESUMED_OK_RE.exec(line)
    if (resumedOk?.[1] !== undefined) {
      const held = pending.get(resumedOk[1])
      pending.delete(resumedOk[1])
      const resumed = STRACE_RESUMED_RE.exec(line)
      // Only a resume that carries a DENIAL is a violation; a successful
      // resume just retires the pending entry.
      const fd = held?.read === true ? RESUMED_FD_RE.exec(line) : null
      if (held !== undefined && resumed?.[3] !== undefined) {
        denied(resumedOk[1], { syscall: held.syscall, rawPath: held.rawPath, errno: resumed[3] })
      } else if (held !== undefined && fd !== null) {
        const at = readPath(held.dirfd ?? 'AT_FDCWD', held.rawPath, fd[1])
        if (at !== undefined) {
          denied(resumedOk[1], { syscall: held.syscall, rawPath: at, errno: '', read: true })
        }
      }
      continue
    }
    // A refused or split `chdir` arrives here: its denial counts with or
    // without the cwd tracking.
    follow(line)
  }
  function follow(line: string): void {
    let m: RegExpExecArray | null
    if ((m = CHDIR_DENIED_RE.exec(line)) !== null) {
      denied(m[1]!, { syscall: 'chdir', rawPath: cStringPath(m[2]!), errno: m[3]! })
      return
    }
    if ((m = CHDIR_UNFINISHED_RE.exec(line)) !== null) {
      chdirring.set(m[1]!, cStringPath(m[2]!))
      return
    }
    if ((m = CHDIR_RESUMED_RE.exec(line)) !== null) {
      const to = chdirring.get(m[1]!)
      chdirring.delete(m[1]!)
      if (to !== undefined && m[2] === '0') opsOf(m[1]!).push({ chdir: to })
      else if (to !== undefined && m[3] !== undefined) {
        denied(m[1]!, { syscall: 'chdir', rawPath: to, errno: m[3] })
      }
      return
    }
    if (cwd === undefined) return
    if ((m = CHDIR_DONE_RE.exec(line)) !== null) opsOf(m[1]!).push({ chdir: cStringPath(m[2]!) })
    else if ((m = FCHDIR_RE.exec(line)) !== null) opsOf(m[1]!).push({ lost: true })
    else if ((m = FORK_DONE_RE.exec(line)) !== null) {
      forked(m[1]!, m[2]!, opsOf(m[1]!).length, line.includes('CLONE_FS'))
    } else if ((m = FORK_UNFINISHED_RE.exec(line)) !== null) {
      forking.set(m[1]!, { at: opsOf(m[1]!).length, shared: line.includes('CLONE_FS') })
    } else if ((m = FORK_RESUMED_RE.exec(line)) !== null) {
      const start = forking.get(m[1]!)
      forking.delete(m[1]!)
      forked(m[1]!, m[2]!, start?.at ?? opsOf(m[1]!).length, start?.shared === true)
    }
  }
  if (cwd === undefined) return out
  // dirsOf(pid)[i]: the process's cwd before its op i (undefined: lost).
  const dirs = new Map<string, (string | undefined)[]>()
  const dirsOf = (pid: string): (string | undefined)[] => {
    const known = dirs.get(pid)
    if (known !== undefined) return known
    dirs.set(pid, []) // a cycle reads as lost
    const from = parent.get(pid)
    let dir: string | undefined = from === undefined ? cwd : dirsOf(from.pid)[from.at]
    const list: (string | undefined)[] = [dir]
    for (const op of ops.get(pid) ?? []) {
      if ('chdir' in op) {
        dir = path.isAbsolute(op.chdir) ? op.chdir : dir && path.resolve(dir, op.chdir)
      } else if ('lost' in op) dir = undefined
      list.push(dir)
    }
    dirs.set(pid, list)
    return list
  }
  for (const [pid, list] of ops) {
    list.forEach((op, i) => {
      if (!('call' in op)) return
      const dir = dirsOf(pid)[i]
      if (dir !== undefined && dir !== cwd) out[op.call]!.dir = dir
    })
  }
  return out
}

export async function parseStraceViolations(
  logPath: string,
  args: SandboxedRunArgs,
  baselines: { allowRead: readonly string[]; denyRead: readonly string[]; cwd: string },
  /** `widenedEntries` taken as the task started: no entry, no read parse. */
  widened: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Promise<SandboxViolation[]> {
  const text = await Bun.file(logPath).text()
  if (text.length === 0) return []

  // Treat every baseAllow + sandbox.allowRead path as "this was
  // explicitly permitted; any -ENOENT here is the user's own missing
  // file, not a sandbox-induced denial". Same for absolute denyRead
  // checks below. Canonical on BOTH sides — the policy is expressed in
  // real paths (see `canonicalBaselines`), so comparing a link-path here
  // would report an explicitly-allowed read as a violation.
  const allowAbs = new Set<string>(
    // A grant SRT could not mount (`bindableReads`) permits nothing.
    [...baselines.allowRead, ...bindableReads(args.config.allowRead)].map((p) =>
      toRealPath(absolutize(p)),
    ),
  )
  const denyAnchors = baselines.denyRead.map((p) => toRealPath(absolutize(p)))
  // A read under a widened write grant's directory is never refused, so it
  // is reported when it succeeds: an entry that was there at the start and
  // no grant covers is an input the key never saw, and so is the
  // directory's listing while it holds one. The granted files and what the
  // task made itself stay readable.
  const written = new Set(args.config.allowWrite.map((p) => toRealPath(absolutize(p))))
  const undeclared = (abs: string): boolean => {
    for (const [dir, entries] of widened) {
      if (abs === dir)
        return [...entries].some((e) => !isUnderAny(e, written) && !isUnderAny(e, allowAbs))
      if (!atOrUnder(abs, dir)) continue
      const top = path.join(dir, path.relative(dir, abs).split(path.sep)[0]!)
      return entries.has(top) && !isUnderAny(abs, written)
    }
    return false
  }

  const seen = new Set<string>()
  const out: SandboxViolation[] = []
  for (const { syscall, rawPath, errno, dir, read } of deniedCalls(
    text,
    baselines.cwd,
    widened.size > 0,
  )) {
    const abs = toRealPath(absolutize(rawPath, dir ?? baselines.cwd))
    // Only report paths under the workspace-root deny anchor — system
    // libs / /proc / /sys / etc. probes are not interesting violations.
    if (!denyAnchors.some((root) => atOrUnder(abs, root))) continue
    // Skip paths the user explicitly allowed (and their descendants).
    if (isUnderAny(abs, allowAbs)) continue
    if (read === true && !undeclared(abs)) continue
    const key = `${syscall}|${abs}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(
      read === true
        ? {
            line: `${syscall}(${rawPath}) read under a write grant's directory, granted no read  [${abs}]`,
            timestamp: new Date(),
            target: abs,
            path: abs,
            ignorable: ['read'],
          }
        : {
            line: `${syscall}(${rawPath}) = -1 ${errno}  [${abs}]`,
            timestamp: new Date(),
            target: abs,
            path: abs,
            // The trace is `-e trace=openat`, and an openat is a read or a
            // write depending on flags the trace does not carry — so either
            // list can silence it.
            ignorable: ['read', 'write'],
          },
    )
  }
  return out
}

/**
 * Does a violation line match something the task said to ignore?
 *
 * The line names an operation and a target — `deny(1) file-write-create
 * /path/x`, `deny(1) system-info vfs.disk-space` — so the operation picks
 * the list and the target is matched against its patterns. Anything
 * unparseable is NOT ignored: a record we cannot classify is exactly the
 * one worth seeing.
 */
function matchesIgnore(
  v: SandboxViolation,
  ignore: NonNullable<ResolvedSandboxConfig['ignore']>,
): boolean {
  if (v.target === undefined || v.ignorable === undefined) return false
  for (const which of v.ignorable) {
    const patterns = ignore[which]
    if (patterns === undefined) continue
    if (patterns.some((pat) => pat === v.target || new Bun.Glob(pat).match(v.target!))) return true
  }
  return false
}

/**
 * Split a seatbelt record into the pieces the filters need. A record with
 * no path (a `system-info` probe) keeps its target — it is not a boundary
 * crossing, and the task can grant it.
 */
function describeMacViolation(line: string): Partial<SandboxViolation> {
  const m = /deny\(\d+\)\s+(\S+)\s+(.+?)\s*$/.exec(line)
  if (m === null) return {}
  const [op, target] = [m[1]!, m[2]!]
  const which = op.startsWith('file-read')
    ? 'read'
    : op.startsWith('file-write')
      ? 'write'
      : op === 'system-info' || op === 'sysctl-read'
        ? 'systemInfo'
        : op.startsWith('network')
          ? 'network'
          : undefined
  return {
    target,
    ...(target.startsWith('/') ? { path: toRealPath(target) } : {}),
    ...(which !== undefined ? { ignorable: [which] } : {}),
  }
}

/**
 * The violations a task's report should carry: inside the project or
 * under a withheld dependency (`linked`), minus the loopback denial no
 * config can avoid, minus what the task chose to ignore. Exported so a
 * test can drive it with either platform's line shape without needing
 * that platform.
 */
export function reportableViolations(
  violations: readonly SandboxViolation[],
  opts: { within: string; linked?: readonly string[]; config: ResolvedSandboxConfig },
): SandboxViolation[] {
  // A record the producer did not describe is a seatbelt one, straight
  // from SRT's store — parse it here so the filters below never see a
  // platform's line format.
  return filterIgnored(
    loopbackNoise(
      withinReported(describe(violations), opts.within, opts.linked ?? []),
      opts.config,
    ),
    opts.config.ignore,
  )
}

/**
 * The writes refused OUTSIDE the project, as distinct paths: the denials
 * `reportableViolations` drops at the wall. A read there is the walk every
 * process makes from `/`, but a refused write is the task failing to put
 * something it needed: `bun build --compile` extracting a cross-compile
 * runtime into `~/.bun/install/cache` said only "Failed to extract
 * executable" and the report named nothing (2026-09-29). Never a
 * violation — a failed task's hint (`runSandboxed`). The kernel's
 * pseudo-files, a descriptor's non-path, and what `skip` names (the task's
 * own temp root, SRT's default write paths) are left out: Linux's observer
 * records every write ATTEMPT, and a write to `/dev/null` or the task's
 * `TMPDIR` landed.
 */
export function refusedWritesOutside(
  violations: readonly SandboxViolation[],
  opts: {
    within: string
    linked?: readonly string[]
    config: ResolvedSandboxConfig
    skip: readonly string[]
  },
): string[] {
  const reported = reportedWithin(opts.within, opts.linked ?? [])
  const skip = ['/dev', '/proc', '/sys', ...opts.skip.map(toRealPath)]
  const paths = new Set<string>()
  for (const v of filterIgnored(describe(violations), opts.config.ignore)) {
    // Write-only: a strace record is ignorable as a read OR a write, and
    // names a READ (a sibling's file at the wall is the sandbox working).
    const write = v.ignorable?.length === 1 && v.ignorable[0] === 'write'
    // Absolute only: a descriptor the runtime writes through (`/proc/self/fd/N`)
    // canonicalizes to `anon_inode:[eventfd]`, which names no place.
    if (v.path === undefined || !path.isAbsolute(v.path) || !write || reported(v)) continue
    if (!skip.some((s) => atOrUnder(v.path!, s))) paths.add(v.path)
  }
  return [...paths]
}

/** Every record described: a seatbelt one parsed, a Linux one as produced. */
function describe(violations: readonly SandboxViolation[]): SandboxViolation[] {
  return violations.map((v) =>
    v.target === undefined ? { ...v, ...describeMacViolation(v.line) } : v,
  )
}

/**
 * Drop the loopback denial no grant can avoid.
 *
 * A runtime that opens a dual-stack socket reaches 127.0.0.1 as
 * ::ffff:127.0.0.1, and seatbelt's only host tokens are `localhost` and
 * `*` — no rule vx or SRT can write names that form. The first connect is
 * denied, the runtime retries on AF_INET and succeeds (measured
 * 2026-09-05: `fetch` to its own `Bun.serve` port returns 200 with one
 * `deny(1) network-outbound` logged). It happens for a task's own server
 * under `localBinding`, and again for SRT's filtering proxy whenever the
 * task declared any network at all. The record has no address and no
 * config can silence it, so under either grant it is noise.
 *
 * It is not a hole for the traffic that matters: a connection that tried
 * to leave the machine goes through that proxy, which reports it WITH its
 * host and port — a line this keeps.
 */
function loopbackNoise(
  violations: SandboxViolation[],
  config: ResolvedSandboxConfig,
): SandboxViolation[] {
  const loopbackGranted = localBindingOn(config) || config.network !== undefined
  if (!loopbackGranted) return violations
  return violations.filter((v) => !/deny\(\d+\)\s+network-outbound\s*$/.test(v.line))
}

/**
 * Keep only denials on a path inside `within`, or inside one of `linked`.
 *
 * A task may not leave its project — that is enforced by the deny anchor at
 * the workspace root — but being STOPPED at the wall is the sandbox
 * working, not a finding. Every process walks from `/` down to its own cwd
 * (`bun build --compile` lists each directory on the way; traced
 * 2026-09-05), and no configuration can declare that away.
 *
 * What is worth reporting is an undeclared touch of the project's OWN
 * files: the cache key folds this project's inputs, so that is the read
 * that makes a cached artifact wrong. A record with no path at all — a
 * `system-info` probe — is kept, since it is not a boundary crossing and
 * the task can grant it.
 *
 * `linked` are the workspace packages core withheld from a cached task's
 * `node_modules` grant because its key does not answer for them. A denial
 * there is the task reaching for a dependency through its own link — the
 * read that would have been a stale hit, a finding and not the wall.
 * Canonical already: sandbox-request.ts takes them from link targets.
 */
function withinReported(
  violations: SandboxViolation[],
  within: string,
  linked: readonly string[],
): SandboxViolation[] {
  return violations.filter(reportedWithin(within, linked))
}

function reportedWithin(
  within: string,
  linked: readonly string[],
): (v: SandboxViolation) => boolean {
  const roots = [toRealPath(within), ...linked]
  // `root === '/'` would otherwise compare against `'//'` and drop
  // everything — the one prefix that needs no separator appended.
  const prefixes = roots.map((root) => (root.endsWith(path.sep) ? root : root + path.sep))
  return (v) =>
    v.path === undefined ||
    roots.some((root, i) => v.path === root || v.path!.startsWith(prefixes[i]!))
}

/**
 * Apply the task's own `sandbox.ignore` lists on top of whatever the
 * macOS log monitor and the Linux strace pass produced: a record is
 * dropped when a list its operation names (`matchesIgnore`) holds a
 * pattern equal to its target or matching it as a glob. Not SRT's
 * per-command substring match, which is what the defaults installed in
 * `initSandbox` use on the macOS side.
 */
function filterIgnored(
  violations: SandboxViolation[],
  ignore: ResolvedSandboxConfig['ignore'],
): SandboxViolation[] {
  if (ignore === undefined) return violations
  return violations.filter((v) => !matchesIgnore(v, ignore))
}

/**
 * The writes SRT's Linux observer saw that this task's binds do not cover.
 * The observer reports every write-intent syscall as `deny <syscall>
 * <path>` (it cannot see the mount table), so a record under a path bwrap
 * binds writable — `bindableWrites` of the task's grants — was a write
 * that landed, and anything else was refused or fell into the deny
 * anchor's scratch and vanished with the sandbox. Deduplicated by syscall
 * and canonical path; only a `write` ignore list can silence one.
 */
export function refusedWrites(
  records: readonly string[],
  writable: readonly string[],
  /** Write globs whose writes land in the sandbox's scratch (`scratchWrites`): granted. */
  scratch: readonly string[] = [],
): SandboxViolation[] {
  const binds = new Set(writable.map((w) => toRealPath(absolutize(w))))
  const globs = scratch.map((g) => new Bun.Glob(g))
  const seen = new Set<string>()
  const out: SandboxViolation[] = []
  for (const record of records) {
    const m = /^deny (\S+) (\/.*)$/.exec(record)
    if (m === null) continue
    const [, syscall, raw] = m as unknown as [string, string, string]
    const abs = toRealPath(raw)
    if (isUnderAny(abs, binds) || underGlob(abs, globs)) continue
    const key = `${syscall}|${abs}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      line: `${syscall}(${raw}) = a write no grant covers  [${abs}]`,
      timestamp: new Date(),
      target: abs,
      path: abs,
      ignorable: ['write'],
    })
  }
  return out
}

/** `p`, or a directory holding it, matches one of `globs`. */
function underGlob(p: string, globs: readonly InstanceType<typeof Bun.Glob>[]): boolean {
  if (globs.length === 0) return false
  for (let at = p; ; at = path.dirname(at)) {
    if (globs.some((g) => g.match(at))) return true
    if (path.dirname(at) === at) return false
  }
}
