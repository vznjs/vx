// Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for enforcing
// per-task filesystem + network isolation.
//
// Design contract:
//   The caller (sandbox/request.ts) hands over the task's own
//   `sandbox.allow` block plus two baselines: the `node_modules` reads a
//   task's dependencies need, and the workspace-root deny anchor. Writes
//   are the task's `allow.write` alone — nothing is derived from `cache`.
//   This module adds nothing implicit on top — no /tmp, no project dir —
//   so what a task may touch is its vx.config.ts plus those baselines.
//
// Network is a domain list, and the run's: SRT's one proxy filters every
// sandboxed task against the union of the lists the run's tasks declare.
// With no list, no domain is reachable; `sandbox.network: true` adds none.
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
import {
  chmodSync,
  closeSync,
  lstatSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { SandboxConfig } from '../config.js'
import {
  armTimeout,
  drainOrAbort,
  lineEnds,
  POST_EXIT_CUT_LINE,
  shellQuote,
  withForwardArgs,
  signalExitCode,
  stopSignal,
  SANDBOXED_TASK,
  sandboxArgTooLongText,
  spawnFailureText,
  streamToString,
  resourceUsageToCpuRss,
  type CaptureConfig,
  type ResolvedSandboxConfig,
  type RunResult,
  type SandboxViolation,
  type TreeUsage,
} from '../exec/index.js'
import { TaskPipes } from '../exec/index.js'
import { startTaskProxy, type TaskProxy } from './task-proxy.js'
import { watchTree } from '../exec/index.js'
import {
  BUN_GLOB_WILDCARDS,
  ESSENTIAL_ENV,
  executablePath,
  helperEnv,
  holdSecret,
  taskShell,
  grantPrefix,
  isTmpdirRefusal,
  notify,
  procfsIsOwn,
  relPosix,
  scannable,
  taskGlobOf,
  TMPDIR_HINT,
  UserError,
  xxh3hex,
} from '../util/index.js'
import {
  bindableReads,
  bindableWrites,
  buildCustomConfig,
  type TaskSandboxConfig,
  linkedWriteBinds,
  punchedLinks,
  withPunchedLinks,
  readOnlyMasks,
  withCwd,
  scratchWrites,
  globDir,
  widenedEntries,
  withLinkedWrites,
} from './binds.js'
import {
  atOrUnder,
  grantAlternatives,
  isMountableLiteral,
  localBindingOn,
  loopbackPorts,
  MOUNT_WILDCARDS,
  namedPath,
  toRealPath,
  unique,
} from './paths.js'
import { canScopeDenyScan, scopedMandatoryDenies, srtDefaultWritePaths } from './deny-scan.js'
import {
  hiddenReadsOutside,
  parseStraceViolations,
  refusedConnections,
  refusedWrites,
  refusedWritesOutside,
  reportableViolations,
} from './violations.js'
import {
  closeSignalChannel,
  groupAlive,
  killTree,
  releaseGroup,
  runTime,
  signalThrough,
  guardLine,
  guardSession,
  spawnGuarded,
} from '../exec/index.js'

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime')
let srtPromise: Promise<SrtModule> | undefined
/** Set once loaded, for `releaseBridges`, which a sync exit handler calls. */
let srtLoaded: SrtModule | undefined

async function loadSrt(): Promise<SrtModule> {
  if (!srtPromise) {
    srtPromise = import('@anthropic-ai/sandbox-runtime').then((m) => (srtLoaded = m))
  }
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
  // SRT checks the scan command its live config names, and once that is
  // vx's no-scan file (B-92) a process `exit` hook may have removed it
  // while the process goes on: name one that is there.
  const deps = SandboxManager.checkDependencies(
    noScan === undefined ? undefined : { command: scanCommandAgain() },
  )
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
    env: helperEnv(),
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
  const hint = stderr.includes('capability-restricted')
    ? // Ubuntu 25.04+ confines bwrap with this AppArmor profile (2026-10-23).
      " — AppArmor's bwrap-userns-restrict profile strips the capabilities of the seccomp helper's nested user namespace: replace it with a profile for /usr/bin/bwrap that grants `userns,` (https://discourse.ubuntu.com/t/58007)"
    : stderr.includes('uid_map')
      ? " — the runtime's seccomp helper cannot create its nested user namespace here (root inside a container, or a kernel that forbids nested user namespaces): run as a non-root user, or set `sandbox.weakerWhenNested: true` on every sandboxed task"
      : ''
  return `a sandboxed \`true\` failed (exit ${exitCode}): ${stderr.slice(0, 200)}${hint}`
}

/** vx's values of the variables every task gets (`ESSENTIAL_ENV`). */
function essentialEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ESSENTIAL_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
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
    const proc = Bun.spawn([taskShell(), '-c', wrapped], {
      argv0: 'sh',
      // What a task gets of vx's env: the probe is a sandboxed `true`.
      env: essentialEnv(),
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
function dependencyReason(errors: readonly string[]): string {
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
 * On Linux the longer name is the network bridge's,
 * `claude-http-<16 hex>.sock`, and it is the one that fails there.
 *
 * Both directories that hold sockets are also checked for what the paths
 * pass through: `tmpdir`, where the runtime puts its bridges, and
 * `taskTmp`, the parent of vx's own task temp directories (`taskTmpdir`).
 */
export function socketPathRefusal(
  tmpdir = os.tmpdir(),
  taskTmp = sandboxTmpdir(),
): string | undefined {
  const unsafe =
    unquotableSocketDir(tmpdir, 'TMPDIR') ?? unquotableSocketDir(taskTmp, 'CLAUDE_CODE_TMPDIR')
  if (unsafe !== undefined) return unsafe
  const sample = path.join(
    tmpdir,
    process.platform === 'linux'
      ? `claude-http-${'0'.repeat(16)}.sock`
      : `srt-mux-${process.pid}-zzz.sock`,
  )
  const limit = process.platform === 'darwin' ? 103 : 107
  const length = Buffer.byteLength(sample)
  if (length <= limit) return undefined
  return `the sandbox runtime listens on a unix socket under the temp directory, and ${sample} is ${length} bytes where the OS allows ${limit} — point TMPDIR at a shorter path`
}

/**
 * The runtime pastes its bridge socket's path unquoted into the shell
 * script it runs inside the sandbox and into socat addresses on the host,
 * and vx's port bridges hand theirs to socat and splice them into bwrap's
 * command line. Shell splits on whitespace and its metacharacters, socat on
 * `:` `,` `!` and `\`, and a relative path names another directory inside
 * the sandbox: `;` hung the run, a space cost every task ~7 s and its
 * network proxy, `,` failed "Failed to create bridge sockets" (2026-11-10).
 * Each character this lets through was run as both directories. Not a
 * non-ASCII letter: the runtime quotes it in the command it hands back, and
 * a networked task's proxy front, found by the bare path, was not swapped in.
 */
const SOCKET_DIR = /^\/[A-Za-z0-9._\-/+@]*$/

function unquotableSocketDir(dir: string, variable: string): string | undefined {
  if (SOCKET_DIR.test(dir)) return undefined
  const why = path.isAbsolute(dir) ? 'holds a character they cannot carry' : 'is not absolute'
  return `the sandbox runtime writes socket paths under ${variable} unquoted into shell and socat commands, and ${JSON.stringify(dir)} ${why} — point ${variable} at an absolute path of ASCII letters, digits and . _ - / + @`
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

/**
 * The temp files of tasks still running: strace logs and port-bridge
 * sockets. A signal exit is `process.exit` (orchestrator/signals.ts),
 * which never reaches a task's own unlink, so a Ctrl-C left one log per
 * sandboxed task in the temp dir (item 848); the process's `exit` event
 * removes what is still listed.
 */
const liveTempFiles = new Set<string>()
let tempExitHooked = false
function unlinkOnExit(file: string): void {
  liveTempFiles.add(file)
  if (tempExitHooked) return
  tempExitHooked = true
  process.on('exit', () => {
    for (const f of liveTempFiles) {
      try {
        unlinkSync(f)
      } catch {
        // never written, or gone
      }
    }
  })
}

/**
 * A task's own temp directory, `TMPDIR` inside its sandbox. SRT points
 * every sandboxed task at ONE host directory (`sandboxTmpdir`), bound
 * read-write and kept across runs, so a file one task wrote there was
 * another's undeclared input: a cached reader replayed the first value it
 * saw after the writer changed it (item 965). Created for the task, removed
 * with its bridges at its end (and at exit, as the logs are); a `kill -9`
 * leaves it. No sweep by the owner's pid: a nested vx sees another pid
 * namespace, where the outer vx's pid reads as dead, and a sweep there
 * removed the outer task's own TMPDIR mid-run (the gate, item 965). The shared
 * directory itself stays writable, since SRT's policy grants it: a command
 * that names it outright still reaches it.
 */
function taskTmpdir(tag: string): string {
  return path.join(taskTmpRoot(), `vx-task-${process.pid}-${tag}`)
}

/**
 * The parent of every task's own temp directory, walled off from every
 * sandboxed task, each granted its own directory inside: SRT binds its
 * whole temp dir writable into every task, so a task listed and read what
 * a concurrent one kept in its TMPDIR, or replaced its port bridge's
 * socket (L-10).
 */
function taskTmpRoot(): string {
  return path.join(sandboxTmpdir(), 'vx-tasks')
}

/**
 * `taskTmpRoot()`, made or checked as this user's own before a task's
 * directory goes in it. It sits in a shared temp dir: a user who made it
 * first owned the parent of every task's TMPDIR and bridge socket, and
 * renamed a running task's directory to plant their own under its name
 * (probed, L-13) — the path the host bridge dials and the write grant is
 * resolved from. A symlink, another owner, or a parent another user may
 * rewrite is refused; one of ours left open to others is closed.
 */
function ownTaskTmpRoot(): string {
  const root = taskTmpRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const uid = process.getuid?.()
  if (uid === undefined) return root
  const st = lstatSync(root)
  const parent = statSync(path.dirname(root))
  // Group write is a umask-002 box's default; others' write is the hole,
  // unless the sticky bit keeps them to their own entries (`/tmp`).
  const parentShared = (parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0
  if (
    !st.isDirectory() ||
    st.uid !== uid ||
    (parent.uid !== uid && parent.uid !== 0) ||
    parentShared
  ) {
    throw new UserError(
      `sandbox: ${root} is not this user's own directory (a link, another owner, or a parent others may write); remove it, or point CLAUDE_CODE_TMPDIR at a private directory`,
    )
  }
  if ((st.mode & 0o077) !== 0) chmodSync(root, 0o700)
  return root
}

const liveTaskTmpdirs = new Set<string>()
let tmpdirExitHooked = false
function trackTaskTmpdir(dir: string): void {
  liveTaskTmpdirs.add(dir)
  if (tmpdirExitHooked) return
  tmpdirExitHooked = true
  process.on('exit', () => {
    for (const d of liveTaskTmpdirs) removeTaskTmpdir(d)
  })
}

/**
 * Remove a task's temp directory; never throws. The task may leave it
 * unremovable: a read-only directory in it (EACCES), or a straggler still
 * writing (ENOTEMPTY). Thrown, either failed a task that had passed, as a
 * worker fault under dte. A read-only one is made writable and the remove
 * retried; what still stands is left to the exit hook's last try.
 */
function removeTaskTmpdir(dir: string): boolean {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      if (attempt === 2) return false
      ownerWritable(dir)
    }
  }
}

/** Give the owner write and search on every directory under `dir`, which a recursive remove needs. */
function ownerWritable(dir: string): void {
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory()) return
    if ((st.mode & 0o700) !== 0o700) chmodSync(dir, (st.mode & 0o7777) | 0o700)
    for (const name of readdirSync(dir)) ownerWritable(path.join(dir, name))
  } catch {
    // gone, or not this user's: the retry says
  }
}

/** Whether SRT is up in this process — set by `initSandbox`, cleared by `resetSandbox`. */
let srtUp = false
/**
 * The run's config while one of its tasks lifts SRT's `socket(AF_UNIX)`
 * block or grants `gitConfig`, else undefined. SRT reads both from its
 * run-wide config, so one task's `unixSockets` or port list lifted the
 * block for every sandboxed task of the run, and a task that asked for
 * neither reached the host's docker or ssh-agent socket (L-6); the
 * per-task `allowGitConfig` vx passed was never read at all (B-41). Such a
 * run sets both per task, for the span of its wrap, which is when SRT
 * reads them.
 */
let perTaskRun: Parameters<SrtModule['SandboxManager']['updateConfig']>[0] | undefined
/** Wraps of a `perTaskRun`, one at a time: each holds SRT's config for its task. */
let wrapTurn: Promise<unknown> = Promise.resolve()

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

/** Whether this run's SRT scans at depth 1 and vx supplies the task-scoped denies (B-40). */
let scopedDenyScan = false

/**
 * SRT's own deny scan, when `wrapSandboxedCommand` walks each task's write
 * grants (B-40): none. SRT spawns its ripgrep on every wrap, and at depth
 * 1 the scan finds only the root's entries, which SRT keeps only inside a
 * write grant, where the scoped walk already reaches (the parity rows in
 * `sandbox-deny-scan.unsafe.test.ts`). A no-op in rg's place ends the
 * spawn's 3.8 ms at 1.0; SRT has no way to skip it. A file that cannot be
 * exec'd ends it sooner still: `posix_spawn` refuses it (ENOEXEC) in
 * 0.32 ms against `true`'s 1.06, SRT reads the refusal as an empty scan,
 * and its dependency check (`Bun.which`) still finds the file (B-92).
 */
function scopedScanConfig(): { mandatoryDenySearchDepth: number; ripgrep?: { command: string } } {
  try {
    return { mandatoryDenySearchDepth: 1, ripgrep: { command: noScanCommand() } }
  } catch {
    try {
      return { mandatoryDenySearchDepth: 1, ripgrep: { command: executablePath('true') } }
    } catch {
      return { mandatoryDenySearchDepth: 1 }
    }
  }
}

let noScan: string | undefined

/** The no-scan file again (made anew if gone), or `true` where it cannot be. */
function scanCommandAgain(): string {
  try {
    return noScanCommand()
  } catch {
    return executablePath('true')
  }
}
/**
 * An empty executable only this user can write: SRT runs it outside the
 * sandbox on every wrap, so it lives in this user's own 0700 directory under
 * the OS temp dir, never the shared `/tmp/claude`. One directory per user,
 * not per process: a per-process one outlived every SIGKILLed run, and the
 * exit hook that removed it fired under a test's emitted `exit` with the
 * process going on (B-93). Anything else at the name (another owner, group
 * or other bits, a link, a non-empty file) is refused, and the caller falls
 * back to `true`.
 */
function noScanCommand(): string {
  if (noScan !== undefined && existsSync(noScan)) return noScan
  const uid = process.getuid!()
  const dir = path.join(os.tmpdir(), `vx-noscan-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const d = lstatSync(dir)
  // A link reads mode 0777 here, and a file at the name fails the write
  // below (ENOTDIR).
  if (d.uid !== uid || (d.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not this user's own directory`)
  }
  const file = path.join(dir, 'rg')
  try {
    writeFileSync(file, '', { mode: 0o700, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const f = lstatSync(file)
  // SRT's dependency check (`Bun.which`) refuses what is not an executable
  // file, which would make the sandbox unavailable rather than fall back. A
  // directory's size is never 0.
  if (f.size !== 0 || (f.mode & 0o100) === 0) {
    throw new Error(`${file} is not an empty executable of this user's`)
  }
  noScan = file
  return file
}

/**
 * vx's executables the runtime spawns OUTSIDE the sandbox (the no-op scan,
 * the socat wrapper), as directories every task is walled from, and the
 * files a task still runs (the wrapper is its side of the proxy bridge
 * too), granted back read-only. They live in the OS temp dir, and where
 * that is one every task may write (SRT binds `/tmp/claude` writable into
 * each), a task rewrote the no-op and the next wrap ran it unsandboxed.
 */
function hostHelpers(): { dirs: string[]; files: string[] } {
  const files = [...socatWrappers].filter(([bare, w]) => w !== bare).map(([, w]) => w)
  const dirs = [...(noScan === undefined ? [] : [noScan]), ...files].map((f) =>
    toRealPath(path.dirname(f)),
  )
  return { dirs: unique(dirs), files: files.map(toRealPath) }
}

/**
 * What a hermetic task reads outside the workspace without naming it: the
 * programs vx and the runtime run around its command (the runtime's bash,
 * the task shell, setsid, strace, env, socat, the seccomp helper, and the
 * grep and sleep its network wait runs) and what the
 * loader maps for them. Anything else outside the workspace is the task's
 * to grant. Learned once per PATH: the files a host's shell links are
 * fixed for the process.
 */
interface HermeticReads {
  /** What is denied: `/`, spelled as the runtime can mount it. */
  deny: string[]
  allow: string[]
}
let hermeticMemo: { path: string; reads: Promise<HermeticReads> } | undefined
function hermeticReads(): Promise<HermeticReads> {
  const PATH = process.env['PATH'] ?? ''
  if (hermeticMemo?.path !== PATH) hermeticMemo = { path: PATH, reads: learnHermeticReads() }
  return hermeticMemo.reads
}

async function learnHermeticReads(): Promise<HermeticReads> {
  return { deny: rootDenies(), allow: await hermeticAllows() }
}

/**
 * `/` as the runtime can deny it. Given `/`, it lays a tmpfs over every
 * entry of the root, and bwrap cannot mount one on a link: a merged-/usr
 * host's `/sbin -> usr/sbin` failed every hermetic task. A link at the
 * root leads into a directory denied here, so it is left as it is. `/proc`,
 * `/dev` and `/sys` are the runtime's own mounts; macOS denies by path, so
 * `/` stands.
 */
function rootDenies(): string[] {
  if (process.platform !== 'linux') return ['/']
  const skip = new Set(['proc', 'dev', 'sys'])
  return readdirSync('/', { withFileTypes: true })
    .filter((e) => !skip.has(e.name) && !e.isSymbolicLink())
    .map((e) => `/${e.name}`)
}

async function hermeticAllows(): Promise<string[]> {
  const programs: string[] = []
  for (const name of ['bash', 'setsid', 'strace', 'env', 'socat', 'grep', 'sleep']) {
    try {
      programs.push(executablePath(name))
    } catch {
      // The runtime's dependency check names a missing one.
    }
  }
  programs.push(taskShell())
  if (process.platform === 'darwin') {
    // dyld and the shared cache every macOS binary maps.
    return unique([...programs.flatMap(bothSpellings), '/usr/lib', '/System'])
  }
  const { getApplySeccompBinaryPath } =
    await import('@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js')
  const seccomp = getApplySeccompBinaryPath(undefined)
  if (seccomp) programs.push(seccomp)
  const files = [...programs]
  // The loader and the libraries each program links, by `ldd`'s answer.
  let ldd: string
  try {
    ldd = executablePath('ldd')
  } catch {
    throw new UserError(
      'exec.sandbox.hermetic: no `ldd` on PATH, so vx cannot tell which libraries the ' +
        "task's shell needs — install it (glibc's libc-bin), or drop hermetic",
    )
  }
  const r = Bun.spawnSync({ cmd: [ldd, ...programs], stdout: 'pipe', stderr: 'ignore' })
  for (const m of r.stdout.toString().matchAll(/(\/\S+)\s+\(0x/g)) files.push(m[1]!)
  return unique(files.flatMap(bothSpellings))
}

/**
 * Every spelling the loader walks from `p` to its file: a link (the
 * loader's `/lib64/ld-linux-x86-64.so.2` is one, then `/usr/lib64`'s is
 * another) is bound as the file it reaches, so each hop needs its own
 * grant, named under its directory's real path, where the mount lands.
 */
function bothSpellings(p: string): string[] {
  const hops: string[] = []
  for (let at = p; hops.length < 40;) {
    const here = path.join(toRealPath(path.dirname(at)), path.basename(at))
    hops.push(here)
    let next: string
    try {
      if (!lstatSync(here).isSymbolicLink()) break
      next = path.resolve(path.dirname(here), readlinkSync(here))
    } catch {
      break
    }
    at = next
  }
  return hops
}

/**
 * The runtime's own sockets a hermetic task's command reaches: the write
 * observer's and the network proxy's, under the host's temp directory.
 * The runtime binds each before the read denies, so the deny's tmpfs over
 * that directory hid them (`connect …/srt-obs-…: No such file`), and no
 * call names the observer's. They are read off the wrap, once per run
 * each: the observer listens after the runtime starts, so a later wrap may
 * name one the first did not.
 */
const runtimeOwn = new Set<string>()
function runtimeBinds(wrapped: string): string[] {
  const tmp = toRealPath(os.tmpdir()) + path.sep
  const out: string[] = []
  for (const m of wrapped.matchAll(/--bind (?:'([^']*)'|(\S+)) (?:'([^']*)'|(\S+))/g)) {
    const from = m[1] ?? m[2]!
    if (from === (m[3] ?? m[4]) && from.startsWith(tmp)) out.push(from)
  }
  return out
}

/**
 * The sandbox's own tools, by the paths vx resolves on its own PATH. SRT
 * writes a bare `bwrap` (and, in the network bridge, a bare `socat`) into
 * the command the task's shell runs, with the TASK's environment: a
 * dependency's `node_modules/.bin/bwrap`, first on that PATH, ran in
 * bwrap's place and the task ran unsandboxed with exit 0 (J-33's lead,
 * B-19). A tool vx cannot find is left to SRT's own dependency check,
 * whose refusal names it.
 */
function linuxToolPaths(): { bwrapPath?: string; socatPath?: string } {
  if (process.platform !== 'linux') return {}
  const paths: { bwrapPath?: string; socatPath?: string } = {}
  try {
    paths.bwrapPath = executablePath('bwrap')
  } catch {
    // SRT's dependency check says so
  }
  try {
    paths.socatPath = envCutSocat(executablePath('socat'))
  } catch {
    // SRT's dependency check says so
  }
  return paths
}

/**
 * socat behind a wrapper that `exec`s it with the essential env only.
 * SRT spawns its host bridge (`socat UNIX-LISTEN:… TCP:localhost:…`) with
 * no `env`, so it held vx's whole environment for the run, readable from
 * its `/proc/<pid>/environ` by any unsandboxed task beside it, the hole
 * `hideEnvFromTasks` closes for vx itself. SRT takes no env for it, and
 * narrowing `process.env` around `initialize` would hand a task spawned
 * meanwhile the narrowed one. The same path runs socat inside the
 * sandbox, so the wrapper keeps `SOCAT_DEFAULT_LISTEN_IP` (`hostHasIpv6`).
 * It lives in this user's own 0700 directory, named by its content, and
 * no exit hook removes it: SRT's dependency check reads the path its live
 * config holds, and a per-process one an emitted `exit` reaped left the
 * next probe "socat not executable" while the process went on (B-93's
 * shape). A host where it cannot run (`/tmp` mounted noexec) keeps the
 * bare socat.
 */
const socatWrappers = new Map<string, string>()
function envCutSocat(socat: string): string {
  const known = socatWrappers.get(socat)
  // One stat per init: a wrapper someone removed is made again.
  if (known !== undefined && (known === socat || existsSync(known))) return known
  let wrapper = socat
  try {
    const keep = [...ESSENTIAL_ENV, 'SOCAT_DEFAULT_LISTEN_IP']
      .map((n) => `\${${n}+"${n}=$${n}"}`)
      .join(' ')
    const body = `#!/bin/sh\nexec ${shellQuote(executablePath('env'))} -i ${keep} ${shellQuote(socat)} "$@"\n`
    const file = ownWrapper(body)
    if (
      Bun.spawnSync([file, '-V'], { env: helperEnv(), stdout: 'ignore', stderr: 'ignore' })
        .exitCode === 0
    ) {
      wrapper = file
    }
  } catch {
    // no private directory or no `env`: the bare socat, as before
  }
  socatWrappers.set(socat, wrapper)
  return wrapper
}

/**
 * `body` as an executable in `vx-socat-<uid>/` under the OS temp dir,
 * written once (to a temp, then renamed, so a process beside this one
 * never runs half of it) and checked byte for byte before it is used.
 * Anything else at the names (another owner, group or other bits, a
 * link, other bytes) is refused.
 */
function ownWrapper(body: string): string {
  const uid = process.getuid!()
  const dir = path.join(os.tmpdir(), `vx-socat-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const d = lstatSync(dir)
  if (!d.isDirectory() || d.uid !== uid || (d.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not this user's own directory`)
  }
  const file = path.join(dir, `socat-${xxh3hex(body).slice(0, 16)}`)
  const ok = (): boolean => {
    const f = lstatSync(file, { throwIfNoEntry: false })
    return (
      f !== undefined &&
      f.isFile() &&
      f.uid === uid &&
      (f.mode & 0o777) === 0o500 &&
      readFileSync(file, 'utf8') === body
    )
  }
  if (ok()) return file
  const tmp = `${file}.${process.pid}`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, body, { mode: 0o500, flag: 'wx' })
  renameSync(tmp, file)
  if (!ok()) throw new Error(`${file} is not this user's wrapper`)
  return file
}

/**
 * Whether this Linux host speaks IPv6. SRT's in-sandbox network bridge is
 * `socat TCP-LISTEN:3128`, and socat 1.8 opens that as an IPv6 socket: on
 * a host without IPv6 it failed ("Address family not supported by
 * protocol"), its error went to /dev/null, and every networked task met
 * only "connection refused" on the proxy (J-33's lead, B-22). Without
 * IPv6 the wrapped command sets `SOCAT_DEFAULT_LISTEN_IP=4`, socat's own
 * switch for the listen family; with it nothing changes. Asked once.
 */
let hasIpv6: boolean | undefined
function hostHasIpv6(): boolean {
  hasIpv6 ??= existsSync('/proc/net/if_inet6')
  return hasIpv6
}

/**
 * Refuse a network entry SRT's own schema refuses, naming it. vx handed
 * the union over unchecked, and SRT's proxy matched as it could: a URL
 * (`https://example.com`), a dotless host or a port past 65535 matched
 * nothing, so the grant silently reached no host, and `'*'`, which the
 * schema refuses as too broad, opened every host to every sandboxed task
 * of the run, the allowlist being the run's (2026-10-02).
 */
function assertDomains(
  schema: SrtModule['NetworkConfigSchema'],
  allowed: readonly string[],
  denied: readonly string[],
): void {
  const bad = [
    ...allowed
      .filter((d) => !schema.shape.allowedDomains.safeParse([d]).success)
      .map((d) => `allow.network "${d}"`),
    ...denied
      .filter((d) => !schema.shape.deniedDomains.safeParse([d]).success)
      .map((d) => `deny.network "${d}"`),
  ]
  if (bad.length === 0) return
  throw new UserError(
    `sandbox: ${bad.join(', ')} is not a host pattern: name a host ("example.com"), a ` +
      `subdomain wildcard ("*.example.com") or either with a port ("example.com:443"); no ` +
      `scheme or path, and "*" or "*.com" is refused as too broad (a bare "*" only in deny)`,
  )
}

/**
 * One-time SRT initialization per orchestrator run. Starts the proxy
 * servers + (on macOS) the violation log monitor. Safe to call repeatedly
 * — SRT itself returns early on the second call.
 *
 * The base config sets network to "block everything" (empty allowedDomains)
 * unless `allowedDomains` names some; `sandbox.network: true` adds none.
 *
 * @param opts.allowedDomains every domain any sandboxed task in this run
 * declared. SRT's filtering proxy is per-RUN and reads its allowlist from
 * this call, never from the per-task config, so the union is the only
 * place a domain list can take effect; each task's own front
 * (`ownProxy`) narrows it to the task's list.
 */
export async function initSandbox(opts?: {
  allowedDomains?: readonly string[]
  /**
   * Every domain any sandboxed task of the run denies, checked here and
   * never handed to the run's proxy: each task's front refuses its own.
   */
  deniedDomains?: readonly string[]
  /**
   * Whether any task of the run lifts SRT's seccomp block on
   * `socket(AF_UNIX)`: one that declares `unixSockets` or a `localBinding`
   * port list (the port bridge is a unix socket the task's side has to
   * create). SRT reads the lift from its run-wide config, so `wrapForTask`
   * sets it for each task's own wrap (L-6).
   */
  allowAllUnixSockets?: boolean
  /** Whether any task of the run grants `gitConfig`: SRT reads it run-wide, so it is set per wrap (B-41). */
  gitConfig?: boolean
}): Promise<void> {
  // This run owns the session now; a reset an earlier run deferred to its
  // last server would tear it down under this run's tasks (M-25).
  resetDeferred = false
  // A reset a server's exit started unawaited: a watch cycle stops its
  // server and starts its run at once, and an init under that reset
  // found SRT up, hot-reloaded it, and had it torn down after (item 884).
  await resetting
  // Before SRT starts, so the very first task already has one.
  await mkdir(sandboxTmpdir(), { recursive: true })
  const { SandboxManager, NetworkConfigSchema } = await loadSrt()
  assertDomains(NetworkConfigSchema, opts?.allowedDomains ?? [], opts?.deniedDomains ?? [])
  scopedDenyScan = process.platform === 'linux' && canScopeDenyScan(process.cwd())
  const config: Parameters<typeof SandboxManager.initialize>[0] = {
    network: {
      allowedDomains: [...(opts?.allowedDomains ?? [])],
      // Each task's own front refuses its own denies; the run's proxy
      // refusing the union denied one task's host to every task.
      deniedDomains: [],
      ...(opts?.allowAllUnixSockets === true ? { allowAllUnixSockets: true } : {}),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    ignoreViolations: DEFAULT_IGNORE_VIOLATIONS,
    ...linuxToolPaths(),
    ...(scopedDenyScan ? scopedScanConfig() : {}),
  }
  runAllowed = config.network.allowedDomains
  runAllowsHosts = runAllowed.length > 0
  const wasUp = srtUp
  if (!wasUp) await unlinkStaleMuxSockets()
  const listening = srtCleanupAdopted ? undefined : cleanupListeners()
  // A SIGINT or SIGTERM while SRT starts runs its reset before the session
  // exists: the reset found no bridge to kill, the start then made one,
  // and that socat outlived vx for good (one per early Ctrl-C, regr1112).
  let cut = false
  const onCut = (): void => {
    cut = true
  }
  for (const ev of CUT_SIGNALS) process.once(ev, onCut)
  try {
    await SandboxManager.initialize(
      config,
      undefined,
      // enableLogMonitor — macOS-only; populates the SandboxViolationStore.
      true,
    )
  } finally {
    for (const ev of CUT_SIGNALS) process.off(ev, onCut)
  }
  if (listening !== undefined) adoptSrtCleanup(listening)
  if (cut) {
    // What the start finished after the signal's reset is taken down here.
    srtDown()
    const reset = SandboxManager.reset()
    trackReset(reset)
    await reset
    return
  }
  srtUp = true
  if (!wasUp && process.platform === 'linux' && procfsIsOwn()) {
    const { pids, paths } = sessionLeftovers(SandboxManager)
    sessionRelease = guardSession(pids, paths)
  }
  perTaskRun = opts?.allowAllUnixSockets === true || opts?.gitConfig === true ? config : undefined
  // `initialize()` returns early once SRT is up, and on Linux the
  // availability probe brought it up with an EMPTY config before the run's
  // own call — so the run's allowlist and unix-socket allowance never
  // reached it (found 2026-09-10 by the port bridge: the task's side died
  // on `socket(AF_UNIX)` with the flag set). `updateConfig` is SRT's hot
  // reload of exactly these fields; the proxy and the wrapper read them
  // through getters, so the run's config is what every task sees.
  SandboxManager.updateConfig(config)
  // The proxy's session token rides into a networked task's env
  // (CLOUDSDK_PROXY_PASSWORD, the proxy URLs' password): a task printing
  // its env put it in the terminal, the cached log and `vx last --log`.
  const token = SandboxManager.getProxyAuthToken()
  if (token !== undefined) holdSecret(token)
}

/**
 * The tags of sandboxed servers still running (`wrapSandboxedCommand`'s
 * `server`). A run resets the sandbox at its end, and a foreground
 * `vx run dev` or a `vx watch` holds its servers past that: the reset
 * released their host bridges and SRT's proxies, and a server's port went
 * dark ~40 ms after the summary (item 882). While one runs, the reset
 * releases only the bridges no server owns and waits for the last
 * server's `releaseBridges`.
 */
const liveServers = new Set<string>()
let resetDeferred = false
/** The reset in flight, settled either way; `initSandbox` waits for it. */
let resetting: Promise<void> | undefined

export async function resetSandbox(): Promise<void> {
  for (const tag of [...hostBridges.keys()]) if (!liveServers.has(tag)) releaseBridges(tag)
  if (liveServers.size > 0) {
    resetDeferred = true
    return
  }
  resetDeferred = false
  const reset = (async () => {
    const { SandboxManager } = await loadSrt()
    await SandboxManager.reset()
    srtDown()
  })()
  trackReset(reset)
  await reset
}

function srtDown(): void {
  srtUp = false
  runtimeOwn.clear()
  perTaskRun = undefined
  availabilityCache.clear()
  straceAvailableCache = undefined
}

/** Strikes the live session from the group guard's lists; set by `initSandbox`. */
let sessionRelease: (() => void) | undefined

/**
 * The runtime's session as the group guard must take it if vx dies
 * (kill-tree.md): the bridge socats, vx's children named by the socket
 * they listen on, and what a `kill -9` leaves in the temp directory — the
 * bridge sockets and the `srt-*` sockets vx itself holds (the violation
 * observer's directory, the mux). The runtime exposes none of the pids and
 * not the observer's path, so procfs answers: vx's children, and its own
 * socket inodes against `/proc/net/unix`. ~3 ms, once per session.
 */
function sessionLeftovers(SandboxManager: SrtModule['SandboxManager']): {
  pids: number[]
  paths: string[]
} {
  const sockets = new Set(
    [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath()].filter(
      (p): p is string => p !== undefined,
    ),
  )
  const pids: number[] = []
  const paths = [...sockets]
  try {
    for (const entry of readdirSync('/proc')) {
      const first = entry.charCodeAt(0)
      if (first < 48 || first > 57) continue
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ', 2)[1]) !== process.pid) continue
        const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')
        if (argv.some((a) => [...sockets].some((s) => a.startsWith(`UNIX-LISTEN:${s},`)))) {
          pids.push(Number(entry))
        }
      } catch {
        // exited
      }
    }
    const inodes = new Set<string>()
    for (const fd of readdirSync('/proc/self/fd')) {
      try {
        const link = readlinkSync(`/proc/self/fd/${fd}`)
        if (link.startsWith('socket:[')) inodes.add(link.slice(8, -1))
      } catch {
        // closed
      }
    }
    const tmp = os.tmpdir()
    for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f.length < 8 || !inodes.has(f[6]!)) continue
      const p = f.slice(7).join(' ')
      const dir = path.dirname(p)
      if (dir === tmp && path.basename(p).startsWith('srt-mux-')) paths.push(p)
      else if (path.dirname(dir) === tmp && path.basename(dir).startsWith('srt-obs-')) {
        paths.push(dir)
      }
    }
  } catch {
    // Best-effort, as the guard is: what was found is listed.
  }
  return { pids, paths }
}

/** `reset` is the one `initSandbox` waits out before it starts SRT again. */
function trackReset(reset: Promise<unknown>): void {
  const settled = reset.then(
    () => {},
    () => {},
  )
  // Struck once the runtime has killed its bridges and removed its files;
  // a reset `exit` starts never settles, and the guard takes the rest.
  const release = sessionRelease
  sessionRelease = undefined
  if (release !== undefined) void settled.then(release)
  resetting = settled
  void settled.then(() => {
    if (resetting === settled) resetting = undefined
  })
}

const SRT_CLEANUP_EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const
const CUT_SIGNALS = ['SIGINT', 'SIGTERM'] as const
let srtCleanupAdopted = false

function cleanupListeners(): Map<string, unknown[]> {
  return new Map(SRT_CLEANUP_EVENTS.map((ev) => [ev, process.listeners(ev)]))
}

/**
 * SRT's first `initialize` registers its own once-only `exit`, SIGINT and
 * SIGTERM listeners, each an unawaited `reset()`. That reset kills the
 * bridges at once but clears SRT's init promise only once its proxies
 * have closed, so an `initSandbox` in between had `initialize` return
 * early on the dying session, and the next wrap threw "Linux HTTP bridge
 * socket does not exist" (the bridge-socket row's gate failure, M-35).
 * Each listener stays, once-only as SRT made it; vx now tracks the reset
 * it starts, as its own. SRT 0.0.81's `exit` listener starts that reset
 * and returns nothing, so the reset is the session's end itself: SRT
 * drops its context last, once its proxies have closed.
 */
function adoptSrtCleanup(before: Map<string, unknown[]>): void {
  for (const ev of SRT_CLEANUP_EVENTS) {
    const had = before.get(ev)!
    for (const l of process.listeners(ev) as ((...a: unknown[]) => unknown)[]) {
      if (had.includes(l)) continue
      srtCleanupAdopted = true
      process.removeListener(ev, l)
      process.once(ev, (...a: unknown[]) => {
        srtDown()
        const reset = l(...a)
        trackReset(reset instanceof Promise ? reset : sessionGone())
      })
    }
  }
}

/** Settles once SRT has dropped its session's context, or after 10 s. */
function sessionGone(): Promise<void> {
  const m = srtLoaded?.SandboxManager
  const up = () =>
    m !== undefined && (m.getProxyPort() !== undefined || m.getLinuxHttpSocketPath() !== undefined)
  const end = performance.now() + 10_000
  return new Promise((resolve) => {
    const check = () => {
      if (!up() || performance.now() >= end) return resolve()
      setTimeout(check, 5).unref()
    }
    check()
  })
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
  /** See `RunOptions.onSpawn`. */
  onSpawn?: (pid: number) => void
  /** `ExecuteRequest.signal`: once aborted, the tracer retry spawns nothing. */
  signal?: AbortSignal
  /** See `RunOptions.timeoutMs` — SIGTERM the child after this many ms. */
  timeoutMs?: number
  /** See `CaptureConfig` — which streams are retained on the result. */
  capture?: CaptureConfig
  /**
   * Baseline reads — paths the sandbox allows beside the task's own
   * `allow.read`. Core passes the project's and the root's
   * `node_modules` and the workspace dependencies linked from them
   * (sandbox/request.ts); nothing is derived from `cache`.
   */
  baseAllowRead: readonly string[]
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
  /** `ExecuteSandbox.keyRoot`. */
  readonly keyRoot?: string
  /** `ExecuteSandbox.keyNested`. */
  readonly keyNested?: readonly string[]
  /** `ExecuteSandbox.dependencyReads` and `dependencyReported`: the dependencies' outputs. */
  readonly upstreamOutputs?: readonly string[]
  /**
   * User-declared sandbox block (after path-resolution). Path lists are
   * unioned with the baselines; bool/object fields fall through to SRT.
   */
  config: ResolvedSandboxConfig
}

/**
 * Canonical form of every path the sandbox policy is expressed in.
 *
 * `resolveSandboxConfig` already canonicalizes the USER's paths; the
 * orchestrator-supplied baselines (the `node_modules` reads and the
 * workspace-root deny anchor) arrived raw, so a workspace reached through a
 * symlink expressed HALF its policy in real paths and half in link paths.
 * bwrap then died mounting the link path inside its new root
 * (`Can't mount tmpfs on /newroot/<link>`) and EVERY sandboxed task failed —
 * whatever the config, with an error naming an internal path the user has no
 * way to act on. Canonicalizing here is what makes the two halves agree.
 */
interface CanonicalBaselines {
  allowRead: string[]
  denyRead: string[]
  cwd: string
}

function canonicalBaselines(
  args: Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead' | 'cwd'>,
): CanonicalBaselines {
  return {
    allowRead: args.baseAllowRead.map(toRealPath),
    denyRead: args.baseDenyRead.map(toRealPath),
    cwd: toRealPath(args.cwd),
  }
}

/**
 * Linux: does some mount hold the task's cwd? bwrap enters the old cwd
 * only if it exists in the new root, and otherwise `$HOME`, with no word:
 * a project granted no read ran in the home directory, where `cat x.txt`
 * read `~/x.txt`. A grant at or above the cwd holds it, and so does an
 * existing one below (bwrap builds the path to a bind). When none does,
 * the cwd is denied instead: an empty directory the task enters, whose
 * reads are refused and reported as the anchor's are. A single-package
 * workspace's cwd is its anchor, denied already; the runtime takes the
 * second entry as the same mount.
 */
function cwdMounted(
  cwd: string,
  fs: {
    allowRead?: readonly string[] | undefined
    allowWrite?: readonly string[] | undefined
  },
): boolean {
  return [...(fs.allowRead ?? []), ...(fs.allowWrite ?? [])].some(
    (p) => atOrUnder(cwd, p) || (atOrUnder(p, cwd) && existsSync(p)),
  )
}

/**
 * A write grant that names a path in the project must BIND one there. The
 * grant was realpath'd, so `out.txt -> ../b/src/x` (committed, or planted
 * by the task's own previous run) bound project b's directory writable,
 * and the task wrote into a sibling with exit 0 (item 1003). A read grant
 * may resolve out through a link (`node_modules` into the store) and is
 * not judged here; a grant spelled outside the project is the user's own.
 */
function assertWriteStaysHome(grant: string, real: string, projectDir: string): void {
  if (grant.startsWith('~') || path.isAbsolute(grant)) return
  const lexical = path.resolve(projectDir, grant)
  if (!atOrUnder(lexical, projectDir)) return
  const home = toRealPath(projectDir)
  // `toRealPath` stops at a DANGLING link and keeps its own path, which is
  // inside; the link's target is where a write through it would land.
  const target = throughLinks(real)
  if (atOrUnder(real, home) && atOrUnder(target, home)) return
  throw new UserError(
    `exec.sandbox.allow.write: "${grant}" resolves through a symlink to ${atOrUnder(real, home) ? target : real}, outside the ` +
      `project — a write grant binds the path it names in the project, and vx does not follow a ` +
      `link out of it. Remove the link, or grant the target by its own path.`,
  )
}

/**
 * Linux: a literal write grant spelled through a link in the project
 * (`gen/` over `gen -> real`), as the task names it: the project's real
 * directory with the grant's own components, links unresolved. The grant
 * binds at its real path and bwrap mounts no link, so without a second
 * bind there the task met "Directory nonexistent", or, under a read
 * grant of the project, the link bound read-only over the same directory
 * ("Read-only file system"). Seatbelt judges the resolved path, so macOS
 * needs none.
 */
function linkSpelling(
  grant: string,
  real: string,
  projectDir: string,
): { link: string; target: string } | undefined {
  if (process.platform !== 'linux' || grant.startsWith('~') || path.isAbsolute(grant)) return
  // `gen/**` is the directory whole (`expandGrants`).
  const whole = /\/\*\*(?:\/\*)?$/
  const lexical = path.resolve(projectDir, grant.replace(whole, ''))
  const target = real.replace(whole, '')
  if (!atOrUnder(lexical, projectDir) || !isMountableLiteral(target)) return
  const link = path.join(toRealPath(projectDir), path.relative(projectDir, lexical))
  return link === target ? undefined : { link, target }
}

/** Where `p` lands through every link on it, a dangling last one included. */
function throughLinks(p: string, hops = 0): string {
  if (hops > 40) return p
  try {
    return realpathSync(p)
  } catch {
    try {
      return throughLinks(path.resolve(path.dirname(p), readlinkSync(p)), hops + 1)
    } catch {
      const parent = path.dirname(p)
      return parent === p ? p : path.join(throughLinks(parent, hops + 1), path.basename(p))
    }
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
  /** Canonical directories a glob's hits stop at (sandbox/request.ts `wallOff`). */
  walls: readonly string[] = [],
): ResolvedSandboxConfig {
  const resolve = (p: string): string => {
    if (p.startsWith('~')) return toRealPath(path.join(os.homedir(), p.slice(1)))
    if (path.isAbsolute(p)) return toRealPath(p)
    return toRealPath(path.resolve(projectDir, p))
  }
  const a = cfg.allow ?? {}
  const pending: string[] = []
  const linked: Array<{ link: string; target: string }> = []
  const r: ResolvedSandboxConfig = {
    allowRead: expandGrants((a.read ?? []).flatMap(grantAlternatives).map(resolve), walls),
    allowWrite: expandGrants(
      (a.write ?? []).flatMap(grantAlternatives).map((p) => {
        const real = resolve(p)
        assertWriteStaysHome(p, real, projectDir)
        const link = linkSpelling(p, real, projectDir)
        if (link !== undefined) linked.push(link)
        // A directory a write glob matches is writable whole, as Linux's
        // bind of the hit makes it: `<glob>/**` collapses below into the
        // glob and its subtree. SRT compiles a glob as an exact regex, so
        // `/tmp/pnpm-store-operation-locks-*/` covered the directory and
        // not the lock file pnpm 12 opens inside it.
        return process.platform !== 'linux' &&
          !isMountableLiteral(real) &&
          !/\/\*\*(?:\/\*)?$/.test(real)
          ? `${real}/**`
          : real
      }),
      walls,
      pending,
    ),
  }
  if (pending.length > 0) r.pendingWrites = pending
  if (linked.length > 0) r.linkedWrites = linked
  if (process.platform === 'darwin') {
    const read = wallsGlobsReach(r.allowRead, walls)
    const write = wallsGlobsReach(r.allowWrite, walls)
    if (read.length + write.length > 0) r.wallsReached = { read, write }
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
  if (cfg.hermetic === true) r.hermetic = true
  if (cfg.ignore !== undefined) {
    // Relative patterns anchor at the project dir, `~` ones at the home
    // directory, as a grant's are (a `~` pattern kept as written matched no
    // recorded path). A pattern is not a path, but its literal head is: both
    // producers record where a denial LANDS, so the head is canonicalized
    // like every other side of the policy. Anchored at a project reached
    // through a link (macOS's `/var`), no pattern matched and the denial it
    // named failed the task (B-2).
    const anchor = (pat: string): string => {
      const abs = pat.startsWith('~')
        ? path.join(os.homedir(), pat.slice(1))
        : path.isAbsolute(pat)
          ? pat
          : path.join(projectDir, pat)
      const wild = abs.search(BUN_GLOB_WILDCARDS)
      const head = wild === -1 ? abs : abs.slice(0, abs.lastIndexOf(path.sep, wild)) || path.sep
      return toRealPath(head) + abs.slice(head.length)
    }
    r.ignore = {
      ...(cfg.ignore.read ? { read: cfg.ignore.read.map(anchor) } : {}),
      ...(cfg.ignore.write ? { write: cfg.ignore.write.map(anchor) } : {}),
      ...(cfg.ignore.systemInfo ? { systemInfo: [...cfg.ignore.systemInfo] } : {}),
      ...(cfg.ignore.network ? { network: [...(cfg.ignore.network as string[])] } : {}),
    }
  }
  return r
}

export interface SandboxedRunResult extends RunResult {
  /** Violations captured during this task. Empty when nothing tripped. */
  violations: SandboxViolation[]
}

/**
 * The shell that gives a sandboxed task its OWN `JAVA_TOOL_OPTIONS`. When
 * SRT restricts the network it sets the variable to its proxy agent's flag
 * composed with VX'S value (`process.env`, read inside the wrap), over the
 * one vx gave the task: a host value no layer passes reached the task, out
 * of its key, and a changed host value replayed the old output; a task's
 * own `define` never arrived (item 995). Where SRT left the variable alone
 * it already holds the task's value and this is a no-op; elsewhere the
 * host's value is cut out and the task's appended to what SRT added.
 */
function javaToolOptionsFix(host: string | undefined, task: string | undefined): string {
  // The same value both sides (a task that passes the host's through, or
  // neither has one): SRT's composition is already the task's own, and a
  // prefix quoting the value twice would only lengthen every command
  // (item 1007).
  if ((host ?? '') === (task ?? '')) return ''
  const cut = host
    ? `__vx_h=${shellQuote(host)}; case "$__vx_j" in *"$__vx_h"*) __vx_j="\${__vx_j%%"$__vx_h"*}\${__vx_j#*"$__vx_h"}";; esac; `
    : ''
  const add = task ? `__vx_j="$__vx_j $__vx_t"; ` : ''
  return (
    `__vx_t=${shellQuote(task ?? '')}; __vx_j=\${JAVA_TOOL_OPTIONS-}; ` +
    `if [ "$__vx_j" != "$__vx_t" ]; then ${cut}${add}` +
    `case "$__vx_j" in *[![:space:]]*) export JAVA_TOOL_OPTIONS="$__vx_j";; *) unset JAVA_TOOL_OPTIONS;; esac; fi; ` +
    `unset __vx_j __vx_h __vx_t; `
  )
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
  args: Pick<SandboxedRunArgs, 'command' | 'cwd' | 'forwardArgs' | 'config' | 'env'> &
    Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead'> & {
      /** A persistent server: the sandbox outlives a run's reset until `releaseBridges(tag)`. */
      server?: boolean
      /** Trace the command's `openat` calls to descriptor TRACE_FD (Linux; `wantsStraceDetection`). */
      trace?: 'plain' | 'seccomp'
      /** Trace with `-y`, each descriptor's path printed: a read under a widened grant is judged. */
      tracePaths?: boolean
    },
): Promise<{
  wrapped: string
  tag: string
  taggedCommand: string
  /** What SRT wrapped, and so what its store keys a record by (the group wrapper included on Linux). */
  srtCommand: string
  baselines: CanonicalBaselines
  /** The pending write globs a write may still land under (`scratchWrites`). */
  scratch: string[]
  /** The pending write globs `punchedWriteGlobs` bound, and their directories. */
  held: { dirs: string[]; globs: string[] }
  /** The command reads its polite signals off fd 3: spawn it with one and `signalThrough` it. */
  forwardsSignals: boolean
  /** The command writes its trace to fd TRACE_FD: spawn it with the log there. */
  traced: boolean
}> {
  const { SandboxManager } = await loadSrt()
  const userCommand = withForwardArgs(args.command, args.forwardArgs)

  const tag = xxh3hex(`${args.cwd}|${userCommand}|${process.hrtime.bigint()}`).slice(0, 16)
  ownTaskTmpRoot()
  const tmp = taskTmpdir(tag)
  mkdirSync(tmp, { mode: 0o700 })
  trackTaskTmpdir(tmp)
  try {
    return await wrapIn(args, SandboxManager, userCommand, tag, tmp)
  } catch (err) {
    // Nothing spawned, so nothing releases it on exit: a `vx watch` kept
    // one task directory per refused wrap (a held port) until it quit.
    releaseBridges(tag)
    throw err
  }
}

async function wrapIn(
  args: Parameters<typeof wrapSandboxedCommand>[0],
  SandboxManager: SrtModule['SandboxManager'],
  userCommand: string,
  tag: string,
  tmp: string,
): ReturnType<typeof wrapSandboxedCommand> {
  // After the tag: SRT keys violations by the command's first 100 chars.
  // TMP and TEMP pass through from the host, whose temp directory the
  // sandbox mounts read-only: a tool reading them failed to write there.
  const alsoTmp = ['TMP', 'TEMP'].filter((name) => args.env[name] !== undefined)
  const inTmp = `export TMPDIR=${shellQuote(tmp)}; ${alsoTmp
    .map((name) => `export ${name}="$TMPDIR"; `)
    .join('')}${javaToolOptionsFix(
    process.env['JAVA_TOOL_OPTIONS'],
    args.env['JAVA_TOOL_OPTIONS'],
  )}${userCommand}`
  const taggedCommand = `: 'vx-${tag}'; ${inTmp}`

  const baselines = canonicalBaselines(args)
  const customConfig = buildCustomConfig(args, baselines)
  const links = punchedLinks(
    [...baselines.allowRead, ...args.config.allowRead],
    customConfig.filesystem!.allowRead!,
  )
  // The directories `punchedWriteGlobs` bound, and the globs they hold.
  const own = new Set(bindableWrites(args.config.allowWrite))
  const heldDirs = customConfig.filesystem!.allowWrite.filter((w) => !own.has(w))
  const globsHeld = {
    dirs: heldDirs,
    globs: (args.config.pendingWrites ?? []).filter((g) => heldDirs.includes(globDir(g))),
  }
  const scratch = pendingWriteGrants(
    args.config,
    customConfig!.filesystem!,
    baselines.denyRead,
    baselines.cwd,
  )
  customConfig!.filesystem!.denyRead!.push(toRealPath(taskTmpRoot()))
  if (args.config.hermetic === true) {
    const reads = await hermeticReads()
    customConfig!.filesystem!.denyRead!.push(...reads.deny)
    customConfig!.filesystem!.allowRead!.push(...reads.allow, ...runtimeOwn)
  }
  const helpers = hostHelpers()
  customConfig!.filesystem!.denyRead!.push(...helpers.dirs)
  customConfig!.filesystem!.allowRead!.push(...helpers.files)
  const cwdDenied =
    process.platform === 'linux' && !cwdMounted(baselines.cwd, customConfig!.filesystem!)
  if (cwdDenied) customConfig!.filesystem!.denyRead!.push(baselines.cwd)
  customConfig!.filesystem!.allowWrite!.push(toRealPath(tmp))
  // Seatbelt judges `/dev/stdout` by the path the kernel resolves it to,
  // `/dev/fd/1`, which SRT's default `/dev/stdout` grant does not name, so
  // `echo x > /dev/stdout` failed EPERM (X-113). `/dev/fd/N` reopens only a
  // descriptor the task already holds.
  if (process.platform === 'darwin') customConfig!.filesystem!.allowWrite!.push('/dev/fd')
  if (scopedDenyScan) {
    customConfig!.filesystem!.denyWrite!.push(
      ...scopedMandatoryDenies(
        process.cwd(),
        [...srtDefaultWritePaths(), ...customConfig!.filesystem!.allowWrite!],
        args.config.gitConfig === true,
      ),
    )
  }
  // Seatbelt re-allows a read inside a denied region only by name; on Linux
  // a read grant over a write path would remount it read-only.
  if (process.platform === 'darwin') customConfig!.filesystem!.allowRead!.push(toRealPath(tmp))
  // Linux: the ports a list grants are bridged out of the task's network
  // namespace. The task's side of each bridge is a socat in front of the
  // user command, so it goes INTO the sandboxed command; the host side is
  // spawned here and released when the task's process ends.
  const ports = process.platform === 'linux' ? bridgedPorts(args.config) : []
  // And the host loopback ports its `network` list names are relayed in,
  // the other way: its own listener on each, the host's side dialling out.
  const reach =
    process.platform === 'linux'
      ? loopbackPorts(args.config.network).filter((p) => !ports.includes(p))
      : []
  // Before the wrap, which holds the runtime's stub cleanup until `afterCommand`.
  const held = portsHeld(ports)
  if (held.length > 0) {
    throw new UserError(
      `sandbox: localBinding port${held.length === 1 ? '' : 's'} ${held.join(', ')} ` +
        `${held.length === 1 ? 'is' : 'are'} already in use on this machine, so the task's own ` +
        `cannot be exposed there and a client would reach the other listener; stop what ` +
        `holds ${held.length === 1 ? 'it' : 'them'} or list another port`,
    )
  }
  if (ports.length > 0 || reach.length > 0) {
    hostBridges.set(tag, { ports, reach, procs: [] })
    writeFileSync(portDialScript(tag), PORT_DIAL_SCRIPT)
  }
  const grouped =
    process.platform === 'linux'
      ? ownGroupCommand(tag, inTmp, args.trace, args.tracePaths === true)
      : { command: taggedCommand, forwards: false, traced: false }
  // The tag leads: SRT keys a record by the wrap's first 100 characters,
  // and the proxy wait below is the same ~360 for every task.
  const inner = [
    process.platform === 'linux' ? `: 'vx-${tag}';` : '',
    ports.length > 0 ? portBridgeInner(ports, tag) : '',
    reach.length > 0 ? reachBridgeInner(reach, tag, hostHasIpv6()) : '',
    process.platform === 'linux' && SandboxManager.getLinuxHttpSocketPath() !== undefined
      ? PROXY_BRIDGE_WAIT
      : '',
    grouped.command,
  ]
    .filter((part) => part !== '')
    .join(' ')
  let wrapped = await wrapForTask(
    SandboxManager,
    inner,
    process.platform === 'linux'
      ? literalReadPaths(customConfig)
      : process.platform === 'darwin'
        ? seatbeltBrackets(customConfig, baselines.allowRead)
        : customConfig,
    ports.length > 0 || reach.length > 0 || asksUnixSockets(args.config),
    args.config.gitConfig === true,
  )
  if (process.platform === 'linux' && args.config.hermetic === true) {
    const own = runtimeBinds(wrapped).filter((p) => !runtimeOwn.has(p))
    if (own.length > 0) {
      for (const p of own) runtimeOwn.add(p)
      customConfig!.filesystem!.allowRead!.push(...own)
      wrapped = await wrapForTask(
        SandboxManager,
        inner,
        literalReadPaths(customConfig),
        ports.length > 0 || reach.length > 0 || asksUnixSockets(args.config),
        args.config.gitConfig === true,
      )
    }
  }
  if (runAllowsHosts) {
    try {
      wrapped = await ownProxy(SandboxManager, wrapped, inner, tag, args.config)
    } catch (err) {
      releaseBridges(tag)
      afterCommand(SandboxManager)
      throw err
    }
  }
  if (process.platform === 'darwin') {
    const rules = [
      ...macProfileRules(args.config),
      ...darwinGrantRules(args.config, baselines.allowRead, baselines.denyRead),
    ]
    try {
      if (rules.length > 0) wrapped = injectProfileRules(wrapped, rules)
    } catch (err) {
      releaseBridges(tag)
      afterCommand(SandboxManager)
      throw err
    }
  }
  // Linux: the shell execs bwrap, so bwrap is the spawn itself and its
  // `--die-with-parent` is keyed to vx. Behind a shell that waited on it,
  // a `kill -9` of vx left the shell alive, bwrap never heard, and a
  // sandboxed server and all it forked outlived vx (turborepo#9666). Now
  // the namespace goes with vx, a `setsid` daemon inside included, a
  // traced one-shot task too: its strace runs inside (B-11).
  // Every mask and bind is a mount point, and git's discovery stops at
  // one: a task granted the repository's `.git` still read "not a git
  // repository … Stopping at filesystem boundary" (2026-10-03). The
  // boundaries are the sandbox's, so a task that names a `.git` may walk
  // across them; only such a task, since git-aware tools read the variable
  // (vx's own repoFacts asks git instead of the disk under it). A value the
  // task's environment sets wins.
  if (process.platform === 'linux' && /^\S*bwrap /.test(wrapped)) {
    const gitGranted = [...args.config.allowRead, ...args.config.allowWrite].some((g) =>
      g.split(/[\\/]/).includes('.git'),
    )
    wrapped =
      (gitGranted ? 'GIT_DISCOVERY_ACROSS_FILESYSTEM=${GIT_DISCOVERY_ACROSS_FILESYSTEM-1} ' : '') +
      `exec ${readOnlyMasks(withCwd(withPunchedLinks(withLinkedWrites(wrapped, linkedWriteBinds(args.config.linkedWrites)), links), cwdDenied ? baselines.cwd : undefined), scratch)}`
  }
  if (process.platform === 'linux' && !hostHasIpv6())
    wrapped = `SOCAT_DEFAULT_LISTEN_IP=4 ${wrapped}`
  if (args.server === true) liveServers.add(tag)
  if (ports.length > 0 || reach.length > 0) {
    spawnHostBridges(tag)
    if (ports.length > 0) await hostBridgesListen(ports, tag)
  }
  return {
    wrapped,
    tag,
    taggedCommand,
    srtCommand: inner,
    baselines,
    scratch,
    held: globsHeld,
    forwardsSignals: grouped.forwards,
    traced: grouped.traced,
  }
}

/**
 * The in-sandbox watcher's body: each signal name vx writes down fd 3 goes
 * to the command's group, and the end of the channel (vx closed it once
 * the task exited, or vx is gone) SIGKILLs that group and the watcher's
 * own, the runtime's shells and bridges. The namespace's init then has no
 * child left and exits. bwrap's `--die-with-parent` alone missed: it is
 * set in the namespace only after bwrap's monitor forks it, and a monitor
 * killed in those milliseconds (a `kill -9` of vx, a task stopped as it
 * started) left init, the command and its bridges running under the
 * host's init, the port held, for hours (2026-11-12).
 */
function channelWatch(group: string): string {
  return `while IFS= read -r s; do kill -s "$s" -- "-${group}"; done; kill -s KILL -- "-${group}" 0`
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
function ownGroupCommand(
  tag: string,
  userCommand: string,
  trace?: 'plain' | 'seccomp',
  tracePaths = false,
): { command: string; forwards: boolean; traced: boolean } {
  // `sh`, as an unsandboxed task runs (`runner.ts`): the command ran under
  // bash here, so `[[ … ]]`, brace expansion and `echo 'a\tb'` read one
  // way sandboxed and another unsandboxed or on a remote executor, where
  // `/bin/sh` is dash (item 964).
  let sh: string
  try {
    sh = taskShell()
  } catch {
    return { command: `: 'vx-${tag}'; ${userCommand}`, forwards: false, traced: false }
  }
  const tag0 = `: 'vx-${tag}';`
  let setsid: string | undefined
  try {
    setsid = `${shellQuote(executablePath('setsid'))} `
  } catch {
    setsid = undefined
  }
  if (trace === undefined) {
    const run = `exec ${setsid ?? ''}${shellQuote(sh)} -c ${shellQuote(userCommand)}`
    if (setsid === undefined) return { command: `${tag0} ${run}`, forwards: false, traced: false }
    const watch = `{ ${channelWatch('$$')}; } 2>/dev/null <&3 3<&- &`
    return { command: `${tag0} ${watch} ${run} 3<&-`, forwards: true, traced: false }
  }
  // Traced, strace runs INSIDE the sandbox, around the command alone:
  // outside, it followed bwrap building the namespace, a ptrace stop per
  // `openat` of the setup, 17 of a sandboxed `true`'s 45 ms (B-11). It
  // writes to the host's log through descriptor TRACE_FD, which the
  // command's shell closes first, so the task cannot reach the trace.
  // `-DD`: the command keeps the pid it was forked with and strace forks
  // off it into a group of its own, so a `sleep 10 &` the command leaves
  // behind is not a tracee strace waits for: the shell's `wait` ends with
  // the command, the namespace with the shell, and strace goes with it. A tracee stops at each `openat` until strace
  // has written its line, so the kill loses none. `-qq`: nothing of
  // strace's own about the processes it follows.
  // Forked, never `exec`'d: `-DD`'s process waits for ANY child to hear
  // the tracer attached, so one it inherited (the watcher, SRT's network
  // bridges) that exits first sent the command on untraced, and under
  // `--seccomp-bpf` its `execve` failed ENOSYS. A fresh fork has none.
  // POSIX lets an async list start with SIGINT and SIGQUIT ignored, and a
  // shell cannot trap what it was started ignoring: bash 5.2 ignores them
  // for a backgrounded simple command (the first cut here, whose task's
  // `trap … INT` never fired) but not for a brace group, so the `trap -`
  // is for a bash that does; SRT's bash may put them back (dash may not).
  const tracer = [
    executablePath('strace'),
    '-DD',
    '-f',
    ...(trace === 'seccomp' ? ['--seccomp-bpf'] : []),
    // A read through a directory's descriptor (`find`, `grep -r`) names
    // only the entry; `-y` prints the path it opened. 40% slower on 2,000
    // opens, so only where a widened grant's reads are judged.
    ...(tracePaths ? ['-y'] : []),
    '-qq',
    '-e',
    // A process's cwd moves on `chdir` and starts as its parent's at the
    // fork (`deniedCalls`); `?` lets an arch without `fork` skip it.
    TRACED_CALLS,
    '-o',
    `/dev/fd/${TRACE_FD}`,
    '--',
  ]
    .map(shellQuote)
    .join(' ')
  const body = shellQuote(`exec ${TRACE_FD}>&-; ${userCommand}`)
  const run = `{ trap - INT QUIT; exec ${setsid ?? ''}${tracer} ${shellQuote(sh)} -c ${body} 3<&-; } & c=$!;`
  // Bash reports a job a signal killed on its stderr, the task's: a task
  // whose shell died of SIGKILL printed this whole wrapper (X-111).
  const wait = `wait "$c" 2>/dev/null`
  if (setsid === undefined) {
    return { command: `${tag0} ${run} ${wait}`, forwards: false, traced: true }
  }
  const watch = `{ ${channelWatch('$c')}; } 2>/dev/null <&3 3<&- &`
  return { command: `${tag0} ${run} ${watch} ${wait}`, forwards: true, traced: true }
}

/**
 * What strace stops on: the reads (`openat`, and `open`, musl's open():
 * traced as openat alone, a sibling under a widened write grant was read
 * unreported and cached; arm64 has no `open`; an `openat2` never reaches
 * strace, SRT's write observer takes each one first: `refusedWrites`),
 * the execs and access probes (a refused
 * `./gen.sh || fallback` passed unreported), `readlink` (git hashes a link
 * by its target string: `readlink cfg > out.txt` under a widened grant
 * cached `v1` and replayed it after `cfg` pointed at `v2`; a stop costs
 * ~9 µs, 37 ms on 2,000 links, below the A/A noise on oxlint and vx), and
 * what moves or makes a process's cwd. Not the stat family: a stop per
 * stat cost oxlint 19% and `git status` 30%, where the execs and probes cost nothing measurable, and
 * vx's own no-op run 69% (pr-bench, 495 → 835 ms, 2026-10-23). So a tool
 * that stats before it opens, as Ubuntu 26's cat (uutils) does, refused
 * nothing the trace sees.
 */
const TRACED_CALLS =
  'trace=openat,?open,execve,?access,faccessat,?faccessat2,?readlink,?readlinkat,chdir,fchdir,clone,?clone3,?fork,?vfork'

/** The descriptor an in-sandbox strace writes its trace to (`ownGroupCommand`). */
const TRACE_FD = 5

function asksUnixSockets(c: Pick<ResolvedSandboxConfig, 'unixSockets'>): boolean {
  return c.unixSockets === true || (c.unixSockets !== undefined && c.unixSockets.length > 0)
}

/**
 * Linux: the read paths as SRT must be handed them to take each as the
 * name it is. vx has expanded every grant by then, so each is a path,
 * but SRT reads any holding `[` as a glob, where a bracket opens a class:
 * a route granted as `pages/\[id\].tsx` was never mounted (its denial
 * unreported, a listed grant), and a workspace under `[ws]/` was never
 * walled. `[[]` is a class of one `[`; a lone `]` is plain text to it. A
 * `*` or `?` has no such spelling: `bindableReads` leaves its grant out.
 */
function literalReadPaths(config: TaskSandboxConfig | undefined): TaskSandboxConfig | undefined {
  const fs = config?.filesystem
  if (fs === undefined) return config
  const escape = (paths: readonly string[]): string[] => paths.map((p) => p.replaceAll('[', '[[]'))
  return {
    ...config,
    filesystem: {
      ...fs,
      // A `*` or `?` in a deny path matches its siblings too: a wider wall.
      denyRead: escape(fs.denyRead),
      ...(fs.allowRead !== undefined ? { allowRead: escape(bindableReads(fs.allowRead)) } : {}),
    },
  }
}

/**
 * macOS: a grant's escaped bracket as seatbelt's SRT can read it. vx hands
 * it the pattern, and SRT compiles any spelling holding `[` as a regex in
 * which a backslash is a literal one, so `pages/\[id\].tsx` matched no
 * file and the route could not be granted. `[[]` is a class of one `[`; a
 * lone `]` is plain text (B-65). A deny path is a real directory, never a
 * pattern: a nested project's wall under `[legacy]/` compiled as a class,
 * matched nothing, and the root task read it. So is each of `names`, the
 * baseline reads: a linked dependency under `packages/[legacy]/` was a
 * class too, and as an exact regex even `[[]` grants the directory's entry
 * and none of its files, so its subtree is granted beside it (a trailing
 * `/**` is stripped before the compile). A task's read grant whose only
 * brackets are escaped names one path too, and Linux binds it whole, so
 * it gets the same subtree: `out/\[id\]` read `out/[id]` and none of it.
 *
 * A `*` or `?` meant as itself (escaped in a grant, or in a baseline's
 * name) has no spelling: SRT's rewrite of each runs inside a class too,
 * and a backslash compiles as a literal one, so `a\*.txt` granted
 * `a\bc.txt` and never `a*.txt`. Left out and said once, as on Linux
 * (`bindableReads`).
 */
export function seatbeltBrackets(
  config: TaskSandboxConfig | undefined,
  names: readonly string[] = [],
): TaskSandboxConfig | undefined {
  const fs = config?.filesystem
  if (fs === undefined) return config
  const literal = (p: string): string => p.replaceAll('\\[', '[[]').replaceAll('\\]', ']')
  const bracketed = new Set(names.filter((n) => /[[\]]/.test(n)))
  const baseline = new Set(names)
  const read = (p: string): string[] => {
    if (!seatbeltSpells(p, 'read', baseline.has(p))) return []
    const name = bracketed.has(p) ? p : /\\[[\]]/.test(p) ? namedPath(p) : undefined
    if (name === undefined) return [patternOnly(literal(p))]
    const at = name.replaceAll('[', '[[]')
    return [at, `${at}/**/*`]
  }
  return {
    ...config,
    filesystem: {
      ...fs,
      denyRead: fs.denyRead.map((p) => p.replaceAll('[', '[[]')),
      allowWrite: fs.allowWrite
        .filter((p) => seatbeltSpells(p, 'write', false))
        .map((p) => patternOnly(literal(p))),
      ...(fs.allowRead !== undefined
        ? { allowRead: [...new Set(fs.allowRead.flatMap(read))] }
        : {}),
    },
  }
}

/**
 * A grant's pattern and nothing else. SRT (0.0.81) also reads an allow
 * entry holding a bracket as the name it spells wherever that is on disk,
 * so the class `pages/[id].tsx` (`i` or `d`) granted a file named
 * `[id].tsx` too. Each class takes its last member again, the same class,
 * until the name the spelling makes is not on disk.
 */
function patternOnly(grant: string): string {
  if (!grant.includes('[')) return grant
  let out = grant
  for (let n = 1; n <= 8 && namedOnDisk(out); n++) {
    out = grant.replace(/\[([^\]]+)\]/g, (_, c: string) => `[${c}${c.at(-1)!.repeat(n)}]`)
  }
  return out
}

/** Whether a component holding a bracket names something on disk, as SRT probes it. */
function namedOnDisk(spelling: string): boolean {
  const parts = spelling.split('/')
  for (let i = 1; i <= parts.length; i++) {
    if (!/[[\]]/.test(parts[i - 1]!)) continue
    try {
      lstatSync(parts.slice(0, i).join('/') || '/')
      return true
    } catch {
      // not there: this component is only a pattern
    }
  }
  return false
}

/** A `*` or `?` behind an odd run of backslashes: the grant means the character. */
const ESCAPED_WILDCARD = /(?:^|[^\\])(?:\\\\)*\\[*?]/

const warnedUnspellable = new Set<string>()

/** Whether seatbelt's SRT can take `grant` as written; said once when not. */
function seatbeltSpells(grant: string, kind: 'read' | 'write', name: boolean): boolean {
  const m = name ? /[*?]/.exec(grant) : ESCAPED_WILDCARD.exec(grant)
  if (m === null) return true
  const at = name ? m.index : m.index + m[0].length - 2
  if (!warnedUnspellable.has(`${kind} ${grant}`)) {
    warnedUnspellable.add(`${kind} ${grant}`)
    notify({
      kind: 'line',
      tone: 'warn',
      text:
        `[vx] sandbox: the ${kind} grant ${grant} names a literal ${grant[at + (name ? 0 : 1)]}, ` +
        `which the macOS sandbox reads as a pattern and cannot spell as a name, so it is not ` +
        `granted. Rename it, or grant the directory above it: ` +
        `${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
    })
  }
  return false
}

/** SRT's wrap, with the socket lift and the git-config grant this task asked for, or none (L-6, B-41). */
function wrapForTask(
  SandboxManager: SrtModule['SandboxManager'],
  command: string,
  customConfig: TaskSandboxConfig | undefined,
  sockets: boolean,
  gitConfig: boolean,
): Promise<string> {
  // macOS: the runtime runs the command under bash unless told, and an
  // unsandboxed task runs under `taskShell()` (dash). Linux needs no word:
  // `ownGroupCommand` already puts the task shell inside.
  const shell = process.platform === 'darwin' ? taskShell() : undefined
  const run = perTaskRun
  if (run === undefined) return SandboxManager.wrapWithSandbox(command, shell, customConfig)
  const turn = wrapTurn.then(() => {
    SandboxManager.updateConfig({
      ...run,
      network: { ...run.network, allowAllUnixSockets: sockets },
      filesystem: { ...run.filesystem, allowGitConfig: gitConfig },
    })
    return SandboxManager.wrapWithSandbox(command, shell, customConfig)
  })
  wrapTurn = turn.catch(() => undefined)
  return turn
}

/** The ports a list grants, deduped; `true` bridges nothing (the host sees no port on Linux). */
export function bridgedPorts(c: Pick<ResolvedSandboxConfig, 'localBinding'>): number[] {
  return Array.isArray(c.localBinding) ? [...new Set(c.localBinding)] : []
}

/**
 * Linux: SRT starts its in-sandbox proxy bridges (`socat TCP-LISTEN:3128`
 * and `:1080`) in the background and runs the command at once, so a
 * networked task that dialled the proxy first met "connection refused"
 * (curl's `000`) on a loaded box (M-20). This waits, in front of the
 * command, until both listen in the task's network namespace, read off
 * /proc/net (IPv4 or IPv6, state 0A). Bounded at ~5 s: a bridge that never
 * listens leaves the command to meet the refusal it met before, and says
 * so on the task's stderr (it gave up in silence, 2026-11-10).
 *
 * Every task the run's bridge reaches waits, not only one that lists a
 * network: one that lists none dials the same proxy, which refuses and
 * names the host, and that refusal fails it. Waited for only by networked
 * tasks, it met the closed port instead under load, swallowed the error
 * and passed with nothing reported (2026-11-06). The wait costs ~4 ms, the
 * socat's own start.
 */
export const PROXY_BRIDGE_WAIT =
  "( i=0; until grep -qsE ':0C38 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6 && grep -qsE ':0438 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6; do [ $i -ge 500 ] && { echo \"[vx] the sandbox's network proxy bridges (ports 3128 and 1080) did not listen within 5 s; this task's network requests will be refused\" >&2; break; }; i=$((i+1)); sleep 0.01; done );"

/** Each networked task's own proxy front, by tag, closed when its bridges go. */
const taskProxies = new Map<string, TaskProxy>()
/** Whether the run's proxy allows any host: one that allows none refuses every task alike, front or not. */
let runAllowsHosts = false
/** The run's union: what a `network: true` task's front allows. */
let runAllowed: readonly string[] = []

/**
 * A networked task's own proxy front (task-proxy.ts). The runtime's proxy
 * is the run's and filters by the union of every task's lists, so a task
 * reached a host only another task of the run declared. The front judges
 * by this task's own lists and passes what it allows on to the run's
 * proxy. Linux: it listens on a socket in the task's tmpdir, bound over
 * the runtime's bridge socket, so the task's side dials the same path.
 * macOS: it listens on a loopback port of its own, and the task's proxy
 * variables and profile name that port in place of the run's, so the
 * profile refuses the run's. A task that lists no network gets a front
 * that refuses every host; `network: true` gets one that allows the
 * run's union. Each front refuses only its own task's denies. Fails closed: a task the front cannot take does not run.
 */
async function ownProxy(
  SandboxManager: SrtModule['SandboxManager'],
  wrapped: string,
  inner: string,
  tag: string,
  config: ResolvedSandboxConfig,
): Promise<string> {
  const port = SandboxManager.getProxyPort()
  const token = SandboxManager.getProxyAuthToken()
  const linux = process.platform === 'linux'
  const bridge = linux ? SandboxManager.getLinuxHttpSocketPath() : undefined
  const bind = bridge === undefined ? undefined : `--bind ${bridge} ${bridge}`
  const runPort = new RegExp(`localhost:${port}(?!\\d)`, 'g')
  const handed =
    port !== undefined &&
    token !== undefined &&
    (linux ? bind !== undefined && wrapped.includes(bind) : runPort.test(wrapped))
  // A task that lists no network is handed the run's proxy too when another
  // task of the run lists some; it gets a front that refuses every host.
  if (!handed) {
    if (config.network === undefined) return wrapped
    throw new Error('sandbox: the runtime gave this networked task no proxy to replace')
  }
  const socket = path.join(taskTmpdir(tag), 'vx-net.sock')
  const key = Buffer.from(inner.slice(0, 100)).toString('base64')
  const front = await startTaskProxy({
    endpoint: linux ? socket : 0,
    allowed:
      config.network === true
        ? runAllowed
        : config.network === undefined
          ? []
          : (config.network as string[]),
    denied: config.denyNetwork ?? [],
    runProxyPort: port!,
    token: token!,
    encodedCommand: key,
    refused: (line) => collecting.get(key)?.push({ line, timestamp: new Date() }),
  })
  taskProxies.set(tag, front)
  if (!linux) return wrapped.replace(runPort, `localhost:${front.port}`)
  // After the root's read-only bind, which would mask a bind made before it
  // with the host's own file: the runtime's socket, reachable as itself.
  const own = `--bind ${socket} ${bridge}`
  const root = ' --ro-bind / / '
  const at = wrapped.indexOf(root)
  return at === -1
    ? wrapped.replace(bind!, own)
    : `${wrapped.slice(0, at + root.length)}${own} ${wrapped.slice(at + root.length)}`
}

/** Where a bridge's unix socket lives: the sandbox tmpdir, bound read-write on both sides. */
export function portBridgeSocket(tag: string, port: number): string {
  return path.join(taskTmpdir(tag), `vx-port-${tag}-${port}.sock`)
}

/**
 * Which loopback a bridged connection dials, chosen per connection from
 * the namespace's listen tables (`$1` the port, `$2` the tables' directory):
 * `::1` when only it holds the port, else 127.0.0.1. A server bound to
 * `localhost` on a host that resolves `::1` first (Vite's default) listens
 * on `::1` alone, and a fixed 127.0.0.1 dial was refused. Read before any
 * byte moves, so a connection is never retried halfway through.
 */
export const PORT_DIAL_SCRIPT = `p=$1 n=\${2:-/proc/net}
h=$(printf %04X "$p")
if grep -qsE "^ *[0-9]+: 0{24}01000000:$h [0-9A-F]+:0{4} 0A" "$n/tcp6" &&
  ! grep -qsE "^ *[0-9]+: (0100007F|0{8}):$h [0-9A-F]+:0{4} 0A" "$n/tcp"; then
  exec socat - "TCP6:[::1]:$p"
fi
exec socat - "TCP4:127.0.0.1:$p"
`

/** Where the dial script lives: beside the bridge's sockets, written by `wrapSandboxedCommand`. */
function portDialScript(tag: string): string {
  return path.join(taskTmpdir(tag), `vx-port-dial-${tag}.sh`)
}

/**
 * The task's side of the bridge, in front of the user command inside the
 * sandbox: one socat per port, listening on the unix socket and relaying
 * into the namespace's loopback through `PORT_DIAL_SCRIPT`. Backgrounded
 * and reaped with the shell, exactly as SRT starts its own proxy bridges.
 * `unlink-early` clears a socket a killed task left behind; `>/dev/null`
 * keeps its chatter out of the task's frame.
 */
export function portBridgeInner(ports: readonly number[], tag: string): string {
  const cmds = ports.map(
    (p) =>
      `socat UNIX-LISTEN:${shellQuote(portBridgeSocket(tag, p))},fork,unlink-early ${shellQuote(`SYSTEM:sh ${portDialScript(tag)} ${p}`)} >/dev/null 2>&1 &`,
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

/** Where a reached port's unix socket lives: beside the bridge's, in the sandbox tmpdir. */
function reachBridgeSocket(tag: string, port: number): string {
  return path.join(taskTmpdir(tag), `vx-reach-${tag}-${port}.sock`)
}

/**
 * The task's side of a reached loopback port (`network: ['localhost:4173']`),
 * in front of the user command: a listener on the port in the task's own
 * namespace (127.0.0.1, and ::1 where the host has IPv6: a client that
 * resolves `localhost` to ::1 first is refused there otherwise), relaying
 * each connection to the unix socket the host's side holds, with a retry
 * as the host's side of a port bridge has. Then a wait, bounded at ~5 s
 * as `PROXY_BRIDGE_WAIT`'s, until each listens: the client dials at once.
 */
function reachBridgeInner(ports: readonly number[], tag: string, ipv6: boolean): string {
  const listens = ports.flatMap((p) => {
    const to = shellQuote(`UNIX-CONNECT:${reachBridgeSocket(tag, p)},retry=40,interval=0.25`)
    return [
      `socat TCP4-LISTEN:${p},bind=127.0.0.1,fork,reuseaddr ${to} >/dev/null 2>&1 &`,
      ...(ipv6
        ? [`socat TCP6-LISTEN:${p},bind=[::1],ipv6only=1,fork,reuseaddr ${to} >/dev/null 2>&1 &`]
        : []),
    ]
  })
  const waits = ports.map(
    (p) =>
      `( i=0; until grep -qsE ':${p.toString(16).toUpperCase().padStart(4, '0')} [0-9A-F]+:0000 0A' /proc/net/tcp; do [ $i -ge 500 ] && break; i=$((i+1)); sleep 0.01; done );`,
  )
  return `${listens.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT; ${waits.join(' ')}`
}

/**
 * The host's side of a reached port: a unix socket in the task's tmpdir,
 * dialling the host's loopback per connection through `PORT_DIAL_SCRIPT`
 * (::1 when only it holds the port: Vite's `localhost`).
 */
function reachBridgeHostArgv(tag: string, port: number): string[] {
  return [
    'socat',
    `UNIX-LISTEN:${reachBridgeSocket(tag, port)},fork,unlink-early`,
    `SYSTEM:sh ${portDialScript(tag)} ${port}`,
  ]
}

const hostBridges = new Map<
  string,
  {
    ports: readonly number[]
    /** The host loopback ports the task reaches (`reachBridgeInner`). */
    reach: readonly number[]
    procs: Array<ReturnType<typeof Bun.spawn>>
  }
>()

/**
 * The ports a host listener already holds where the bridge would bind
 * (`127.0.0.1`, or every address). The listen wait below reads the same
 * table and took that listener for the bridge, whose bind had failed: the
 * task passed and a client of the port reached the other process
 * (2026-10-03). Linux, own procfs only, as the wait.
 */
function portsHeld(ports: readonly number[]): number[] {
  if (ports.length === 0) return []
  // This run's own bridges first: a wrap claims its ports before it awaits,
  // and two tasks granted one port both read the table before either
  // bridge bound, so the second's bind failed unseen and its clients
  // reached the first task.
  const claimed = new Set([...hostBridges.values()].flatMap((b) => b.ports))
  const ours = ports.filter((p) => claimed.has(p))
  if (ours.length > 0 || !procfsIsOwn()) return ours
  const held = new Set<string>()
  for (const [file, any, loop] of [
    ['/proc/net/tcp', '00000000', '0100007F'],
    ['/proc/net/tcp6', '00000000000000000000000000000000', '00000000000000000000000001000000'],
  ] as const) {
    let table: string
    try {
      table = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] !== '0A' || f[1] === undefined) continue
      const [addr, port] = f[1].split(':')
      // `::1` does not hold 127.0.0.1's port; every address does.
      if (addr === any || (file === '/proc/net/tcp' && addr === loop)) held.add(port!)
    }
  }
  return ports.filter((p) => held.has(p.toString(16).toUpperCase().padStart(4, '0')))
}

/**
 * Wait until each host-side bridge listens on its port, so a server that
 * says it is ready inside the sandbox is reachable on the host: the socat
 * starts asynchronously, and a held server's port refused a connection
 * right after its ready line under I/O load (M-22). Read off
 * /proc/net/tcp (127.0.0.1, state 0A); skipped where /proc is not this
 * process's (its net table could be another namespace's), ended early by
 * a bridge that exited, and bounded at 5 s. A port another listener holds
 * reads as listening here, so the wrap refuses it first (`portsHeld`).
 */
async function hostBridgesListen(ports: readonly number[], tag: string): Promise<void> {
  if (!procfsIsOwn()) return
  const want = ports.map((p) => `0100007F:${p.toString(16).toUpperCase().padStart(4, '0')}`)
  const procs = hostBridges.get(tag)?.procs ?? []
  const until = performance.now() + 5_000
  while (performance.now() < until && procs.every((p) => p.exitCode === null)) {
    let table: string
    try {
      table = readFileSync('/proc/net/tcp', 'utf8')
    } catch {
      return
    }
    const listening = new Set<string>()
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] === '0A' && f[1] !== undefined) listening.add(f[1])
    }
    if (want.every((w) => listening.has(w))) return
    await Bun.sleep(5)
  }
}

function spawnHostBridges(tag: string): void {
  const { ports, reach, procs } = hostBridges.get(tag)!
  const argvs = [
    ...ports.map((p) => portBridgeHostArgv(tag, p)),
    ...reach.map((p) => reachBridgeHostArgv(tag, p)),
  ]
  for (const bridge of argvs) {
    // A spawn failure (no socat on the host) is the task's to report:
    // its own side dies the same way, in its frame.
    try {
      // socat resolved on vx's PATH, as every tool vx spawns: by bare name
      // Bun.spawn walked the startup PATH (M-22).
      const [tool, ...rest] = bridge
      const argv = [executablePath(tool!), ...rest]
      // Guarded, in a group of its own (kill-tree.ts): a plain child of vx
      // was in no group the guard lists, and a `kill -9` of vx left it
      // listening on the port under init, where the next run's bridge
      // could not bind it (item 873).
      procs.push(
        spawnGuarded((guard) =>
          guard === undefined
            ? Bun.spawn(argv, {
                stdio: ['ignore', 'ignore', 'ignore'],
                detached: true,
                env: helperEnv(),
              })
            : Bun.spawn(
                [taskShell(), '-c', `${guardLine(3)}exec ${argv.map(shellQuote).join(' ')}`],
                { stdio: ['ignore', 'ignore', 'ignore', guard], detached: true, env: helperEnv() },
              ),
        ),
      )
    } catch {
      // see above
    }
  }
  if (procs.length > 0) {
    for (const p of ports) unlinkOnExit(portBridgeSocket(tag, p))
    for (const p of reach) unlinkOnExit(reachBridgeSocket(tag, p))
  }
}

/**
 * Stop the host side of a task's port bridges and remove their sockets;
 * idempotent. Called once the task's process has exited, so the socat
 * that listened on each socket is gone with the namespace, and never
 * unlinked it: one socket per bridged run stayed in the temp dir (item
 * 877).
 */
export function releaseBridges(tag: string): void {
  const tmp = taskTmpdir(tag)
  // One that will not go stays tracked, for the exit hook.
  if (liveTaskTmpdirs.has(tmp) && removeTaskTmpdir(tmp)) liveTaskTmpdirs.delete(tmp)
  if (liveServers.delete(tag)) {
    // A server's wrap stays counted until it stops: one stopped server
    // kept every later task's stubs in the workspace until the reset.
    afterCommand(srtLoaded!.SandboxManager)
    if (liveServers.size === 0 && resetDeferred) void resetSandbox().catch(() => {})
  }
  const front = taskProxies.get(tag)
  if (front !== undefined) {
    taskProxies.delete(tag)
    // quiet: a front that will not close holds only its own socket, gone with the tmpdir
    void front.close().catch(() => undefined)
  }
  const bridges = hostBridges.get(tag)
  if (bridges === undefined) return
  hostBridges.delete(tag)
  for (const sock of [
    ...bridges.ports.map((p) => portBridgeSocket(tag, p)),
    ...bridges.reach.map((p) => reachBridgeSocket(tag, p)),
  ]) {
    try {
      unlinkSync(sock)
    } catch {
      // never bound, or gone
    }
    liveTempFiles.delete(sock)
  }
  for (const p of bridges.procs) {
    // The group: a socat forks one child per connection. Listed on the
    // guard until it has gone (item 867's order).
    killTree(p, 'SIGTERM')
    void p.exited.then(() => releaseGroup(p))
  }
}

/** What a task's output says when strace, not the task, ended its first attempt. */
const TRACER_RETRY_LINE =
  "[vx] the sandbox's tracer (strace) failed on its own; running the task again\n"

/** What a task's output says when a mount went away as bwrap set the sandbox up. */
const MOUNT_RACE_RETRY_LINE =
  '[vx] a mount went away as the sandbox was set up; running the task again\n'

/**
 * bwrap's own refusal of a mount gone between its read of the mount table
 * and its remount: a container runtime's transient mount under /tmp
 * (`/newroot/tmp/containerd-mount…`, a `docker build` beside the task on
 * CI). The command never started. Caught after the unmount but before its
 * directory is removed, the remount meets a path that is no longer a mount
 * point: `Invalid argument`. Or a path the wrap walls, gone before
 * bwrap mounts on it: bwrap makes the mount point anew under a read-only
 * parent (`Can't mkdir /tmp/vx-noscan-0: Read-only file system`, the no-scan
 * directory removed by another process).
 */
const BWRAP_MOUNT_GONE =
  /^bwrap: Can't (?:.*: No such file or directory|mkdir .*: Read-only file system|bind mount .*: Unable to apply mount flags: remount ".*": Invalid argument)$/

/**
 * Run a single task wrapped in the sandbox. Caller must have called
 * `initSandbox()` first.
 *
 * On Linux the task runs under strace, which only REPORTS what the sandbox
 * denied. strace failing on its own (`ptrace(PTRACE_LISTEN,…): Input/output
 * error`, after a build that had finished) turned green work red on CI five
 * times (STATUS Next 24): its exit was the task's. Since B-11 strace runs
 * detached (`-DD`), yet under `--seccomp-bpf` (strace 6.8 implies
 * `--kill-on-exit`) a tracer that dies still SIGKILLs the command: exit
 * 137 on CI (M-18). Untraced or killed, the trace stopped short and a
 * denial after it goes unreported. So an attempt whose stderr carries strace's own word is
 * run once more, whatever its exit, unless the run is stopping: the sandbox kept its writes to what it
 * declared, so a second run redoes, not doubles, it.
 */
export async function runSandboxed(args: SandboxedRunArgs): Promise<SandboxedRunResult> {
  // Whether the first attempt's output, both streams, ended mid-line: the
  // notice starts its own line (it read `…/strace: bare[vx] the sandbox's…`).
  let midLine = false
  const seen =
    (on: ((chunk: string) => void) | undefined) =>
    (chunk: string): void => {
      if (chunk.length > 0) midLine = !chunk.endsWith('\n')
      on?.(chunk)
    }
  const { tracerFailed, mountGone, ranMs, ...first } = await runSandboxedOnce({
    ...args,
    onStdout: seen(args.onStdout),
    onStderr: seen(args.onStderr),
  })
  // A stopping run has killed the children it holds; a retry would be one
  // spawned after that kill.
  if (!(tracerFailed || mountGone) || args.signal?.aborted === true) return first
  const notice = (midLine ? '\n' : '') + (mountGone ? MOUNT_RACE_RETRY_LINE : TRACER_RETRY_LINE)
  args.onStderr?.(notice)
  // `timeout` bounds the task's whole run (schema.md), so the retry gets
  // what the first attempt left of it, not a fresh window.
  const {
    tracerFailed: _again,
    mountGone: _gone,
    ranMs: _ran,
    ...second
  } = await runSandboxedOnce(
    args.timeoutMs === undefined
      ? args
      : { ...args, timeoutMs: Math.max(0, args.timeoutMs - ranMs) },
  )
  return {
    ...second,
    durationMs: first.durationMs + second.durationMs,
    stdout: first.stdout + second.stdout,
    stderr: first.stderr + notice + second.stderr,
  }
}

/** The records collected for the commands running, by SRT's key for each. */
const collecting = new Map<string, SandboxViolation[]>()
let collectorOn = false

/**
 * Start collecting SRT's store records for `command`; the returned function
 * stops and hands them over, with `settle` once every record the task's
 * Linux observer (`observer`, its socket) sent is read. The store is a
 * 100-record ring the whole run shares, and on Linux its write observer
 * reports every write any task
 * makes, so a refused write followed by 150 declared ones was gone before
 * the task's exit read it (B-7). One subscription takes each record as it
 * arrives and keeps it only for a command still running. SRT keys a record
 * by the base64 of the command's first 100 characters
 * (`encodeSandboxedCommand`, not exported).
 */
export function collectRecords(
  store: ReturnType<SrtModule['SandboxManager']['getSandboxViolationStore']>,
  command: string,
  observer: string | undefined,
): (settle: boolean) => Promise<SandboxViolation[]> {
  if (!collectorOn) {
    collectorOn = true
    let seen = store.getTotalCount()
    store.subscribe((all) => {
      const total = store.getTotalCount()
      const fresh = Math.min(total - seen, all.length)
      seen = total
      for (const v of fresh > 0 ? all.slice(-fresh) : []) {
        collecting.get(v.encodedCommand ?? '')?.push({ line: v.line, timestamp: v.timestamp })
      }
    })
  }
  const key = Buffer.from(command.slice(0, 100)).toString('base64')
  const list: SandboxViolation[] = []
  collecting.set(key, list)
  return async (settle) => {
    if (settle && observer !== undefined) await observerCaughtUp(observer)
    collecting.delete(key)
    return list
  }
}

/**
 * The Unix socket SRT's Linux write observer listens on, from the command
 * it wrapped (`--setenv SRT_OBSERVE_SOCK <path>`); none when the listener
 * failed or on macOS.
 */
function observerSocket(wrapped: string): string | undefined {
  return /--setenv SRT_OBSERVE_SOCK (?:'([^']*)'|(\S+))/.exec(wrapped)?.slice(1).find(Boolean)
}

/**
 * Resolves once SRT has read every record sent to `socket` before the call.
 * A task's observer sends its records before the task exits, but they are
 * read when this process gets to that connection: a fixed count of event
 * loop turns after the exit (2) lost 4 of 24 refusals on a loaded CI
 * worker. So a connection of ours goes in after them: the kernel queues
 * connections in order, so SRT accepts it no earlier than the task's, and
 * the task's bytes were already there when it did. SRT's server is not
 * half-open, so it ends ours once it reads our end, and that end coming
 * back means the task's bytes were read first. A socket that is gone
 * answers at once with an error.
 */
function observerCaughtUp(socket: string): Promise<void> {
  return new Promise((resolve) => {
    const conn = createConnection(socket)
    conn.on('connect', () => conn.end())
    conn.on('error', () => resolve())
    conn.on('close', () => resolve())
    conn.resume()
  })
}

/**
 * strace's own message, a line of a traced task's stderr. strace names
 * itself by its argv[0], the absolute path vx runs it by
 * (`/usr/bin/strace: ptrace(PTRACE_LISTEN,…)` on CI), so a bare
 * `strace: ` never matched there and the retry never fired.
 */
const STRACE_OWN_ERROR = /^(?:[^\s:]*\/)?strace: /

/** One attempt's result, with what `runSandboxed` decides a second on. */
type AttemptResult = SandboxedRunResult & {
  tracerFailed: boolean
  mountGone: boolean
  ranMs: number
}

/** An attempt whose command never ran: nothing to report, nothing to retry. */
function notRun(
  start: number,
  ended: { exitCode: number; stderr: string; spawnFailed?: true; signal?: NodeJS.Signals },
): AttemptResult {
  return {
    exitCode: ended.exitCode,
    durationMs: Math.round(runTime() - start),
    stdout: '',
    stderr: ended.stderr,
    ...(ended.spawnFailed ? { spawnFailed: true } : {}),
    ...(ended.signal !== undefined ? { signal: ended.signal } : {}),
    violations: [],
    tracerFailed: false,
    mountGone: false,
    ranMs: 0,
  }
}

type Wrap = Awaited<ReturnType<typeof wrapSandboxedCommand>>

/** The wrap, and what the task's widened and held grants held before it ran. */
interface Prepared {
  wrap: Wrap
  /** Each widened grant's entries before the spawn: what the task creates there is its own. */
  widened: Map<string, Set<string>>
  /** `widened`, plus each directory bound for a glob, judged as a widened one (`refusedWrites`). */
  heldEntries: Map<string, Set<string>>
}

/**
 * Linux: SRT's store sees only writes, so read denials need the command
 * traced and the trace parsed for denied syscalls. The trace is per-task
 * (a log keyed by the command tag) so parallel tasks don't share a
 * stream. Skipped when strace isn't on PATH — bwrap still enforces
 * structurally; we just lose the structured violation list.
 *
 * We trace the opens, the read itself, plus `execve` and the access
 * probes (`TRACED_CALLS`). Not `statx` / `newfstatat`: a stop per stat
 * is a tax on every stat-heavy task. A probe's ENOENT counts only where
 * the host has the path (`parseStraceViolations`), so a PATH walk past
 * a missing `node_modules/.bin` entry reports nothing.
 *
 * `--seccomp-bpf` is what makes that filter cheap: without it strace
 * ptrace-stops the tracee on EVERY syscall and discards the untraced ones
 * in userspace, so a stat-heavy task ran many times slower under the
 * sandbox than outside it (plain `bun test` 24/24; under
 * `strace -f -e trace=openat` four failed at 2.5–7× their budget; with
 * `--seccomp-bpf` 24/24 again). With the flag the kernel filter stops only
 * on the traced calls. strace ≥ 5.3 (2019); an older one gets the slow
 * form rather than no detection.
 */
async function prepareAttempt(
  args: SandboxedRunArgs,
  SandboxManager: SrtModule['SandboxManager'],
  start: number,
): Promise<{ prepared: Prepared } | { result: AttemptResult }> {
  const useStrace = await wantsStraceDetection()
  const widened = widenedEntries(args.config.allowWrite)
  let wrap: Wrap
  try {
    wrap = await wrapSandboxedCommand({
      ...args,
      ...(useStrace ? { trace: useStrace } : {}),
      ...(useStrace && widened.size > 0 ? { tracePaths: true } : {}),
    })
  } catch (err) {
    if ((err as { code?: unknown } | undefined)?.code !== 'command_too_long') throw err
    const bytes = /\((\d+) bytes/.exec((err as Error).message)?.[1]
    const stderr = sandboxArgTooLongText(
      bytes !== undefined ? Number(bytes) : Buffer.byteLength(args.command),
    )
    args.onStderr?.(stderr)
    afterCommand(SandboxManager)
    return { result: notRun(start, { exitCode: 127, stderr, spawnFailed: true }) }
  }
  const heldEntries = new Map(widened)
  for (const dir of wrap.held.dirs) {
    try {
      heldEntries.set(dir, new Set(readdirSync(dir).map((e) => path.join(dir, e))))
    } catch {
      // Gone: nothing there to judge.
    }
  }
  return { prepared: { wrap, widened, heldEntries } }
}

/** The sandboxed command, spawned, and the trace log it writes. */
interface Spawned {
  proc: ReturnType<typeof Bun.spawn>
  pipes: TaskPipes
  straceLog: string | undefined
}

/** Spawn the wrapped command, or say why it did not start. */
function spawnAttempt(
  args: SandboxedRunArgs,
  wrap: Wrap,
  takeRecords: (settle: boolean) => Promise<SandboxViolation[]>,
  SandboxManager: SrtModule['SandboxManager'],
  start: number,
): { spawned: Spawned } | { result: AttemptResult } {
  const { wrapped, tag, forwardsSignals, traced } = wrap
  // A stop that landed during the awaits before this leaves nothing to
  // kill yet: spawned now, the task ran after the teardown swept the run's
  // children.
  if (args.signal?.aborted === true) {
    releaseBridges(tag)
    void takeRecords(false)
    afterCommand(SandboxManager)
    const signal = stopSignal(args.signal.reason)
    return { result: notRun(start, { exitCode: signalExitCode(signal), stderr: '', signal }) }
  }
  // Beside the task directories, which every sandbox replaces with its own:
  // in the shared temp dir a concurrent task read this log, every path
  // this task opened (L-25).
  const straceLog = traced ? path.join(taskTmpRoot(), `vx-strace-${tag}.log`) : undefined
  if (straceLog) unlinkOnExit(straceLog)
  let proc: ReturnType<typeof Bun.spawn>
  let traceFd: number | undefined
  const pipes = new TaskPipes()
  try {
    // Resolved on vx's own PATH (util/which.ts), not the task's, where a
    // project's node_modules/.bin comes first.
    const sh = taskShell()
    if (straceLog) traceFd = openSync(straceLog, 'w')
    // Descriptors: 3 the signal channel the in-sandbox watcher reads, 4 the
    // guard's pipe (kill-tree.ts), TRACE_FD the trace log; a gap is 'ignore'.
    proc = spawnGuarded((guard) =>
      Bun.spawn([sh, '-c', (guard === undefined ? '' : guardLine(4)) + wrapped], {
        argv0: 'sh',
        cwd: args.cwd,
        env: args.env as Record<string, string>,
        stdio: [
          'ignore',
          ...pipes.stdio,
          forwardsSignals ? 'pipe' : 'ignore',
          guard ?? 'ignore',
          ...(traceFd === undefined ? [] : [traceFd]),
        ],
        // As the unsandboxed spawn: its own process group (kill-tree.ts).
        detached: true,
      }),
    )
    if (forwardsSignals) signalThrough(proc, proc.stdio[3] as number)
  } catch (err) {
    pipes.close()
    if (straceLog) {
      rmSync(straceLog, { force: true })
      liveTempFiles.delete(straceLog)
    }
    const stderr = spawnFailureText(err, args.cwd, SANDBOXED_TASK, wrapped, args.env)
    args.onStderr?.(stderr)
    releaseBridges(tag)
    void takeRecords(false)
    afterCommand(SandboxManager)
    return { result: notRun(start, { exitCode: 127, stderr, spawnFailed: true }) }
  } finally {
    // The child holds its own copy; ours would keep nothing but a descriptor.
    if (traceFd !== undefined) closeSync(traceFd)
    pipes.spawned()
  }
  return { spawned: { proc, pipes, straceLog } }
}

/** What the command's stderr said about the attempt, read whatever the capture setting. */
interface StderrSigns {
  /** The unfinished last line. */
  partial: string
  /** A line was strace's own: the trace stopped short. */
  straceSpoke: boolean
  /** bwrap's refusal of a mount gone as it set up (`BWRAP_MOUNT_GONE`). */
  mountGone: boolean
  /** `hiddenGitHint`. */
  gitNoRepo: boolean
  /** `grantRemovalHint`: a run captures no output. */
  readOnlyLines: string[]
}

/** The attempt, ended: its exit, its streams, and what was seen while it ran. */
interface Ended {
  exitCode: number
  stdout: string
  stderr: string
  ranMs: number
  /** Linux: the tree's use, looked at while it ran (`watchTree`). */
  looked: TreeUsage | undefined
  /** Something of the group outlived the command. */
  left: boolean
  timeout: ReturnType<typeof armTimeout>
  signs: StderrSigns
  /**
   * The last 16 KiB of each stream, chunks kept by reference, read on a
   * failure only (`statedHiddenHint`, `refusedLoopbackHint`). Two chunks
   * were kept, and a pipe that split curl's one refusal line in three
   * left the port out of the tail.
   */
  outTail: Tail
  errTail: Tail
}

/** Read the command's streams until it exits, then let its group and bridges go. */
async function awaitAttempt(args: SandboxedRunArgs, spawned: Spawned, tag: string): Promise<Ended> {
  const { proc, pipes } = spawned
  args.liveChildren?.add(proc)
  args.onSpawn?.(proc.pid)
  const watch = process.platform === 'linux' ? watchTree(proc.pid) : undefined
  const timeout = armTimeout(proc, args.timeoutMs)
  const armedAt = runTime()
  const ac = new AbortController()
  const signs: StderrSigns = {
    partial: '',
    straceSpoke: false,
    mountGone: false,
    gitNoRepo: false,
    readOnlyLines: [],
  }
  const outTail = new Tail()
  const errTail = new Tail()
  const [out, err] = pipes.streams(proc)
  const ends = lineEnds(args.onStdout, args.onStderr)
  const streams = Promise.all([
    streamToString(
      out,
      (chunk) => {
        outTail.push(chunk)
        ends.onStdout?.(chunk)
      },
      ac.signal,
      args.capture?.stdout ?? true,
    ),
    streamToString(
      err,
      (chunk) => {
        const lines = (signs.partial + chunk).split('\n')
        signs.partial = (lines.pop() ?? '').slice(0, 512)
        if (lines.some((l) => STRACE_OWN_ERROR.test(l))) signs.straceSpoke = true
        if (lines.some((l) => BWRAP_MOUNT_GONE.test(l))) signs.mountGone = true
        if (lines.some((l) => GIT_NO_REPO.test(l))) signs.gitNoRepo = true
        for (const l of lines)
          if (signs.readOnlyLines.length < 64 && READ_ONLY_FS.test(l)) signs.readOnlyLines.push(l)
        errTail.push(chunk)
        ends.onStderr?.(chunk)
      },
      ac.signal,
      args.capture?.stderr ?? true,
    ),
  ]).finally(() => pipes.close())
  // See runCommand: gate on child exit; a lingering grandchild pipe (timeout
  // OR a clean exit that backgrounds a process) can't hang the run — timeout
  // aborts at once, otherwise drainOrAbort bounds the post-exit drain.
  await proc.exited
  const ranMs = Math.round(runTime() - armedAt)
  const looked = watch?.stop()
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac)
  const [stdout, streamed] = await streams
  ends.end()
  // As runCommand: a leftover of a task the run stopped is vx's doing.
  // (`?? false`: the check above narrowed `aborted`, which a stop has
  // turned true across the awaits since.)
  const blame = cut && !(args.signal?.aborted ?? false)
  const cutLine = ends.own(POST_EXIT_CUT_LINE)
  if (blame) args.onStderr?.(cutLine)
  const stderr = blame ? streamed + cutLine : streamed
  // As runCommand: a leftover holding no pipe is still in the group. Under
  // Linux's pid namespace it died with the command; macOS keeps it.
  const left = cut || groupAlive(proc)
  args.liveChildren?.delete(proc)
  releaseGroup(proc)
  closeSignalChannel(proc)
  releaseBridges(tag)
  const exited = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  // A timeout is a failure, whatever the child said: one that traps the
  // TERM and exits 0 reported success to every executor built on this.
  const exitCode = exited === 0 && timeout.timedOut() ? signalExitCode('SIGTERM') : exited
  return { exitCode, stdout, stderr, ranMs, looked, left, timeout, signs, outTail, errTail }
}

/** Every denial the attempt recorded, and those of them its config reports. */
interface Denials {
  recorded: SandboxViolation[]
  violations: SandboxViolation[]
  /** The baselines' reads and the task's own. */
  grantedRead: string[]
}

/**
 * The attempt's denials. `records` are EVERY record SRT's store saw for
 * this command, unfiltered: a sandboxed task that fails must say what it
 * was denied, and deciding on the user's behalf that a record was "just
 * traversal" is how a failure ends up with no explanation.
 *
 * macOS: the store is fed asynchronously from the unified log, read once
 * right after the child exits, with no settle window: one cost 300 ms on
 * every clean sandboxed task (clean `echo` 331 ms sandboxed vs 16 ms
 * plain), and a poll only halved the loss, since the log drops records
 * under load. Reporting there is lossy; enforcement is not, and a command
 * that could not proceed still fails on its own exit code.
 *
 * Linux: the store is fed by SRT's write observer, judged against the
 * GLOBAL `allowWrite` from `initialize` (empty here; the per-task list
 * travels in `customConfig`, which the monitor never sees), so read as
 * is, every write to a declared output failed the task. strace never sees
 * a write: SRT's seccomp step hands every write-intent syscall to its
 * observer (USER_NOTIF takes precedence over strace's TRACE). So the
 * records are judged here against the task's own binds (`refusedWrites`),
 * and what is left is a write bwrap refused, or one into the anchor's
 * scratch that vanished with the sandbox (B-5). Reads come from the strace
 * log, best-effort: a parse that fails reports no Linux read.
 */
async function attemptDenials(
  args: SandboxedRunArgs,
  prepared: Prepared,
  records: readonly SandboxViolation[],
  straceLog: string | undefined,
): Promise<Denials> {
  const { baselines, scratch, held } = prepared.wrap
  const grantedRead = [...baselines.allowRead, ...args.config.allowRead]
  // A timestamp change seatbelt refused where the task may read landed
  // nothing, as on Linux (`refusedWrites`): `tsc -b` touches an up-to-date
  // dependency's buildinfo and swallows the refusal.
  const macViolations =
    process.platform === 'darwin'
      ? records.filter((v) => {
          const touched = /deny\(\d+\)\s+file-write-times\s+(\/.*?)\s*$/.exec(v.line)?.[1]
          return touched === undefined || !readableUnder(touched, grantedRead)
        })
      : []
  const linuxViolations: SandboxViolation[] =
    process.platform === 'linux'
      ? [
          ...(straceLog
            ? await parseStraceViolations(straceLog, args, baselines, prepared.widened).catch(
                () => [],
              )
            : []),
          ...refusedWrites(
            // Keyed by what SRT wrapped, the in-sandbox group wrapper
            // included, not by the tagged command macOS is keyed by.
            records.map((v) => v.line),
            [...bindableWrites(args.config.allowWrite), ...held.dirs],
            [...scratch, ...held.globs],
            [...baselines.allowRead, ...bindableReads(args.config.allowRead)],
            { entries: prepared.heldEntries, granted: args.config.allowWrite },
          ),
          ...refusedConnections(records.map((v) => v.line)),
        ]
      : []
  if (straceLog) {
    // Listed until the unlink lands, as the run lock's taking (item 868).
    await unlink(straceLog).catch(() => undefined)
    liveTempFiles.delete(straceLog)
  }
  // The task's own `ignore` lists, on top of the global defaults: SRT's
  // macOS wrap does not thread `customConfig.ignoreViolations` through to
  // the log monitor, whose filter is set once at `initSandbox`.
  const recorded = [...macViolations, ...linuxViolations]
  const violations = reportableViolations(recorded, {
    within: args.reportWithin,
    linked: args.reportLinked,
    config: args.config,
  })
  return { recorded, violations, grantedRead }
}

/**
 * vx's own notes beside the denials, each a `hint` never counted as one,
 * and all but the upstream note on a failure only, so none can redden a
 * pass. Pushed onto `denials.violations`.
 */
function addHints(
  args: SandboxedRunArgs,
  ended: Ended,
  denials: Denials,
  baselines: Wrap['baselines'],
): void {
  const { exitCode, signs, outTail, errTail } = ended
  const { recorded, violations, grantedRead } = denials
  // A write refused past the wall is not a violation (nothing a key reads),
  // but it may be why the task failed. A write refused in a dependency's
  // outputs is that project's task's work, never a grant here: `tsc -b`
  // under --exclude-dependencies rebuilt its upstream, and the hints named
  // `write: ['../p00/']`.
  const upstream = (args.upstreamOutputs ?? []).map(toRealPath)
  const isUpstream = (p: string | undefined): p is string =>
    p !== undefined && upstream.some((u) => atOrUnder(p, u))
  const upstreamWrites = new Set(
    violations
      .filter((v) => v.hint !== true && v.opened !== 'read' && v.ignorable?.includes('write'))
      .map((v) => v.path)
      .filter(isUpstream),
  )
  if (exitCode !== 0) {
    const refused = refusedWritesOutside(recorded, {
      within: args.reportWithin,
      linked: args.reportLinked,
      config: args.config,
      skip: [taskTmpRoot(), ...srtDefaultWritePaths()],
    })
    for (const p of refused.filter(isUpstream)) upstreamWrites.add(p)
    const outside = refused.filter((p) => !isUpstream(p))
    if (outside.length > 0) {
      const made = new Set(
        recorded.filter((v) => /^mkdir(?:at)?\(/.test(v.line)).map((v) => v.path),
      )
      violations.push(outsideWritesHint(outside, made, baselines.denyRead, args.reportWithin))
    }
    if (process.platform === 'linux') {
      const removed = grantRemovalHint(
        // Playwright says it on stdout, removing its own outputDir: its
        // tail, read on a failure only, as `statedHiddenHint` reads it.
        [
          ...signs.readOnlyLines,
          ...outTail
            .text()
            .split('\n')
            .filter((l) => READ_ONLY_FS.test(l))
            .slice(-64),
        ],
        bindableWrites(args.config.allowWrite),
        args.cwd,
        args.reportWithin,
      )
      if (removed !== undefined) violations.push(removed)
    }
  }
  if (upstreamWrites.size > 0)
    violations.push(upstreamWritesHint([...upstreamWrites], args.reportWithin))

  // The one denial macOS never logs: with the cwd outside every read
  // grant the process dies before macOS logs anything, and the child
  // reports what it likes (`bun test`: `An unknown error occurred`). Not a
  // guess: the cwd lying outside every allowRead prefix is a fact of the
  // resolved baselines. Added only when the task already failed with
  // nothing to show.
  if (exitCode !== 0 && violations.length === 0 && !readableUnder(args.cwd, grantedRead)) {
    violations.push({
      timestamp: new Date(),
      hint: true,
      line:
        `vx: this sandbox grants no read access to the task's own working directory ` +
        `(${args.cwd}), so a command that reads or lists it fails with whatever error it ` +
        `reports for that — macOS logs no violation record. Add ` +
        "`sandbox: { allow: { read: ['.'] } }`.",
    })
  }

  if (exitCode !== 0) {
    const hidden = hiddenReadsOutside(recorded, {
      within: args.reportWithin,
      linked: args.reportLinked,
      config: args.config,
      skip: [taskTmpRoot()],
    })
    if (hidden.length > 0)
      violations.push(hiddenReadsHint(hidden, baselines.denyRead, args.reportWithin, keyOf(args)))
    const git = signs.gitNoRepo
      ? hiddenGitHint(args.cwd, grantedRead, baselines.denyRead, args.reportWithin)
      : undefined
    if (git !== undefined && !hidden.some((p) => atOrUnder(p, git.dir))) violations.push(git.hint)
    if (process.platform === 'linux') {
      // tsc prints its errors on stdout.
      const named = statedHiddenHint(
        `${outTail.text()}\n${errTail.text()}`
          .split('\n')
          .filter((l) => NOT_FOUND.test(l))
          .slice(-64),
        args.cwd,
        [...grantedRead, ...args.config.allowWrite],
        baselines.denyRead,
        args.reportWithin,
        // `recorded`, not only what is reported: a traced denial an `ignore`
        // entry silenced was asked for, and naming it here undid the entry.
        [
          ...[...recorded, ...violations].map((v) => v.path),
          ...hidden,
          ...(git === undefined ? [] : [git.dir]),
        ],
        keyOf(args),
      )
      if (named !== undefined) violations.push(named)
      const refused = refusedLoopbackHint(
        `${outTail.text()}\n${errTail.text()}`.split('\n').slice(-64),
        [...loopbackPorts(args.config.network), ...bridgedPorts(args.config)],
      )
      if (refused !== undefined) violations.push(refused)
    }
  }
}

/**
 * One attempt of `runSandboxed`: wrap, spawn, wait, read the denials, add
 * the hints.
 *
 * Violations are matched by a unique per-task command prefix — SRT's
 * `getViolationsForCommand` keys by base64 of the first 100 chars, so
 * two tasks running the same underlying command (e.g. parallel `tsc`
 * across packages) would otherwise collide. We prepend `: '<tag>';`
 * (shell no-op) to make every command's first 100 chars unique.
 */
async function runSandboxedOnce(args: SandboxedRunArgs): Promise<AttemptResult> {
  // Elapsed time, not wall time, less time vx was stopped: see runCommand.
  const start = runTime()
  const { SandboxManager } = await loadSrt()
  const ready = await prepareAttempt(args, SandboxManager, start)
  if ('result' in ready) return ready.result
  const { prepared } = ready
  const { wrapped, tag, srtCommand, baselines } = prepared.wrap
  const takeRecords = collectRecords(
    SandboxManager.getSandboxViolationStore(),
    srtCommand,
    observerSocket(wrapped),
  )
  const started = spawnAttempt(args, prepared.wrap, takeRecords, SandboxManager, start)
  if ('result' in started) return started.result
  const { proc, straceLog } = started.spawned
  const ended = await awaitAttempt(args, started.spawned, tag)
  // Linux: the write observer's records arrive over a socket, not with the
  // exit; `takeRecords(true)` waits until all it sent are read.
  const denials = await attemptDenials(args, prepared, await takeRecords(true), straceLog)
  addHints(args, ended, denials, baselines)
  afterCommand(SandboxManager)
  const { exitCode, timeout, looked, signs } = ended
  return {
    exitCode,
    durationMs: Math.round(runTime() - start),
    stdout: ended.stdout,
    stderr: ended.stderr,
    violations: denials.violations,
    ...(typeof proc.signalCode === 'string' ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...(timeout.sigkilled() ? { killedAfterGrace: true } : {}),
    ...(ended.left ? { leftRunning: true } : {}),
    // Linux: the task's CPU and peak never reach this wait. bwrap runs it
    // in a pid namespace (`--unshare-pid`), and what the namespace's
    // processes used is not folded into bwrap's usage: a 500 ms busy loop
    // read 2 ms under it and 510 without the flag, and the peak read was
    // vx's own high-water mark, inherited at exec (a sandboxed `true` from a
    // 300 MB vx: 353 MB; B-3). So the tree is looked at while it runs
    // (`watchTree`); a task over before the first look reports nothing.
    // macOS's `sandbox-exec` execs the command, so its usage is the task's.
    ...(process.platform !== 'linux'
      ? resourceUsageToCpuRss(proc.resourceUsage())
      : looked === undefined
        ? {}
        : { cpuMs: looked.cpuMs, peakRssBytes: looked.rssBytes }),
    ranMs: ended.ranMs,
    mountGone: exitCode !== 0 && (signs.mountGone || BWRAP_MOUNT_GONE.test(signs.partial)),
    tracerFailed:
      straceLog !== undefined &&
      !timeout.timedOut() &&
      (signs.straceSpoke || STRACE_OWN_ERROR.test(signs.partial)),
  }
}

/**
 * The runtime counts every wrap as a live sandbox until this, and removes
 * the empty files bwrap made on the host as mount points (`.bashrc`,
 * `.vscode`, … under a write grant) only at a count of 0: a wrap with no
 * call here kept every later task's stubs on the host until the reset.
 */
function afterCommand(SandboxManager: SrtModule['SandboxManager']): void {
  try {
    SandboxManager.cleanupAfterCommand()
  } catch {
    // ignore; bwrap mount-point cleanup is best-effort
  }
}

/**
 * The hint for writes refused outside the project, a few paths named, and
 * a grant for each: a sandboxed `go build` on a fresh home was refused its
 * telemetry file and then `mkdir ~/.cache`, and the hint granted only the
 * first one's directory, which left the build failing (2026-11-11).
 * `made` holds the paths a refused `mkdir` named: the directory itself is
 * the grant, not its parent.
 */
export function outsideWritesHint(
  paths: readonly string[],
  made: ReadonlySet<string | undefined>,
  walled: readonly string[],
  within: string,
): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const refused =
    `vx: the sandbox refused writes outside the project, which are not reported as ` +
    `violations: ${shown}${more}.`
  const home = toRealPath(os.homedir())
  const walls = walled.map(toRealPath)
  // Granting a system temp directory opens it to every write of the task;
  // the task already has a temp directory of its own. A workspace kept
  // under one is the workspace, and its directory is the grant.
  // A home kept under one (a CI container's, an agent's) is home: a tool
  // writes its store there whatever $TMPDIR says.
  const temps = hostTempRoots()
  const inHome = (p: string): boolean => atOrUnder(p, home) && !temps.includes(home)
  const scratchTemp = (p: string): boolean =>
    temps.some((t) => atOrUnder(p, t)) && !walls.some((w) => atOrUnder(p, w)) && !inHome(p)
  const isDir = (p: string): boolean =>
    made.has(p) || statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  // A tool's cache under `~/.cache` is its own directory there: `go build`
  // writes `~/.cache/go-build/ab/<hash>-d`, and `ab/` alone failed the next
  // build on another subdirectory.
  const homeCache = path.join(home, '.cache')
  const toolCache = (p: string): string | undefined => {
    if (!atOrUnder(p, homeCache) || p === homeCache) return undefined
    const tool = p.slice(homeCache.length + 1).split('/')[0]
    return `${homeCache}/${tool}`
  }
  // Never home or above it: a tool's own `~/.cache` (or `~/.npmrc`) is the grant.
  const grantOf = (p: string): string => {
    const cache = toolCache(p)
    if (cache !== undefined && (cache !== p || isDir(p))) return `${cache}/`
    return isDir(p) ? `${p}/` : atOrUnder(home, path.dirname(p)) ? p : `${path.dirname(p)}/`
  }
  const grants = [...new Set(paths.filter((p) => !scratchTemp(p)).map(grantOf))].filter(
    (g, _, all) =>
      !all.some(
        (o) => o !== g && o.endsWith('/') && atOrUnder(g.replace(/\/$/, ''), o.slice(0, -1)),
      ),
  )
  const temp = paths.some(scratchTemp)
    ? ` The task has its own temp directory, empty at its start: write under ` +
      `$TMPDIR (os.tmpdir() in Node and Bun) instead of a fixed path.`
    : ''
  const spelled = grants.slice(0, 3).map((g) => {
    const s = grantSpelling(g.endsWith('/') ? g.slice(0, -1) : g, walled, within)
    return jsString(g.endsWith('/') && !s.endsWith('/') ? `${s}/` : s)
  })
  const line =
    grants.length === 0
      ? `${refused}${temp}`
      : `${refused} If the task needs ${grants.length === 1 ? 'one, grant its directory' : 'them, grant their directories'}, e.g. ` +
        `\`allow: { write: [${spelled.join(', ')}] }\`.${temp}`
  return { timestamp: new Date(), hint: true, line }
}

/**
 * The note for writes refused in a dependency's declared outputs: that
 * project's own task writes them, so the remedy is to run it, or to keep
 * this task from rebuilding it, never a grant to write there.
 */
function upstreamWritesHint(paths: readonly string[], within: string): SandboxViolation {
  const real = toRealPath(within)
  const shown = paths
    .slice(0, 5)
    .map((p) => path.relative(real, p))
    .join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the task tried to write a dependency's declared outputs (${shown}${more}), which that ` +
      `project's own task writes. Run it with its dependencies (drop --exclude-dependencies), ` +
      `or keep the task from rebuilding them (\`tsc -p\`, not \`tsc -b\`); a write grant there ` +
      `is not the fix.`,
  }
}

/**
 * Linux: a directory write grant is a bind mount, and a mount point cannot
 * be removed or renamed, so `rm -rf dist` empties it and then fails with
 * "Read-only file system" (EBUSY under a writable parent). Binding the
 * parent instead would let the task write beside the grant, so the
 * removal stays refused; a failure whose stderr, or stdout's tail, names
 * a grant on such an error line gets the spelling that works.
 */
function grantRemovalHint(
  lines: readonly string[],
  roots: readonly string[],
  cwd: string,
  within: string,
): SandboxViolation | undefined {
  if (lines.length === 0) return undefined
  const named = roots.filter((root) => {
    const rel = path.relative(cwd, root)
    const spellings = rel === '' ? [root] : [root, rel]
    return spellings.some((s) => {
      const re = new RegExp(`(^|[\\s'"\`(])(\\./)?${RegExp.escape(s)}/?($|[\\s'"\`:,)])`)
      return lines.some((l) => re.test(l))
    })
  })
  if (named.length === 0) return undefined
  const grants = named.map((r) => `'${path.relative(within, r) || '.'}/'`).join(', ')
  const contents = path.relative(cwd, named[0]!) || '.'
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the write grant ${grants} is mounted in place on Linux: the task may empty it ` +
      `but not remove or rename it ("Read-only file system"). Remove its contents ` +
      `instead, e.g. \`rm -rf ${contents}/*\`, and give a tool that removes its own ` +
      `output directory one inside it (Playwright: \`--output ${contents}/run\`).`,
  }
}

/** An output line that may say a removal of a write grant was refused (`grantRemovalHint`). */
const READ_ONLY_FS = /Read-only file system|EROFS|EBUSY|resource busy/i

/** git's word, on stderr, for a discovery that found no `.git`. */
const GIT_NO_REPO = /not a git repository/i

/**
 * The hint for git finding no repository because the sandbox hid `.git`.
 * git probes it by `stat` alone, which strace does not stop on
 * (`TRACED_CALLS`: a stop per stat cost every sandboxed task), so no
 * record names it; git's own words (`GIT_NO_REPO`) do, and a failed task
 * that said them is the only one looked at. The `.git`
 * nearest the cwd is the one git looked for. Grantable only where its
 * directory is a deny anchor the task stands in (the workspace root); one
 * outside the workspace, or a worktree's `.git` file, whose data lies
 * outside, is walled on purpose.
 */
function hiddenGitHint(
  cwd: string,
  granted: readonly string[],
  walled: readonly string[],
  within: string,
): { dir: string; hint: SandboxViolation } | undefined {
  let dir = toRealPath(cwd)
  let st = lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })
  while (st === undefined && path.dirname(dir) !== dir) {
    dir = path.dirname(dir)
    st = lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })
  }
  const git = path.join(dir, '.git')
  if (st === undefined || readableUnder(git, granted)) return undefined
  const said = `vx: git found no repository: the sandbox hides ${git}, and its probe is not reported.`
  const grantable = st.isDirectory() && walled.some((w) => toRealPath(w) === dir)
  return {
    dir: git,
    hint: {
      timestamp: new Date(),
      hint: true,
      line: grantable
        ? `${said} Grant it: \`allow: { read: [${jsString(path.relative(toRealPath(within), git))}] }\`.`
        : `${said} Its data lies outside the workspace, walled on purpose, so vx suggests no grant.`,
    },
  }
}

/** The last `TAIL_BYTES` (or a little more) of a stream, as its chunks. */
const TAIL_BYTES = 16_384
class Tail {
  private chunks: string[] = []
  private size = 0
  push(chunk: string): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= TAIL_BYTES)
      this.size -= this.chunks.shift()!.length
  }
  text(): string {
    return this.chunks.join('')
  }
}

/**
 * An output line saying a connection was refused (Node's `ECONNREFUSED`,
 * a browser's `ERR_CONNECTION_REFUSED`, curl's "Couldn't connect" or,
 * since 8.7, "Could not connect"), and the loopback ports it names
 * (`refusedLoopbackHint`).
 */
const REFUSED =
  /ECONNREFUSED|ERR_CONNECTION_REFUSED|Connection refused|Could(?:n't| not) connect to server/i
const LOOPBACK_PORT = /(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::| port )(\d{1,5})\b/gi

/**
 * The hint for a failed task refused on a loopback port a process on the
 * host listens on. On Linux a sandboxed task has a loopback of its own, so
 * a client dialling a dependency's port there got a bare `ECONNREFUSED`
 * and no word of the grant that relays it (2026-11-12). Only a port the
 * host listens on, on loopback or every address, and one not granted
 * already (`granted`: the task's `network` ports and its own `localBinding`).
 */
function refusedLoopbackHint(
  lines: readonly string[],
  granted: readonly number[],
): SandboxViolation | undefined {
  const named = new Set<number>()
  for (const line of lines) {
    if (!REFUSED.test(line)) continue
    for (const m of line.matchAll(LOOPBACK_PORT)) {
      const port = Number(m[1])
      if (port > 0 && port < 65536 && !granted.includes(port)) named.add(port)
    }
  }
  if (named.size === 0 || !procfsIsOwn()) return undefined
  const listening = hostLoopbackListeners()
  const ports = [...named].filter((p) => listening.has(p))
  if (ports.length === 0) return undefined
  const grants = ports.map((p) => `'localhost:${p}'`).join(', ')
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the task was refused on localhost port${ports.length === 1 ? '' : 's'} ` +
      `${ports.join(', ')}, which a process on this machine listens on: a sandboxed task has ` +
      `a loopback of its own. Grant ${ports.length === 1 ? 'it' : 'them'}: ` +
      `\`allow: { network: [${grants}] }\`.`,
  }
}

/** The TCP ports the host listens on at a loopback address or every address. */
function hostLoopbackListeners(): Set<number> {
  const reachable = new Set([
    '0100007F',
    '00000000',
    '00000000000000000000000001000000',
    '00000000000000000000000000000000',
    '0000000000000000FFFF00000100007F',
  ])
  const ports = new Set<number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let table: string
    try {
      table = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] !== '0A' || f[1] === undefined) continue
      const [addr, port] = f[1].split(':')
      if (reachable.has(addr!)) ports.add(Number.parseInt(port!, 16))
    }
  }
  return ports
}

/** An output line that may name a file its tool found missing (`statedHiddenHint`). */
const NOT_FOUND =
  /does not exist|not found|no such file|cannot find|can't find|could not find|no makefile found|no rule to make target|ENOENT|missing/i

/** The names GNU make looks for, in its order. */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']

/**
 * The hint for a failed task whose last output calls missing a path the
 * sandbox hides and the host has. A tool that stats before it opens (tsc's
 * `-p tsconfig.json`: "TS5058: The specified path does not exist") leaves
 * no record: strace does not stop on the stat family (`TRACED_CALLS`), so
 * the task failed with no violation and no fix. Each word of those lines
 * is asked of the host only on a failure; one already named is skipped.
 */
function statedHiddenHint(
  lines: readonly string[],
  cwd: string,
  granted: readonly string[],
  walled: readonly string[],
  within: string,
  named: readonly (string | undefined)[],
  key: KeyScope | undefined,
): SandboxViolation | undefined {
  const deny = walled.map(toRealPath)
  const grants = granted.map(toRealPath)
  const seen = new Set<string>()
  const found: string[] = []
  for (const line of lines) {
    const words = line.split(/[\s'"`,:()]+/)
    // make names no file when it found none: the ones it looks for.
    if (/no makefile found/i.test(line)) words.push(...MAKEFILES)
    for (const word of words) {
      const w = word.replace(/\.+$/, '')
      if (w === '' || w.startsWith('-') || w.length > 4096) continue
      const abs = path.resolve(cwd, w)
      if (seen.has(abs)) continue
      seen.add(abs)
      if (!lstatSync(abs, { throwIfNoEntry: false })) continue
      const real = toRealPath(abs)
      // A directory holding a grant is listable (bwrap builds the path to
      // the bind): cargo names its cwd in "could not find `Cargo.toml`".
      if (!deny.some((d) => atOrUnder(real, d)) || readableUnder(real, grants)) continue
      if (named.some((n) => n !== undefined && atOrUnder(real, n))) continue
      if (!found.includes(real)) found.push(real)
    }
  }
  if (found.length === 0) return undefined
  const project = toRealPath(within)
  const grantable = found.find((p) => !deny.some((w) => atOrUnder(p, w) && !atOrUnder(project, w)))
  const said =
    `vx: the task failed naming paths the sandbox hides that exist on this machine: ` +
    `${found.slice(0, 5).join(', ')}${found.length > 5 ? ` and ${found.length - 5} more` : ''}. ` +
    `A stat is not traced on Linux, so no violation names them.`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      grantable === undefined
        ? `${said} They are walled on purpose, so vx suggests no grant for them.`
        : `${said} If the task reads one, grant it, e.g. ` +
          `\`allow: { read: [${jsString(grantSpelling(grantable, walled, within))}] }\`` +
          `${keyEntryHint(grantable, within, key)}.`,
  }
}

/** A cached task's key scope: the workspace root, and the projects nested in its own. */
interface KeyScope {
  root: string
  nested: readonly string[]
}

const keyOf = (args: Pick<SandboxedRunArgs, 'keyRoot' | 'keyNested'>): KeyScope | undefined =>
  args.keyRoot === undefined ? undefined : { root: args.keyRoot, nested: args.keyNested ?? [] }

/**
 * For a cached task (`key`), the input entry that keys a path a hint
 * grants: the grant alone, applied as given, read it unkeyed, and an edit
 * there replayed the old bytes (`replace … => ../golib` in a cached `go
 * build`). The project's own `inputs.files` in it, else
 * `inputs.workspaceFiles`, which a path in a nested project takes too:
 * `vx lock` refuses a `files` glob into one. A directory whole. Nothing
 * outside the workspace: no glob can name it.
 */
function keyEntryHint(p: string, within: string, key: KeyScope | undefined): string {
  if (key === undefined) return ''
  const root = toRealPath(key.root)
  if (!atOrUnder(p, root)) return ''
  const project = toRealPath(within)
  const own = atOrUnder(p, project) && !key.nested.some((d) => atOrUnder(p, toRealPath(d)))
  const [field, base] = own ? ['files', project] : ['workspaceFiles', root]
  const rel = relPosix(base, p)
  const dir = statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  const glob = rel === '' ? '**' : dir ? `${taskGlobOf(rel)}/**` : taskGlobOf(rel)
  return `, and, if the output depends on it, key it: \`inputs: { ${field}: [${jsString(glob)}] }\``
}

/**
 * A path as a JS string literal a config can take: a quote or a backslash
 * in it is escaped, so the escape in a key entry `\!cfg` survives being pasted.
 */
const jsString = (p: string): string =>
  p.includes("'") ? JSON.stringify(p) : `'${p.replaceAll('\\', '\\\\')}'`

/** The host's shared temp directories, canonical: what a fixed temp path in a tool names. */
function hostTempRoots(): string[] {
  return [...new Set(['/tmp', '/var/tmp', os.tmpdir()].map(toRealPath))]
}

/**
 * The hint for reads the wall hid outside the project. A path under a
 * deny entry other than the ones holding the project (a credential store
 * or its link's target, vx's own store, the repository's git data outside
 * the workspace) is walled on purpose and never the suggested grant: an
 * agent applies a suggestion as given, and `cat ~/.npmrc` was told to
 * grant `../../home/.npmrc`. For a cached task (`keyRoot`) a grant in the
 * workspace is named for `inputs.workspaceFiles` too: applied alone, an
 * edit there replayed the old bytes.
 */
function hiddenReadsHint(
  paths: readonly string[],
  walled: readonly string[],
  within: string,
  key: KeyScope | undefined,
): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const project = toRealPath(within)
  const deny = walled.map(toRealPath)
  const grantable = paths.find((p) => !deny.some((w) => atOrUnder(p, w) && !atOrUnder(project, w)))
  const said =
    `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
    `not reported as violations: ${shown}${more}.`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      grantable === undefined
        ? `${said} They are walled on purpose, so vx suggests no grant for them.`
        : `${said} If the task reads one, grant it, e.g. ` +
          `\`allow: { read: [${jsString(grantSpelling(grantable, walled, within))}] }\`` +
          `${keyEntryHint(grantable, within, key)}.`,
  }
}

/**
 * A path as a committed config spells its grant: from the project inside
 * the walls (the absolute path holds only on the machine that printed
 * it), `~/…` under home, else absolute.
 */
function grantSpelling(p: string, walled: readonly string[], within: string): string {
  const home = toRealPath(os.homedir())
  return walled.some((w) => atOrUnder(p, toRealPath(w)))
    ? path.relative(toRealPath(within), p) || '.'
    : atOrUnder(p, home)
      ? `~${p.slice(home.length)}`
      : p
}

/**
 * Is `dir` inside a path the sandbox granted for reading? bwrap binds and
 * seatbelt rules are both prefix-based, so a grant covers the subtree.
 */
function readableUnder(dir: string, granted: readonly string[]): boolean {
  const target = toRealPath(dir)
  return granted.some((p) => {
    const g = toRealPath(p)
    // On Linux a grant INSIDE the cwd makes the cwd listable too: bwrap
    // builds the path to the bind. A root's `read: ['.']` is bound as its
    // children around the walls (`wallOff`), so every failing root task
    // was told its cwd was unreadable while it listed it (B-20). Seatbelt
    // grants no parent, so on macOS the cwd itself must be covered.
    return atOrUnder(target, g) || (process.platform === 'linux' && atOrUnder(g, target))
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
 * `allowMachLookup` / `enableWeakerNetworkIsolation` off the config given to `initialize()` and never off
 * the per-call one (`sandbox-manager.js` getters, 0.0.75 and 0.0.76) — so a per-task
 * grant passed there is silently dropped. vx is per-task by definition,
 * so it emits them itself. The rule text mirrors SRT's own.
 */
export function macProfileRules(c: ResolvedSandboxConfig): string[] {
  const rules: string[] = []
  // A name is an info type to one caller and a sysctl to another (Bun
  // reads `hw.optional.neon` with sysctl-read), so it grants both.
  for (const t of c.systemInfo ?? []) {
    const name = sbplToken(t, 'allow.systemInfo')
    rules.push(`(allow system-info (info-type "${name}"))`)
    rules.push(`(allow sysctl-read (sysctl-name "${name}"))`)
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
  // A loopback port the network list names is dialled directly (the
  // proxy is skipped for loopback), so the profile allows that port alone.
  const ports = loopbackPorts(c.network)
  for (const p of ports) {
    rules.push(`(allow network-outbound (remote ip "localhost:${p}"))`)
  }
  // curl asks configd for the proxy settings before it dials; refused, the
  // record failed a client that had its answer (exit 0, CI 2026-11-12).
  if (ports.length > 0)
    rules.push('(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd"))')
  if (c.weakerNetworkIsolation === true) {
    rules.push('(allow mach-lookup (global-name "com.apple.trustd.agent"))')
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
 * The walls a glob grant can reach: each one under (or at) a glob's
 * literal head. On Linux `expandGrants` drops such a hit before the bind
 * (B-1); seatbelt matches a glob as a path regex, with no hit to drop.
 */
export function wallsGlobsReach(grants: readonly string[], walls: readonly string[]): string[] {
  const heads = grants
    .filter((g) => namedPath(g) === undefined)
    .map((g) => path.dirname(g.slice(0, g.search(MOUNT_WILDCARDS))))
  return walls.filter((w) => heads.some((h) => atOrUnder(w, h)))
}

/**
 * macOS: the grant rules vx appends. The listings come first so a wall's
 * deny, later, wins: SBPL is last-match-wins.
 */
export function darwinGrantRules(
  c: Pick<ResolvedSandboxConfig, 'wallsReached' | 'allowRead' | 'allowWrite'>,
  baseAllowRead: readonly string[],
  anchors: readonly string[],
): string[] {
  return [...darwinAncestorRules(c, anchors), ...darwinWallRules(c, baseAllowRead)]
}

/**
 * macOS: each directory above a grant may be listed, as on Linux. bwrap
 * makes every directory above a mount, so a task granted
 * `../vx-*\/package.json` could glob it from `..`; seatbelt matches paths
 * and refused the listing (EPERM), so `@vzn/vx-docs#import` failed on
 * every Mac (2026-10-17). Above the glob that is each literal directory
 * strictly inside a deny anchor (outside one, all is readable already);
 * a directory the glob itself names (`vx-a/`) is matched as a regex, and
 * under a `**` any directory is. The rules grant directories only, never
 * a file, and come before the wall denies, which still win.
 *
 * A listing shows every name in the directory, where Linux's scaffold
 * shows only what it mounted: names, never a file's data. Not the anchor
 * itself: Bun, shown the workspace root's `package.json` it
 * may not read, failed with "Cannot read file" (EPERM).
 */
export function darwinAncestorRules(
  c: Pick<ResolvedSandboxConfig, 'allowRead' | 'allowWrite'>,
  anchors: readonly string[],
): string[] {
  const literals = new Set<string>()
  const patterns = new Set<string>()
  // Grants are canonical already (`resolveSandboxConfig`), and so is each
  // directory above one: no realpath here, at every spawn.
  const inside = (d: string): boolean => anchors.some((a) => d !== a && atOrUnder(d, a))
  for (const g of [...c.allowRead, ...c.allowWrite]) {
    const named = namedPath(g)
    const head = g.slice(0, g.search(MOUNT_WILDCARDS))
    const cut = head.lastIndexOf('/')
    const top = named !== undefined ? path.dirname(named) : head.slice(0, cut) || '/'
    for (let d = top; inside(d); d = path.dirname(d)) literals.add(d)
    if (named !== undefined || g.includes('\\')) continue
    let re = top === '/' ? '' : regexLiteral(top)
    for (const part of g
      .slice(cut + 1)
      .split('/')
      .slice(0, -1)) {
      if (part === '**') {
        patterns.add(`^${re}(/.*)?$`)
        break
      }
      re += `/${part
        .replace(/[.^$+{}()|]/g, '[$&]')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]')}`
      patterns.add(`^${re}$`)
    }
  }
  // A name seatbelt's quoted string cannot hold keeps today's refusal
  // rather than failing the task (`sbplResolvedPath` would throw).
  const spellable = (p: string): boolean => !UNSPELLABLE.test(p)
  return [
    ...[...literals].filter(spellable).map((d) => `(allow file-read-data (literal "${d}"))`),
    ...[...patterns]
      .filter(spellable)
      .map((r) => `(allow file-read-data (require-all (vnode-type DIRECTORY) (regex #"${r}")))`),
  ]
}

// eslint-disable-next-line no-control-regex -- the control range is the point
const UNSPELLABLE = /["'\\\x00-\x1f\x7f]/

/** A real path as a regex matching only itself: each special in a class of one. */
function regexLiteral(p: string): string {
  return p.replace(/[.^$+{}()|*?[\]]/g, (ch) => `[${ch}]`)
}

/**
 * macOS: the walls a glob grant reaches, denied at the profile's tail
 * (SBPL is last-match-wins). SRT re-emits a wall's deny after the allows
 * only under a LITERAL allow, so a root project's `read: ['**\/*.ts']`
 * read nested projects' sources its key excludes — item 1010's stale hit,
 * by glob, on darwin (B-12). A literal grant at or inside the wall, the
 * task's or a baseline's (a linked dependency), is carved out: on Linux
 * too it binds. Reads deny the data, not the metadata, as SRT's own wall
 * denies do: a walk may still stat the directory.
 */
export function darwinWallRules(
  c: Pick<ResolvedSandboxConfig, 'wallsReached' | 'allowRead' | 'allowWrite'>,
  baseAllowRead: readonly string[],
): string[] {
  const rules: string[] = []
  const deny = (op: string, walls: readonly string[], literals: readonly string[]): void => {
    for (const w of walls) {
      const at = `(subpath "${sbplResolvedPath(w, 'wall')}")`
      const kept = literals
        .filter((l) => atOrUnder(l, w))
        .map((l) => `(require-not (subpath "${sbplResolvedPath(l, 'grant')}"))`)
      rules.push(
        kept.length === 0
          ? `(deny ${op} ${at})`
          : `(deny ${op} (require-all ${at} ${kept.join(' ')}))`,
      )
    }
  }
  // A baseline is a name the filesystem handed back, never a pattern: a
  // bracket in it does not make it a glob.
  const named = (grants: readonly string[]): string[] => grants.flatMap((g) => namedPath(g) ?? [])
  deny('file-read-data', c.wallsReached?.read ?? [], [...named(c.allowRead), ...baseAllowRead])
  deny('file-write*', c.wallsReached?.write ?? [], named(c.allowWrite))
  return rules
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
 * The classifier is `isMountableLiteral` (sandbox/paths.ts), deliberately
 * NOT `isLiteralPattern`: its docblock says why the brace is not a wildcard
 * to a grant.
 */
function expandGrants(
  paths: readonly string[],
  walls: readonly string[],
  /** Write globs only: where a pattern that matched nothing is put. */
  unmatched?: string[],
): string[] {
  // A pattern covering a directory WHOLE is that directory. `<d>/**/*` and
  // `<d>/**` match everything UNDER `<d>` and never `<d>` itself, so a task
  // granted `read: ['**/*']` still could not list its own cwd — the exact
  // shape `bun test` and `oxlint` need. Collapsing is not a widening: the
  // pattern already covered every file there; it adds the directory entry.
  //
  // On macOS a `<d>` that is itself a glob keeps its subtree as `<d>/**/*`:
  // SRT matches a glob as an exact regex and a literal as a subpath, so the
  // collapsed `.*.tmp` alone covered the directory and nothing in it, and
  // `bun build --compile` could create its extraction directory but not
  // the runtime inside it (2026-09-29). Not `<d>/**`: SRT strips a trailing
  // `/**` before it compiles the regex (`removeTrailingGlobSuffix`), which
  // CI's `cp: .a1.tmp/f: Operation not permitted` showed.
  const collapsed = paths.flatMap((p) => {
    const m = /^(.*?)\/\*\*(?:\/\*)?$/.exec(p)
    if (m === null) return [p]
    const dir = m[1]!
    return process.platform !== 'linux' && !isMountableLiteral(dir) ? [dir, `${dir}/**/*`] : [dir]
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
    // A hit that leaves the scan's base through a link is not what the
    // pattern named: bwrap binds by the link's target, so `read: ['*']`
    // over `shared -> ../b/src` bound project b readable, a read `'.'`
    // never gives, and a cached task replayed b's old bytes (item 1006).
    // The boundary is the directory holding the first wildcard component,
    // not the scan's anchor: that sits one component higher.
    const head = p.slice(0, p.search(MOUNT_WILDCARDS))
    const home = toRealPath(head.endsWith('/') ? head.slice(0, -1) : path.dirname(head))
    let hits = 0
    for (const hit of scanOrNothing(pattern, base)) {
      const abs = path.join(base, hit)
      const real = toRealPath(abs)
      if (!atOrUnder(real, home)) continue
      // A hit that IS a wall, or lies inside one, was matched, not named:
      // `read: ['*']` in a root project bound `.git` and `.vx`, and
      // `packages/*` a nested project its key excludes (B-1). A grant that
      // names a wall literally never reaches this loop and stays, and one
      // spelled with escaped brackets names it as surely.
      if (namedPath(p) === undefined && walls.some((w) => atOrUnder(real, w))) continue
      // A write hit that HOLDS a wall would bind it writable: `.*` in a root
      // project matched `.vx`, which holds the cache. A read hit is punched
      // around it instead (`punchWalls`).
      if (
        unmatched !== undefined &&
        namedPath(p) === undefined &&
        walls.some((w) => atOrUnder(w, real))
      )
        continue
      out.push(abs)
      hits++
    }
    if (hits === 0) unmatched?.push(p)
  }
  return out
}

/**
 * A glob's hits under `base`, or none when `base` does not exist yet:
 * `Bun.Glob` throws ENOENT there, and a cache not yet populated on a fresh
 * runner (`~/.cache/x/y/*`) failed its task with the raw errno and no word
 * of the grant (B-6). A missing base matches nothing, as an empty one does.
 */
function scanOrNothing(pattern: string, base: string): Iterable<string> {
  const glob = new Bun.Glob(scannable(pattern))
  try {
    // Materialised here: the throw comes from the first step, not the call.
    return [...glob.scanSync({ cwd: base, onlyFiles: false, dot: true })]
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
}

/**
 * The write globs that matched nothing at the start (Linux): the ones a
 * write may still land under, in the sandbox's scratch, returned; the ones
 * a read-only mount or the host's root holds, reported once each
 * (`writeGrantMatchedNothing`). `anchors` are the deny anchors the scratch
 * is made of; `within`, the task's directory, which the report spells from.
 */
export function pendingWriteGrants(
  config: Pick<ResolvedSandboxConfig, 'pendingWrites'>,
  fs: {
    readonly allowRead?: readonly string[] | undefined
    readonly allowWrite?: readonly string[] | undefined
  },
  anchors: readonly string[],
  within: string,
): string[] {
  const { scratch, mountless } = scratchWrites(config.pendingWrites ?? [], fs, anchors)
  for (const grant of mountless) writeGrantMatchedNothing(grant, within)
  return scratch
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
function writeGrantMatchedNothing(grant: string, within: string): void {
  if (warnedEmptyWriteGrant.has(grant)) return
  warnedEmptyWriteGrant.add(grant)
  // As a committed config spells them (B-97): the absolute path held only
  // on the machine that printed it, as in `outsideWritesHint`.
  const dir = grantSpelled(grantPrefix(grant), within)
  notify({
    kind: 'line',
    tone: 'warn',
    text:
      `[vx] sandbox: the write grant ${jsString(grantSpelled(grant, within))} matches nothing ` +
      `yet, and a read grant mounts its directory read-only, so a file the task creates under ` +
      `it will fail with "Read-only file system". A bind mount covers what exists when the ` +
      `task starts — grant the directory instead: ` +
      `\`allow: { write: [${jsString(dir === '.' ? '.' : `${dir}/`)}] }\`\n`,
  })
}

/** An absolute grant path as a config spells it: from `within`, from `~`, or whole. */
function grantSpelled(p: string, within: string): string {
  const real = toRealPath(within)
  if (atOrUnder(p, real)) return path.relative(real, p) || '.'
  const home = toRealPath(os.homedir())
  return atOrUnder(p, home) ? `~${p.slice(home.length)}` : p
}

/**
 * Memoized check: is `strace` on PATH on a Linux host, and does it know
 * `--seccomp-bpf` (5.3+)? `'seccomp'` is the fast form; `'plain'` traces
 * every syscall through ptrace and is kept only for an old strace. `why`
 * names what is missing when there is no form, for the warning and for
 * `vx info`.
 */
let straceAvailableCache: Promise<{ form: false | 'plain' | 'seccomp'; why: string }> | undefined
function straceState(): Promise<{ form: false | 'plain' | 'seccomp'; why: string }> {
  if (process.platform !== 'linux') return Promise.resolve({ form: false, why: '' })
  // The promise is the memo, not its answer: a run starts a wave of tasks
  // at once, and each asked before the first answer landed (one probe per task).
  straceAvailableCache ??= probeStrace()
  return straceAvailableCache
}

async function probeStrace(): Promise<{ form: false | 'plain' | 'seccomp'; why: string }> {
  try {
    const p = Bun.spawn([executablePath('strace'), '--version'], {
      env: helperEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    if (p.exitCode !== 0) return { form: false, why: `strace --version exited ${p.exitCode}` }
    const m = /version (\d+)\.(\d+)/.exec(out)
    const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0]
    let form: 'plain' | 'seccomp' = major > 5 || (major === 5 && minor >= 3) ? 'seccomp' : 'plain'
    let refused = await traceRefusal(form)
    // A strace that cannot check the seccomp filter says so and traces on
    // without it, exit 0. Inside the sandbox that line read as the trace
    // cut short, and every sandboxed task ran twice: the plain form, if
    // it is quiet, is the one that works here.
    if (refused?.warned === true && form === 'seccomp') {
      refused = await traceRefusal('plain')
      if (refused === null) form = 'plain'
    }
    return refused === null
      ? { form, why: '' }
      : { form: false, why: `strace cannot trace here (${refused.line})` }
  } catch {
    // Not on PATH. Said as the refused attach is: without it an undeclared
    // read is denied but never reported, so a task that tolerates the miss
    // passes and caches with no word of it (J's lead).
    return { form: false, why: 'strace is not on PATH' }
  }
}

async function wantsStraceDetection(): Promise<false | 'plain' | 'seccomp'> {
  const { form, why } = await straceState()
  if (form === false && why !== '') warnUntraced(why)
  return form
}

/**
 * Why a sandboxed task on this host runs without the report of the reads
 * the sandbox denied, or null when it is traced (or the host is not
 * Linux, where the report does not come from strace). Says nothing on
 * stderr: `vx info` reports it as a fact (B-51's lead).
 */
export async function untracedReason(): Promise<string | null> {
  const { why } = await straceState()
  return why === '' ? null : why
}

/**
 * Why strace may not attach here (null when it may), asked once with the flags a task's trace
 * uses (`ownGroupCommand`). A strace that exits 0 having said something of
 * its own is refused too (`warned`): in a task, its line is the retry key. `--version` answers on a host that refuses
 * ptrace (Yama's `ptrace_scope` 2 or 3, a container's seccomp profile),
 * and there every sandboxed task failed twice, the retry included, on
 * `attach: ptrace(PTRACE_SEIZE…): Operation not permitted`. Refused, the
 * run goes untraced, as without strace: bwrap still enforces, and only the
 * read-violation report is lost, which is said once.
 */
async function traceRefusal(
  form: 'plain' | 'seccomp',
): Promise<{ line: string; warned: boolean } | null> {
  const p = Bun.spawn(
    [
      executablePath('strace'),
      '-DD',
      '-f',
      ...(form === 'seccomp' ? ['--seccomp-bpf'] : []),
      '-qq',
      '-e',
      TRACED_CALLS,
      '-o',
      '/dev/null',
      '--',
      executablePath('true'),
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: helperEnv() },
  )
  const err = await new Response(p.stderr).text()
  const line = err.split('\n').find((l) => STRACE_OWN_ERROR.test(l))
  if ((await p.exited) === 0) return line === undefined ? null : { line, warned: true }
  return { line: err.trim().split('\n')[0] || `exit ${p.exitCode}`, warned: false }
}
let warnedNoTrace = false

/** Said once per process: why sandboxed tasks run untraced, and what that loses. */
function warnUntraced(why: string): void {
  if (warnedNoTrace) return
  warnedNoTrace = true
  notify({
    kind: 'line',
    tone: 'warn',
    text:
      `[vx] sandbox: ${why}, so sandboxed tasks run without the report of the reads the sandbox denied; ` +
      `the sandbox still enforces\n`,
  })
}
