// One attempt of a miss: clean, build the request, execute, and classify the
// exit (a sandbox violation on a 0 exit fails it; a timeout is said and
// fails it; the shell's 126/127/128+n get their verdict line). Shared by
// every attempt of the retry loop, so they never drift on that path.

import { existsSync } from 'node:fs'
import {
  assertExecuteResult,
  type ExecuteRequest,
  type ExecuteResult,
  isExecutorFallback,
  maskCaptured,
  type SandboxViolation,
  signalExitCode,
} from '../exec/index.js'
import { keyedOutsideGrants, sandboxReads } from '../sandbox/index.js'
import { isLocalExecutor, localExecutor } from './local-executor.js'
import { relPosix, span, UserError } from '../util/index.js'
import { warnOf } from '../report/index.js'
import { outputsStep } from './attempt-outputs.js'
import { buildRequest } from './attempt-request.js'
import type { MissRun, PriorAttempt } from './miss-run.js'
import { executorLabel, nameExecutorFailure } from './plugin-host.js'
import { lockedDirGone } from './projects.js'
import {
  commandWriteReach,
  reachedWithheld,
  sweepPlaceholders,
  untouchedPlaceholderLine,
  withheldLinkLine,
} from '../sandbox/index.js'
import { sandboxFix } from '../sandbox/index.js'
import { shellVerdict } from './shell-verdict.js'
import { taskBinDirs } from './task-process.js'

export interface AttemptResult {
  readonly result: ExecuteResult
  readonly exitCode: number
  /** A retry fail-fast withdrew: `result` is the attempt before it, which stands. */
  readonly withdrawn?: true
  /** Fail-fast withdrew the first attempt before its executor began it. */
  readonly unbegun?: true
}

export async function runAttempt(
  m: MissRun,
  prior: PriorAttempt | undefined,
  spentMs: number,
): Promise<AttemptResult> {
  const { args, policy, stream, secrets, signal, sandbox } = m
  const { node, log } = args
  const cfg = node.config
  const described = m.inputs.described
  // Its throw (a name vx cannot clear) fails the task before this attempt's
  // command: no exit of its own to name.
  await outputsStep('clean', m.attempt > 1 ? prior!.exitCode : 1, spentMs, () =>
    m.guard.prepare(m.attempt),
  )
  // What the attempt before this one left, put back if this one is
  // withdrawn: it stands, with its output and its refusals.
  const standing = { stream: stream.snapshot(), violations: sandbox.violations }
  const withdrawn = (): AttemptResult => {
    stream.restore(standing.stream)
    sandbox.violations = standing.violations
    return { result: prior!.result, exitCode: prior!.exitCode, withdrawn: true }
  }
  sandbox.violations = []
  const endReq = span('miss: build request')
  const req = await buildRequest(m, isLocalExecutor(args.executor))
  endReq()
  // A sibling's failure under --continue=never can land while a retry
  // cleans or builds its request, after the loop's own check: the retry is
  // withdrawn and the attempt before it stands.
  if (m.attempt > 1 && args.run.failFast?.aborted === true) {
    const back = withdrawn()
    signal.settle()
    await sweepPlaceholders(sandbox.placeholders)
    return back
  }
  // An executor that THROWS produces no captured output. Rethrown: the
  // scheduler classifies it and prints its one line into the task's own
  // stream (run()'s onError), where the frame reads it.
  const endExec = span('miss: execute')
  // A plugin's execute may throw before returning or return a bare result:
  // the throw is its rejection, the value its resolution, so both reach the
  // naming catch and the cleanup in finally below.
  let running: Promise<unknown>
  // A file the key holds outside the project that no grant reaches is not
  // there inside the sandbox, so the run cannot see what its key says (a
  // build that falls back on a hidden root `tsconfig.base.json` emits other
  // code). Known from the request, so the command is never spawned: a
  // stat-first tool leaves no record, and a read past the wall is no
  // violation. One in the project is a violation when opened, and a key may
  // hold one the task never reads.
  const unseen =
    req.sandbox !== undefined &&
    described !== undefined &&
    (cfg.inputs?.workspaceFiles?.length ?? 0) > 0
      ? keyedOutsideGrants(
          req.sandbox,
          args.run.workspaceRoot,
          outsideProject(described.inputs.files, relPosix(args.run.workspaceRoot, node.projectDir)),
        )
      : []
  const closeWindow =
    unseen.length > 0
      ? () => {}
      : (args.run.commandWindows?.open(
          node.id,
          node.projectDir,
          commandWriteReach(node, args.run.workspaceRoot),
        ) ?? (() => {}))
  if (unseen.length === 0) args.run.executing?.(node.id)
  try {
    running = Promise.resolve(
      unseen.length > 0
        ? unseenResult(unseen, node.projectDir, args.run.workspaceRoot)
        : args.executor.execute(req),
    )
  } catch (thrown) {
    running = Promise.reject(thrown)
  }
  if (args.run.failFast?.aborted === true) signal.withdraw()
  let res = await signal
    .bound(running, req.signal, (line) => log.taskStderr(node, `${stream.nl()}${line}`))
    .then((r: unknown) => {
      assertExecuteResult(args.executor.name, node.id, r)
      return r
    })
    .catch(async (thrown: unknown) => {
      let raw = thrown
      // A remote that gives the task back (it never started it): run it on
      // the local floor with a request of its own, so its timeout counts
      // from now. `remote: 'only'` keeps it off this machine: refused.
      if (isExecutorFallback(raw) && args.executor.remote === true) {
        const why = secrets.text(raw.message)
        if (policy.remoteOnly) {
          raw = new UserError(`${why}, and remote: 'only' keeps it off this machine`)
        } else if (args.executor.exclusive === true) {
          raw = new UserError(`${why}, and ${args.executor.name} runs no task on this machine`)
        } else {
          warnOf(log)(
            `[vx] ${node.id}: ${executorLabel(args.executor)} gave it back: ${why} — running it here`,
          )
          const local = await localExecutor().execute(await buildRequest(m, true))
          assertExecuteResult('local', node.id, local)
          return local
        }
      }
      const err = nameExecutorFailure(args.executor, raw)
      // A remote executor's message carries the server's own text, which may
      // echo the env it was sent: masked on the error the scheduler prints
      // with its cause.
      if (secrets.mask !== null) {
        for (const e of [err, err instanceof Error ? err.cause : undefined])
          if (e instanceof Error) e.message = secrets.mask.mask(e.message)
      }
      await sweepPlaceholders(sandbox.placeholders)
      throw err
    })
    .finally(() => {
      closeWindow()
      signal.settle()
      stream.flushMasked()
      m.load.seen = m.load.untrack?.() ?? m.load.seen
      m.load.untrack = undefined
    })
    .catch((thrown: unknown) => {
      // The scheduler prints the throw's line into the task's stream, after
      // the masked tail the finally above flushed.
      if (stream.midLine) log.taskStderr(node, '\n')
      throw thrown
    })
  endExec()
  // A locked directory moved away after `vx lock`: the spawn's "working
  // directory does not exist" named no way out. Asked only here.
  if (res.spawnFailed === true && !existsSync(node.projectDir)) {
    await sweepPlaceholders(sandbox.placeholders)
    throw new UserError(
      lockedDirGone(args.run.workspaceRoot, node.projectName, node.projectDir),
      'VX_E_LOCK',
    )
  }
  if (signal.unbegun) {
    await sweepPlaceholders(sandbox.placeholders)
    if (m.attempt === 1) return { result: res, exitCode: res.exitCode, unbegun: true }
    // A retry withdrawn: the attempt before it stands, as above.
    return withdrawn()
  }
  if (secrets.mask !== null)
    res = {
      ...res,
      stdout: maskCaptured(res.stdout, secrets.mask),
      stderr: maskCaptured(res.stderr, secrets.mask),
    }
  // An executor that stopped on the timeout's abort timed out, whatever its
  // exit: a child that traps the TERM and exits 0 left partial outputs a
  // pass would save, as the local runner's own `timedOut` says. A local
  // request carries no timer, so the runner alone decides there.
  if (signal.timeoutFired && res.timedOut !== true) res = { ...res, timedOut: true }
  return { result: res, exitCode: await classifyExit(m, res, req.sandbox) }
}

/**
 * The attempt's exit as vx counts it, with its refusals and vx's own lines
 * said: a sandboxed task that tripped fails, so does one that timed out
 * (even a child that trapped the SIGTERM and exited 0), and the shell's
 * own codes get their verdict.
 */
async function classifyExit(
  m: MissRun,
  res: ExecuteResult,
  sandbox: ExecuteRequest['sandbox'],
): Promise<number> {
  const { args, policy, stream, secrets } = m
  const { node, log } = args
  const violations = (m.sandbox.violations = [...res.violations])
  // A denial under a dependency the key does not answer for says only
  // ENOENT; the line beside it names the package and how to key it. Only
  // with a denial there, so it never reddens a pass.
  for (const w of reachedWithheld(m.sandbox.withheld, violations)) {
    violations.push({
      timestamp: new Date(),
      hint: true,
      line: withheldLinkLine(node.id, w, args.run.projectAt?.(w.target)),
    })
  }
  // A placeholder the task never wrote is not its output: take it back
  // before the outputs are collected. On a failure it is also the one clue
  // to a grant that meant a directory: say so beside the failure.
  const untouched = await sweepPlaceholders(m.sandbox.placeholders)
  if (res.exitCode !== 0 && violations.length === 0) {
    for (const p of untouched) {
      violations.push({
        timestamp: new Date(),
        hint: true,
        line: untouchedPlaceholderLine(node.projectDir, p),
      })
    }
  }
  let code = res.exitCode
  // ANY violation fails a sandboxed task, on both platforms. A sandboxed
  // task declares what it touches; a denial means it touched something
  // else, and an artifact built while reading (or failing to read)
  // something the key never folded is not a safe thing to replay. A task
  // that survives the denial is the dangerous case: the run that succeeds
  // and caches a wrong result.
  if (policy.sandboxed && violations.some((v) => v.hint !== true) && code === 0) code = 1
  // A child SIGTERMed for exceeding the timeout is a genuine failure: a line
  // says so. One that outlived the grace died of the SIGKILL, and the line
  // names that.
  if (res.timedOut) {
    // A plugin executor's child is its own: core only aborted its request,
    // or, on the executor's own clock, aborted nothing.
    const how = !isLocalExecutor(args.executor)
      ? m.signal.timeoutFired
        ? 'its executor was aborted'
        : 'as its executor reported'
      : res.signal === 'SIGKILL' || res.killedAfterGrace === true
        ? 'killed (SIGKILL after the SIGTERM grace)'
        : 'killed (SIGTERM)'
    const after = policy.timeout === undefined ? '' : ` after ${policy.timeout}ms`
    log.taskStderr(node, `${stream.nl()}[vx] timed out${after} — ${how}\n`)
    // Non-zero even if the child TRAPPED SIGTERM and exited 0 (`trap 'exit
    // 0' TERM`): classified a success, its PARTIAL outputs were cached and
    // replayed forever. A genuinely killed child already reports 143.
    if (code === 0) code = signalExitCode('SIGTERM')
  }
  // The shell's 127 and 126 name the word and nothing about why (the PATH
  // vx built, or a `#!` line the file carries), and an exit above 128 is a
  // signal's number and nothing about what sent it. One frame line names
  // the rule. A spawn that threw ran no shell: its 127 is vx's. A run's
  // stop killed it itself. A SIGINT/SIGTERM death waits a turn for a
  // pending handler first, as the shutdown check does: a Ctrl-C reaches the
  // child and vx together.
  if (
    !res.timedOut &&
    (res.signal === 'SIGINT' || res.signal === 'SIGTERM') &&
    args.run.stopSignal?.aborted !== true
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  if (!res.timedOut && res.spawnFailed !== true && args.run.stopSignal?.aborted !== true) {
    const verdict = shellVerdict({
      code,
      command: policy.exec.command,
      cwd: node.projectDir,
      bins: taskBinDirs(node, args.run.workspaceRoot),
      signal: res.signal,
      hidden: sandbox && ((f: string) => !sandboxReads(sandbox, f)),
      stderr: stream.errTail,
    })
    // The line quotes the command's first word, which a config may have
    // built from a secret: masked as the task's own output is.
    if (verdict !== undefined) log.taskStderr(node, `${stream.nl()}${secrets.text(verdict)}\n`)
  }
  return code
}

/** The workspace-relative paths of `files` outside project `project` (workspace-relative). */
function outsideProject(files: readonly { readonly path: string }[], project: string): string[] {
  if (project === '') return []
  const under = `${project}/`
  return files.flatMap((f) => (f.path === project || f.path.startsWith(under) ? [] : [f.path]))
}

/**
 * The result of a task not run because the sandbox hides files its key
 * holds (`keyedOutsideGrants`): one read violation per file, which
 * `sandboxFix` turns into its grant, and the line that says why.
 */
function unseenResult(
  unseen: readonly string[],
  projectDir: string,
  workspaceRoot: string,
): ExecuteResult {
  const timestamp = new Date()
  const denied: SandboxViolation[] = unseen.map((p) => ({
    line: `vx: hidden by the sandbox, held by the key: ${p}`,
    timestamp,
    target: p,
    path: p,
    ignorable: ['read'],
  }))
  const shown = unseen.slice(0, 5).join(', ')
  const more = unseen.length > 5 ? ` and ${unseen.length - 5} more` : ''
  const grants = (sandboxFix(denied, projectDir, workspaceRoot)?.read ?? []).map((g) =>
    g.includes("'") ? JSON.stringify(g) : `'${g.replaceAll('\\', '\\\\')}'`,
  )
  const said = `vx: the sandbox hides a file this task's key holds, so it was not run: ${shown}${more}.`
  // A credential store is walled on purpose and never suggested (sandbox/fix.ts).
  const line =
    grants.length === 0
      ? `${said} It is walled on purpose, so vx suggests no grant for it.`
      : `${said} Grant it, e.g. \`allow: { read: [${grants.join(', ')}] }\`.`
  return {
    exitCode: 0,
    durationMs: 0,
    stdout: '',
    stderr: '',
    violations: [...denied, { timestamp, hint: true, line }],
  }
}
