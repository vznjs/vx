// After a miss's command: does the key still describe the inputs it ran
// over, and did it write undeclared state a later run would read back?
// Either withholds the save; the result stands.

import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { ABSENT_INPUT, type CacheLayer, declaresInput } from '../cache/index.js'
import { racyWindowMs, stampGrainMs } from '../memo/index.js'
import { type ExecuteResult } from '../exec/index.js'
import { atOrUnder, MOUNT_WILDCARDS, toRealPath } from '../sandbox/index.js'
import { printable, relPosix, span, taskGlobOf } from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { ExecuteArgs } from './execute-task.js'
import type { MissRun } from './miss-run.js'
import { commandWriteReach } from '../sandbox/index.js'
import { type InputFact, movedInput } from './task-hash.js'
import { forgetUndeclaredWrites } from './task-process.js'
import { declareStateHint, stateChanged, type stampUndeclaredState } from './undeclared-state.js'

/** A test snapshot's path: jest's and vitest's `__snapshots__/`, or a `.snap` file. */
const SNAPSHOT = /(?:^|[\\/])__snapshots__[\\/]|\.snap$/

/** What the re-check found; read by the outcome. */
export interface KeyCheck {
  /** The key no longer describes the bytes on disk (`TaskOutcome.unkeyed`). */
  unkeyed: boolean
  /** The input found moved under the command (`TaskOutcome.driftedInput`). */
  drifted?: string | null
  /** `inputs.stability.severity: 'error'`: the moved input that fails the task. */
  movedFails?: string
  /** The other command that may have put a moved input back. */
  rewroteBy?: string | undefined
}

/** The undeclared state the command may write and read back next run, stamped before it. */
export interface StateStamp {
  readonly state: ReturnType<typeof stampUndeclaredState> | undefined
  readonly from: number
}

/**
 * A claimed file every key here folded through its claimant has moved (a
 * task rewrote the lockfile), said once per run.
 */
export function fingerprintMoved(args: ExecuteArgs): boolean {
  if (args.fingerprintWatch?.moved() === undefined) return false
  args.fingerprintWatch.say(args.log)
  return true
}

/**
 * The input that no longer holds what the key folded, or one the key did
 * not fold that is there now: `null` when the key re-derived just before
 * the command already differed (the file unnamed), undefined when none
 * moved.
 */
export async function movedSinceKey(
  m: MissRun,
  result: ExecuteResult,
  check: KeyCheck,
): Promise<string | null | undefined> {
  const { args, hash } = m
  const { node } = args
  const { described, keyed, commandFrom } = m.inputs
  if (described!.hash !== hash) return null
  // Changed where an executor ran it: this disk never shows it.
  if (result.changed !== undefined && result.changed.length > 0) {
    const changed = new Set(result.changed.map((f) => path.join(args.workspaceRoot, f)))
    const there = keyed(described!.facts).find((f) => changed.has(f.path))
    if (there !== undefined) return there.path
    // One the key never folded, as this disk lacks it (untracked there),
    // that the declaration matches: the command read it, and its entry
    // here was every later run's hit.
    const dir = relPosix(args.workspaceRoot, node.projectDir)
    for (const f of result.changed) {
      const own = relPosix(node.projectDir, path.join(args.workspaceRoot, f))
      const projectRel = own.startsWith('../') ? null : own
      if (declaresInput(node.config, projectRel, f, false, true, dir))
        return path.join(args.workspaceRoot, f)
    }
  }
  // Under `'mutable'`, a write during the command that left the key's bytes
  // is the task's own identical rewrite only if no other command that may
  // write the file ran between the describe and that write: one that did
  // may have changed it and put it back while this command read it.
  const ownRewrite = (file: string, ctimeMs: number): boolean => {
    check.rewroteBy = args.commandWindows?.writerDuring(
      node.id,
      file,
      described!.describedAt,
      ctimeMs + racyWindowMs(ctimeMs, 0),
    )
    return check.rewroteBy === undefined
  }
  return (
    (await movedInput(
      keyed(described!.facts),
      args.cache,
      commandFrom,
      m.policy.stability.strategy === 'mutable' ? ownRewrite : undefined,
    )) ?? described!.added()
  )
}

/**
 * Does the key still describe the inputs the command ran over? It was taken
 * before the command, up front or before `describeTaskInputs`, and a save
 * files the outputs under it. A user's edit mid-run, or a task rewriting
 * its own input (a formatter), saved bytes built from one state under the
 * key of another: restore the old state and the next run replayed them as
 * up-to-date (turborepo#10111, #1146). The result stands; only the entry
 * is withheld, and the facts about the project go, since something wrote
 * there. A lockfile a task rewrote withholds it too: the key folded the
 * old one.
 */
export async function keyStillTrue(
  m: MissRun,
  result: ExecuteResult,
  check: KeyCheck,
): Promise<boolean> {
  const { args, hash, policy } = m
  const { node, log } = args
  const { described, keyed, commandFrom } = m.inputs
  const { stability, wsOutputs } = policy
  if (fingerprintMoved(args)) {
    check.unkeyed = true
    return false
  }
  // `'unchecked'` skips the check of the command's own window; a key the
  // re-derive before the command already disagreed with still withholds,
  // since it never described the bytes the command read. Unchecked, the
  // command may still have rewritten an input in place: a later reader
  // keyed after it (stable-keys.ts) must not read the project's run-start
  // facts.
  if (stability.strategy === 'unchecked' && described!.hash === hash) {
    if (args.executor.remote !== true)
      forgetUndeclaredWrites(
        args,
        wsOutputs.length > 0 ? 'workspace' : commandWriteReach(node, args.workspaceRoot),
      )
    return true
  }
  const endCheck = span('miss: recheck inputs')
  const moved = await movedSinceKey(m, result, check)
  endCheck()
  if (moved === undefined) return true
  const { rewroteBy } = check
  const name =
    moved === null ? 'its inputs' : `\`${printable(relPosix(args.workspaceRoot, moved))}\``
  // Only its ctime moved: a hard link (`cp -al src dist`), chmod or chown.
  // It is still withheld: an edit undone with its mtime put back reads the
  // same. Not said of a change an executor reported from where it ran.
  const fact =
    moved === null || rewroteBy !== undefined || (result.changed?.length ?? 0) > 0
      ? undefined
      : keyed(described!.facts).find((f) => f.path === moved)
  const ctimeOnly = fact !== undefined && (await onlyCtimeMoved(fact, commandFrom, args.cache))
  const what = ctimeOnly
    ? `${name}'s ctime moved while the task ran, but not its bytes or mtime (a hard link, chmod or chown)`
    : `${name} changed after its key was taken` +
      (rewroteBy === undefined ? '' : ` while ${rewroteBy} ran`)
  // A task that regenerates its own input (TanStack Router's committed
  // `routeTree.gen.ts`, rewritten to the same bytes by every build) is never
  // saved. A file the key read may instead be one the task rewrites in place
  // (a formatter's temp + rename), whose sources cannot be its outputs: vx
  // deletes outputs before the command. Its way out is judging the write by
  // its bytes. Neither is said of a file this disk lacks: one the task
  // deleted, or one only where an executor ran it.
  const read =
    moved !== null &&
    keyed(described!.facts).some((f) => f.path === moved && f.digest !== ABSENT_INPUT)
  // One that appeared is not an output to declare: vx deletes an
  // uncommitted output before each run, so a snapshot vitest writes on its
  // first run was written anew every run and a changed value passed. A file
  // the task checks against is committed; a generated one leaves the inputs
  // before it joins the outputs.
  const appeared = (rel: string): string => {
    const own = relPosix(node.projectDir, rel)
    const [field, at] = own.startsWith('../')
      ? ['inputs.workspaceFiles', relPosix(args.workspaceRoot, rel)]
      : ['inputs.files', own]
    return (
      '; it appeared during the run: if the task checks against it (a test snapshot), ' +
      `commit it; if the task generates it, exclude it from ${field} ` +
      `('!${printable(taskGlobOf(at)).replace(/[\\']/g, '\\$&')}') and declare it in outputs`
    )
  }
  // A sandboxed task none of whose write grants reach the file could not
  // have written it: the outputs and 'mutable' advice read as if it had.
  const sandboxWrites = m.sandbox.writes
  const notTheTask =
    moved !== null &&
    sandboxWrites !== undefined &&
    !sandboxWrites.some((w) => mayWrite(toRealPath(moved), w))
  // Under watch the edit starts the next cycle, which runs on it: said
  // first, or the way out read as the fix for the user's own edit.
  const hint =
    (args.watch === true && rewroteBy === undefined ? '; the next cycle runs on it' : '') +
    (ctimeOnly
      ? "; if the task hard-links it, copy it instead, or set inputs.stability: { strategy: 'mutable' }"
      : moved === null || rewroteBy !== undefined || !existsSync(moved)
        ? ''
        : notTheTask
          ? '; the sandbox let the task write none of it, so another process changed it during the run (an editor, a checkout)' +
            (args.watch === true ? '' : '; the next run runs on it')
          : !read
            ? appeared(moved)
            : // `jest -u`: a snapshot the task checks against is committed, as
              // a new one is, never an output or a mutable input.
              SNAPSHOT.test(moved)
              ? '; it is a test snapshot the task updated: commit it'
              : '; if the task generates it, declare it in outputs' +
                (stability.strategy !== 'mutable'
                  ? "; if it rewrites it in place, set inputs.stability: { strategy: 'mutable' }"
                  : ''))
  if (stability.severity === 'error') {
    warnOf(log)(
      `[vx] ${node.id}: ${what} — the result is not saved, ` +
        `and inputs.stability.severity is 'error', so the task fails${hint}`,
    )
    check.movedFails = moved === null ? '' : printable(relPosix(args.workspaceRoot, moved))
  } else {
    warnOf(log)(
      `[vx] ${node.id}: ${what} — ` +
        (ctimeOnly
          ? 'vx cannot tell that from an edit undone, so the result stands but is not saved'
          : 'the result stands, but is not saved under a key that no longer describes it') +
        hint,
    )
  }
  forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
  check.unkeyed = true
  check.drifted = moved
  return false
}

/**
 * The command changed an undeclared ignored file in its project
 * (`undeclared-state.ts`). One a sandbox let it write none of is another
 * process's. One another command of the project may have written while
 * this one ran cannot be told from this one's write: still not saved, and
 * the warning names that command.
 */
export function noStateWritten(m: MissRun, { state, from }: StateStamp): boolean {
  const { args } = m
  const { node, log } = args
  if (state === undefined || state.size === 0) return true
  const sandboxWrites = m.sandbox.writes
  const changed = stateChanged(state, node.projectDir).filter(
    (rel) =>
      sandboxWrites === undefined ||
      sandboxWrites.some((w) => mayWrite(toRealPath(path.join(node.projectDir, rel)), w)),
  )
  if (changed.length === 0) return true
  const to = Date.now() + 1
  let alongside: string | undefined
  for (const rel of changed) {
    alongside = args.commandWindows?.writerDuring(
      node.id,
      path.join(node.projectDir, rel),
      from,
      to,
    )
    if (alongside !== undefined) break
  }
  warnOf(log)(
    `[vx] ${node.id}: ${changed.map(printable).join(', ')} changed while the task ran, ` +
      `but git ignores ${changed.length === 1 ? 'it' : 'them'} and the task declares ` +
      `${changed.length === 1 ? 'it' : 'them'} neither input nor output — the result stands, but is not saved: ` +
      `a tool that reads such a file back (an incremental build's state) builds from it, not from the inputs` +
      declareStateHint(changed, alongside),
  )
  return false
}

/** Whether write grant `grant` (absolute) may reach `abs`: a glob by its whole directory, to err toward "it could". */
function mayWrite(abs: string, grant: string): boolean {
  const at = grant.search(MOUNT_WILDCARDS)
  return atOrUnder(abs, at === -1 ? grant : path.dirname(grant.slice(0, at + 1)))
}

/**
 * Whether a moved input kept the bytes and the mtime its key folded, so only
 * its ctime moved. Asked once, of the file a re-check named: the common
 * path pays nothing.
 */
async function onlyCtimeMoved(fact: InputFact, from: number, cache: CacheLayer): Promise<boolean> {
  if (fact.digest === ABSENT_INPUT || fact.behind !== undefined) return false
  let st
  try {
    st = lstatSync(fact.path)
  } catch {
    return false
  }
  if (st.ctimeMs < from - stampGrainMs(st.ctimeMs)) return false
  if (st.mtimeMs >= from - stampGrainMs(st.mtimeMs)) return false
  return (await cache.memo.hashFile(fact.path).catch(() => undefined)) === fact.digest
}
