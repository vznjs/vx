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
import { readdirSync, realpathSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import type { SandboxConfig } from '../config.js'
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
import { UserError, xxh3hex } from '../util/index.js'

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

/** One verdict per mode: the wrapper the probe runs differs by mode. */
const availabilityCache = new Map<'secure' | 'weaker', SandboxAvailability>()

/**
 * Probe whether SRT can sandbox on this host. Memoized per mode — the
 * binary presence + platform check doesn't change within a process.
 *
 * In addition to SRT's own `checkDependencies` (which only verifies
 * binary presence on PATH), this runs ONE sandboxed `true` on Linux
 * through SRT's own wrapper: bwrap with the runtime's namespace flags
 * plus its vendored seccomp helper, which creates a NESTED user
 * namespace. A bare `bwrap … /bin/true` (the probe until 2026-09-04)
 * passed on hosts where every task then failed — as root inside a
 * container, the helper's `write /proc/self/uid_map` is EPERM under
 * `--cap-drop ALL`. Without this real-execution probe the
 * unavailability surfaces only at the first task spawn, deep inside the
 * orchestrator, as exit 1 with the helper's line in the task's stderr.
 *
 * `weakerNested` probes with `enableWeakerNestedSandbox`; the caller
 * passes it only when EVERY sandboxed task opts in, since the secure
 * wrapper is what any other task will run under.
 *
 * On Linux the probe INITIALIZES SRT (idempotent — `run()` initializes
 * right after anyway), and SRT's proxy sockets then keep the event loop
 * alive: a standalone caller must `resetSandbox()` or exit. CI's
 * diagnostic `bun -e` step sat on this for its whole 10-minute timeout
 * (2026-09-04).
 */
export async function probeSandbox(opts?: {
  weakerNested?: boolean
}): Promise<SandboxAvailability> {
  const mode = opts?.weakerNested === true ? 'weaker' : 'secure'
  const cached = availabilityCache.get(mode)
  if (cached) return cached
  const verdict = await probeUncached(mode === 'weaker')
  availabilityCache.set(mode, verdict)
  return verdict
}

async function probeUncached(weakerNested: boolean): Promise<SandboxAvailability> {
  const { SandboxManager } = await loadSrt()
  if (!SandboxManager.isSupportedPlatform()) {
    return { available: false, reason: `platform ${process.platform} not supported` }
  }
  const deps = SandboxManager.checkDependencies()
  if (deps.errors.length > 0) return { available: false, reason: deps.errors.join('; ') }
  if (process.platform === 'linux') {
    await initSandbox()
    return trySandboxedTrue(SandboxManager, weakerNested)
  }
  return applyPolicyHere()
}

/**
 * Can a seatbelt policy be applied in THIS process at all?
 *
 * Not if one already is: macOS refuses `sandbox_apply` inside a sandbox,
 * at any permission level — an inner profile of `(allow default)` still
 * dies `sandbox_apply: Operation not permitted` (exit 71, measured
 * 2026-09-05). No grant fixes it, so the honest verdict is "unavailable",
 * which is what stops a sandboxed task from spawning tasks that report
 * a sandbox they never got. Answering `available: true` here is how a
 * suite that exercises the sandbox came to fail sixteen ways at once.
 *
 * The probe costs one `/usr/bin/true` and is memoized with the rest.
 */
function applyPolicyHere(): SandboxAvailability {
  const proc = Bun.spawnSync({
    cmd: ['sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if (proc.exitCode === 0) return { available: true, reason: '' }
  const stderr = proc.stderr.toString().trim()
  if (stderr.includes('sandbox_apply')) {
    return {
      available: false,
      reason:
        'this process is already sandboxed and macOS cannot nest one — a task that ' +
        'itself sandboxes has to run without `exec.sandbox` of its own',
    }
  }
  return { available: false, reason: `sandbox-exec failed: ${stderr || `exit ${proc.exitCode}`}` }
}

async function trySandboxedTrue(
  SandboxManager: SrtModule['SandboxManager'],
  weakerNested: boolean,
): Promise<SandboxAvailability> {
  try {
    const wrapped = await SandboxManager.wrapWithSandbox(
      'true',
      undefined,
      weakerNested ? { enableWeakerNestedSandbox: true } : undefined,
    )
    const proc = Bun.spawn(['sh', '-c', wrapped], {
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const stderr = (await new Response(proc.stderr).text()).trim()
    await proc.exited
    if (proc.exitCode === 0) return { available: true, reason: '' }
    const hint = stderr.includes('uid_map')
      ? " — the runtime's seccomp helper cannot create its nested user namespace here (root inside a container, or a kernel that forbids nested user namespaces): run as a non-root user, or set `sandbox.enableWeakerNestedSandbox: true` on every sandboxed task"
      : ''
    return {
      available: false,
      reason: `a sandboxed \`true\` failed (exit ${proc.exitCode}): ${stderr.slice(0, 200)}${hint}`,
    }
  } catch (err) {
    return { available: false, reason: `sandbox probe threw: ${(err as Error).message}` }
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
/**
 * The temp directory SRT hands every sandboxed task. It overrides `TMPDIR`
 * so temp-file writers land somewhere its filesystem policy already allows,
 * and it deliberately does NOT create the directory — its own comment says
 * "/tmp/claude may not exist". Nobody else does either, so on any machine
 * that is not Claude Code's own, every sandboxed task that writes a temp
 * file died with ENOENT: this repo's `bun build --compile` under
 * a sandboxed `bun build --compile` reported only `error: An unknown error occurred
 * (Unexpected)` (2026-09-04). Resolution mirrors SRT's exactly.
 */
function sandboxTmpdir(): string {
  // `process.env`, not `Bun.env`: a caller that REPLACES the env object
  // (two tests here do, and an embedder may) leaves `Bun.env` pointing at
  // the original, so a late assignment would be invisible.
  const named = process.env['CLAUDE_CODE_TMPDIR'] ?? process.env['CLAUDE_TMPDIR']
  return named !== undefined && named !== '' ? named : '/tmp/claude'
}

/**
 * @param opts.allowedDomains every domain any sandboxed task in this run
 * declared. SRT's filtering proxy is per-RUN and reads its allowlist from
 * this call, never from the per-task config, so the union is the only
 * place a domain list can take effect. Per-task precision survives where
 * it matters: a task that declared none is never handed the proxy port.
 */
export async function initSandbox(opts?: { allowedDomains?: readonly string[] }): Promise<void> {
  // Before SRT starts, so the very first task already has one.
  await mkdir(sandboxTmpdir(), { recursive: true })
  const { SandboxManager } = await loadSrt()
  await SandboxManager.initialize(
    {
      network: { allowedDomains: [...(opts?.allowedDomains ?? [])], deniedDomains: [] },
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
  availabilityCache.clear()
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
   * Only denials on a path under this directory are reported. A denial
   * outside it is still ENFORCED — the task cannot leave its project — but
   * that is the wall doing its job, not a finding to fail a run over.
   */
  readonly reportWithin: string
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
  /** Readable path prefixes, absolute. */
  allowRead: readonly string[]
  /** Writable path prefixes, absolute. */
  allowWrite: readonly string[]
  network?: true | readonly string[]
  denyNetwork?: readonly string[]
  systemInfo?: readonly string[]
  unixSockets?: true | readonly string[]
  localBinding?: boolean
  machLookup?: readonly string[]
  pty?: boolean
  gitConfig?: boolean
  weakerWhenNested?: boolean
  weakerNetworkIsolation?: boolean
  ignore?: {
    read?: readonly string[]
    write?: readonly string[]
    systemInfo?: readonly string[]
    network?: readonly string[]
  }
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
interface CanonicalBaselines {
  allowRead: string[]
  allowWrite: string[]
  denyRead: string[]
  cwd: string
}

function canonicalBaselines(args: SandboxedRunArgs): CanonicalBaselines {
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
  const a = cfg.allow ?? {}
  const r: ResolvedSandboxConfig = {
    allowRead: expandGrants((a.read ?? []).map(resolve)),
    allowWrite: expandGrants((a.write ?? []).map(resolve)),
  }
  if (a.network !== undefined) r.network = a.network
  if (cfg.deny?.network !== undefined) r.denyNetwork = cfg.deny.network
  if (a.systemInfo !== undefined) r.systemInfo = a.systemInfo
  if (a.unixSockets !== undefined) r.unixSockets = a.unixSockets
  if (a.localBinding !== undefined) r.localBinding = a.localBinding
  if (a.machLookup !== undefined) r.machLookup = a.machLookup
  if (a.pty !== undefined) r.pty = a.pty
  if (a.gitConfig !== undefined) r.gitConfig = a.gitConfig
  if (cfg.weakerWhenNested !== undefined) r.weakerWhenNested = cfg.weakerWhenNested
  if (cfg.weakerNetworkIsolation !== undefined) {
    r.weakerNetworkIsolation = cfg.weakerNetworkIsolation
  }
  if (cfg.ignore !== undefined) {
    // Relative patterns anchor at the project dir; absolute and `~` ones
    // are taken as written. NOT realpath'd — a pattern is not a path.
    const anchor = (pat: string): string =>
      pat.startsWith('~') || path.isAbsolute(pat) ? pat : path.join(projectDir, pat)
    r.ignore = {
      ...(cfg.ignore.read ? { read: cfg.ignore.read.map(anchor) } : {}),
      ...(cfg.ignore.write ? { write: cfg.ignore.write.map(anchor) } : {}),
      ...(cfg.ignore.systemInfo ? { systemInfo: [...cfg.ignore.systemInfo] } : {}),
      ...(cfg.ignore.network ? { network: [...(cfg.ignore.network as string[])] } : {}),
    }
  }
  return r
}

export interface SandboxViolation {
  /** Raw log line from SRT. Format differs between macOS / Linux. */
  line: string
  timestamp: Date
  /**
   * What the denial named, and which `ignore` lists could silence it —
   * filled in by whichever platform produced the record. The filters read
   * these instead of re-parsing a line whose shape depends on the OS: a
   * seatbelt `deny(1) file-read-data /x` and a strace
   * `openat(../x) = -1 ENOENT  [/x]` say the same thing.
   */
  target?: string
  /** Absolute, when `target` is a path at all. */
  path?: string
  ignorable?: readonly ('read' | 'write' | 'network' | 'systemInfo')[]
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
  let wrapped = await SandboxManager.wrapWithSandbox(taggedCommand, undefined, customConfig)
  if (process.platform === 'darwin') {
    const rules = macProfileRules(args.config)
    if (rules.length > 0) wrapped = injectProfileRules(wrapped, rules)
  }

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
  //
  // The store is fed ASYNCHRONOUSLY — SRT's monitor ingests macOS unified-log
  // records, and log delivery lags under load — so reading it immediately
  // after child exit races the pipeline: the denial happened, the child died
  // on it, and the store is still empty. Observed locally as the 1-in-N
  // "denied but zero violation lines" flake (decision log 2026-08-23/24).
  // When the exit is a FAILURE and the store is empty, give the pipeline a
  // bounded settle window; a clean exit skips the poll entirely, so the warm
  // path pays nothing.
  //
  // MEASURED (2026-08-24, ~430 runs/arm under full-suite load): the poll
  // HALVES the loss (5.0% → 2.2%) but cannot eliminate it — the residual
  // failures survive the whole 1 s window, meaning those records were
  // DROPPED by the unified log under pressure, not delayed. Reporting on
  // macOS is therefore lossy-by-OS under load; ENFORCEMENT is unaffected
  // (every observed loss still denied the read and failed the child).
  const store = SandboxManager.getSandboxViolationStore()
  // EVERY record the store holds for this command, unfiltered (owner,
  // 2026-09-05). A sandboxed task that fails must say what it was denied;
  // deciding on the user's behalf that a record was "just traversal" is how
  // a failure ends up with an empty violations section and no explanation.
  const readMacViolations = (): SandboxViolation[] =>
    store.getViolationsForCommand(taggedCommand).map((v) => ({
      line: v.line,
      timestamp: v.timestamp,
    }))
  // Darwin only. Since SRT 0.0.75 the store is fed on Linux too, by the
  // seccomp helper's write observer — but SRT judges those reports against
  // the GLOBAL `filesystem.allowWrite` from `initialize` (empty here; the
  // per-task list travels in `customConfig`, which the monitor never sees),
  // so every write a task makes to its own declared output arrived as
  // `deny openat <output>` and failed the task (reproduced 2026-09-04 in a
  // Linux container: exit 1, empty stderr). Linux detection is the strace
  // pass below, judged against the task's own baselines.
  let macViolations = process.platform === 'darwin' ? readMacViolations() : []
  // The fail-exit gate keeps the warm path free — EXCEPT when the caller
  // says a clean exit + empty store will be read as PROOF (verify=inputs):
  // a leaky task that swallows its own read error exits 0, so without the
  // settle window a late unified-log record becomes a FALSE PASS of the
  // verify (measured locally 2026-08-24: 1/30 at idle, the same lossy
  // channel as the fail-exit case).
  // No settle window: the store is read once, right after the child exits
  // (owner, 2026-09-05). It cost 300ms on EVERY clean sandboxed task — the
  // full budget, since a task with nothing to report can only prove that by
  // waiting — against 26ms for one that reports something and breaks out
  // early. Measured: clean `echo` 331ms sandboxed vs 16ms plain.
  //
  // The price is that macOS feeds this store asynchronously, so a record
  // that has not arrived yet is not reported. Enforcement is unaffected —
  // the OS denied the operation either way, and a command that could not
  // proceed still fails on its own exit code.
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
  const violations = reportableViolations([...macViolations, ...linuxViolations], {
    within: args.reportWithin,
    config: args.config,
  })

  // The one denial macOS never logs. MEASURED 2026-09-05, same machine, two
  // runs differing only in the grant: with the cwd granted a failing task
  // reports its denials normally; WITHOUT it the store stays empty across
  // the whole settle window (11 reads, 0 records) and the child reports
  // whatever it likes — `bun test` says only `error: An unknown error
  // occurred (Unexpected)`. The process dies before macOS logs anything, so
  // no amount of un-filtering can surface it.
  //
  // Not a guess about the cause: the cwd lying outside every allowRead
  // prefix is a fact of the resolved baselines. Added only when the task
  // ALREADY failed with nothing to show, so it can never redden a pass.
  const grantedRead = [...baselines.allowRead, ...args.config.allowRead]
  if (exitCode !== 0 && violations.length === 0 && !readableUnder(args.cwd, grantedRead)) {
    violations.push({
      timestamp: new Date(),
      line:
        `vx: this sandbox grants no read access to the task's own working directory ` +
        `(${args.cwd}), so a command that reads or lists it fails with whatever error it ` +
        `reports for that — macOS logs no violation record. Add ` +
        "`sandbox: { allow: { read: ['.'] } }`.",
    })
  }

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

/**
 * Is `dir` inside a path the sandbox granted for reading? bwrap binds and
 * seatbelt rules are both prefix-based, so a grant covers the subtree.
 */
function readableUnder(dir: string, granted: readonly string[]): boolean {
  const target = toRealPath(dir)
  return granted.some((p) => {
    const g = toRealPath(p)
    return target === g || target.startsWith(g.endsWith(path.sep) ? g : g + path.sep)
  })
}

/**
 * A token safe to interpolate into a seatbelt profile. The profile travels
 * inside a shell-quoted `sandbox-exec -p '…'` argument, so a value carrying
 * a quote, paren or backslash could rewrite the policy or escape the
 * argument. Refuse rather than escape — every real info type is a plain
 * dotted name.
 */
function sbplToken(value: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new UserError(`${field}: '${value}' is not a valid name`)
  }
  return value
}

/**
 * The capabilities that reach the macOS profile as rules rather than
 * through SRT's config.
 *
 * `systemInfo` has no SRT field at any level. The rest DO have fields,
 * but SRT reads `network.allowLocalBinding` / `allowUnixSockets` /
 * `allowMachLookup` off the config given to `initialize()` and never off
 * the per-call one (`sandbox-manager.js` getters, 0.0.75) — so a per-task
 * grant passed there is silently dropped. vx is per-task by definition,
 * so it emits them itself. The rule text mirrors SRT's own.
 */
function macProfileRules(c: ResolvedSandboxConfig): string[] {
  const rules: string[] = []
  for (const t of c.systemInfo ?? []) {
    rules.push(`(allow system-info (info-type "${sbplToken(t, 'allow.systemInfo')}"))`)
  }
  if (c.localBinding === true) {
    // `*:*`, not `localhost:*`: a dual-stack socket bound to 127.0.0.1 is
    // ::ffff:127.0.0.1 in the kernel, which seatbelt's `localhost` does
    // not match. bind and inbound carry no remote endpoint, so this is
    // not egress. Egress stays pinned to loopback.
    rules.push('(allow network-bind (local ip "*:*"))')
    rules.push('(allow network-inbound (local ip "*:*"))')
    rules.push('(allow network-outbound (remote ip "localhost:*"))')
  }
  if (c.unixSockets === true) {
    rules.push('(allow system-socket (socket-domain AF_UNIX))')
    rules.push('(allow network-bind (local unix-socket (path-regex #"^/")))')
    rules.push('(allow network-outbound (remote unix-socket (path-regex #"^/")))')
  } else if (c.unixSockets !== undefined && c.unixSockets.length > 0) {
    rules.push('(allow system-socket (socket-domain AF_UNIX))')
    for (const sock of c.unixSockets) {
      // Both the declared path and what it resolves to: seatbelt matches the
      // path the kernel sees, and on macOS `/tmp` is a symlink to
      // `/private/tmp` — a grant on the former alone never matches.
      for (const p of unique([sbplPath(sock, 'allow.unixSockets'), toRealPath(sock)])) {
        rules.push(`(allow network-bind (local unix-socket (subpath "${p}")))`)
        rules.push(`(allow network-outbound (remote unix-socket (subpath "${p}")))`)
      }
    }
  }
  for (const name of c.machLookup ?? []) {
    rules.push(`(allow mach-lookup (global-name "${sbplToken(name, 'allow.machLookup')}"))`)
  }
  return rules
}

/**
 * A path safe to interpolate into a seatbelt profile. Same reasoning as
 * {@link sbplToken}, with the separators a path needs.
 */
function sbplPath(value: string, field: string): string {
  if (!/^[A-Za-z0-9._\-/@+]+$/.test(value) || value.includes('..')) {
    throw new UserError(`${field}: '${value}' is not a valid path`)
  }
  return value
}

/**
 * Add rules to the END of the seatbelt profile SRT generated.
 *
 * SBPL is last-match-wins, so the tail is the only place a rule of ours
 * outranks one of SRT's. Measured 2026-09-05: the same rules injected
 * after the `(deny default …)` header were inert in both directions —
 * SRT's own later clauses won. Filesystem capabilities still go through
 * SRT's config, where they also work on Linux; what arrives here is what
 * SRT's per-call config CANNOT carry.
 *
 * A profile that does not have the expected shape THROWS. Silently
 * running a task without a capability it asked for is worse than not
 * offering the capability.
 */
function injectProfileRules(wrapped: string, rules: readonly string[]): string {
  const anchor = /sandbox-exec -p '\(version 1\)\n\(deny default[^\n]*\n/.exec(wrapped)
  if (anchor === null) {
    throw new UserError(
      'sandbox: the OS sandbox policy did not have the expected shape, so the ' +
        'capabilities this task declared could not be applied',
    )
  }
  // The profile is a single-quoted shell argument; SRT escapes a literal
  // quote inside it as `'"'"'` (5 chars). The first bare `'` after the
  // header therefore closes the profile.
  let i = anchor.index + anchor[0].length
  for (;;) {
    const q = wrapped.indexOf("'", i)
    if (q === -1) {
      throw new UserError(
        'sandbox: the OS sandbox policy was not quoted as expected, so the ' +
          'capabilities this task declared could not be applied',
      )
    }
    if (wrapped.startsWith(`'"'"'`, q)) {
      i = q + 5
      continue
    }
    return `${wrapped.slice(0, q)}\n${rules.join('\n')}\n${wrapped.slice(q)}`
  }
}

/**
 * Grant paths, with globs handled per platform.
 *
 * macOS: SRT's own `pathFilter` turns a glob into `(regex …)` and a literal
 * into `(subpath …)`, so a pattern is passed through and seatbelt matches
 * it — including files created DURING the run.
 *
 * Linux: a grant is a bwrap bind mount, and you cannot mount a pattern.
 * The glob is expanded against the filesystem here, which means it covers
 * what exists when the task STARTS. A pattern matching a file the task
 * creates later grants nothing there — declare its directory instead.
 */
function expandGrants(paths: readonly string[]): string[] {
  // A pattern covering a directory WHOLE is that directory. `<d>/**/*` and
  // `<d>/**` match everything UNDER `<d>` and never `<d>` itself, so a task
  // granted `read: ['**/*']` still could not list its own cwd — the exact
  // shape `bun test` and `oxlint` need. Collapsing is not a widening: the
  // pattern already covered every file there; it adds the directory entry.
  const collapsed = paths.map((p) => {
    const m = /^(.*?)\/\*\*(?:\/\*)?$/.exec(p)
    return m === null ? p : m[1]!
  })
  if (process.platform !== 'linux') return collapsed
  const out: string[] = []
  for (const p of collapsed) {
    if (!/[*?[\]]/.test(p)) {
      out.push(p)
      continue
    }
    // Anchor the scan at the longest literal prefix so a pattern does not
    // walk the whole filesystem to find its matches.
    const base = path.dirname(p.slice(0, p.search(/[*?[\]]/)))
    const pattern = path.relative(base, p)
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: base, onlyFiles: false, dot: true })) {
      out.push(path.join(base, hit))
    }
  }
  return out
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
  const loopbackGranted = config.localBinding === true || config.network !== undefined
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
/**
 * Expand a read grant so it is never an ANCESTOR of a write grant.
 *
 * bwrap builds the sandbox out of mounts, and SRT emits them write-first:
 * `--bind <out>` then `--ro-bind <readPath>`. When the read path is an
 * ancestor of the write path the read-only mount lands ON TOP of the
 * writable one and every write fails with `Read-only file system`
 * (`pushReadDenyDirMounts`, SRT 0.0.75 — its skip only covers the reverse
 * nesting). Verified in a Linux container 2026-09-05:
 *
 *   read=[proj]     write=[proj/dist]  → mkdir: Read-only file system
 *   read=[proj/src] write=[proj/dist]  → ok
 *   read=[proj]     no writes          → ok
 *
 * So punch the write paths out: grant the ancestor's children instead,
 * recursing only along the branches that actually contain one. Same probe,
 * same command: `read=[src, lib, package.json] write=[dist]` → ok. macOS
 * never needed this (seatbelt is precedence-based, not mounts), and it is
 * harmless there, so both platforms take the same path.
 *
 * A grant with no write path under it is returned untouched — the common
 * case costs nothing, not even a readdir.
 */
export function punchWritePaths(readPath: string, writePaths: readonly string[]): string[] {
  // Linux only. The shadowing is a property of bwrap MOUNTS; macOS seatbelt
  // evaluates rules by precedence, so a read grant on a directory and a
  // write grant inside it coexist. Punching there costs the directory
  // ENTRY: granting every child is not granting the dir, so a command that
  // stats its own cwd — `bun build` — is denied it and dies with
  // `error: An unknown error occurred (Unexpected)` (2026-09-05).
  if (process.platform !== 'linux') return [readPath]
  const under = writePaths.filter((w) => w !== readPath && w.startsWith(readPath + path.sep))
  if (under.length === 0) return [readPath]
  let entries: string[]
  try {
    entries = readdirSync(readPath)
  } catch {
    // Unreadable or not a directory: nothing to expand, hand it over as is.
    return [readPath]
  }
  const out: string[] = []
  for (const entry of entries) {
    const child = path.join(readPath, entry)
    // A write path is already bound read-write, which is readable.
    if (under.includes(child)) continue
    out.push(...punchWritePaths(child, under))
  }
  return out
}

function buildCustomConfig(
  args: SandboxedRunArgs,
  baselines: {
    allowRead: readonly string[]
    allowWrite: readonly string[]
    denyRead: readonly string[]
  },
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const c = args.config
  const denyRead = unique([...baselines.denyRead])
  const allowWrite = unique([...baselines.allowWrite, ...c.allowWrite])
  const allowRead = unique(
    [...baselines.allowRead, ...c.allowRead].flatMap((r) => punchWritePaths(r, allowWrite)),
  )

  const custom: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite: [],
      ...(c.gitConfig !== undefined ? { allowGitConfig: c.gitConfig } : {}),
    },
  }

  // `allow.network` / `deny.network` become SRT's domain lists. SRT requires
  // both to be present on any network config, so we always supply both;
  // omitted means no network at all.
  custom.network = {
    allowedDomains: c.network === true ? ['*'] : [...(c.network ?? [])],
    deniedDomains: [...(c.denyNetwork ?? [])],
    ...(c.unixSockets === true
      ? { allowAllUnixSockets: true }
      : c.unixSockets !== undefined
        ? { allowUnixSockets: [...c.unixSockets] }
        : {}),
    ...(c.localBinding !== undefined ? { allowLocalBinding: c.localBinding } : {}),
    ...(c.machLookup !== undefined ? { allowMachLookup: [...c.machLookup] } : {}),
  }

  if (c.pty !== undefined) custom.allowPty = c.pty
  if (c.weakerWhenNested !== undefined) {
    custom.enableWeakerNestedSandbox = c.weakerWhenNested
  }
  if (c.weakerNetworkIsolation !== undefined) {
    custom.enableWeakerNetworkIsolation = c.weakerNetworkIsolation
  }
  return custom
}

function unique(arr: readonly string[]): string[] {
  return [...new Set(arr)]
}
