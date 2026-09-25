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
import { mkdir, unlink } from 'node:fs/promises'
import type { SandboxConfig } from '../config.js'
import {
  armTimeout,
  drainOrAbort,
  POST_EXIT_CUT_LINE,
  shellQuote,
  signalExitCode,
  spawnFailureText,
  streamToString,
  resourceUsageToCpuRss,
  type CaptureConfig,
  type RunResult,
} from './runner.js'
import {
  executablePath,
  grantPrefix,
  isTmpdirRefusal,
  TMPDIR_HINT,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { buildCustomConfig } from './sandbox-binds.js'
import {
  isMountableLiteral,
  localBindingOn,
  MOUNT_WILDCARDS,
  toRealPath,
  unique,
} from './sandbox-paths.js'
import { parseStraceViolations, reportableViolations } from './sandbox-violations.js'
import { closeSignalChannel, signalThrough } from './kill-tree.js'

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
  if (deps.errors.length > 0) return { available: false, reason: dependencyReason(deps.errors) }
  const long = socketPathRefusal()
  if (long !== undefined) return { available: false, reason: long }
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

/**
 * Why the probe's sandboxed `true` failed, in the user's terms. The hint
 * names the CONFIG field (`exec.sandbox.weakerWhenNested`), not the
 * runtime option it maps to — a user who followed the runtime's name into
 * their config met the loader's unknown-field refusal instead of a fix
 * (`tests/sandbox-hint.test.ts` pins every field the hint names against
 * the loader).
 */
export function unavailableReason(exitCode: number | null, stderr: string): string {
  const hint = stderr.includes('uid_map')
    ? " — the runtime's seccomp helper cannot create its nested user namespace here (root inside a container, or a kernel that forbids nested user namespaces): run as a non-root user, or set `sandbox.weakerWhenNested: true` on every sandboxed task"
    : ''
  return `a sandboxed \`true\` failed (exit ${exitCode}): ${stderr.slice(0, 200)}${hint}`
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
    const proc = Bun.spawn([executablePath('sh'), '-c', wrapped], {
      argv0: 'sh',
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const stderr = (await new Response(proc.stderr).text()).trim()
    await proc.exited
    if (proc.exitCode === 0) return { available: true, reason: '' }
    return { available: false, reason: unavailableReason(proc.exitCode, stderr) }
  } catch (err) {
    return { available: false, reason: thrownReason(err, 'sandbox probe threw') }
  }
}

/**
 * The runtime's own dependency check names what is missing ("ripgrep (rg)
 * not found") and nothing else. On Linux it needs three binaries — bwrap
 * for the namespaces, socat for the network bridge, ripgrep to expand its
 * mandatory deny globs — and the docs named two of them until a minimal
 * image with the two failed on the third (2026-09-16). Name the set and
 * the install.
 */
export function dependencyReason(errors: readonly string[]): string {
  const need =
    process.platform === 'linux'
      ? 'the sandbox runtime needs bubblewrap (bwrap), socat and ripgrep (rg) on PATH'
      : 'the sandbox runtime is missing a dependency'
  return `${need}: ${errors.join('; ')} — install it (Linux: apt install bubblewrap socat ripgrep, or the same names in your package manager) and re-run`
}

/**
 * The runtime listens on `<tmpdir>/srt-mux-<pid>-<seq>.sock`, and a unix
 * socket path has a hard length (`sun_path`: 108 bytes on Linux, 104 on
 * macOS, one of them the NUL). Past it the runtime says "ENAMETOOLONG …
 * listen" on macOS and "Failed to create bridge sockets after 5 attempts"
 * on Linux (its retry loop swallows the code), neither naming the
 * directory (2026-09-16). Checked up front, with room for the sequence.
 */
export function socketPathRefusal(tmpdir = os.tmpdir()): string | undefined {
  const sample = path.join(tmpdir, `srt-mux-${process.pid}-zzz.sock`)
  const limit = process.platform === 'darwin' ? 103 : 107
  const length = Buffer.byteLength(sample)
  if (length <= limit) return undefined
  return `the sandbox runtime listens on a unix socket under the temp directory, and ${sample} is ${length} bytes where the OS allows ${limit} — point TMPDIR at a shorter path`
}

/**
 * A throw from the runtime itself, in the user's terms. Its own temp files
 * (the observer directory, the bridge sockets, the strace log) live under
 * `os.tmpdir()`, so a temp directory that is missing or not writable
 * failed a sandboxed task with a path and no knob ("EACCES … mkdtemp
 * '/tmp/probe-ro/srt-obs-…'", a minimal image, 2026-09-16).
 */
export function thrownReason(err: unknown, what = ''): string {
  const message = err instanceof Error ? err.message : String(err)
  if (isTmpdirRefusal(err)) {
    return `the sandbox runtime needs a writable temp directory and ${os.tmpdir()} is not one (${message}) — ${TMPDIR_HINT}`
  }
  return what === '' ? message : `${what}: ${message}`
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
 * Users can ADD to this via per-task `sandbox.ignore`;
 * those are applied at violation read-back time, on top of the
 * defaults installed here.
 */
const DEFAULT_IGNORE_VIOLATIONS: Record<string, string[]> = {
  '*': [
    'kern.iossupportversion', // newer macOS sysctl SRT's allowlist misses
  ],
}

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

/** Whether SRT is up in this process — set by `initSandbox`, cleared by `resetSandbox`. */
let srtUp = false

/**
 * SRT listens on `<tmpdir>/srt-mux-<pid>-<seq>.sock`, seq from 0, and a
 * killed run leaves those files behind; when the kernel hands the pid to a
 * later vx, its first listen meets EADDRINUSE and every sandboxed task
 * fails (255 of them after a stopped gate, 2026-09-16). A file carrying
 * OUR pid before SRT is up can only be a dead process's, so unlink the
 * contiguous run from seq 0 — a stat per file, no directory scan (a 7,000
 * entry /tmp reads in 9 ms; this is microseconds).
 */
async function unlinkStaleMuxSockets(): Promise<void> {
  for (let seq = 0; seq < 64; seq++) {
    const stale = path.join(os.tmpdir(), `srt-mux-${process.pid}-${seq.toString(36)}.sock`)
    try {
      await unlink(stale)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }
}

/**
 * One-time SRT initialization per orchestrator run. Starts the proxy
 * servers + (on macOS) the violation log monitor. Safe to call repeatedly
 * — SRT itself returns early on the second call.
 *
 * The base config sets network to "block everything" (empty allowedDomains).
 * Per-task wrapping passes a customConfig that re-enables network for
 * tasks with `sandbox.network: true`.
 *
 * @param opts.allowedDomains every domain any sandboxed task in this run
 * declared. SRT's filtering proxy is per-RUN and reads its allowlist from
 * this call, never from the per-task config, so the union is the only
 * place a domain list can take effect. Per-task precision survives where
 * it matters: a task that declared none is never handed the proxy port.
 */
export async function initSandbox(opts?: {
  allowedDomains?: readonly string[]
  /**
   * Lift SRT's seccomp block on `socket(AF_UNIX)` for every sandboxed
   * task of the run (Linux; per-run like the proxy allowlist, since SRT
   * reads it at `initialize()` only). Armed when any task declares
   * `unixSockets` or a `localBinding` port list — the port bridge is a
   * unix socket the task's side has to create.
   */
  allowAllUnixSockets?: boolean
}): Promise<void> {
  // Before SRT starts, so the very first task already has one.
  await mkdir(sandboxTmpdir(), { recursive: true })
  const { SandboxManager } = await loadSrt()
  const config: Parameters<typeof SandboxManager.initialize>[0] = {
    network: {
      allowedDomains: [...(opts?.allowedDomains ?? [])],
      deniedDomains: [],
      ...(opts?.allowAllUnixSockets === true ? { allowAllUnixSockets: true } : {}),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    ignoreViolations: DEFAULT_IGNORE_VIOLATIONS,
  }
  if (!srtUp) await unlinkStaleMuxSockets()
  await SandboxManager.initialize(
    config,
    undefined,
    // enableLogMonitor — macOS-only; populates the SandboxViolationStore.
    true,
  )
  srtUp = true
  // `initialize()` returns early once SRT is up, and on Linux the
  // availability probe brought it up with an EMPTY config before the run's
  // own call — so the run's allowlist and unix-socket allowance never
  // reached it (found 2026-09-10 by the port bridge: the task's side died
  // on `socket(AF_UNIX)` with the flag set). `updateConfig` is SRT's hot
  // reload of exactly these fields; the proxy and the wrapper read them
  // through getters, so the run's config is what every task sees.
  SandboxManager.updateConfig(config)
}

export async function resetSandbox(): Promise<void> {
  for (const tag of [...hostBridges.keys()]) releaseBridges(tag)
  const { SandboxManager } = await loadSrt()
  await SandboxManager.reset()
  srtUp = false
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
  /** Canonical directories whose denials are reported too (`ExecuteSandbox.reportLinked`). */
  readonly reportLinked: readonly string[]
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
  localBinding?: boolean | readonly number[]
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

function canonicalBaselines(
  args: Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseAllowWrite' | 'baseDenyRead' | 'cwd'>,
): CanonicalBaselines {
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
    allowRead: expandGrants((a.read ?? []).map(resolve), 'read'),
    allowWrite: expandGrants((a.write ?? []).map(resolve), 'write'),
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
 * The sandboxed form of a command: SRT's wrapper over the tagged command,
 * with vx's own seatbelt rules appended on macOS. This is the ENFORCEMENT
 * half of `runSandboxed`, shared with persistent tasks — a dev server is
 * spawned through it and never exits while the run watches, so it gets
 * the same walls and no violation report (reporting reads the trace after
 * exit). Returns the wrapped command and the tag the store keys by.
 */
export async function wrapSandboxedCommand(
  args: Pick<SandboxedRunArgs, 'command' | 'cwd' | 'forwardArgs' | 'config'> &
    Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseAllowWrite' | 'baseDenyRead'>,
): Promise<{
  wrapped: string
  tag: string
  taggedCommand: string
  baselines: CanonicalBaselines
  /** The command reads its polite signals off fd 3: spawn it with one and `signalThrough` it. */
  forwardsSignals: boolean
}> {
  const { SandboxManager } = await loadSrt()
  const userCommand =
    args.forwardArgs && args.forwardArgs.length > 0
      ? args.command + ' ' + args.forwardArgs.map(shellQuote).join(' ')
      : args.command

  const tag = xxh3hex(`${args.cwd}|${userCommand}|${process.hrtime.bigint()}`).slice(0, 16)
  const taggedCommand = `: 'vx-${tag}'; ${userCommand}`

  const baselines = canonicalBaselines(args)
  const customConfig = buildCustomConfig(args, baselines)
  // Linux: the ports a list grants are bridged out of the task's network
  // namespace. The task's side of each bridge is a socat in front of the
  // user command, so it goes INTO the sandboxed command; the host side is
  // spawned here and released when the task's process ends.
  const ports = process.platform === 'linux' ? bridgedPorts(args.config) : []
  const grouped =
    process.platform === 'linux'
      ? ownGroupCommand(tag, userCommand)
      : { command: taggedCommand, forwards: false }
  const inner =
    ports.length > 0 ? `${portBridgeInner(ports, tag)} ${grouped.command}` : grouped.command
  let wrapped = await SandboxManager.wrapWithSandbox(inner, undefined, customConfig)
  if (process.platform === 'darwin') {
    const rules = macProfileRules(args.config)
    if (rules.length > 0) wrapped = injectProfileRules(wrapped, rules)
  }
  if (ports.length > 0) spawnHostBridges(ports, tag)
  return { wrapped, tag, taggedCommand, baselines, forwardsSignals: grouped.forwards }
}

/**
 * Linux: the user command in a session, and so a process group, of its
 * own. bwrap's `--new-session` puts the runtime's shells (the proxy
 * bridges' script, the seccomp step's) in ONE group with the command, and
 * `kill 0` reaches a group's members across the nested pid namespace: a
 * command that signalled its own group ended the runtime's shell, bwrap
 * exited 143 and the namespace's teardown SIGKILLed the rest mid-trap
 * (item 751). The shell `exec`s `setsid`, which is no group leader here,
 * so it calls setsid() and execs without a fork: the command keeps the
 * shell's pid, and its status, a signal death included, is the one the
 * runtime waits on.
 *
 * The same group is where a cancellation lands. vx's group signal reaches
 * bwrap's monitor, which dies of it, and the namespace goes with SIGKILL,
 * so vx sends a polite signal's name down fd 3 instead (`signalThrough`)
 * and a watcher forked before the `exec` signals the group, `$$`, with it
 * (item 752). The command runs in the foreground because an `&` command
 * starts with SIGINT ignored, and a shell cannot trap what it inherited
 * ignored. The command does not get fd 3; a caller that passed none
 * forwards nothing, silently.
 *
 * Tools resolve on vx's own PATH; without `setsid` the command keeps the
 * shared group, as before, and `forwards` says the channel is not there.
 */
function ownGroupCommand(tag: string, userCommand: string): { command: string; forwards: boolean } {
  let setsid: string
  let bash: string
  try {
    setsid = executablePath('setsid')
    bash = executablePath('bash')
  } catch {
    return { command: `: 'vx-${tag}'; ${userCommand}`, forwards: false }
  }
  const watch = `{ IFS= read -r s && kill -s "$s" -- "-$$"; } 2>/dev/null <&3 3<&- &`
  const run = `exec ${shellQuote(setsid)} ${shellQuote(bash)} -c ${shellQuote(userCommand)} 3<&-`
  return { command: `: 'vx-${tag}'; ${watch} ${run}`, forwards: true }
}

/** The ports a list grants, deduped; `true` bridges nothing (the host sees no port on Linux). */
export function bridgedPorts(c: Pick<ResolvedSandboxConfig, 'localBinding'>): number[] {
  return Array.isArray(c.localBinding) ? [...new Set(c.localBinding)] : []
}

/** Where a bridge's unix socket lives: the sandbox tmpdir, bound read-write on both sides. */
export function portBridgeSocket(tag: string, port: number): string {
  return path.join(sandboxTmpdir(), `vx-port-${tag}-${port}.sock`)
}

/**
 * The task's side of the bridge, in front of the user command inside the
 * sandbox: one socat per port, listening on the unix socket and relaying
 * into the namespace's loopback. Backgrounded and reaped with the shell,
 * exactly as SRT starts its own proxy bridges. `unlink-early` clears a
 * socket a killed task left behind; `>/dev/null` keeps its chatter out
 * of the task's frame.
 */
export function portBridgeInner(ports: readonly number[], tag: string): string {
  const cmds = ports.map(
    (p) =>
      `socat UNIX-LISTEN:${shellQuote(portBridgeSocket(tag, p))},fork,unlink-early TCP:127.0.0.1:${p} >/dev/null 2>&1 &`,
  )
  return `${cmds.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT;`
}

/**
 * The host's side: one socat per port, listening on the host's loopback
 * and connecting into the unix socket per client — with a retry, since a
 * client can arrive before the task's side has bound the socket.
 */
export function portBridgeHostArgv(tag: string, port: number): string[] {
  return [
    'socat',
    `TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr`,
    `UNIX-CONNECT:${portBridgeSocket(tag, port)},retry=40,interval=0.25`,
  ]
}

const hostBridges = new Map<string, Array<ReturnType<typeof Bun.spawn>>>()

function spawnHostBridges(ports: readonly number[], tag: string): void {
  const procs: Array<ReturnType<typeof Bun.spawn>> = []
  for (const p of ports) {
    // A spawn failure (no socat on the host) is the task's to report:
    // its own side dies the same way, in its frame.
    try {
      procs.push(
        Bun.spawn(portBridgeHostArgv(tag, p), {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        }),
      )
    } catch {
      // see above
    }
  }
  if (procs.length > 0) hostBridges.set(tag, procs)
}

/** Stop the host side of a task's port bridges; idempotent. */
export function releaseBridges(tag: string): void {
  const procs = hostBridges.get(tag)
  if (procs === undefined) return
  hostBridges.delete(tag)
  for (const p of procs) {
    try {
      p.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
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
  const start = Date.now()
  const { SandboxManager } = await loadSrt()
  const { wrapped, tag, taggedCommand, baselines, forwardsSignals } =
    await wrapSandboxedCommand(args)

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
  //
  // `--seccomp-bpf` is what makes that filter cheap: without it strace
  // ptrace-stops the tracee on EVERY syscall and discards the untraced
  // ones in userspace, so a stat-heavy task ran many times slower under
  // the sandbox than outside it. That is what failed the cache perf
  // baselines on the Linux job (reproduced 2026-09-09: plain `bun test`
  // 24/24; under `strace -f -e trace=openat` the same four fail with
  // medians 2.5–7× over budget; with `--seccomp-bpf` 24/24 again), and
  // it taxed every other sandboxed task the same way. With the flag the
  // kernel filter stops only on `openat`. strace ≥ 5.3 (2019); an older
  // one gets the slow form rather than no detection.
  let proc: ReturnType<typeof Bun.spawn>
  try {
    // Both tools resolved on vx's own PATH (util/which.ts): strace would
    // otherwise walk the task's PATH for `sh`, where a project's
    // node_modules/.bin comes first.
    const sh = executablePath('sh')
    const spawnArgv = straceLog
      ? [
          executablePath('strace'),
          '-f',
          ...(useStrace === 'seccomp' ? ['--seccomp-bpf'] : []),
          '-e',
          'trace=openat',
          '-o',
          straceLog,
          '--',
          sh,
          '-c',
          wrapped,
        ]
      : [sh, '-c', wrapped]
    proc = Bun.spawn(spawnArgv, {
      argv0: straceLog ? 'strace' : 'sh',
      cwd: args.cwd,
      env: args.env as Record<string, string>,
      // fd 3 is the signal channel the in-sandbox watcher reads.
      stdio: forwardsSignals ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // As the unsandboxed spawn: its own process group (kill-tree.ts).
      detached: true,
    })
    if (forwardsSignals) signalThrough(proc, proc.stdio[3] as number)
  } catch (err) {
    const stderr = spawnFailureText(err, args.cwd, 'sandboxed task')
    args.onStderr?.(stderr)
    return { exitCode: 127, durationMs: Date.now() - start, stdout: '', stderr, violations: [] }
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
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac)
  const [stdout, streamed] = await streams
  if (cut) args.onStderr?.(POST_EXIT_CUT_LINE)
  const stderr = cut ? streamed + POST_EXIT_CUT_LINE : streamed
  args.liveChildren?.delete(proc)
  closeSignalChannel(proc)
  releaseBridges(tag)
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
    linked: args.reportLinked,
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
export function macProfileRules(c: ResolvedSandboxConfig): string[] {
  const rules: string[] = []
  for (const t of c.systemInfo ?? []) {
    rules.push(`(allow system-info (info-type "${sbplToken(t, 'allow.systemInfo')}"))`)
  }
  if (localBindingOn(c)) {
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
      for (const p of unique([
        sbplPath(sock, 'allow.unixSockets'),
        sbplResolvedPath(toRealPath(sock), 'allow.unixSockets'),
      ])) {
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
 * The check for a path the FILESYSTEM handed back (`toRealPath` of a
 * declared socket), which the declared-value allowlist above is wrong for:
 * a real macOS home is `/Users/Jane Smith`, and refusing the space would
 * regress every such layout to close a hole. What can leave the quoted
 * SBPL string, or the single-quoted `sandbox-exec -p '…'` argument it
 * travels in, is exactly a double quote, a backslash, a single quote, or a
 * control character — so only those are refused. Item 478 recorded the
 * hole (a symlink whose TARGET carries a quote went into the profile
 * unchecked, because the check was on the string the user wrote and the
 * interpolation was of the string the kernel resolves); item 582 closed
 * it. Refuse, never escape, as the sibling checkers do.
 */
export function sbplResolvedPath(value: string, field: string): string {
  // eslint-disable-next-line no-control-regex -- the control range is the point
  if (/["'\\\x00-\x1f\x7f]/.test(value)) {
    throw new UserError(
      `${field}: '${value}' (resolved from a symlink) carries a quote, a backslash or a control ` +
        `character, which cannot go into a seatbelt profile; point the link at a plain path`,
    )
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
 *
 * That last sentence is the whole contract, and until item 496 a task
 * that broke it learned so from its OWN tool. Measured, one task per
 * spelling, each writing files it declares:
 *
 *   write: ['g/**']         ok — collapsed to the directory
 *   write: ['g/a.txt']      ok — a literal is widened to its directory
 *   write: ['g/*']          FAILED: `bash: g/a.txt: Read-only file system`
 *   write: ['g/*.txt']      FAILED, same
 *   write: ['g/?.txt']      FAILED, same
 *   write: ['g/[ab].txt']   FAILED, same
 *
 * The failure names neither vx nor the grant, so `writeGrantMatchedNothing`
 * below says what happened and what to write instead. A READ grant that
 * matches nothing is ordinary (an optional file, a cache not yet
 * populated), so only writes are reported.
 *
 * The classifier is `isMountableLiteral` (sandbox-paths.ts), deliberately
 * NOT `isLiteralPattern`: its docblock says why the brace is not a wildcard
 * to a grant.
 */
function expandGrants(paths: readonly string[], kind: 'read' | 'write'): string[] {
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
    if (isMountableLiteral(p)) {
      out.push(p)
      continue
    }
    // Anchor the scan at the longest literal prefix so a pattern does not
    // walk the whole filesystem to find its matches.
    const base = path.dirname(p.slice(0, p.search(MOUNT_WILDCARDS)))
    const pattern = path.relative(base, p)
    let hits = 0
    for (const hit of new Bun.Glob(pattern).scanSync({ cwd: base, onlyFiles: false, dot: true })) {
      out.push(path.join(base, hit))
      hits++
    }
    if (hits === 0 && kind === 'write') writeGrantMatchedNothing(p)
  }
  return out
}

/** Grants already reported — once per process, not per spawn. */
const warnedEmptyWriteGrant = new Set<string>()

/**
 * A write grant that mounted nothing, said once, before the task dies on
 * it. The remedy is the directory, which is what the grant would have been
 * widened to anyway had it named a file — and it is named with
 * `grantPrefix`, the shared wildcard-free head, NOT the scan's anchor
 * above: that anchor is one component higher (`dirname` of the head, so
 * the relative pattern keeps its wildcard component), and printing it
 * would tell the user to grant the PARENT of the directory they meant.
 */
function writeGrantMatchedNothing(grant: string): void {
  if (warnedEmptyWriteGrant.has(grant)) return
  warnedEmptyWriteGrant.add(grant)
  process.stderr.write(
    `[vx] sandbox: the write grant ${grant} matches nothing yet, so it mounts nothing and ` +
      `a file the task creates under it will fail with "Read-only file system". A bind mount ` +
      `covers what exists when the task starts — grant the directory instead: ` +
      `${grantPrefix(grant)}/**\n`,
  )
}

/**
 * Memoized check: is `strace` on PATH on a Linux host, and does it know
 * `--seccomp-bpf` (5.3+)? `'seccomp'` is the fast form; `'plain'` traces
 * every syscall through ptrace and is kept only for an old strace.
 */
let straceAvailableCache: false | 'plain' | 'seccomp' | undefined
async function wantsStraceDetection(): Promise<false | 'plain' | 'seccomp'> {
  if (process.platform !== 'linux') return false
  if (straceAvailableCache !== undefined) return straceAvailableCache
  try {
    const p = Bun.spawn([executablePath('strace'), '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    if (p.exitCode !== 0) straceAvailableCache = false
    else {
      const m = /version (\d+)\.(\d+)/.exec(out)
      const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0]
      straceAvailableCache = major > 5 || (major === 5 && minor >= 3) ? 'seccomp' : 'plain'
    }
  } catch {
    straceAvailableCache = false
  }
  return straceAvailableCache
}
