// What a sandboxed task was denied, as a report: the Linux strace pass
// (paired by pid, because a forking task interleaves its lines), the
// seatbelt record description, and the filters that keep only what the
// task's owner can act on — inside the project, minus the loopback denial
// no grant can avoid, minus what the task chose to ignore.

import path from 'node:path'
import { absolutize, isUnderAny, localBindingOn, toRealPath } from './sandbox-paths.js'
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
 * We capture the first quoted-string argument as the path. paths that
 * are relative resolve against the task's cwd (set by Bun.spawn).
 */
const SYSCALLS = 'openat|access|statx|newfstatat'
const STRACE_DONE_RE = new RegExp(
  `^(\\d+)\\s+(${SYSCALLS})\\([^"]*"([^"]+)"[^)]*\\)\\s*=\\s*-1\\s+(ENOENT|EACCES|EPERM)`,
)
const STRACE_UNFINISHED_RE = new RegExp(`^(\\d+)\\s+(${SYSCALLS})\\([^"]*"([^"]+)"[^)]*<unfinished`)
const STRACE_RESUMED_RE = new RegExp(
  `^(\\d+)\\s+<\\.\\.\\. (${SYSCALLS}) resumed>.*?=\\s*-1\\s+(ENOENT|EACCES|EPERM)`,
)
/** A resumed call that SUCCEEDED — clears the pending entry, emits nothing. */
const STRACE_RESUMED_OK_RE = new RegExp(`^(\\d+)\\s+<\\.\\.\\. (${SYSCALLS}) resumed>`)

/** One denied syscall, however strace chose to lay it out. */
export interface DeniedCall {
  syscall: string
  rawPath: string
  errno: string
}

/**
 * Walk the trace, pairing `<unfinished ...>` with its `<... resumed>` line.
 *
 * Exported for testing: this is the security-relevant half of the Linux
 * detector, and a synthetic trace pins the split-line shapes deterministically
 * where an end-to-end run only produces them when strace happens to interleave.
 */
export function deniedCalls(text: string): DeniedCall[] {
  const pending = new Map<string, { syscall: string; rawPath: string }>()
  const out: DeniedCall[] = []
  for (const line of text.split('\n')) {
    const done = STRACE_DONE_RE.exec(line)
    if (done?.[2] !== undefined && done[3] !== undefined && done[4] !== undefined) {
      out.push({ syscall: done[2], rawPath: done[3], errno: done[4] })
      continue
    }
    const unfinished = STRACE_UNFINISHED_RE.exec(line)
    if (
      unfinished?.[1] !== undefined &&
      unfinished[2] !== undefined &&
      unfinished[3] !== undefined
    ) {
      pending.set(unfinished[1], { syscall: unfinished[2], rawPath: unfinished[3] })
      continue
    }
    const resumedOk = STRACE_RESUMED_OK_RE.exec(line)
    if (resumedOk?.[1] === undefined) continue
    const held = pending.get(resumedOk[1])
    pending.delete(resumedOk[1])
    const resumed = STRACE_RESUMED_RE.exec(line)
    // Only a resume that carries a DENIAL is a violation; a successful
    // resume just retires the pending entry.
    if (held !== undefined && resumed?.[3] !== undefined) {
      out.push({ syscall: held.syscall, rawPath: held.rawPath, errno: resumed[3] })
    }
  }
  return out
}

export async function parseStraceViolations(
  logPath: string,
  args: SandboxedRunArgs,
  baselines: { allowRead: readonly string[]; denyRead: readonly string[]; cwd: string },
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
    [...baselines.allowRead, ...args.config.allowRead].map((p) => toRealPath(absolutize(p))),
  )
  const denyAnchors = baselines.denyRead.map((p) => toRealPath(absolutize(p)))

  const seen = new Set<string>()
  const out: SandboxViolation[] = []
  for (const { syscall, rawPath, errno } of deniedCalls(text)) {
    const abs = toRealPath(absolutize(rawPath, baselines.cwd))
    // Only report paths under the workspace-root deny anchor — system
    // libs / /proc / /sys / etc. probes are not interesting violations.
    if (!denyAnchors.some((root) => abs === root || abs.startsWith(root + path.sep))) continue
    // Skip paths the user explicitly allowed (and their descendants).
    if (isUnderAny(abs, allowAbs)) continue
    const key = `${syscall}|${abs}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      line: `${syscall}(${rawPath}) = -1 ${errno}  [${abs}]`,
      timestamp: new Date(),
      target: abs,
      path: abs,
      // The trace is `-e trace=openat`, and an openat is a read or a
      // write depending on flags the trace does not carry — so either
      // list can silence it.
      ignorable: ['read', 'write'],
    })
  }
  return out
}

/**
 * Apply the task's user-provided `sandbox.ignore` grants on top
 * of whatever the macOS log monitor + Linux strace pass produced.
 * Mirrors SRT's own substring-match semantics:
 *   - `'*'` entries match every command
 *   - other keys match commands whose userCommand string CONTAINS the key
 *   - the array of strings under each key is substring-matched against
 *     the violation line
 *
 * The defaults installed in `initSandbox` already filter on the macOS
 * side; this pass catches per-task additions + Linux strace results.
 */
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
 * The violations a task's report should carry: inside the project,
 * minus the loopback denial no config can avoid, minus what the task
 * chose to ignore. Exported so a test can drive it with either
 * platform's line shape without needing that platform.
 */
export function reportableViolations(
  violations: readonly SandboxViolation[],
  opts: { within: string; config: ResolvedSandboxConfig },
): SandboxViolation[] {
  // A record the producer did not describe is a seatbelt one, straight
  // from SRT's store — parse it here so the filters below never see a
  // platform's line format.
  const described = violations.map((v) =>
    v.target === undefined ? { ...v, ...describeMacViolation(v.line) } : v,
  )
  return filterIgnored(
    loopbackNoise(withinReported(described, opts.within), opts.config),
    opts.config.ignore,
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
 * Keep only denials on a path inside `within`.
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
 */
function withinReported(violations: SandboxViolation[], within: string): SandboxViolation[] {
  const root = toRealPath(within)
  // `root === '/'` would otherwise compare against `'//'` and drop
  // everything — the one prefix that needs no separator appended.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return violations.filter(
    (v) => v.path === undefined || v.path === root || v.path.startsWith(prefix),
  )
}

function filterIgnored(
  violations: SandboxViolation[],
  ignore: ResolvedSandboxConfig['ignore'],
): SandboxViolation[] {
  if (ignore === undefined) return violations
  return violations.filter((v) => !matchesIgnore(v, ignore))
}
