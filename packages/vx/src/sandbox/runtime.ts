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
//
// This file wraps and runs one task (`wrapSandboxedCommand`,
// `runSandboxed`). Beside it: the run's SRT session (session.ts), the host
// probe (probe.ts), the Linux tracer (trace.ts), the port bridges and proxy
// fronts (bridges.ts), a task's temp files (tmp.ts), grant resolution
// (grants.ts), the macOS profile rules (seatbelt.ts) and the notes on a
// failure (hints.ts).

import path from 'node:path'
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
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
  type StreamTally,
  type TreeUsage,
  TaskPipes,
  watchTree,
  closeSignalChannel,
  groupOutlives,
  releaseGroup,
  runTime,
  signalThrough,
  sweepDeadShell,
  guardLine,
  markTree,
  spawnGuarded,
  treeToken,
  VX_RUN_TREE_ENV,
} from '../exec/index.js'
import { observePath } from './seccomp-helper.js'
import { taskShell, POST_EXIT_DRAIN_MS, UserError, xxh3hex } from '../util/index.js'
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
  widenedEntries,
  withLinkedWrites,
  stagedOutputs,
} from './binds.js'
import { atOrUnder, loopbackPorts, MOUNT_WILDCARDS, toRealPath } from './paths.js'
import { scopedMandatoryDenies, srtDefaultWritePaths } from './deny-scan.js'
import {
  observedWrites,
  parseStraceViolations,
  refusedConnections,
  refusedWrites,
  reportableViolations,
} from './violations.js'
import {
  type TraceForm,
  ownGroupCommand,
  withoutRuntimeObserver,
  observerRefusedIn,
  traceFor,
  STRACE_OWN_ERROR,
  OBSERVER_OWN_ERROR,
  collectRecords,
  observerSocket,
} from './trace.js'
import {
  type CanonicalBaselines,
  canonicalBaselines,
  baselineLinks,
  readGrantLinks,
  pendingWriteGrants,
  cwdMounted,
} from './grants.js'
import {
  loadSrt,
  releaseBridges,
  type SrtModule,
  hermeticReads,
  runtimeOwn,
  hostHelpers,
  bothSpellings,
  scopedDenyScan,
  hostHasIpv6,
  type SrtTaskConfig,
  wrapForTask,
  runtimeBinds,
  runAllowsHosts,
  runAllowed,
  afterCommand,
  liveServers,
} from './session.js'
import {
  ownTaskTmpRoot,
  taskTmpdir,
  trackTaskTmpdir,
  taskTmpRoot,
  unlinkOnExit,
  liveTempFiles,
} from './tmp.js'
import {
  bridgedPorts,
  bridgesGone,
  portsHeld,
  hostBridges,
  portDialScript,
  PORT_DIAL_SCRIPT,
  portBridgeInner,
  reachBridgeInner,
  PROXY_BRIDGE_WAIT,
  ownProxy,
  spawnHostBridges,
  hostBridgesListen,
} from './bridges.js'
import {
  seatbeltBrackets,
  macProfileRules,
  darwinGrantRules,
  injectProfileRules,
} from './seatbelt.js'
import { GIT_NO_REPO, READ_ONLY_FS, readableUnder, addHints } from './hints.js'

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
   * Directories the task's declared outputs claim whole (`dist/**`),
   * absolute: only these may be staged (`stagedOutputs`), since no other
   * task may write or rely on what is in them while it runs.
   */
  readonly ownedOutputs?: readonly string[]
  /**
   * User-declared sandbox block (after path-resolution). Path lists are
   * unioned with the baselines; bool/object fields fall through to SRT.
   */
  config: ResolvedSandboxConfig
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
  args: Pick<
    SandboxedRunArgs,
    'command' | 'cwd' | 'forwardArgs' | 'config' | 'env' | 'ownedOutputs'
  > &
    Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead'> & {
      /** A persistent server: the sandbox outlives a run's reset until `releaseBridges(tag)`. */
      server?: boolean
      /** Report the command's refused reads to descriptor TRACE_FD (Linux; `traceFor`). */
      trace?: TraceForm
      /** Report each read that succeeded too (strace: `-y`): a read under a widened grant is judged. */
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
  /**
   * The pending write globs `punchedWriteGlobs` bound, and their directories;
   * `unshown`, those no read grant shows, whose reads are judged too.
   */
  held: { dirs: string[]; globs: string[]; unshown: string[] }
  /** Moves the output directories staged for the task back (`stagedOutputs`): once, after it ends. */
  unstage?: () => void
  /** The command reads its polite signals off fd 3: spawn it with one and `signalThrough` it. */
  forwardsSignals: boolean
  /** The command writes its trace to fd TRACE_FD: spawn it with the log there. */
  traced: boolean
  /** The trace is vx's observer's, the writes in it too, not strace's. */
  observed: boolean
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
  // A write glob's directory no read grant shows is bound only where a
  // tracer judges what the task reads there: with none, it would be read unseen.
  const customConfig = buildCustomConfig(args, {
    ...baselines,
    ...(args.trace === undefined ? { cwd: undefined } : {}),
  })
  const filesystem = customConfig.filesystem!
  const allowRead = filesystem.allowRead!
  const links = [
    ...punchedLinks([...baselines.allowRead, ...args.config.allowRead], allowRead),
    ...baselineLinks(args.baseAllowRead, allowRead),
    ...readGrantLinks(args.config.linkedReads, [...allowRead, ...filesystem.allowWrite]),
  ]
  // The directories `punchedWriteGlobs` bound, and the write globs: a write
  // one matches is granted in any bound directory, a match's widened one
  // too (`dist/a.js` there binds `dist`, where a new `dist/b.js` lands).
  const own = new Set(bindableWrites(args.config.allowWrite))
  const heldDirs = filesystem.allowWrite.filter((w) => !own.has(w))
  const shownBy = [...baselines.allowRead, ...args.config.allowRead]
  const globsHeld = {
    dirs: heldDirs,
    globs: [...(args.config.writeGlobs ?? [])],
    unshown: heldDirs.filter((d) => !shownBy.some((r) => atOrUnder(d, r))),
  }
  const scratch = pendingWriteGrants(args.config, filesystem, baselines.denyRead, baselines.cwd)
  filesystem.denyRead.push(toRealPath(taskTmpRoot()))
  if (args.config.hermetic === true) {
    const reads = await hermeticReads()
    filesystem.denyRead.push(...reads.deny)
    allowRead.push(...reads.allow, ...runtimeOwn)
  }
  const helpers = hostHelpers()
  filesystem.denyRead.push(...helpers.dirs)
  allowRead.push(...helpers.files)
  // The observer runs inside the sandbox, from the cache home or vx's own files.
  const observer = args.trace === 'observe' ? await observePath() : undefined
  if (observer !== undefined) allowRead.push(...bothSpellings(observer))
  const cwdDenied = process.platform === 'linux' && !cwdMounted(baselines.cwd, filesystem)
  if (cwdDenied) filesystem.denyRead.push(baselines.cwd)
  filesystem.allowWrite.push(toRealPath(tmp))
  // Seatbelt judges `/dev/stdout` by the path the kernel resolves it to,
  // `/dev/fd/1`, which SRT's default `/dev/stdout` grant does not name, so
  // `echo x > /dev/stdout` failed EPERM (X-113). `/dev/fd/N` reopens only a
  // descriptor the task already holds.
  if (process.platform === 'darwin') filesystem.allowWrite.push('/dev/fd')
  if (scopedDenyScan) {
    filesystem.denyWrite.push(
      ...scopedMandatoryDenies(
        process.cwd(),
        [...srtDefaultWritePaths(), ...filesystem.allowWrite],
        args.config.gitConfig === true,
      ),
    )
  }
  // Seatbelt re-allows a read inside a denied region only by name; on Linux
  // a read grant over a write path would remount it read-only.
  if (process.platform === 'darwin') allowRead.push(toRealPath(tmp))
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
  await bridgesGone(ports)
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
  const bridged = ports.length > 0 || reach.length > 0
  if (bridged) {
    hostBridges.set(tag, { ports, reach, procs: [] })
    writeFileSync(portDialScript(tag), PORT_DIAL_SCRIPT)
  }
  const grouped =
    process.platform === 'linux'
      ? ownGroupCommand(
          tag,
          inTmp,
          args.trace === 'observe'
            ? observer === undefined
              ? undefined
              : { observer }
            : args.trace,
          // A glob's directory no read grant shows is judged as a widened grant's.
          args.tracePaths === true || globsHeld.unshown.length > 0,
        )
      : { command: taggedCommand, forwards: false, traced: false, trace: undefined }
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
  const wrap = (config: SrtTaskConfig | undefined): Promise<string> =>
    wrapForTask(
      SandboxManager,
      inner,
      config,
      bridged || asksUnixSockets(args.config),
      args.config.gitConfig === true,
    )
  let wrapped = await wrap(
    process.platform === 'linux'
      ? literalReadPaths(customConfig)
      : process.platform === 'darwin'
        ? seatbeltBrackets(customConfig, baselines.allowRead)
        : customConfig,
  )
  if (process.platform === 'linux' && args.config.hermetic === true) {
    const own = runtimeBinds(wrapped).filter((p) => !runtimeOwn.has(p))
    if (own.length > 0) {
      for (const p of own) runtimeOwn.add(p)
      allowRead.push(...own)
      wrapped = await wrap(literalReadPaths(customConfig))
    }
  }
  if (runAllowsHosts) {
    try {
      wrapped = await ownProxy(SandboxManager, wrapped, inner, tag, args.config, runAllowed)
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
  // One listener a filter chain (the kernel answers a second EBUSY), and
  // the runtime's write observer would be the first: vx's observer reports
  // the writes too, so the runtime's is left out of this wrap.
  if (typeof grouped.trace === 'object') wrapped = withoutRuntimeObserver(wrapped)
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
  // A link vx binds as a file for its own programs (`bothSpellings`: a
  // hermetic task's `/usr/bin/sh`) is there already: bwrap refuses a link
  // over it, and a grant spelled through it failed the task.
  const bound = new Set(allowRead)
  const laid = links.filter(
    ([, at], i) => !bound.has(at) && links.findIndex(([, a]) => a === at) === i,
  )
  if (process.platform === 'linux' && /^\S*bwrap /.test(wrapped)) {
    const gitGranted = [...args.config.allowRead, ...args.config.allowWrite].some((g) =>
      g.split(/[\\/]/).includes('.git'),
    )
    wrapped =
      (gitGranted ? 'GIT_DISCOVERY_ACROSS_FILESYSTEM=${GIT_DISCOVERY_ACROSS_FILESYSTEM-1} ' : '') +
      `exec ${readOnlyMasks(withCwd(withPunchedLinks(withLinkedWrites(wrapped, linkedWriteBinds(args.config.linkedWrites)), laid), cwdDenied ? baselines.cwd : undefined), scratch)}`
  }
  if (process.platform === 'linux' && !hostHasIpv6())
    wrapped = `SOCAT_DEFAULT_LISTEN_IP=4 ${wrapped}`
  if (args.server === true) liveServers.add(tag)
  if (bridged) {
    spawnHostBridges(tag)
    if (ports.length > 0) await hostBridgesListen(ports, tag)
  }
  // A server outlives the attempt that would move its outputs back.
  const staged =
    args.server === true
      ? undefined
      : stagedOutputs(wrapped, {
          cwd: baselines.cwd,
          allowRead: filesystem.allowRead!,
          allowWrite: filesystem.allowWrite,
          granted: args.config.allowWrite,
          linked: args.config.linkedWrites,
          owned: args.ownedOutputs ?? [],
          tag,
        })
  if (staged !== undefined) wrapped = staged.wrapped
  return {
    wrapped,
    tag,
    taggedCommand,
    srtCommand: inner,
    baselines,
    scratch,
    held: globsHeld,
    ...(staged === undefined ? {} : { unstage: staged.restore }),
    forwardsSignals: grouped.forwards,
    traced: grouped.traced,
    observed: grouped.traced && typeof grouped.trace === 'object',
  }
}

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
function literalReadPaths(config: TaskSandboxConfig | undefined): SrtTaskConfig | undefined {
  const fs = config?.filesystem
  if (fs === undefined) return config as SrtTaskConfig | undefined
  // A `*` or `?` reaches here only in a named directory (`nameDir`, a
  // project under `packages/[*]/`): marked literal, as is every write path
  // holding a wildcard, which SRT would otherwise drop.
  const literal = (p: string) => ({ path: p, literal: true as const })
  const escape = (paths: readonly string[]) =>
    paths.map((p) => (/[*?]/.test(p) ? literal(p) : p.replaceAll('[', '[[]')))
  const names = (paths: readonly string[]) =>
    paths.map((p) => (MOUNT_WILDCARDS.test(p) ? literal(p) : p))
  return {
    ...config,
    filesystem: {
      ...fs,
      // A `*` or `?` in a deny path matches its siblings too: a wider wall.
      denyRead: escape(fs.denyRead),
      ...(fs.allowRead !== undefined ? { allowRead: escape(bindableReads(fs.allowRead)) } : {}),
      allowWrite: names(fs.allowWrite),
      denyWrite: names(fs.denyWrite),
    },
  }
}

/** What a task's output says when strace, not the task, ended its first attempt. */
const TRACER_RETRY_LINE =
  "[vx] the sandbox's tracer (strace) failed on its own; running the task again\n"

/** The same, of vx's own observer. */
const OBSERVER_RETRY_LINE =
  "[vx] the sandbox's observer failed on its own; running the task again\n"

/** What it says when the observer could not start inside the sandbox: the command has not run. */
const OBSERVER_REFUSED_LINE =
  "[vx] the sandbox's observer cannot run in this sandbox; running the task without it\n"

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
 * On Linux the task runs under vx's observer, or under strace, which only
 * REPORT what the sandbox denied. An observer that cannot start inside the
 * sandbox says so before the command runs, and the task is run without
 * it; one whose supervisor died is strace's case below. strace failing on its own (`ptrace(PTRACE_LISTEN,…): Input/output
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
  const { tracerFailed, observerCut, observerRefused, mountGone, ranMs, ...first } =
    await runSandboxedOnce({
      ...args,
      onStdout: seen(args.onStdout),
      onStderr: seen(args.onStderr),
    })
  // Refused inside the sandbox where it ran outside (a /proc that is not
  // the task's own, a listener the sandbox around vx holds): every later
  // task of this kind is traced the old way.
  if (observerRefused !== undefined)
    observerRefusedIn.set(args.config.weakerWhenNested === true, observerRefused)
  // A stopping run has killed the children it holds; a retry would be one
  // spawned after that kill.
  if (
    !(tracerFailed || mountGone || observerRefused !== undefined) ||
    args.signal?.aborted === true
  )
    return first
  const notice =
    (midLine ? '\n' : '') +
    (mountGone
      ? MOUNT_RACE_RETRY_LINE
      : observerRefused !== undefined
        ? OBSERVER_REFUSED_LINE
        : observerCut === true
          ? OBSERVER_RETRY_LINE
          : TRACER_RETRY_LINE)
  args.onStderr?.(notice)
  // `timeout` bounds the task's whole run (schema.md), so the retry gets
  // what the first attempt left of it, not a fresh window.
  const {
    tracerFailed: _again,
    observerCut: _cut,
    observerRefused: _refused,
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

/** Its exit status with one. */
const OBSERVER_FAILED = 125

/** The one it says after the command ran: its supervisor died, and the report stopped short. */
const OBSERVER_CUT_SHORT = 'the supervisor ended before the command'

/** What it says when its report refused a write (a full disk): the reads are unknown, so the task fails, once. */
const OBSERVER_LOST = /^the report could not be written/

/** One attempt's result, with what `runSandboxed` decides a second on. */
type AttemptResult = SandboxedRunResult & {
  tracerFailed: boolean
  /** The tracer that failed was vx's observer. */
  observerCut?: true
  /** Why the observer did not start in this sandbox: the command never ran. */
  observerRefused?: string
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

export type Wrap = Awaited<ReturnType<typeof wrapSandboxedCommand>>

/** The wrap, and what the task's widened and held grants held before it ran. */
interface Prepared {
  wrap: Wrap
  /** Each widened grant's entries before the spawn: what the task creates there is its own. */
  widened: Map<string, Set<string>>
  /** `widened`, plus each directory bound for a glob, judged as a widened one (`refusedWrites`). */
  heldEntries: Map<string, Set<string>>
  /** `widened`, plus each glob's directory no read grant shows: whose reads are judged. */
  readJudged: Map<string, Set<string>>
}

/**
 * Linux: SRT's store sees only writes, so read denials need the command
 * traced and the trace parsed for denied syscalls. The trace is per-task
 * (a log keyed by the command tag) so parallel tasks don't share a
 * stream. vx's own observer writes it (`traceFor`); where that cannot
 * run, strace does, and what follows is strace's form. Skipped when
 * neither can — bwrap still enforces structurally; we just lose the
 * structured violation list.
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
  const trace = await traceFor(args.config.weakerWhenNested === true)
  const widened = widenedEntries(args.config.allowWrite)
  let wrap: Wrap
  try {
    wrap = await wrapSandboxedCommand({
      ...args,
      ...(trace ? { trace } : {}),
      ...(trace && widened.size > 0 ? { tracePaths: true } : {}),
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
  const readJudged = new Map(widened)
  for (const dir of wrap.held.unshown) {
    const entries = heldEntries.get(dir)
    if (entries !== undefined) readJudged.set(dir, entries)
  }
  return { prepared: { wrap, widened, heldEntries, readJudged } }
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
    // What a seatbelt task starts carries it: a stop finds what left its
    // group. A Linux one's pid namespace takes that (kill-tree.ts, `markTree`).
    const tree = forwardsSignals ? undefined : treeToken()
    // Descriptors: 3 the signal channel the in-sandbox watcher reads, 4 the
    // guard's pipe (kill-tree.ts), TRACE_FD the trace log; a gap is 'ignore'.
    proc = spawnGuarded((guard) =>
      Bun.spawn([sh, '-c', (guard === undefined ? '' : guardLine(4)) + wrapped], {
        argv0: 'sh',
        cwd: args.cwd,
        env: (tree === undefined ? args.env : { ...args.env, [VX_RUN_TREE_ENV]: tree }) as Record<
          string,
          string
        >,
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
    if (tree !== undefined) markTree(proc, tree)
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
  /** What the observer said of itself, its first line. */
  observerSaid: string | undefined
  /** bwrap's refusal of a mount gone as it set up (`BWRAP_MOUNT_GONE`). */
  mountGone: boolean
  /** `hiddenGitHint`. */
  gitNoRepo: boolean
  /** `grantRemovalHint`: a run captures no output. */
  readOnlyLines: string[]
}

/** The attempt, ended: its exit, its streams, and what was seen while it ran. */
export interface Ended {
  exitCode: number
  stdout: string
  stderr: string
  ranMs: number
  /** Linux: the tree's use, looked at while it ran (`watchTree`). */
  looked: TreeUsage | undefined
  /** Something of the group outlived the command. */
  left: boolean
  /** The run's stop landed after the command exited (`RunResult.exitedBeforeStop`). */
  exitedBeforeStop: boolean
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
    observerSaid: undefined,
    mountGone: false,
    gitNoRepo: false,
    readOnlyLines: [],
  }
  const outTail = new Tail()
  const errTail = new Tail()
  const [out, err] = pipes.streams(proc)
  const ends = lineEnds(args.onStdout, args.onStderr)
  const taken: StreamTally = { chars: 0 }
  const streams = Promise.all([
    streamToString(
      out,
      (chunk) => {
        outTail.push(chunk)
        ends.onStdout?.(chunk)
      },
      ac.signal,
      args.capture?.stdout ?? true,
      taken,
    ),
    streamToString(
      err,
      (chunk) => {
        const lines = (signs.partial + chunk).split('\n')
        signs.partial = (lines.pop() ?? '').slice(0, 512)
        if (lines.some((l) => STRACE_OWN_ERROR.test(l))) signs.straceSpoke = true
        for (const l of lines) signs.observerSaid ??= OBSERVER_OWN_ERROR.exec(l)?.[1]
        if (lines.some((l) => BWRAP_MOUNT_GONE.test(l))) signs.mountGone = true
        if (lines.some((l) => GIT_NO_REPO.test(l))) signs.gitNoRepo = true
        for (const l of lines)
          if (signs.readOnlyLines.length < 64 && READ_ONLY_FS.test(l)) signs.readOnlyLines.push(l)
        errTail.push(chunk)
        ends.onStderr?.(chunk)
      },
      ac.signal,
      args.capture?.stderr ?? true,
      taken,
    ),
  ]).finally(() => pipes.close())
  // See runCommand: gate on child exit; a lingering grandchild pipe (timeout
  // OR a clean exit that backgrounds a process) can't hang the run — timeout
  // aborts at once, otherwise drainOrAbort bounds the post-exit drain.
  await proc.exited
  const stoppedAtExit = args.signal?.aborted === true
  // As runCommand: a shell killed by a signal takes its group at once.
  if (proc.signalCode !== null && !stoppedAtExit) sweepDeadShell(proc, false)
  const ranMs = Math.round(runTime() - armedAt)
  const looked = watch?.stop()
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac, taken, args.signal, () => pipes.writersLeft())
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
  const left = cut || (await groupOutlives(proc, POST_EXIT_DRAIN_MS))
  args.liveChildren?.delete(proc)
  releaseGroup(proc)
  closeSignalChannel(proc)
  releaseBridges(tag)
  const exited = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  // A timeout is a failure, whatever the child said: one that traps the
  // TERM and exits 0 reported success to every executor built on this.
  const exitCode = exited === 0 && timeout.timedOut() ? signalExitCode('SIGTERM') : exited
  const exitedBeforeStop = !stoppedAtExit && (args.signal?.aborted ?? false)
  return {
    exitCode,
    stdout,
    stderr,
    ranMs,
    looked,
    left,
    exitedBeforeStop,
    timeout,
    signs,
    outTail,
    errTail,
  }
}

/** Every denial the attempt recorded, and those of them its config reports. */
export interface Denials {
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
  const trace =
    process.platform === 'linux' && straceLog
      ? await Bun.file(straceLog)
          .text()
          .catch(() => '')
      : ''
  const linuxViolations: SandboxViolation[] =
    process.platform === 'linux'
      ? [
          ...(trace.length > 0
            ? await parseStraceViolations(
                { text: trace },
                args,
                baselines,
                prepared.readJudged,
              ).catch(() => [])
            : []),
          ...refusedWrites(
            // Keyed by what SRT wrapped, the in-sandbox group wrapper
            // included, not by the tagged command macOS is keyed by. Under
            // vx's observer the writes are in the trace, not the store.
            prepared.wrap.observed
              ? observedWrites(trace, {
                  writable: (await loadSrt()).getDefaultWritePaths(),
                  within: args.cwd,
                })
              : records.map((v) => v.line),
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
  let takeRecords: ReturnType<typeof collectRecords>
  let ended!: Ended
  let started: ReturnType<typeof spawnAttempt>
  try {
    takeRecords = collectRecords(
      SandboxManager.getSandboxViolationStore(),
      srtCommand,
      observerSocket(wrapped),
    )
    started = spawnAttempt(args, prepared.wrap, takeRecords, SandboxManager, start)
    if (!('result' in started)) ended = await awaitAttempt(args, started.spawned, tag)
  } catch (err) {
    try {
      prepared.wrap.unstage?.()
    } catch {
      // The attempt's own failure is the one to say.
    }
    throw err
  }
  let unstaged: unknown
  try {
    prepared.wrap.unstage?.()
  } catch (err) {
    unstaged = err
  }
  if ('result' in started) {
    if (unstaged !== undefined) throw unstaged
    return started.result
  }
  const { proc, straceLog } = started.spawned
  // A restore that failed fails the task, after what the attempt holds is
  // let go: thrown from the cleanup above, the trace log stayed on disk
  // until vx exited and the command's records and mount points stayed
  // held (a watch session gathered one of each per failure, 2026-11-23).
  if (unstaged !== undefined) {
    await takeRecords(false)
    if (straceLog) {
      await unlink(straceLog).catch(() => undefined)
      liveTempFiles.delete(straceLog)
    }
    afterCommand(SandboxManager)
    throw unstaged
  }
  // Linux: the write observer's records arrive over a socket, not with the
  // exit; `takeRecords(true)` waits until all it sent are read.
  const denials = await attemptDenials(args, prepared, await takeRecords(true), straceLog)
  addHints(args, ended, denials, baselines)
  afterCommand(SandboxManager)
  const { exitCode, timeout, looked, signs } = ended
  const { observed } = prepared.wrap
  const observerSaid =
    observed && exitCode === OBSERVER_FAILED
      ? (signs.observerSaid ?? OBSERVER_OWN_ERROR.exec(signs.partial)?.[1])
      : undefined
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
    ...(ended.exitedBeforeStop ? { exitedBeforeStop: true as const } : {}),
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
      (observed
        ? observerSaid === OBSERVER_CUT_SHORT
        : signs.straceSpoke || STRACE_OWN_ERROR.test(signs.partial)),
    ...(observerSaid === undefined || OBSERVER_LOST.test(observerSaid)
      ? {}
      : observerSaid === OBSERVER_CUT_SHORT
        ? { observerCut: true as const }
        : { observerRefused: observerSaid }),
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
