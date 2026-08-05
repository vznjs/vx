// Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for enforcing
// per-task filesystem + network isolation.
//
// Design contract:
//   The caller (executeCachedTask) computes the exact allowRead /
//   allowWrite paths from the task's declared inputs + outputs + sandbox
//   block. This module adds nothing implicit — no /tmp, no node_modules,
//   no project dir. If a task needs them, the user declares them in
//   their sandbox config. That gives users a complete view of what each
//   task can touch from a single vx.config.ts file.
//
// Network is opt-in per task. By default the sandbox blocks all outbound
// traffic; tasks that need it set `sandbox.network: true`.
//
// Platform reality:
//   macOS — `SandboxViolationStore` is populated from the system log
//   monitor in real time; violations carry the offending command +
//   syscall line, so we get structured detection.
//   Linux  — bwrap denies the read at the kernel boundary; the child
//   sees ENOENT (or EPERM for some operations). SRT surfaces no
//   structured events there, so we wrap the spawn in strace and parse
//   the trace ourselves (`deniedCalls`) — detection is NOT
//   enforcement-only on Linux, and the fail-on-violation branch in
//   execute-task is live on both platforms.

import path from 'node:path'
import os from 'node:os'
import { realpathSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { SandboxConfig, SandboxNetworkConfig } from '../config.js'
import {
  armTimeout,
  drainOrAbort,
  shellQuote,
  signalExitCode,
  streamToString,
  resourceUsageToCpuRss,
  type CaptureConfig,
  type RunResult,
} from './runner.js'
import { xxh3hex } from '../util/index.js'

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime')
let srtPromise: Promise<SrtModule> | undefined

async function loadSrt(): Promise<SrtModule> {
  if (!srtPromise) srtPromise = import('@anthropic-ai/sandbox-runtime')
  return srtPromise
}

export interface SandboxAvailability {
  available: boolean
  /** Reason it isn't available (platform / missing deps). Empty when available. */
  reason: string
}

let availabilityCache: SandboxAvailability | undefined

/**
 * Probe whether SRT can sandbox on this host. Memoized — the binary
 * presence + platform check doesn't change within a process.
 *
 * In addition to SRT's own `checkDependencies` (which only verifies
 * binary presence on PATH), this runs a minimal bwrap invocation on
 * Linux to catch the "bwrap installed but unprivileged user namespaces
 * blocked by AppArmor / sysctl" case that's the default on stock
 * Ubuntu 24.04. Without this real-execution probe, the unavailability
 * surfaces only at the first task spawn, deep inside the orchestrator.
 */
export async function probeSandbox(): Promise<SandboxAvailability> {
  if (availabilityCache) return availabilityCache
  const { SandboxManager } = await loadSrt()
  if (!SandboxManager.isSupportedPlatform()) {
    availabilityCache = { available: false, reason: `platform ${process.platform} not supported` }
    return availabilityCache
  }
  const deps = SandboxManager.checkDependencies()
  if (deps.errors.length > 0) {
    availabilityCache = { available: false, reason: deps.errors.join('; ') }
    return availabilityCache
  }
  // Linux only: real-execution probe. Run `bwrap` with the minimal
  // user-namespace invocation it'd attempt for a sandboxed task; if
  // the kernel rejects (AppArmor / sysctl), surface that here.
  if (process.platform === 'linux') {
    const ok = await tryBwrapOnce()
    if (!ok.available) {
      availabilityCache = ok
      return availabilityCache
    }
  }
  availabilityCache = { available: true, reason: '' }
  return availabilityCache
}

async function tryBwrapOnce(): Promise<SandboxAvailability> {
  try {
    const proc = Bun.spawn(
      ['bwrap', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '/bin/true'],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    )
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    if (proc.exitCode !== 0) {
      return {
        available: false,
        reason: `bwrap probe failed (exit ${proc.exitCode}): ${stderr.trim().slice(0, 200)}`,
      }
    }
    return { available: true, reason: '' }
  } catch (err) {
    return { available: false, reason: `bwrap probe threw: ${(err as Error).message}` }
  }
}

/**
 * Default `ignoreViolations` we install in the SRT global config.
 * These are well-known macOS shell-startup probes that SRT's own
 * sysctl allowlist doesn't cover — every binary launched by sh
 * (bash, sleep, mkdir, touch, etc.) sysctl-reads them at init, so
 * without this filter every task floods with noise that isn't
 * actionable security signal.
 *
 * Format mirrors SRT's: `'*'` is a wildcard pattern; entries in the
 * array are substring-matched against the violation details line.
 * Users can ADD to this via per-task `sandbox.ignoreViolations`;
 * those are applied at violation read-back time, on top of the
 * defaults installed here.
 */
const DEFAULT_IGNORE_VIOLATIONS: Record<string, string[]> = {
  '*': [
    'kern.iossupportversion', // newer macOS sysctl SRT's allowlist misses
  ],
}

/**
 * One-time SRT initialization per orchestrator run. Starts the proxy
 * servers + (on macOS) the violation log monitor. Safe to call repeatedly
 * — SRT itself returns early on the second call.
 *
 * The base config sets network to "block everything" (empty allowedDomains).
 * Per-task wrapping passes a customConfig that re-enables network for
 * tasks with `sandbox.network: true`.
 */
export async function initSandbox(): Promise<void> {
  const { SandboxManager } = await loadSrt()
  await SandboxManager.initialize(
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      ignoreViolations: DEFAULT_IGNORE_VIOLATIONS,
    },
    undefined,
    // enableLogMonitor — macOS-only; populates the SandboxViolationStore.
    true,
  )
}

export async function resetSandbox(): Promise<void> {
  const { SandboxManager } = await loadSrt()
  await SandboxManager.reset()
  availabilityCache = undefined
  straceAvailableCache = undefined
}

export interface SandboxedRunArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[] | undefined
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** See `RunOptions.liveChildren` — same contract for sandboxed spawns. */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /** See `RunOptions.timeoutMs` — SIGTERM the child after this many ms. */
  timeoutMs?: number
  /** See `CaptureConfig` — which streams are retained on the result. */
  capture?: CaptureConfig
  /**
   * Baseline reads — paths the sandbox unconditionally allows. The
   * caller builds this from resolved `cache.inputs.files`.
   */
  baseAllowRead: readonly string[]
  /**
   * Baseline writes — paths the sandbox unconditionally allows for
   * writes. Built from the static prefix of `cache.outputs.files`.
   */
  baseAllowWrite: readonly string[]
  /**
   * Read-deny anchor. Combined with allowRead it produces the effective
   * deny set: anything under one of these paths that isn't in allowRead
   * is forbidden. Pass `[workspaceRoot]` to enforce project boundaries.
   */
  baseDenyRead: readonly string[]
  /**
   * User-declared sandbox block (after path-resolution). Path lists are
   * unioned with the baselines; bool/object fields fall through to SRT.
   */
  config: ResolvedSandboxConfig
}

/**
 * Sandbox config with all path fields resolved to absolute paths.
 * Produced by `resolveSandboxConfig`. The shape mirrors `SandboxConfig`
 * but every string in a path list is guaranteed absolute.
 */
export interface ResolvedSandboxConfig {
  allowRead: readonly string[]
  allowWrite: readonly string[]
  allowGitConfig?: boolean
  network?: boolean | SandboxNetworkConfig
  allowPty?: boolean
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  ignoreViolations?: Record<string, string[]>
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
function toRealPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(toRealPath(parent), path.basename(p))
  }
}

/**
 * Canonical form of every path the sandbox policy is expressed in.
 *
 * `resolveSandboxConfig` already canonicalizes the USER's paths; the
 * orchestrator-supplied baselines (resolved inputs, output prefixes, the
 * workspace-root deny anchor) arrived raw, so a workspace reached through a
 * symlink expressed HALF its policy in real paths and half in link paths.
 * bwrap then died mounting the link path inside its new root
 * (`Can't mount tmpfs on /newroot/<link>`) and EVERY sandboxed task failed —
 * whatever the config, with an error naming an internal path the user has no
 * way to act on. Canonicalizing here is what makes the two halves agree.
 */
function canonicalBaselines(args: SandboxedRunArgs): {
  allowRead: string[]
  allowWrite: string[]
  denyRead: string[]
  cwd: string
} {
  return {
    allowRead: args.baseAllowRead.map(toRealPath),
    allowWrite: args.baseAllowWrite.map(toRealPath),
    denyRead: args.baseDenyRead.map(toRealPath),
    cwd: toRealPath(args.cwd),
  }
}

/**
 * Convert a user-facing `SandboxConfig` (paths may be relative / tilde)
 * into a `ResolvedSandboxConfig` (all paths absolute + canonical) for a
 * given project. Relative paths resolve against `projectDir`; tilde
 * paths expand against the user's home; symlinks resolve to real paths.
 */
export function resolveSandboxConfig(
  cfg: SandboxConfig,
  projectDir: string,
): ResolvedSandboxConfig {
  const resolve = (p: string): string => {
    if (p.startsWith('~')) return toRealPath(path.join(os.homedir(), p.slice(1)))
    if (path.isAbsolute(p)) return toRealPath(p)
    return toRealPath(path.resolve(projectDir, p))
  }
  const r: ResolvedSandboxConfig = {
    allowRead: (cfg.allowRead ?? []).map(resolve),
    allowWrite: (cfg.allowWrite ?? []).map(resolve),
  }
  if (cfg.allowGitConfig !== undefined) r.allowGitConfig = cfg.allowGitConfig
  if (cfg.network !== undefined) r.network = cfg.network
  if (cfg.allowPty !== undefined) r.allowPty = cfg.allowPty
  if (cfg.enableWeakerNestedSandbox !== undefined) {
    r.enableWeakerNestedSandbox = cfg.enableWeakerNestedSandbox
  }
  if (cfg.enableWeakerNetworkIsolation !== undefined) {
    r.enableWeakerNetworkIsolation = cfg.enableWeakerNetworkIsolation
  }
  if (cfg.ignoreViolations !== undefined) r.ignoreViolations = cfg.ignoreViolations
  return r
}

export interface SandboxViolation {
  /** Raw log line from SRT. Format differs between macOS / Linux. */
  line: string
  timestamp: Date
}

export interface SandboxedRunResult extends RunResult {
  /** Violations captured during this task. Empty when nothing tripped. */
  violations: SandboxViolation[]
}

/**
 * Run a single task wrapped in the sandbox. Caller must have called
 * `initSandbox()` first.
 *
 * Violations are matched by a unique per-task command prefix — SRT's
 * `getViolationsForCommand` keys by base64 of the first 100 chars, so
 * two tasks running the same underlying command (e.g. parallel `tsc`
 * across packages) would otherwise collide. We prepend `: '<tag>';`
 * (shell no-op) to make every command's first 100 chars unique.
 */
export async function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult> {
  const { SandboxManager } = await loadSrt()
  const start = Date.now()
  const userCommand =
    args.forwardArgs && args.forwardArgs.length > 0
      ? args.command + ' ' + args.forwardArgs.map(shellQuote).join(' ')
      : args.command

  const tag = xxh3hex(`${args.cwd}|${userCommand}|${process.hrtime.bigint()}`).slice(0, 16)
  const taggedCommand = `: 'vx-${tag}'; ${userCommand}`

  const baselines = canonicalBaselines(args)
  const customConfig = buildCustomConfig(args, baselines)
  const wrapped = await SandboxManager.wrapWithSandbox(taggedCommand, undefined, customConfig)

  // Linux: SRT's SandboxViolationStore is macOS-only, so structured
  // detection on Linux requires us to wrap the spawn with strace and
  // parse the trace for denied syscalls. The trace is per-task (unique
  // log path keyed by the command tag) so parallel tasks don't share
  // a stream. Skipped when strace isn't on PATH — bwrap still enforces
  // structurally; we just lose the structured violation list.
  const useStrace = await wantsStraceDetection()
  const straceLog = useStrace ? path.join(os.tmpdir(), `vx-strace-${tag}.log`) : undefined
  // We trace only `openat` — it's the actual file-read attempt, the
  // signal the user cares about. `statx` / `newfstatat` / `access`
  // are mostly shell PATH-walking and stat probes that aren't
  // actionable (we'd report every node_modules/.bin entry the shell
  // checks before resolving a command).
  const spawnArgv = straceLog
    ? ['strace', '-f', '-e', 'trace=openat', '-o', straceLog, '--', 'sh', '-c', wrapped]
    : ['sh', '-c', wrapped]

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(spawnArgv, {
      cwd: args.cwd,
      env: args.env as Record<string, string>,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      exitCode: 127,
      durationMs: Date.now() - start,
      stdout: '',
      stderr: `\n[vx] failed to spawn sandboxed task: ${message}\n`,
      violations: [],
    }
  }

  args.liveChildren?.add(proc)
  const timeout = armTimeout(proc, args.timeoutMs)
  const ac = new AbortController()
  const streams = Promise.all([
    streamToString(proc.stdout, args.onStdout, ac.signal, args.capture?.stdout ?? true),
    streamToString(proc.stderr, args.onStderr, ac.signal, args.capture?.stderr ?? true),
  ])
  // See runCommand: gate on child exit; a lingering grandchild pipe (timeout
  // OR a clean exit that backgrounds a process) can't hang the run — timeout
  // aborts at once, otherwise drainOrAbort bounds the post-exit drain.
  await proc.exited
  timeout.clear()
  if (timeout.timedOut()) ac.abort()
  else await drainOrAbort(streams, ac)
  const [stdout, stderr] = await streams
  args.liveChildren?.delete(proc)
  const exitCode = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)

  // macOS: read the violation store keyed by our tagged command.
  const store = SandboxManager.getSandboxViolationStore()
  const macViolations = store.getViolationsForCommand(taggedCommand).map((v) => ({
    line: v.line,
    timestamp: v.timestamp,
  }))

  // Linux: parse the strace log and emit one violation per denied
  // syscall on a path inside denyRead that wasn't unconditionally
  // allowed. Best-effort — if parsing fails we surface no Linux
  // violations rather than fail the whole task.
  const linuxViolations: SandboxViolation[] = straceLog
    ? await parseStraceViolations(straceLog, args, baselines).catch(() => [])
    : []
  if (straceLog) await unlink(straceLog).catch(() => undefined)

  // Apply the task's own ignoreViolations on top of the global defaults.
  // SRT's wrapCommandWithSandboxMacOS doesn't actually thread customConfig.
  // ignoreViolations through to the log monitor — that filter is set
  // once globally at initSandbox time. So per-task user overrides have
  // to be applied here, after read-back.
  const userIgnore = args.config.ignoreViolations
  const violations: SandboxViolation[] = filterIgnored(
    [...macViolations, ...linuxViolations],
    userIgnore,
    userCommand,
  )

  try {
    SandboxManager.cleanupAfterCommand()
  } catch {
    // ignore; bwrap mount-point cleanup is best-effort
  }

  return {
    exitCode,
    durationMs: Date.now() - start,
    stdout,
    stderr,
    violations,
    ...(proc.signalCode ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...resourceUsageToCpuRss(proc.resourceUsage()),
  }
}

/** Memoized check: is `strace` on PATH on a Linux host? */
let straceAvailableCache: boolean | undefined
async function wantsStraceDetection(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  if (straceAvailableCache !== undefined) return straceAvailableCache
  try {
    const p = Bun.spawn(['strace', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    await p.exited
    straceAvailableCache = p.exitCode === 0
  } catch {
    straceAvailableCache = false
  }
  return straceAvailableCache
}

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
 * INCOMPLETE violation list — which for `--verify=inputs` reads as
 * `proven-complete`. We pair them by pid instead (a process has at most
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

async function parseStraceViolations(
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
    })
  }
  return out
}

function absolutize(p: string, cwd?: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  if (path.isAbsolute(p)) return p
  return path.resolve(cwd ?? process.cwd(), p)
}

function isUnderAny(abs: string, allow: Set<string>): boolean {
  if (allow.has(abs)) return true
  for (const a of allow) {
    if (abs === a || abs.startsWith(a + path.sep)) return true
  }
  return false
}

/**
 * Apply the task's user-provided `sandbox.ignoreViolations` map on top
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
function filterIgnored(
  violations: SandboxViolation[],
  ignore: Record<string, string[]> | undefined,
  userCommand: string,
): SandboxViolation[] {
  if (!ignore) return violations
  const wildcard = ignore['*'] ?? []
  const cmdEntries = Object.entries(ignore).filter(([k]) => k !== '*')
  return violations.filter((v) => {
    if (wildcard.some((s) => v.line.includes(s))) return false
    for (const [pattern, needles] of cmdEntries) {
      if (userCommand.includes(pattern) && needles.some((s) => v.line.includes(s))) {
        return false
      }
    }
    return true
  })
}

/**
 * Merge the orchestrator-provided baseline (declared inputs / outputs /
 * workspace-root anchor) with the user's resolved sandbox block to
 * produce the SRT customConfig. Path arrays are unioned and deduped.
 *
 * Network coercion:
 *   - missing / undefined / false  → block all (allowedDomains: [])
 *   - true                          → allow all (allowedDomains: ['*'])
 *   - object                        → use as-is (no merge with shortcuts)
 */
function buildCustomConfig(
  args: SandboxedRunArgs,
  baselines: {
    allowRead: readonly string[]
    allowWrite: readonly string[]
    denyRead: readonly string[]
  },
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const c = args.config
  const allowRead = unique([...baselines.allowRead, ...c.allowRead])
  const denyRead = unique([...baselines.denyRead])
  const allowWrite = unique([...baselines.allowWrite, ...c.allowWrite])

  const custom: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite: [],
      ...(c.allowGitConfig !== undefined ? { allowGitConfig: c.allowGitConfig } : {}),
    },
  }

  // Network coercion. SRT requires allowedDomains + deniedDomains to be
  // present on any network config; we always supply both.
  if (c.network === true) {
    custom.network = { allowedDomains: ['*'], deniedDomains: [] }
  } else if (c.network && typeof c.network === 'object') {
    custom.network = {
      allowedDomains: c.network.allowedDomains ?? [],
      deniedDomains: c.network.deniedDomains ?? [],
      ...(c.network.allowUnixSockets !== undefined
        ? { allowUnixSockets: c.network.allowUnixSockets }
        : {}),
      ...(c.network.allowAllUnixSockets !== undefined
        ? { allowAllUnixSockets: c.network.allowAllUnixSockets }
        : {}),
      ...(c.network.allowLocalBinding !== undefined
        ? { allowLocalBinding: c.network.allowLocalBinding }
        : {}),
      ...(c.network.allowMachLookup !== undefined
        ? { allowMachLookup: c.network.allowMachLookup }
        : {}),
    }
  } else {
    // false / undefined → block all
    custom.network = { allowedDomains: [], deniedDomains: [] }
  }

  if (c.allowPty !== undefined) custom.allowPty = c.allowPty
  if (c.enableWeakerNestedSandbox !== undefined) {
    custom.enableWeakerNestedSandbox = c.enableWeakerNestedSandbox
  }
  if (c.enableWeakerNetworkIsolation !== undefined) {
    custom.enableWeakerNetworkIsolation = c.enableWeakerNetworkIsolation
  }
  if (c.ignoreViolations !== undefined) custom.ignoreViolations = c.ignoreViolations
  return custom
}

function unique(arr: readonly string[]): string[] {
  return [...new Set(arr)]
}
