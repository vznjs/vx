// A miss's attempts: up to `1 + retries`, one more for a known flake, none
// after the run stopped or fail-fast tripped. Each attempt cleans, builds the
// request, executes, and classifies the exit (a sandbox violation on a 0 exit
// fails it; a timeout is said and fails it; the shell's 126/127/128+n get
// their verdict line), so every attempt of the retry loop takes one path.

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
import { printable, relPosix, span, UserError } from '../util/index.js'
import { warnOf } from '../report/index.js'
import { missingOutputs, outputsStep } from './attempt-outputs.js'
import { buildRequest } from './attempt-request.js'
import { bracketLiteralHint } from './miss-save.js'
import { declareStateHint, stateLeft } from './undeclared-state.js'
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
import { shellVerdict, unpassedEnv } from './shell-verdict.js'
import { forgetUndeclaredWrites, taskBinDirs } from './task-process.js'
import type { OutcomeTiming, TaskOutcome } from '../graph/index.js'
import { failedOutputLog } from './output-log.js'
import { mayWriteFingerprint, undeclaredWriteReach } from '../sandbox/index.js'

export interface FailedAttempt {
  endedAt: number
  exitCode: number
  timedOut?: true
}

export interface Attempts {
  /** The attempt that stands: the last, or the one before a withdrawn retry. */
  readonly result: ExecuteResult
  readonly exitCode: number
  readonly attempts: number
  /** What THIS run spent on the task, every attempt. */
  readonly spentMs: number
  readonly failedAttempts: FailedAttempt[]
  /** Each failed attempt's output, beside `failedAttempts`: kept for `vx last --log`. */
  readonly attemptOutputs: string[]
  /** Any attempt's shell left a process running, not only the last one's. */
  readonly leftRunning: boolean
}

/** The attempts that ran, or the outcome when the task ends without one standing. */
export async function runAttempts(
  m: MissRun,
  wallclockStartNs: bigint,
): Promise<Attempts | { outcome: TaskOutcome }> {
  const { args, policy, hash, stream, secrets } = m
  const { node, log } = args
  // Pass or fail, the command may have written where its project's run-start
  // facts describe; a remote executor wrote on its own disk.
  const writeReach =
    args.executor.capabilities?.remote === true
      ? 'none'
      : undeclaredWriteReach(node, args.run.workspaceRoot)
  const writesFingerprint =
    args.executor.capabilities?.remote !== true &&
    mayWriteFingerprint(node, args.run.workspaceRoot, args.run.fingerprintWatch?.names ?? [])
  let maxAttempts = policy.maxAttempts
  let prior: { result: ExecuteResult; exitCode: number } | undefined
  let spentMs = 0
  let leftRunning = false
  const failedAttempts: FailedAttempt[] = []
  const attemptOutputs: string[] = []
  const timing = (): OutcomeTiming => ({
    startNs: wallclockStartNs,
    endNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
  })
  for (;;) {
    m.attempt++
    const a = await runAttempt(m, prior, spentMs)
    // Never started: skipped, as fail-fast skips a task not yet dispatched;
    // on the run's stop, not run, as the scheduler ends one it never dispatched.
    if (a.unbegun)
      return {
        outcome:
          a.unbegun === 'stop'
            ? { node, status: 'aborted', exitCode: 1, durationMs: 0, hash }
            : { node, status: 'skipped', durationMs: 0, hash, timing: timing() },
      }
    const result = a.result
    prior = { result, exitCode: a.exitCode }
    if (a.withdrawn) {
      m.attempt--
      failedAttempts.pop()
      attemptOutputs.pop()
      break
    }
    // A failed attempt's leftover may write into the retry's outputs too. It
    // is not killed, as a passing attempt's is not: only the save is
    // withheld (`nothingLeftRunning`), and its dependents' (`args.leftRunning`).
    if (result.leftRunning === true && !leftRunning) {
      leftRunning = true
      args.run.leftRunning?.(node)
    }
    forgetUndeclaredWrites(args.node, args.run.gitFilesCache, writeReach)
    if (writesFingerprint) args.run.fingerprintWatch?.wrote()
    spentMs += result.durationMs

    // An attempt that ended in a shutdown never finished on its own terms:
    // it is aborted, so it is neither cached, counted, shown, nor RETRIED.
    // The RUN stopping is what says so: a child that traps the forwarded
    // SIGINT and exits 0 was cached as a success with its partial outputs.
    // A child that died of SIGINT / SIGTERM while the run was NOT stopping
    // (a supervisor, a `kill` from another shell) is a failure. A terminal's
    // Ctrl-C reaches the child and vx together, and the child's exit can be
    // seen before vx's own handler has run, so a signal death waits one
    // event-loop turn for a pending handler before it is judged; a
    // timeout's SIGTERM is our own deadline and judged now.
    let shutdown = args.run.stopSignal?.aborted === true
    if (
      !shutdown &&
      (result.signal === 'SIGINT' || result.signal === 'SIGTERM') &&
      !result.timedOut
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      shutdown = args.run.stopSignal?.aborted === true
    }
    if (shutdown) {
      const outcome: TaskOutcome = {
        node,
        status: 'aborted',
        exitCode: a.exitCode,
        durationMs: spentMs,
        hash,
        timing: timing(),
      }
      if (result.where !== undefined) outcome.placement = { where: result.where }
      return { outcome }
    }

    // A known flake gets the one retry its config did not ask for; a
    // timeout always fails, and a task whose key names nothing (no cache
    // block, or keyed on a keyless upstream) has no record to know it by.
    if (
      a.exitCode !== 0 &&
      m.attempt === 1 &&
      !policy.retriesSet &&
      result.timedOut !== true &&
      policy.cacheable &&
      policy.keylessBy === undefined &&
      args.run.failFast?.aborted !== true &&
      args.run.knownFlaky?.(node, hash) === true
    )
      maxAttempts = 2
    if (a.exitCode === 0 || m.attempt >= maxAttempts || args.run.failFast?.aborted === true) break
    failedAttempts.push({
      endedAt: Date.now(),
      exitCode: a.exitCode,
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
    })
    // The outcome's SANDBOX VIOLATIONS section is the last attempt's: a
    // retried attempt's refusals go into its own output, kept for
    // `vx last --log`, as the section prints them.
    const refused = new Set<string>()
    let denials = 0
    for (const v of m.sandbox.violations) {
      const line = printable(secrets.text(v.line))
      if (!refused.has(line) && v.hint !== true) denials++
      refused.add(line)
    }
    if (refused.size > 0 && stream.output !== undefined) {
      const section = `${stream.nl()}${denials > 0 ? `SANDBOX VIOLATIONS (${denials})` : 'SANDBOX'}\n${[...refused].join('\n')}\n`
      stream.output.push(section, true)
      log.taskStderr(node, section)
      stream.midLine = false
    }
    attemptOutputs.push(
      stream.output === undefined
        ? ''
        : failedOutputLog(stream.output, true, secrets.mask ?? undefined),
    )
    // The shell's own exit 0 failed only on the refusal: `exit 1` named
    // nothing that happened.
    const why =
      result.timedOut === true
        ? 'a timeout'
        : result.exitCode === 0 && denials > 0
          ? `${denials} sandbox violation${denials === 1 ? '' : 's'}`
          : `exit ${a.exitCode}`
    log.taskStderr(
      node,
      `${stream.nl()}vx: retrying ${node.id} (attempt ${m.attempt + 1}/${maxAttempts}) after ${why}\n`,
    )
  }
  return {
    result: prior.result,
    exitCode: prior.exitCode,
    attempts: m.attempt,
    spentMs,
    failedAttempts,
    attemptOutputs,
    leftRunning,
  }
}

export interface AttemptResult {
  readonly result: ExecuteResult
  readonly exitCode: number
  /** A retry fail-fast withdrew: `result` is the attempt before it, which stands. */
  readonly withdrawn?: true
  /** Fail-fast or the run's stop withdrew the first attempt before its executor began it. */
  readonly unbegun?: 'stop' | 'failFast'
}

async function runAttempt(
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
    m.guard.prepare(m.attempt, described?.held),
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
  // A sibling's failure under --fail-fast can land while a retry
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
      assertExecuteResult(args.executor.name, node.id, r, req.download)
      return r
    })
    .catch(async (thrown: unknown) => {
      let raw = thrown
      // A remote that gives the task back (it never started it): run it on
      // the local floor with a request of its own, so its timeout counts
      // from now. `remote: 'only'` keeps it off this machine: refused.
      if (isExecutorFallback(raw) && args.executor.capabilities?.remote === true) {
        const why = secrets.text(raw.message)
        if (policy.remoteOnly) {
          raw = new UserError(`${why}, and remote: 'only' keeps it off this machine`)
        } else if (args.executor.capabilities?.exclusive === true) {
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
  // A retry the run's stop withdrew is a stopped task, as any attempt the
  // stop ends: aborted, not the failure before it.
  if (signal.unbegun && (m.attempt === 1 || signal.unbegunBy === 'failFast')) {
    await sweepPlaceholders(sandbox.placeholders)
    if (m.attempt === 1)
      return { result: res, exitCode: res.exitCode, unbegun: signal.unbegunBy ?? 'failFast' }
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
  m.outputsMissing = undefined
  if (code === 0 && args.run.stopSignal?.aborted !== true) {
    m.outputsMissing = outputsMissing(m, res)
    if (m.outputsMissing !== undefined) code = 1
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
    const unpassed = code === 0 ? undefined : unpassedEnv(stream.tail, m.env, process.env)
    if (unpassed !== undefined) log.taskStderr(node, `${stream.nl()}${unpassed}\n`)
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

/**
 * A pass whose declared outputs did not all land here fails, said by the
 * globs that matched nothing. Outputs that land elsewhere (a remote
 * executor, a deferred download) are that executor's to check, and it says
 * which matched nothing (`ExecuteResult.outputsMissing`). Said as a
 * warning, as the save's own output warnings are, not into the task's
 * stream: there it printed uncoloured, or red in a frame.
 */
function outputsMissing(m: MissRun, res: ExecuteResult): string[] | undefined {
  const { args, policy, secrets } = m
  const { node, log } = args
  if (policy.outputs.length + policy.wsOutputs.length === 0) return undefined
  const elsewhere =
    policy.deferred ||
    res.outputs?.kind === 'deferred' ||
    args.executor.capabilities?.remote === true
  const nested = args.outputNestedDirs ?? args.nestedProjectDirs
  const missing = elsewhere
    ? [...(res.outputsMissing ?? [])]
    : [
        ...missingOutputs(node.projectDir, policy.outputs, nested),
        ...missingOutputs(args.run.workspaceRoot, policy.wsOutputs, []),
      ]
  if (missing.length === 0) return undefined
  const cfg = node.config
  const left = elsewhere || m.state === undefined ? [] : stateLeft(m.state, node.projectDir)
  const noWrite =
    cfg.exec?.sandbox !== undefined && (cfg.exec.sandbox.allow?.write?.length ?? 0) === 0
  const line =
    `[vx] ${node.id}: outputs matched no files (${missing.join(', ')}) — the command exited 0 ` +
    `but never wrote ${missing.length === 1 ? 'it' : 'them'}, so the task fails and nothing is cached: ` +
    `write ${missing.length === 1 ? 'it' : 'them'}, or fix the pattern` +
    (noWrite
      ? ` — the task is sandboxed and declares no exec.sandbox.allow.write, so its writes never reached disk`
      : '') +
    (left.length > 0
      ? ` — ${left.map(printable).join(', ')} survived the clean, which the task declares neither input nor ` +
        `output: a tool that reads such a file back (an incremental build's state) may take the cleaned ` +
        `outputs as built` +
        declareStateHint(left)
      : '') +
    bracketLiteralHint([
      ...policy.outputs.map((g) => [node.projectDir, g] as const),
      ...policy.wsOutputs.map((g) => [args.run.workspaceRoot, g] as const),
    ])
  warnOf(log)(secrets.text(line))
  return missing
}
