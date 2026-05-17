// Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for detecting
// undeclared filesystem reads/writes while a task runs.
//
// Policy: detect-and-skip-cache. The sandbox enforces declared inputs at
// the kernel level (bwrap on Linux, sandbox-exec on macOS); any read
// outside the declared `cache.inputs.files` is captured as a violation.
// Tasks pass through exit code unchanged — we don't fail the build on
// violations. We DO skip `cache.save()` so a cache hit can't replay
// outputs derived from undeclared inputs.
//
// Platform reality check:
//   macOS — `SandboxViolationStore` is populated from the system log
//   monitor in real time; violations carry the offending command +
//   syscall line, so we get a structured list back per task.
//   Linux  — bwrap denies the read at the kernel boundary; the child
//   sees EPERM/EACCES. SRT doesn't surface those structurally, so
//   detection on Linux is enforcement-only: a task that needed an
//   undeclared input will fail naturally (and a failed task doesn't
//   cache anyway). Tasks that tolerate the EPERM silently keep
//   running, no violation visible.
//
// All SRT touchpoints are isolated here so the orchestrator stays free
// of platform conditionals.

import { shellQuote, streamToString, resourceUsageToCpuRss, type RunResult } from './runner.js'
import { xxh3hex } from '../util/hash.js'

/** Lazy-loaded SRT module; populated on first use. */
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
 * unprivileged user namespaces while bwrap is still on the PATH). Those
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

export interface InitSandboxArgs {
  workspaceRoot: string
}

/**
 * One-time SRT initialization per orchestrator run. Starts the proxy
 * servers + (on macOS) the violation log monitor. Safe to call repeatedly
 * — SRT itself returns early on the second call.
 *
 * Network sandboxing is intentionally disabled: we're targeting filesystem
 * detection, and the proxy/seccomp dance for network is expensive and
 * breaks common tasks. `enableWeakerNetworkIsolation: true` skips the
 * macOS network namespace; on Linux SRT still allocates the bridge
 * sockets but the empty allowedDomains means all egress is filtered to
 * the proxy. For v1 we accept that limitation.
 */
export async function initSandbox(_args: InitSandboxArgs): Promise<void> {
  const { SandboxManager } = await loadSrt()
  await SandboxManager.initialize(
    {
      // Empty allowedDomains = block everything; we don't care about
      // network for the violation-detection use case. enableWeaker
      // sidesteps the macOS network namespace which otherwise costs
      // a few hundred ms on every wrapWithSandbox.
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowWrite: ['.', '/tmp'],
        denyWrite: [],
      },
      enableWeakerNetworkIsolation: true,
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
   * Absolute paths the task may read freely. Typically:
   *   - the project directory (its own source files)
   *   - every file resolved from `cache.inputs.files`
   *   - the workspace root's node_modules (dep resolution)
   */
  allowRead: readonly string[]
  /**
   * Absolute paths the task may write to. Typically the project
   * directory and the cache dir (so cache.save can run). `/tmp` is
   * always allowed via the base config.
   */
  allowWrite: readonly string[]
  /**
   * Absolute paths to flag as denied reads. Typically the workspace
   * root: combined with `allowRead`, this says "deny reading the whole
   * workspace except for these specific paths". That's how undeclared
   * inputs (sibling projects, root-level config files not in the
   * inputs glob) get surfaced as violations.
   */
  denyRead: readonly string[]
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
 * Run a single task wrapped in the sandbox. Caller is responsible for
 * having called `initSandbox()` first; this function asks SRT for a
 * wrapped command, spawns it via `sh -c`, captures output + resource
 * usage, then reads back any violations the log monitor recorded for
 * this specific command.
 *
 * Violations are matched by a unique per-task command prefix — SRT's
 * `getViolationsForCommand` keys by base64 of the first 100 chars, so
 * two tasks running the same underlying command (e.g. parallel `tsc`
 * across packages) would otherwise collide. We prepend `: '<tag>';` (the
 * shell no-op builtin) to make every command's first 100 chars unique.
 */
export async function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult> {
  const { SandboxManager } = await loadSrt()
  const start = Date.now()
  const userCommand =
    args.forwardArgs && args.forwardArgs.length > 0
      ? args.command + ' ' + args.forwardArgs.map(shellQuote).join(' ')
      : args.command

  // Unique tag: base64-encoded first 100 chars of the COMMAND become
  // the lookup key in SandboxViolationStore. Without a unique prefix,
  // sibling projects running the same command would share violations.
  const tag = xxh3hex(`${args.cwd}|${userCommand}|${process.hrtime.bigint()}`).slice(0, 16)
  const taggedCommand = `: 'vx-${tag}'; ${userCommand}`

  const wrapped = await SandboxManager.wrapWithSandbox(taggedCommand, undefined, {
    filesystem: {
      denyRead: [...args.denyRead],
      allowRead: [...args.allowRead],
      allowWrite: [...args.allowWrite],
      denyWrite: [],
    },
  })

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

  // Read violations for THIS command tag. The log-monitor delivers
  // events asynchronously on macOS; SRT's own teardown reads them
  // straight after exit, so by the time `await proc.exited` returns
  // any in-flight events have landed.
  const store = SandboxManager.getSandboxViolationStore()
  const matched = store.getViolationsForCommand(taggedCommand)
  const violations: SandboxViolation[] = matched.map((v) => ({
    line: v.line,
    timestamp: v.timestamp,
  }))

  // Best-effort: clear cleanup state SRT keeps around per command (it
  // tracks bwrap mount points etc.). Silent if not needed.
  try {
    SandboxManager.cleanupAfterCommand()
  } catch {
    // ignore
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
