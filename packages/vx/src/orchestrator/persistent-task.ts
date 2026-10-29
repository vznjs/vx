// A persistent task (a dev server, a watcher): keyed like an uncached task,
// spawned, and held until `readyWhen` matches. Never cached and never routed
// through an executor. Moved out of execute-task.ts as pure code motion.

import type { ExecConfig } from '../config.js'
import {
  PersistentReadyError,
  releaseBridges,
  runPersistent,
  signalExitCode,
  withForwardArgs,
  wrapSandboxedCommand,
} from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { maskedEmitter, secretMask, testTimerMs } from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { ExecuteArgs } from './execute-task.js'
import {
  commandWriteReach,
  mayWriteFingerprint,
  type Placeholder,
  placeholderSweeper,
  sandboxRequestFor,
  sweepPlaceholders,
  undeclaredWriteReach,
  untouchedPlaceholderLine,
} from './sandbox-request.js'
import { forwardedSignal, terminateChildren } from './signals.js'
import { computeTaskHash } from './task-hash.js'
import { forgetUndeclaredWrites, isAborted, taskEnv, taskTimeoutMs } from './task-process.js'

/** How long a server may take to match `readyWhen` before vx says it waits. */
const READY_NOTICE_MS = 10_000

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
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  const env = taskEnv(node, step, args.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs
  // Keyed on its inputs like any task, so a cached dependant behind a dev
  // server re-runs when the server's sources change; with none it has no
  // key and the dependant always runs (A-17).
  const hash =
    args.noDependants === true
      ? undefined
      : (args.upfrontKey ??
        (await computeTaskHash({
          node,
          upstream: args.upstream,
          workspaceRoot: args.workspaceRoot,
          cache: args.cache,
          forwardArgs: args.forwardArgs,
          nestedProjectDirs: args.nestedProjectDirs,
          ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
          ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        })))

  // Every dependant starts it where it runs (`ServerSpec`): nothing to spawn
  // here, and nothing that ran (2026-10-22: nothing runs on a
  // distributed run's orchestrator).
  if (args.carried === true)
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      carried: true,
      ...(hash === undefined ? {} : { hash }),
      wallclockStartNs,
      wallclockEndNs: wallclockStartNs,
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
  // same trap and the same answer as a one-shot task's (sandbox-request.ts).
  let placeholders: Placeholder[] = []
  if (step.sandbox !== undefined) {
    await args.armSandbox?.()
    // A persistent task never declares `cache` (the loader refuses it), so
    // it keeps the whole linked grant: no key of its can be stale.
    const sb = await sandboxRequestFor(
      node,
      step.sandbox,
      args.workspaceRoot,
      undefined,
      args.nestedProjectDirs,
      args.cacheDir,
    )
    placeholders = sb.placeholders
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
  const serverOut = serverSecrets && maskedEmitter(serverSecrets, (t) => log.taskStdout(node, t))
  const serverErr = serverSecrets && maskedEmitter(serverSecrets, (t) => log.taskStderr(node, t))
  // A server writes until the run stops it: its window stays open.
  args.commandWindows?.open(node.id, node.projectDir, commandWriteReach(node, args.workspaceRoot))
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command,
    cwd: node.projectDir,
    env,
    onStdout: serverOut ? (chunk) => serverOut.push(chunk) : (chunk) => log.taskStdout(node, chunk),
    onStderr: serverErr ? (chunk) => serverErr.push(chunk) : (chunk) => log.taskStderr(node, chunk),
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
    ...(args.track !== undefined
      ? { onSpawn: (pid: number) => void args.track!(node.id, pid) }
      : {}),
    ...(signalChannel ? { signalChannel } : {}),
    ...(args.terminal === true ? { terminal: true } : {}),
  }
  if (step.persistent.readyWhen !== undefined) {
    persistentOpts.readyWhen = step.persistent.readyWhen
  }
  // For a persistent task the timeout bounds the readiness wait. Per-task
  // `exec.timeout` wins; else the run-level default (env/workspace/--timeout).
  const effectiveTimeout = taskTimeoutMs(step) ?? args.timeout
  if (effectiveTimeout !== undefined) {
    persistentOpts.timeoutMs = effectiveTimeout
  }

  // A stop that landed during the awaits above (the key, the sandbox's
  // arming, request and wrap) leaves nothing to kill yet: spawned now, the
  // server came up after the teardown and held the run's exit 7 s.
  if (args.stopSignal?.aborted === true) {
    if (bridgeTag !== undefined) releaseBridges(bridgeTag)
    await placeholderSweeper(placeholders)()
    return {
      node,
      status: 'aborted',
      // The signal a spawned server would have been sent (a hang-up forwards SIGTERM).
      exitCode: signalExitCode(forwardedSignal(args.stopSignal.reason)),
      durationMs: 0,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
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
          if (isAborted(args.stopSignal)) return
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
    if (err instanceof PersistentReadyError && err.reason === 'exited')
      await terminateChildren(() => [spawn.child])
    // What the masked streams hold back (a tail that could begin a secret)
    // belongs above vx's own line: left to the idle flush, it came after it.
    serverOut?.end()
    serverErr?.end()
    // A server the run's stop killed while it started is aborted, as any
    // task the stop kills (item 962): it read `failed (never ready:
    // exited, exit 130)` with a recap after every Ctrl-C (C-62). The stop
    // aborts before it kills, so it is set by the time the child is gone.
    // Read through a call: the early return above narrows `aborted` to
    // false, but the stop can land during `spawn.ready`.
    if (isAborted(args.stopSignal)) {
      return {
        node,
        status: 'aborted',
        exitCode: err instanceof PersistentReadyError ? (err.exitCode ?? 1) : 1,
        durationMs: spawn.readyMs(),
        wallclockStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    // The task's OWN stream, not the process's: the frame is where a
    // reader looks for why a task failed, and a run with a custom logger
    // (an embedder) never saw a bare stderr write at all.
    log.taskStderr(node, `\n[vx] ${node.id}: persistent task failed to become ready: ${message}\n`)
    // A server is never traced, so the sandbox's refusals reach no report:
    // a dev server that died on a file outside its grants read only as the
    // tool's own "not found" (2026-10-03). Said for a sandboxed server that
    // exited failing, which is the shape a refusal takes.
    if (
      step.sandbox !== undefined &&
      err instanceof PersistentReadyError &&
      err.reason === 'exited' &&
      err.exitCode !== 0
    ) {
      log.taskStderr(
        node,
        `[vx] ${node.id} ran in the sandbox, which reports nothing for a server: a path outside ` +
          `its grants reads as missing (ENOENT), a refused write as read-only (EROFS). Check ` +
          `exec.sandbox.allow, or run the command as a one-shot sandboxed task to see what it was refused.\n`,
      )
    }
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
        ready?.reason === 'timeout'
          ? (await spawn.child.exited) || signalExitCode('SIGTERM')
          : (ready?.exitCode ?? 1),
      durationMs: spawn.readyMs(),
      ...(ready !== undefined ? { notReady: ready.reason } : {}),
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  // Ready only once the stop had landed: a trap that prints the marker on
  // the way down, or a race with the signal. The stop is killing it (it
  // is in `liveChildren`), and it served nobody, as a one-shot that exits
  // 0 on the stop is aborted (item 962).
  if (isAborted(args.stopSignal)) {
    return {
      node,
      status: 'aborted',
      exitCode: signalExitCode(forwardedSignal(args.stopSignal!.reason)),
      durationMs: spawn.readyMs(),
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }
  args.persistentRegistry?.set(node.id, spawn.child)
  forgetUndeclaredWrites(args, undeclaredWriteReach(node, args.workspaceRoot))
  if (mayWriteFingerprint(node, args.workspaceRoot, args.fingerprintWatch?.names ?? [])) {
    args.fingerprintWatch?.wrote()
  }
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
    ...(hash !== undefined ? { hash } : {}),
    wallclockStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}
