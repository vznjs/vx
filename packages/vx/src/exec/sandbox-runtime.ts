// Thin wrapper around `@anthropic-ai/sandbox-runtime` (SRT) for enforcing
// per-task filesystem + network isolation.
//
// Design contract:
//   The caller (sandbox-request.ts) hands over the task's own
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
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import type { SandboxConfig } from '../config.js'
import {
  armTimeout,
  drainOrAbort,
  POST_EXIT_CUT_LINE,
  shellQuote,
  withForwardArgs,
  signalExitCode,
  stopSignal,
  spawnFailureText,
  streamToString,
  resourceUsageToCpuRss,
  type CaptureConfig,
  type RunResult,
} from './runner.js'
import {
  BUN_GLOB_WILDCARDS,
  executablePath,
  taskShell,
  grantPrefix,
  isTmpdirRefusal,
  procfsIsOwn,
  TMPDIR_HINT,
  UserError,
  xxh3hex,
} from '../util/index.js'
import {
  bindableReads,
  bindableWrites,
  buildCustomConfig,
  readOnlyMasks,
  scratchWrites,
  widenedEntries,
} from './sandbox-binds.js'
import {
  atOrUnder,
  isMountableLiteral,
  localBindingOn,
  MOUNT_WILDCARDS,
  toRealPath,
  unique,
} from './sandbox-paths.js'
import {
  canScopeDenyScan,
  scopedMandatoryDenies,
  srtDefaultWritePaths,
} from './sandbox-deny-scan.js'
import {
  hiddenReadsOutside,
  parseStraceViolations,
  refusedConnections,
  refusedWrites,
  refusedWritesOutside,
  reportableViolations,
} from './sandbox-violations.js'
import {
  closeSignalChannel,
  killTree,
  releaseGroup,
  signalThrough,
  guardLine,
  spawnGuarded,
} from './kill-tree.js'

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
    const proc = Bun.spawn([taskShell(), '-c', wrapped], {
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
    for (const d of liveTaskTmpdirs) rmSync(d, { recursive: true, force: true })
  })
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

/**
 * The sandbox's own tools, by the paths vx resolves on its own PATH. SRT
 * writes a bare `bwrap` (and, in the network bridge, a bare `socat`) into
 * the command the task's shell runs, with the TASK's environment: a
 * dependency's `node_modules/.bin/bwrap`, first on that PATH, ran in
 * bwrap's place and the task ran unsandboxed with exit 0 (J-33's lead,
 * B-19). A tool vx cannot find is left to SRT's own dependency check,
 * whose refusal names it.
 */
let javaAgent: { javaAgentJarPath?: string } | undefined

/**
 * The JVM proxy agent SRT ships, named so SRT need not look for it. SRT's
 * search lists `npm root -g` among its candidates before trying any, so it
 * spawned npm on every init (~110 ms, the bulk of `vx info`'s sandbox
 * probe) even though the jar sits beside it. Absent (a compiled vx), SRT
 * searches as before.
 */
function bundledJavaAgent(): { javaAgentJarPath?: string } {
  if (javaAgent) return javaAgent
  javaAgent = {}
  try {
    const dist = path.dirname(require.resolve('@anthropic-ai/sandbox-runtime'))
    const jar = path.join(dist, '..', 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar')
    if (existsSync(jar)) javaAgent = { javaAgentJarPath: jar }
  } catch {
    // unresolvable: SRT searches
  }
  return javaAgent
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

function linuxToolPaths(): { bwrapPath?: string; socatPath?: string } {
  if (process.platform !== 'linux') return {}
  const paths: { bwrapPath?: string; socatPath?: string } = {}
  try {
    paths.bwrapPath = executablePath('bwrap')
  } catch {
    // SRT's dependency check says so
  }
  try {
    paths.socatPath = executablePath('socat')
  } catch {
    // SRT's dependency check says so
  }
  return paths
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
 * place a domain list can take effect. Per-task precision survives where
 * it matters: a task that declared none is never handed the proxy port.
 */
export async function initSandbox(opts?: {
  allowedDomains?: readonly string[]
  /**
   * Every domain any sandboxed task of the run denies. The proxy is the
   * run's, so a deny refuses it for every task, as the allowlist is the
   * union's; before B-21 the list was always empty and a `deny.network`
   * refused nothing.
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
      deniedDomains: [...(opts?.deniedDomains ?? [])],
      ...(opts?.allowAllUnixSockets === true ? { allowAllUnixSockets: true } : {}),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    ignoreViolations: DEFAULT_IGNORE_VIOLATIONS,
    ...linuxToolPaths(),
    ...(scopedDenyScan ? scopedScanConfig() : {}),
    ...bundledJavaAgent(),
  }
  if (!srtUp) await unlinkStaleMuxSockets()
  const listening = srtCleanupAdopted ? undefined : cleanupListeners()
  await SandboxManager.initialize(
    config,
    undefined,
    // enableLogMonitor — macOS-only; populates the SandboxViolationStore.
    true,
  )
  if (listening !== undefined) adoptSrtCleanup(listening)
  srtUp = true
  perTaskRun = opts?.allowAllUnixSockets === true || opts?.gitConfig === true ? config : undefined
  // `initialize()` returns early once SRT is up, and on Linux the
  // availability probe brought it up with an EMPTY config before the run's
  // own call — so the run's allowlist and unix-socket allowance never
  // reached it (found 2026-09-10 by the port bridge: the task's side died
  // on `socket(AF_UNIX)` with the flag set). `updateConfig` is SRT's hot
  // reload of exactly these fields; the proxy and the wrapper read them
  // through getters, so the run's config is what every task sees.
  SandboxManager.updateConfig(config)
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
  perTaskRun = undefined
  availabilityCache.clear()
  straceAvailableCache = undefined
}

/** `reset` is the one `initSandbox` waits out before it starts SRT again. */
function trackReset(reset: Promise<unknown>): void {
  const settled = reset.then(
    () => {},
    () => {},
  )
  resetting = settled
  void settled.then(() => {
    if (resetting === settled) resetting = undefined
  })
}

const SRT_CLEANUP_EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const
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
 * it starts, as its own.
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
        trackReset(Promise.resolve(l(...a)))
      })
    }
  }
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
   * (sandbox-request.ts); nothing is derived from `cache`.
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
  /**
   * Linux: the write globs that matched nothing when the task started, so
   * no mount holds them. `scratchWrites` decides which still cover a write.
   */
  pendingWrites?: readonly string[]
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
  /** macOS: the walls a glob grant reaches, by kind (`darwinWallRules`). */
  wallsReached?: { read: readonly string[]; write: readonly string[] }
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
  /** Canonical directories a glob's hits stop at (sandbox-request.ts `wallOff`). */
  walls: readonly string[] = [],
): ResolvedSandboxConfig {
  const resolve = (p: string): string => {
    if (p.startsWith('~')) return toRealPath(path.join(os.homedir(), p.slice(1)))
    if (path.isAbsolute(p)) return toRealPath(p)
    return toRealPath(path.resolve(projectDir, p))
  }
  const a = cfg.allow ?? {}
  const pending: string[] = []
  const r: ResolvedSandboxConfig = {
    allowRead: expandGrants((a.read ?? []).map(resolve), walls),
    allowWrite: expandGrants(
      (a.write ?? []).map((p) => {
        const real = resolve(p)
        assertWriteStaysHome(p, real, projectDir)
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
  /**
   * vx's own note beside a failure (the cwd it cannot read, a placeholder
   * the task never wrote, a withheld link), not a denial: shown with the
   * denials, never counted as one (B-20).
   */
  hint?: true
  /** Absolute, when `target` is a path at all. */
  path?: string
  ignorable?: readonly ('read' | 'write' | 'network' | 'systemInfo')[]
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
  // After the tag: SRT keys violations by the command's first 100 chars.
  const inTmp = `export TMPDIR=${shellQuote(tmp)}; ${javaToolOptionsFix(
    process.env['JAVA_TOOL_OPTIONS'],
    args.env['JAVA_TOOL_OPTIONS'],
  )}${userCommand}`
  const taggedCommand = `: 'vx-${tag}'; ${inTmp}`

  const baselines = canonicalBaselines(args)
  const customConfig = buildCustomConfig(args, baselines)
  const scratch = pendingWriteGrants(
    args.config,
    customConfig!.filesystem!,
    baselines.denyRead,
    baselines.cwd,
  )
  customConfig!.filesystem!.denyRead!.push(toRealPath(taskTmpRoot()))
  if (process.platform === 'linux' && !cwdMounted(baselines.cwd, customConfig!.filesystem!)) {
    customConfig!.filesystem!.denyRead!.push(baselines.cwd)
  }
  customConfig!.filesystem!.allowWrite!.push(toRealPath(tmp))
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
  const grouped =
    process.platform === 'linux'
      ? ownGroupCommand(tag, inTmp, args.trace, args.tracePaths === true)
      : { command: taggedCommand, forwards: false, traced: false }
  const inner = [
    ports.length > 0 ? portBridgeInner(ports, tag) : '',
    process.platform === 'linux' && args.config.network !== undefined ? PROXY_BRIDGE_WAIT : '',
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
        ? seatbeltBrackets(customConfig)
        : customConfig,
    ports.length > 0 || asksUnixSockets(args.config),
    args.config.gitConfig === true,
  )
  if (process.platform === 'darwin') {
    const rules = [
      ...macProfileRules(args.config),
      ...darwinWallRules(args.config, baselines.allowRead),
    ]
    if (rules.length > 0) wrapped = injectProfileRules(wrapped, rules)
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
      `exec ${readOnlyMasks(wrapped, scratch)}`
  }
  if (process.platform === 'linux' && !hostHasIpv6())
    wrapped = `SOCAT_DEFAULT_LISTEN_IP=4 ${wrapped}`
  const held = portsHeld(ports)
  if (held.length > 0) {
    throw new UserError(
      `sandbox: localBinding port${held.length === 1 ? '' : 's'} ${held.join(', ')} ` +
        `${held.length === 1 ? 'is' : 'are'} already in use on this machine, so the task's own ` +
        `cannot be exposed there and a client would reach the other listener; stop what ` +
        `holds ${held.length === 1 ? 'it' : 'them'} or list another port`,
    )
  }
  if (args.server === true) liveServers.add(tag)
  if (ports.length > 0) {
    spawnHostBridges(ports, tag)
    await hostBridgesListen(ports, tag)
  }
  return {
    wrapped,
    tag,
    taggedCommand,
    srtCommand: inner,
    baselines,
    scratch,
    forwardsSignals: grouped.forwards,
    traced: grouped.traced,
  }
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
    const watch = `{ IFS= read -r s && kill -s "$s" -- "-$$"; } 2>/dev/null <&3 3<&- &`
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
  if (setsid === undefined) {
    return { command: `${tag0} ${run} wait "$c"`, forwards: false, traced: true }
  }
  const watch = `{ IFS= read -r s && kill -s "$s" -- "-$c"; } 2>/dev/null <&3 3<&- &`
  return { command: `${tag0} ${run} ${watch} wait "$c"`, forwards: true, traced: true }
}

/** What strace stops on: the reads, and what moves or makes a process's cwd. */
const TRACED_CALLS = 'trace=openat,chdir,fchdir,clone,?clone3,?fork,?vfork'

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
function literalReadPaths(
  config: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2],
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
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
 * matched nothing, and the root task read it.
 */
export function seatbeltBrackets(
  config: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2],
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const fs = config?.filesystem
  if (fs === undefined) return config
  const literal = (paths: readonly string[]): string[] =>
    paths.map((p) => p.replaceAll('\\[', '[[]').replaceAll('\\]', ']'))
  return {
    ...config,
    filesystem: {
      ...fs,
      denyRead: fs.denyRead.map((p) => p.replaceAll('[', '[[]')),
      allowWrite: literal(fs.allowWrite),
      ...(fs.allowRead !== undefined ? { allowRead: literal(fs.allowRead) } : {}),
    },
  }
}

/** SRT's wrap, with the socket lift and the git-config grant this task asked for, or none (L-6, B-41). */
function wrapForTask(
  SandboxManager: SrtModule['SandboxManager'],
  command: string,
  customConfig: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2],
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
 * listens leaves the command to meet the refusal it met before.
 */
const PROXY_BRIDGE_WAIT =
  "( i=0; until grep -qsE ':0C38 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6 && grep -qsE ':0438 [0-9A-F]+:0000 0A' /proc/net/tcp /proc/net/tcp6; do [ $i -ge 500 ] && break; i=$((i+1)); sleep 0.01; done );"

/** Where a bridge's unix socket lives: the sandbox tmpdir, bound read-write on both sides. */
export function portBridgeSocket(tag: string, port: number): string {
  return path.join(taskTmpdir(tag), `vx-port-${tag}-${port}.sock`)
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

const hostBridges = new Map<
  string,
  { ports: readonly number[]; procs: Array<ReturnType<typeof Bun.spawn>> }
>()

/**
 * The ports a host listener already holds where the bridge would bind
 * (`127.0.0.1`, or every address). The listen wait below reads the same
 * table and took that listener for the bridge, whose bind had failed: the
 * task passed and a client of the port reached the other process
 * (2026-10-03). Linux, own procfs only, as the wait.
 */
function portsHeld(ports: readonly number[]): number[] {
  if (ports.length === 0 || !procfsIsOwn()) return []
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
  const until = Date.now() + 5_000
  while (Date.now() < until && procs.every((p) => p.exitCode === null)) {
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

function spawnHostBridges(ports: readonly number[], tag: string): void {
  const procs: Array<ReturnType<typeof Bun.spawn>> = []
  for (const p of ports) {
    // A spawn failure (no socat on the host) is the task's to report:
    // its own side dies the same way, in its frame.
    try {
      // socat resolved on vx's PATH, as every tool vx spawns: by bare name
      // Bun.spawn walked the startup PATH (M-22).
      const [tool, ...rest] = portBridgeHostArgv(tag, p)
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
              })
            : Bun.spawn(
                [taskShell(), '-c', `${guardLine(3)}exec ${argv.map(shellQuote).join(' ')}`],
                { stdio: ['ignore', 'ignore', 'ignore', guard], detached: true },
              ),
        ),
      )
    } catch {
      // see above
    }
  }
  if (procs.length > 0) {
    hostBridges.set(tag, { ports, procs })
    for (const p of ports) unlinkOnExit(portBridgeSocket(tag, p))
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
  if (liveTaskTmpdirs.delete(tmp)) rmSync(tmp, { recursive: true, force: true })
  if (liveServers.delete(tag) && liveServers.size === 0 && resetDeferred) {
    void resetSandbox().catch(() => {})
  }
  const bridges = hostBridges.get(tag)
  if (bridges === undefined) return
  hostBridges.delete(tag)
  for (const port of bridges.ports) {
    const sock = portBridgeSocket(tag, port)
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
  const { tracerFailed, ...first } = await runSandboxedOnce(args)
  // A stopping run has killed the children it holds; a retry would be one
  // spawned after that kill.
  if (!tracerFailed || args.signal?.aborted === true) return first
  args.onStderr?.(TRACER_RETRY_LINE)
  const { tracerFailed: _again, ...second } = await runSandboxedOnce(args)
  return {
    ...second,
    durationMs: first.durationMs + second.durationMs,
    stdout: first.stdout + second.stdout,
    stderr: first.stderr + TRACER_RETRY_LINE + second.stderr,
  }
}

/** The records collected for the commands running, by SRT's key for each. */
const collecting = new Map<string, SandboxViolation[]>()
let collectorOn = false

/**
 * Start collecting SRT's store records for `command`; the returned function
 * stops and hands them over. The store is a 100-record ring the whole run
 * shares, and on Linux its write observer reports every write any task
 * makes, so a refused write followed by 150 declared ones was gone before
 * the task's exit read it (B-7). One subscription takes each record as it
 * arrives and keeps it only for a command still running. SRT keys a record
 * by the base64 of the command's first 100 characters
 * (`encodeSandboxedCommand`, not exported).
 */
function collectRecords(
  store: ReturnType<SrtModule['SandboxManager']['getSandboxViolationStore']>,
  command: string,
): () => SandboxViolation[] {
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
  return () => {
    collecting.delete(key)
    return list
  }
}

/**
 * strace's own message, a line of a traced task's stderr. strace names
 * itself by its argv[0], the absolute path vx runs it by
 * (`/usr/bin/strace: ptrace(PTRACE_LISTEN,…)` on CI), so a bare
 * `strace: ` never matched there and the retry never fired.
 */
const STRACE_OWN_ERROR = /^(?:[^\s:]*\/)?strace: /

/**
 * One attempt of `runSandboxed`.
 *
 * Violations are matched by a unique per-task command prefix — SRT's
 * `getViolationsForCommand` keys by base64 of the first 100 chars, so
 * two tasks running the same underlying command (e.g. parallel `tsc`
 * across packages) would otherwise collide. We prepend `: '<tag>';`
 * (shell no-op) to make every command's first 100 chars unique.
 */
async function runSandboxedOnce(
  args: SandboxedRunArgs,
): Promise<SandboxedRunResult & { tracerFailed: boolean }> {
  const start = Date.now()
  const { SandboxManager } = await loadSrt()
  // Linux: SRT's store sees only writes (below), so read denials need
  // the command traced and the trace parsed for denied syscalls. The trace
  // is per-task (a log keyed by the command tag) so parallel tasks don't
  // share a stream. Skipped when strace isn't on PATH — bwrap still
  // enforces structurally; we just lose the structured violation list.
  //
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
  const useStrace = await wantsStraceDetection()
  // Before the spawn: what the task creates under a widened grant is its own.
  const widened = useStrace ? widenedEntries(args.config.allowWrite) : undefined
  const { wrapped, tag, srtCommand, baselines, scratch, forwardsSignals, traced } =
    await wrapSandboxedCommand({
      ...args,
      ...(useStrace ? { trace: useStrace } : {}),
      ...(widened !== undefined && widened.size > 0 ? { tracePaths: true } : {}),
    })
  const takeRecords = collectRecords(SandboxManager.getSandboxViolationStore(), srtCommand)
  // A stop that landed during the awaits above leaves nothing to kill yet:
  // spawned now, the task ran after the teardown swept the run's children.
  if (args.signal?.aborted === true) {
    releaseBridges(tag)
    takeRecords()
    const signal = stopSignal(args.signal.reason)
    return {
      exitCode: signalExitCode(signal),
      durationMs: Date.now() - start,
      stdout: '',
      stderr: '',
      signal,
      violations: [],
      tracerFailed: false,
    }
  }
  // Beside the task directories, which every sandbox replaces with its own:
  // in the shared temp dir a concurrent task read this log, every path
  // this task opened (L-25).
  const straceLog = traced ? path.join(taskTmpRoot(), `vx-strace-${tag}.log`) : undefined
  if (straceLog) unlinkOnExit(straceLog)
  let proc: ReturnType<typeof Bun.spawn>
  let traceFd: number | undefined
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
          'pipe',
          'pipe',
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
    const stderr = spawnFailureText(err, args.cwd, 'sandboxed task')
    args.onStderr?.(stderr)
    releaseBridges(tag)
    takeRecords()
    return {
      exitCode: 127,
      durationMs: Date.now() - start,
      stdout: '',
      stderr,
      spawnFailed: true,
      violations: [],
      tracerFailed: false,
    }
  } finally {
    // The child holds its own copy; ours would keep nothing but a descriptor.
    if (traceFd !== undefined) closeSync(traceFd)
  }

  args.liveChildren?.add(proc)
  args.onSpawn?.(proc.pid)
  const timeout = armTimeout(proc, args.timeoutMs)
  const ac = new AbortController()
  // The unfinished last line of stderr, and whether a line was strace's.
  let partial = ''
  let straceSpoke = false
  const streams = Promise.all([
    streamToString(proc.stdout, args.onStdout, ac.signal, args.capture?.stdout ?? true),
    streamToString(
      proc.stderr,
      (chunk) => {
        // Read whatever the capture setting: a line of strace's own says
        // the trace stopped short.
        const lines = (partial + chunk).split('\n')
        partial = (lines.pop() ?? '').slice(0, 512)
        if (lines.some((l) => STRACE_OWN_ERROR.test(l))) straceSpoke = true
        args.onStderr?.(chunk)
      },
      ac.signal,
      args.capture?.stderr ?? true,
    ),
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
  releaseGroup(proc)
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
  // EVERY record SRT's store saw for this command, unfiltered (owner,
  // 2026-09-05). A sandboxed task that fails must say what it was denied;
  // deciding on the user's behalf that a record was "just traversal" is how
  // a failure ends up with an empty violations section and no explanation.
  const records = takeRecords()
  // Read as is on darwin only. Since SRT 0.0.75 the store is fed on Linux
  // too, by the seccomp helper's write observer — but SRT judges those
  // reports against the GLOBAL `filesystem.allowWrite` from `initialize`
  // (empty here; the per-task list travels in `customConfig`, which the
  // monitor never sees), so every write a task makes to its own declared
  // output arrived as `deny openat <output>` and, read as is, failed the
  // task (reproduced 2026-09-04 in a Linux container: exit 1, empty
  // stderr). On Linux the records are judged against the task's own binds
  // below (`refusedWrites`).
  const macViolations = process.platform === 'darwin' ? records : []
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
  //
  // strace never sees a write: SRT's seccomp step hands every write-intent
  // syscall to its observer (USER_NOTIF, which takes precedence over
  // strace's TRACE), and the observer feeds the store with every ATTEMPT,
  // judged against the run-wide config, which grants no write. Judged here
  // against this task's own binds, what is left is a write bwrap refused,
  // or one into the anchor's scratch that vanished with the sandbox: a
  // task that swallowed it exited 0 with nothing reported (B-5).
  const linuxViolations: SandboxViolation[] =
    process.platform === 'linux'
      ? [
          ...(straceLog
            ? await parseStraceViolations(straceLog, args, baselines, widened).catch(() => [])
            : []),
          ...refusedWrites(
            // Keyed by what SRT wrapped, the in-sandbox group wrapper
            // included, not by the tagged command macOS is keyed by.
            records.map((v) => v.line),
            bindableWrites(args.config.allowWrite),
            scratch,
          ),
          ...refusedConnections(records.map((v) => v.line)),
        ]
      : []
  if (straceLog) {
    // Listed until the unlink lands, as the run lock's taking (item 868).
    await unlink(straceLog).catch(() => undefined)
    liveTempFiles.delete(straceLog)
  }

  // Apply the task's own ignoreViolations on top of the global defaults.
  // SRT's wrapCommandWithSandboxMacOS doesn't actually thread customConfig.
  // ignoreViolations through to the log monitor — that filter is set
  // once globally at initSandbox time. So per-task user overrides have
  // to be applied here, after read-back.
  const recorded = [...macViolations, ...linuxViolations]
  const violations = reportableViolations(recorded, {
    within: args.reportWithin,
    linked: args.reportLinked,
    config: args.config,
  })
  // A write refused past the wall is not a violation (nothing a key reads),
  // but it may be why the task failed: name it, never counted, and only on
  // a failure, so it can never redden a pass.
  if (exitCode !== 0) {
    const outside = refusedWritesOutside(recorded, {
      within: args.reportWithin,
      linked: args.reportLinked,
      config: args.config,
      skip: [taskTmpRoot(), ...srtDefaultWritePaths()],
    })
    if (outside.length > 0)
      violations.push(outsideWritesHint(outside, baselines.denyRead, args.reportWithin))
  }

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
    if (hidden.length > 0) violations.push(hiddenReadsHint(hidden, args.reportWithin))
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
    // Linux: the task's CPU and peak never reach this wait. bwrap runs it
    // in a pid namespace (`--unshare-pid`), and what the namespace's
    // processes used is not folded into bwrap's usage: a 500 ms busy loop
    // read 2 ms under it and 510 without the flag, and the peak read was
    // vx's own high-water mark, inherited at exec (a sandboxed `true` from a
    // 300 MB vx: 353 MB; B-3). Nothing is reported rather than a number
    // that is someone else's. macOS's `sandbox-exec` execs the command, so
    // its usage is the task's.
    ...(process.platform === 'linux' ? {} : resourceUsageToCpuRss(proc.resourceUsage())),
    tracerFailed:
      straceLog !== undefined &&
      !timeout.timedOut() &&
      (straceSpoke || STRACE_OWN_ERROR.test(partial)),
  }
}

/** The hint for writes refused outside the project, a few paths named. */
function outsideWritesHint(
  paths: readonly string[],
  walled: readonly string[],
  within: string,
): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const home = toRealPath(os.homedir())
  const dir = path.dirname(paths[0]!)
  // In the workspace, from the project, as a committed config spells it:
  // the absolute path held only on the machine that printed it.
  const spelled = walled.some((w) => atOrUnder(dir, toRealPath(w)))
    ? path.relative(toRealPath(within), dir) || '.'
    : atOrUnder(dir, home)
      ? `~${dir.slice(home.length)}`
      : dir
  const refused =
    `vx: the sandbox refused writes outside the project, which are not reported as ` +
    `violations: ${shown}${more}.`
  // Granting a system temp directory opens it to every write of the task;
  // the task already has a temp directory of its own. A workspace kept
  // under one is the workspace, and its directory is the grant.
  const first = paths[0]!
  const scratchTemp =
    hostTempRoots().some((t) => atOrUnder(first, t)) &&
    !walled.some((w) => atOrUnder(first, toRealPath(w)))
  const line = scratchTemp
    ? `${refused} The task has its own temp directory, empty at its start: write under ` +
      `$TMPDIR (os.tmpdir() in Node and Bun) instead of a fixed path.`
    : `${refused} If the task needs one, grant its directory, e.g. ` +
      `\`allow: { write: [${jsString(`${spelled}/`)}] }\`.`
  return { timestamp: new Date(), hint: true, line }
}

/** A path as a JS string literal a config can take: a quote in it is escaped. */
const jsString = (p: string): string => (p.includes("'") ? JSON.stringify(p) : `'${p}'`)

/** The host's shared temp directories, canonical: what a fixed temp path in a tool names. */
function hostTempRoots(): string[] {
  return [...new Set(['/tmp', '/var/tmp', os.tmpdir()].map(toRealPath))]
}

function hiddenReadsHint(paths: readonly string[], within: string): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
      `not reported as violations: ${shown}${more}. If the task reads one, grant it, e.g. ` +
      `\`allow: { read: [${jsString(path.relative(toRealPath(within), paths[0]!))}] }\`.`,
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
 * `allowMachLookup` off the config given to `initialize()` and never off
 * the per-call one (`sandbox-manager.js` getters, 0.0.75 and 0.0.76) — so a per-task
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
 *   write: ['g/**
 * The walls a glob grant can reach: each one under (or at) a glob's
 * literal head. On Linux `expandGrants` drops such a hit before the bind
 * (B-1); seatbelt matches a glob as a path regex, with no hit to drop.
 */
export function wallsGlobsReach(grants: readonly string[], walls: readonly string[]): string[] {
  const heads = grants
    .filter((g) => !isMountableLiteral(g))
    .map((g) => path.dirname(g.slice(0, g.search(MOUNT_WILDCARDS))))
  return walls.filter((w) => heads.some((h) => atOrUnder(w, h)))
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
        .filter((l) => isMountableLiteral(l) && atOrUnder(l, w))
        .map((l) => `(require-not (subpath "${sbplResolvedPath(l, 'grant')}"))`)
      rules.push(
        kept.length === 0
          ? `(deny ${op} ${at})`
          : `(deny ${op} (require-all ${at} ${kept.join(' ')}))`,
      )
    }
  }
  deny('file-read-data', c.wallsReached?.read ?? [], [...c.allowRead, ...baseAllowRead])
  deny('file-write*', c.wallsReached?.write ?? [], c.allowWrite)
  return rules
}

/**']         ok — collapsed to the directory
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
      // names a wall literally never reaches this loop and stays.
      if (walls.some((w) => atOrUnder(real, w))) continue
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
  const glob = new Bun.Glob(pattern)
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
  process.stderr.write(
    `[vx] sandbox: the write grant ${jsString(grantSpelled(grant, within))} matches nothing ` +
      `yet, and a read grant mounts its directory read-only, so a file the task creates under ` +
      `it will fail with "Read-only file system". A bind mount covers what exists when the ` +
      `task starts — grant the directory instead: ` +
      `\`allow: { write: [${jsString(dir === '.' ? '.' : `${dir}/`)}] }\`\n`,
  )
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
let straceAvailableCache: { form: false | 'plain' | 'seccomp'; why: string } | undefined
async function straceState(): Promise<{ form: false | 'plain' | 'seccomp'; why: string }> {
  if (process.platform !== 'linux') return { form: false, why: '' }
  if (straceAvailableCache !== undefined) return straceAvailableCache
  try {
    const p = Bun.spawn([executablePath('strace'), '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    if (p.exitCode !== 0) {
      straceAvailableCache = { form: false, why: `strace --version exited ${p.exitCode}` }
    } else {
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
      straceAvailableCache =
        refused === null
          ? { form, why: '' }
          : { form: false, why: `strace cannot trace here (${refused.line})` }
    }
  } catch {
    // Not on PATH. Said as the refused attach is: without it an undeclared
    // read is denied but never reported, so a task that tolerates the miss
    // passes and caches with no word of it (J's lead).
    straceAvailableCache = { form: false, why: 'strace is not on PATH' }
  }
  return straceAvailableCache
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
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
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
  process.stderr.write(
    `[vx] sandbox: ${why}, so sandboxed tasks run without the report of the reads the sandbox denied; ` +
      `the sandbox still enforces\n`,
  )
}
