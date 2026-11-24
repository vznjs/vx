// The sandbox runtime's (SRT's) session for a run: starting it with the
// run's config (`initSandbox`), tearing it down (`resetSandbox`) without
// cutting a live server's bridges, and what each wrap needs from it: the
// task's own temp directory, the host helpers SRT runs (the no-op deny
// scan, the env-cut socat), a hermetic task's reads, and the per-task
// config a wrap holds (`wrapForTask`). The host probe is memoized per
// session here (`probeSandbox`), and a task's end releases what it held
// (`releaseBridges`).

import path from 'node:path'
import os from 'node:os'
import {
  lstatSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import type { ProjectConfig } from '../config.js'
import { shellQuote, guardSession } from '../exec/index.js'
import { applySeccompPath, observePath } from './seccomp-helper.js'
import {
  ESSENTIAL_ENV,
  executablePath,
  helperEnv,
  holdSecret,
  taskShell,
  procfsIsOwn,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { toRealPath, unique } from './paths.js'
import { canScopeDenyScan } from './deny-scan.js'
import {
  type SandboxAvailability,
  dependencyReason,
  socketPathRefusal,
  trySandboxedTrue,
  applyPolicyHere,
} from './probe.js'
import { sandboxTmpdir, taskTmpdir, liveTaskTmpdirs, removeTaskTmpdir } from './tmp.js'
import { hostBridges, closeTaskNet } from './bridges.js'
import { forgetTraceProbes } from './trace.js'

export type SrtModule = typeof import('@anthropic-ai/sandbox-runtime')

export type SrtTaskConfig = NonNullable<
  Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2]
>

/**
 * The variables the sandbox sets over a task's own (module page § The
 * environment SRT sets): a `passThrough` or `define` of one never reaches
 * a sandboxed task. Upper-case only, as `unpassedEnv` reads names.
 */
export const SANDBOX_SET_ENV: ReadonlySet<string> = new Set([
  'SANDBOX_RUNTIME',
  'TMPDIR',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'GRPC_PROXY',
  'FTP_PROXY',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_USERNAME',
  'CLOUDSDK_PROXY_PASSWORD',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH_COMMAND',
  'CLAUDE_CODE_HOST_HTTP_PROXY_PORT',
  'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT',
])

let srtPromise: Promise<SrtModule> | undefined

/** Set once loaded, for `releaseBridges`, which a sync exit handler calls. */
let srtLoaded: SrtModule | undefined

export async function loadSrt(): Promise<SrtModule> {
  if (!srtPromise) {
    srtPromise = import('@anthropic-ai/sandbox-runtime').then((m) => (srtLoaded = m))
  }
  return srtPromise
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
 * namespace. A bare `bwrap … /bin/true` passed on hosts where every
 * task then failed: as root inside a container, the helper's
 * `write /proc/self/uid_map` is EPERM under `--cap-drop ALL`.
 *
 * `weakerNested` probes with `enableWeakerNestedSandbox`; the caller
 * passes it only when EVERY sandboxed task opts in, since the secure
 * wrapper is what any other task will run under.
 *
 * On Linux the probe INITIALIZES SRT (idempotent — `run()` initializes
 * right after anyway), and SRT's proxy sockets then keep the event loop
 * alive: a standalone caller must `resetSandbox()` or exit.
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

/** Whether SRT is up in this process — set by `initSandbox`, cleared by `resetSandbox`. */
let srtUp = false

/**
 * The run's config while one of its tasks lifts SRT's `socket(AF_UNIX)`
 * block, grants `gitConfig` or sets `weakerWhenNested`, else undefined. SRT
 * reads each from its run-wide config (`weakerWhenNested` did nothing
 * until 2026-11-13: it was passed per call), so one task's `unixSockets` or port list lifted the
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
export let scopedDenyScan = false

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
    return { mandatoryDenySearchDepth: 1, ripgrep: { command: scanCommandAgain() } }
  } catch {
    return { mandatoryDenySearchDepth: 1 }
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

/** `<os tmpdir>/<prefix>-<uid>`: made 0700, refused unless it is this user's own private directory. */
function ownTmpDir(prefix: string): string {
  const uid = process.getuid!()
  const dir = path.join(os.tmpdir(), `${prefix}-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const d = lstatSync(dir)
  if (!d.isDirectory() || d.uid !== uid || (d.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not this user's own directory`)
  }
  return dir
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
  const file = path.join(ownTmpDir('vx-noscan'), 'rg')
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
export function hostHelpers(): { dirs: string[]; files: string[] } {
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

export function hermeticReads(): Promise<HermeticReads> {
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
  const seccomp = getApplySeccompBinaryPath(await applySeccompPath())
  if (seccomp) programs.push(seccomp)
  const observer = await observePath()
  if (observer !== undefined) programs.push(observer)
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
export function bothSpellings(p: string): string[] {
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
export const runtimeOwn = new Set<string>()

export function runtimeBinds(wrapped: string): string[] {
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
  const file = path.join(ownTmpDir('vx-socat'), `socat-${xxh3hex(body).slice(0, 16)}`)
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

export function hostHasIpv6(): boolean {
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
  const bad = badDomains(schema, allowed, denied)
  if (bad.length > 0) throw new UserError(`sandbox: ${domainsRefusal(bad)}`)
}

function badDomains(
  schema: SrtModule['NetworkConfigSchema'],
  allowed: readonly string[],
  denied: readonly string[],
): string[] {
  return [
    ...allowed
      .filter((d) => !schema.shape.allowedDomains.safeParse([d]).success)
      .map((d) => `allow.network "${d}"`),
    ...denied
      .filter((d) => !schema.shape.deniedDomains.safeParse([d]).success)
      .map((d) => `deny.network "${d}"`),
  ]
}

function domainsRefusal(bad: readonly string[]): string {
  return (
    `${bad.join(', ')} is not a host pattern: name a host ("example.com"), a ` +
    `subdomain wildcard ("*.example.com") or either with a port ("example.com:443"); no ` +
    `scheme or path, and "*" or "*.com" is refused as too broad (a bare "*" only in deny)`
  )
}

/**
 * The network entries `vx lock` refuses, by task. The run's check above
 * judges the union of every sandboxed task in the run as the sandbox
 * starts, so one task's bad entry failed every sandboxed task of the run,
 * each with the same line and none naming the task that wrote it, while
 * `vx lock` had passed the config (2026-11-23).
 */
export async function networkPatternRefusal(
  projects: Iterable<{ readonly name: string; readonly config: ProjectConfig }>,
): Promise<string | undefined> {
  const tasks: [string, readonly string[], readonly string[]][] = []
  for (const p of projects) {
    for (const [task, t] of Object.entries(p.config.tasks ?? {})) {
      const sandbox = t.exec?.sandbox
      const net = sandbox?.allow?.network
      const allowed = Array.isArray(net) ? net : []
      const denied = sandbox?.deny?.network ?? []
      if (allowed.length + denied.length > 0) tasks.push([`${p.name}#${task}`, allowed, denied])
    }
  }
  if (tasks.length === 0) return undefined
  const { NetworkConfigSchema } = await loadSrt()
  for (const [id, allowed, denied] of tasks) {
    const bad = badDomains(NetworkConfigSchema, allowed, denied)
    if (bad.length > 0) return `${id} exec.sandbox: ${domainsRefusal(bad)}`
  }
  return undefined
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
  /** Whether any task of the run sets `weakerWhenNested`: read run-wide too, so set per wrap. */
  weakerNested?: boolean
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
  const applyPath = await applySeccompPath()
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
    ...(applyPath === undefined ? {} : { seccomp: { applyPath } }),
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
  } catch (err) {
    // SRT 0.0.83 cancels a start its own reset overtook and throws: the
    // stop asked for, not a failed sandbox. Taken down below as before.
    if (!cut) throw err
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
  perTaskRun =
    opts?.allowAllUnixSockets === true || opts?.gitConfig === true || opts?.weakerNested === true
      ? config
      : undefined
  // `initialize()` returns early once SRT is up, and on Linux the
  // availability probe brought it up with an EMPTY config before the run's
  // own call — so the run's allowlist and unix-socket allowance never
  // reached it. `updateConfig` is SRT's hot
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
export const liveServers = new Set<string>()

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
  forgetTraceProbes()
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

/** SRT's wrap, with the socket lift, the git-config grant and the weaker nested profile this task asked for, or none (L-6, B-41). */
export function wrapForTask(
  SandboxManager: SrtModule['SandboxManager'],
  command: string,
  customConfig: SrtTaskConfig | undefined,
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
      enableWeakerNestedSandbox: customConfig?.enableWeakerNestedSandbox === true,
    })
    return SandboxManager.wrapWithSandbox(command, shell, customConfig)
  })
  wrapTurn = turn.catch(() => undefined)
  return turn
}

/** Whether the run's proxy allows any host: one that allows none refuses every task alike, front or not. */
export let runAllowsHosts = false

/** The run's union: what a `network: true` task's front allows. */
export let runAllowed: readonly string[] = []

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
  closeTaskNet(tag)
}

/**
 * The runtime counts every wrap as a live sandbox until this, and removes
 * the empty files bwrap made on the host as mount points (`.bashrc`,
 * `.vscode`, … under a write grant) only at a count of 0: a wrap with no
 * call here kept every later task's stubs on the host until the reset.
 */
export function afterCommand(SandboxManager: SrtModule['SandboxManager']): void {
  try {
    SandboxManager.cleanupAfterCommand()
  } catch {
    // ignore; bwrap mount-point cleanup is best-effort
  }
}
