// A persistent task (a dev server, a watcher): keyed like an uncached task,
// spawned, and held until `readyWhen` matches. Never cached and never routed
// through an executor. Moved out of execute-task.ts as pure code motion.

import type { ExecConfig } from '../config.js'
import {
  lineEnds,
  PersistentReadyError,
  runPersistent,
  signalExitCode,
  withForwardArgs,
} from '../exec/index.js'
import { releaseBridges, sandboxReads, wrapSandboxedCommand } from '../sandbox/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { maskedStreams, secretMask, testTimerMs } from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { ExecuteArgs } from './execute-task.js'
import {
  commandWriteReach,
  dependencyReads,
  mayWriteFingerprint,
  type Placeholder,
  placeholderSweeper,
  sandboxRequestFor,
  sweepPlaceholders,
  undeclaredWriteReach,
  untouchedPlaceholderLine,
} from '../sandbox/index.js'
import { explainServerExit } from './persistent.js'
import { shellVerdict } from './shell-verdict.js'
import { forwardedSignal, terminateChildren } from './signals.js'
import { computeTaskHash, keyOf } from './task-hash.js'
import {
  forgetUndeclaredWrites,
  isAborted,
  taskBinDirs,
  taskEnv,
  taskTimeoutMs,
} from './task-process.js'

/** How long a server may take to match `readyWhen` before vx says it waits. */
const READY_NOTICE_MS = 10_000

/**
 * A server is keyed on its inputs like any task, so a cached dependant
 * behind a dev server re-runs when the server's sources change; with none
 * it has no key and the dependant always runs (A-17). A server the watch
 * loop keeps up is keyed too: its dependant folds the key either way.
 */
export function serverKey(args: ExecuteArgs): Promise<string | undefined> | string | undefined {
  if (args.noDependants === true) return undefined
  return (
    args.upfrontKey ??
    keyOf(
      computeTaskHash({
        node: args.node,
        upstream: args.upstream,
        workspaceRoot: args.run.workspaceRoot,
        cache: args.run.cache,
        forwardArgs: args.run.forwardArgs,
        nestedProjectDirs: args.nestedProjectDirs,
        ...(args.run.gitFilesCache !== undefined ? { gitFilesCache: args.run.gitFilesCache } : {}),
        ...(args.run.hashCache !== undefined ? { hashCache: args.run.hashCache } : {}),
      }),
    )
  )
}

/**
 * Persistent task: dev server / file watcher / daemon. Spawn, wait
 * for ready (regex match or immediate), stash the subprocess in the
 * orchestrator-owned registry, return success. The orchestrator
 * SIGTERMs the registry at end-of-run.
 *
 * Never reads or writes the cache — the project loader rejects
 * `cache + persistent` at config-load time, so by the time we get
 * here, `cache` is guaranteed undefined.
 *
 * Never routed through an executor: a persistent task is local by
 * construction (its port lives on this machine).
 */
export async function executePersistentTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, log } = args
  // Type narrowing: the dispatcher checks `exec.persistent` before
  // calling us, so `exec` and `exec.persistent` are both present.
  const step = node.config.exec as ExecConfig & {
    persistent: NonNullable<ExecConfig['persistent']>
  }
  const effectiveForwardArgs = node.requested ? (args.run.forwardArgs ?? []) : []
  const env = taskEnv(node, step, args.run.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const hash = await serverKey(args)

  // Every dependant starts it where it runs (`ServerSpec`): nothing to spawn
  // here, and nothing that ran (2026-10-22: nothing runs on a
  // distributed run's orchestrator).
  if (args.carried === true)
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      placement: { carried: true },
      ...(hash === undefined ? {} : { hash }),
      timing: { startNs: wallclockStartNs, endNs: wallclockStartNs },
    }

  // The args after `--` reach a server as they reach any task. A readyWhen
  // server once got none — "so the matcher sees the unmodified output",
  // though the args change the command, not what the matcher reads — and
  // `vx run dev -- --port 4000` on the documented Vite task dropped the
  // port in silence (item 1060).
  const plainCommand = withForwardArgs(step.command, effectiveForwardArgs)
  // A persistent task declaring `exec.sandbox` runs inside it like any
  // other: the same grants, the same walls. What it cannot have is the
  // violation REPORT — that reads the trace after the child exits, and a
  // server exits when the run tears it down. Enforced, not reported.
  // (Until 2026-09-09 the block was accepted and silently ignored.)
  let command = plainCommand
  let bridgeTag: string | undefined
  let signalChannel = false
  // The empty files the request pre-created for a literal write grant; a
  // server that never writes one gets it taken back when it exits, and a
  // server that dies before readiness is told the directory spelling — the
  // same trap and the same answer as a one-shot task's (sandbox/request.ts).
  let placeholders: Placeholder[] = []
  let serverSandbox: Awaited<ReturnType<typeof sandboxRequestFor>>['sandbox'] | undefined
  if (step.sandbox !== undefined) {
    await args.run.armSandbox?.()
    // A persistent task never declares `cache` (the loader refuses it), so
    // it keeps the whole linked grant: no key of its can be stale.
    const deps = await dependencyReads(args.run.readableDeps?.(node) ?? [], args.run.workspaceRoot)
    const sb = await sandboxRequestFor(
      node,
      step.sandbox,
      args.run.workspaceRoot,
      undefined,
      args.nestedProjectDirs,
      args.run.cacheDir,
      deps.reads,
      deps.reported,
    )
    placeholders = sb.placeholders
    serverSandbox = sb.sandbox
    // A wrap that refuses (a port the host holds) leaves the server unspawned
    // and the placeholders vx made for it in the project for every later run.
    const wrapped = await wrapSandboxedCommand({
      command: plainCommand,
      cwd: node.projectDir,
      env,
      ...sb.sandbox,
      server: true,
    }).catch(async (err: unknown) => {
      await sweepPlaceholders(placeholders)
      throw err
    })
    command = wrapped.wrapped
    bridgeTag = wrapped.tag
    signalChannel = wrapped.forwardsSignals
  }
  // A server's output masked as a one-shot task's is (L-11); `readyWhen`
  // is matched on the raw chunks, before this. Its held tail is flushed by
  // the idle timer: a server never ends on the way to a flush.
  const serverSecrets = secretMask([process.env, env, step.env?.define], step.env?.secret)
  // A server writes until the run stops it: its window stays open.
  args.run.commandWindows?.open(
    node.id,
    node.projectDir,
    commandWriteReach(node, args.run.workspaceRoot),
  )
  // Whether the server's output ends mid-line, for vx's never-ready note.
  const ends = lineEnds(
    (t) => log.taskStdout(node, t),
    (t) => log.taskStderr(node, t),
  )
  // Masked as one: a stream's held tail goes out before the other's next chunk.
  const serverMasked = serverSecrets && maskedStreams(serverSecrets, ends.onStdout!, ends.onStderr!)
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command,
    cwd: node.projectDir,
    env,
    onStdout: serverMasked ? serverMasked.out : ends.onStdout!,
    onStderr: serverMasked ? serverMasked.err : ends.onStderr!,
    ...(args.run.liveChildren !== undefined ? { liveChildren: args.run.liveChildren } : {}),
    ...(args.run.track !== undefined
      ? { onSpawn: (pid: number) => void args.run.track!(node.id, pid) }
      : {}),
    ...(signalChannel ? { signalChannel } : {}),
    ...(args.terminal === true ? { terminal: true } : {}),
    // What the pre-ready text left held goes out first, so the run can
    // tell it from what the server writes since ready.
    ...(args.run.serverReady !== undefined
      ? {
          onReady: () => {
            serverMasked?.end()
            ends.end()
            args.run.serverReady!(node.id)
          },
        }
      : {}),
  }
  if (step.persistent.readyWhen !== undefined) {
    persistentOpts.readyWhen = step.persistent.readyWhen
  }
  // For a persistent task the timeout bounds the readiness wait. Per-task
  // `exec.timeout` wins; else the run-level default (env/workspace/--timeout).
  const effectiveTimeout = taskTimeoutMs(step) ?? args.run.timeout
  if (effectiveTimeout !== undefined) {
    persistentOpts.timeoutMs = effectiveTimeout
  }

  // A stop that landed during the awaits above (the key, the sandbox's
  // arming, request and wrap) leaves nothing to kill yet: spawned now, the
  // server came up after the teardown and held the run's exit 7 s.
  if (args.run.stopSignal?.aborted === true) {
    if (bridgeTag !== undefined) releaseBridges(bridgeTag)
    await placeholderSweeper(placeholders)()
    return {
      node,
      status: 'aborted',
      // The signal a spawned server would have been sent (a hang-up forwards SIGTERM).
      exitCode: signalExitCode(forwardedSignal(args.run.stopSignal.reason)),
      durationMs: 0,
      timing: {
        startNs: wallclockStartNs,
        endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
      },
    }
  }
  // A server's 127, 126 or signal death needs the line a one-shot task's
  // gets (execute-task.ts): a dev server whose tool sits in a sibling's
  // bin said only "exit 127". Before ready or after it: `persistent: {}` is
  // ready at its spawn, so its "not found" came after.
  // A server is never traced, so the sandbox's refusals reach no report:
  // a dev server that died on a file outside its grants read only as the
  // tool's own "not found" (2026-10-03). Said for a sandboxed server that
  // exited failing, which is the shape a refusal takes.
  const exitNotes = (code: number | undefined, signal: string | number | undefined): string[] => {
    const lines: string[] = []
    const verdict =
      code === undefined
        ? undefined
        : shellVerdict({
            code,
            command: step.command,
            cwd: node.projectDir,
            bins: taskBinDirs(node, args.run.workspaceRoot),
            signal,
            hidden: serverSandbox && ((f: string) => !sandboxReads(serverSandbox, f)),
          })
    if (verdict !== undefined) lines.push(serverSecrets?.mask(verdict) ?? verdict)
    if (step.sandbox !== undefined && code !== 0) {
      lines.push(
        `[vx] ${node.id} ran in the sandbox, which reports nothing for a server: a path outside ` +
          `its grants reads as missing (ENOENT), a refused write as read-only (EROFS). Check ` +
          `exec.sandbox.allow, or run the command as a one-shot sandboxed task to see what it was refused.`,
      )
    }
    return lines
  }
  const spawn = runPersistent(persistentOpts)
  // The host side of a port bridge lives exactly as long as the server:
  // released on the child's exit, whether the run tore it down or it died.
  // A placeholder the server never wrote goes back the same way.
  // ONE sweep, shared by the exit handler and the readiness failure below
  // — whichever asks second must get the SAME list. A second sweep cannot
  // produce it: the first one's `rm` already happened, so the file is gone
  // and `sweepPlaceholders` skips it. Collecting both lists and unioning
  // them does not close that, because the union only covers an exit
  // handler that FINISHED; one still between its `rm` and its return has
  // published nothing yet, and the readiness path then reports no
  // placeholder at all. The failure then says only "File exists", which is
  // the message the hint exists to explain (seen under the gate's parallel
  // load, and reproduced deterministically by delaying each side, item 450).
  const sweptUntouched = placeholderSweeper(placeholders)
  if (bridgeTag !== undefined || placeholders.length > 0) {
    const tag = bridgeTag
    const onExit = async (): Promise<void> => {
      if (tag !== undefined) releaseBridges(tag)
      await sweptUntouched()
    }
    // A spawn that failed has no child to wait on: release now, or the
    // tag would hold the sandbox's reset for the rest of the process.
    if (spawn.child === undefined) void onExit()
    else void spawn.child.exited.then(onExit, onExit)
  }
  // Said once if readiness is slow: a dependency's output is hidden unless
  // it fails, and with no `exec.timeout` the wait never ends, so a run
  // whose `readyWhen` never matched showed nothing at all.
  const readyWhen = step.persistent.readyWhen
  // How long a server may take to match `readyWhen` before vx says it waits.
  const noticeMs = testTimerMs('READY_NOTICE', READY_NOTICE_MS)
  const notice =
    readyWhen === undefined
      ? undefined
      : setTimeout(() => {
          // A server that traps SIGTERM runs out the kill grace after the
          // timeout gave up; the wait is over, and its failure says so.
          if (isAborted(args.run.stopSignal) || spawn.gaveUp()) return
          const after = noticeMs < 1000 ? `${noticeMs} ms` : `${noticeMs / 1000} s`
          const unbounded = effectiveTimeout === undefined ? ', with no exec.timeout' : ''
          warnOf(log)(
            `vx: ${node.id} not ready after ${after}: waiting for a line matching /${serverSecrets?.mask(readyWhen) ?? readyWhen}/ (readyWhen)${unbounded}`,
          )
        }, noticeMs)
  if (notice !== undefined) {
    const quiet = (): void => clearTimeout(notice)
    void spawn.ready.then(quiet, quiet)
  }
  try {
    await spawn.ready
  } catch (err) {
    // A shell that exited before ready can leave its group running
    // (`server & …; exit`): never registered, so no teardown reached it,
    // and it held its port against the next `vx watch` cycle's server.
    if (err instanceof PersistentReadyError && err.reason === 'exited' && spawn.child !== undefined)
      await terminateChildren(() => [spawn.child!])
    // What the masked streams hold back (a tail that could begin a secret)
    // belongs above vx's own line: left to the idle flush, it came after it.
    serverMasked?.end()
    // A server the run's stop killed while it started is aborted, as any
    // task the stop kills (item 962): it read `failed (never ready:
    // exited, exit 130)` with a recap after every Ctrl-C (C-62). The stop
    // aborts before it kills, so it is set by the time the child is gone.
    // Read through a call: the early return above narrows `aborted` to
    // false, but the stop can land during `spawn.ready`.
    if (isAborted(args.run.stopSignal)) {
      return {
        node,
        status: 'aborted',
        exitCode: err instanceof PersistentReadyError ? (err.exitCode ?? 1) : 1,
        durationMs: spawn.readyMs(),
        timing: {
          startNs: wallclockStartNs,
          endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
        },
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    // The task's OWN stream, not the process's: the frame is where a
    // reader looks for why a task failed, and a run with a custom logger
    // (an embedder) never saw a bare stderr write at all. What waited on
    // an open line goes first.
    ends.end()
    log.taskStderr(node, ends.own(`[vx] ${node.id}: not ready: ${message}\n`))
    if (err instanceof PersistentReadyError && err.reason === 'exited')
      for (const line of exitNotes(err.exitCode, spawn.child?.signalCode ?? undefined))
        log.taskStderr(node, `${line}\n`)
    // The server is dead or being torn down, so the sweep on its exit may
    // already be running: ask the shared one rather than starting a second.
    for (const p of await sweptUntouched()) {
      log.taskStderr(node, `${untouchedPlaceholderLine(node.projectDir, p)}\n`)
    }
    // The reason rides the outcome (every label reads it), and a child that
    // exited before ready keeps its own exit code rather than a made-up 1.
    // One the readiness timeout is killing reports the signal's, as an
    // ordinary timeout does (X-24).
    // A readiness timeout rejects once the group is gone (runner.ts), so a
    // server that ignored the TERM holds no port into the next `vx watch`
    // cycle, and a second signal here would cut a one-shot handler short.
    const ready = err instanceof PersistentReadyError ? err : undefined
    return {
      node,
      status: 'failed',
      // A server that traps the TERM and exits 0 still timed out, as a
      // one-shot task that does so reports 143 (X-116).
      exitCode:
        ready?.reason === 'timeout' && spawn.child !== undefined
          ? (await spawn.child.exited) || signalExitCode('SIGTERM')
          : (ready?.exitCode ?? 1),
      durationMs: spawn.readyMs(),
      ...(ready !== undefined ? { notReady: ready.reason } : {}),
      timing: {
        startNs: wallclockStartNs,
        endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
      },
    }
  }

  // Ready only once the stop had landed: a trap that prints the marker on
  // the way down, or a race with the signal. The stop is killing it (it
  // is in `liveChildren`), and it served nobody, as a one-shot that exits
  // 0 on the stop is aborted (item 962).
  if (isAborted(args.run.stopSignal)) {
    return {
      node,
      status: 'aborted',
      exitCode: signalExitCode(forwardedSignal(args.run.stopSignal!.reason)),
      durationMs: spawn.readyMs(),
      timing: {
        startNs: wallclockStartNs,
        endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
      },
    }
  }
  // Ready, so it spawned: only a failed spawn has no child.
  const child = spawn.child!
  explainServerExit(child, (code) => exitNotes(code, child.signalCode ?? undefined))
  args.run.persistentRegistry?.set(node.id, child)
  forgetUndeclaredWrites(
    args.node,
    args.run.gitFilesCache,
    undeclaredWriteReach(node, args.run.workspaceRoot),
  )
  if (mayWriteFingerprint(node, args.run.workspaceRoot, args.run.fingerprintWatch?.names ?? [])) {
    args.run.fingerprintWatch?.wrote()
  }
  // Ready by its clean exit (a setup step): nothing is running any more.
  const exited = child.exitCode
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
    ...(exited === null ? {} : { serverExit: exited }),
    ...(hash !== undefined ? { hash } : {}),
    timing: {
      startNs: wallclockStartNs,
      endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
    },
  }
}
