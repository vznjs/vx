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
//   sees ENOENT (or EPERM for some operations). SRT doesn't surface
//   structured events for Linux, so detection is enforcement-only.

import path from 'node:path'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import type { SandboxConfig, SandboxNetworkConfig } from '../config.js'
import { shellQuote, streamToString, resourceUsageToCpuRss, type RunResult } from './runner.js'
import { xxh3hex } from '../util/hash.js'

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
 * Does NOT detect runtime failures (e.g. Ubuntu 24's AppArmor blocking
 * unprivileged user namespaces while bwrap is still on PATH). Those
 * surface when the first task spawns and bwrap exits non-zero.
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
  availabilityCache = { available: true, reason: '' }
  return availabilityCache
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
}

export interface SandboxedRunArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  forwardArgs?: readonly string[] | undefined
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
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
  denyRead: readonly string[]
  allowWrite: readonly string[]
  denyWrite: readonly string[]
  allowGitConfig?: boolean
  network?: boolean | SandboxNetworkConfig
  allowPty?: boolean
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  ignoreViolations?: Record<string, string[]>
}

/**
 * Convert a user-facing `SandboxConfig` (paths may be relative / tilde)
 * into a `ResolvedSandboxConfig` (all paths absolute) for a given project.
 * Relative paths resolve against `projectDir`; tilde paths expand against
 * the user's home; absolute paths stay literal.
 */
export function resolveSandboxConfig(
  cfg: SandboxConfig,
  projectDir: string,
): ResolvedSandboxConfig {
  const resolve = (p: string): string => {
    if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
    if (path.isAbsolute(p)) return p
    return path.resolve(projectDir, p)
  }
  const r: ResolvedSandboxConfig = {
    allowRead: (cfg.allowRead ?? []).map(resolve),
    denyRead: (cfg.denyRead ?? []).map(resolve),
    allowWrite: (cfg.allowWrite ?? []).map(resolve),
    denyWrite: (cfg.denyWrite ?? []).map(resolve),
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

  const customConfig = buildCustomConfig(args)
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

  const [stdout, stderr] = await Promise.all([
    streamToString(proc.stdout, args.onStdout),
    streamToString(proc.stderr, args.onStderr),
  ])
  await proc.exited
  const exitCode = proc.exitCode ?? (proc.signalCode ? 130 : 1)

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
    ? await parseStraceViolations(straceLog, args).catch(() => [])
    : []
  if (straceLog) await unlink(straceLog).catch(() => undefined)

  const violations: SandboxViolation[] = [...macViolations, ...linuxViolations]

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
 * We capture the first quoted-string argument as the path. paths that
 * are relative resolve against the task's cwd (set by Bun.spawn).
 */
const STRACE_RE =
  /^\d+\s+(openat|access|statx|newfstatat)\([^"]*"([^"]+)"[^)]*\)\s*=\s*-1\s+(ENOENT|EACCES|EPERM)/gm

async function parseStraceViolations(
  logPath: string,
  args: SandboxedRunArgs,
): Promise<SandboxViolation[]> {
  const text = await Bun.file(logPath).text()
  if (text.length === 0) return []

  // Treat every baseAllow + sandbox.allowRead path as "this was
  // explicitly permitted; any -ENOENT here is the user's own missing
  // file, not a sandbox-induced denial". Same for absolute denyRead
  // checks below.
  const allowAbs = new Set<string>(
    [...args.baseAllowRead, ...args.config.allowRead].map((p) => absolutize(p)),
  )
  const denyAnchors = args.baseDenyRead.map((p) => absolutize(p))

  const seen = new Set<string>()
  const out: SandboxViolation[] = []
  for (const m of text.matchAll(STRACE_RE)) {
    const [, syscall, rawPath, errno] = m
    if (!rawPath) continue
    const abs = absolutize(rawPath, args.cwd)
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
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const c = args.config
  const allowRead = unique([...args.baseAllowRead, ...c.allowRead])
  const denyRead = unique([...args.baseDenyRead, ...c.denyRead])
  const allowWrite = unique([...args.baseAllowWrite, ...c.allowWrite])
  const denyWrite = unique([...c.denyWrite])

  const custom: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
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
