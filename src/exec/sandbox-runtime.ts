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

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['sh', '-c', wrapped], {
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

  const store = SandboxManager.getSandboxViolationStore()
  const matched = store.getViolationsForCommand(taggedCommand)
  const violations: SandboxViolation[] = matched.map((v) => ({
    line: v.line,
    timestamp: v.timestamp,
  }))

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
