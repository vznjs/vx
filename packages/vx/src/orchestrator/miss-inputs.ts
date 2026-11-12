// A miss's input set, described once before its first attempt: the executor
// gets the values (what a remote worker must reproduce) and the save reuses
// the captured rows for the entry's input fingerprint. Also what the
// description says to the user: a declared set that matched nothing, and
// inputs the declaration lists that git ignores.

import { statSync } from 'node:fs'
import path from 'node:path'
import { type TaskInputComponent } from '../cache/index.js'
import { fsClockNow } from '../memo/index.js'
import { type TaskInputs } from '../exec/index.js'
import { isLocalExecutor } from './local-executor.js'
import type { InputsConfig } from '../config.js'
import {
  anyTaskGlob,
  ignoredByGlobs,
  ignoredInputLine,
  isLiteralPattern,
  MASKED,
  outputMatcher,
  relPosix,
  secretNamed,
} from '../util/index.js'
import { warnOf } from '../report/index.js'
import type { ExecuteArgs } from './execute-task.js'
import { bracketLiteralHint } from './miss-save.js'
import type { TaskPolicy } from './task-policy.js'
import { describeTaskInputs, type InputFact } from './task-hash.js'
import { TaskSecrets } from './task-secrets.js'

export type Described = Awaited<ReturnType<typeof describeTaskInputs>>

export interface MissInputs {
  /** The key's rows; empty for a task that is not cacheable. */
  readonly captured: TaskInputComponent[]
  readonly described: Described | undefined
  readonly inputs: TaskInputs | undefined
  /** What a missed key changed (`ExecuteArgs.explainMiss`). */
  readonly inputChanges: ReturnType<NonNullable<ExecuteArgs['explainMiss']>> | undefined
  /**
   * The command's start for the re-check (`movedInput`), on the clock that
   * stamps its writes: off `Date.now()`, a coarse kernel tick dated an edit
   * in the command's first tick before it, and an edit undone by the end
   * read as an upstream's write of the key's bytes. After the describe, so
   * the stats that tell an upstream's write in its tick apart come first.
   */
  readonly commandFrom: number
  /** `facts` without the task's own outputs (`keyedInputs`). */
  readonly keyed: (facts: readonly InputFact[]) => readonly InputFact[]
}

/** Describe the inputs and build the secret mask its rows' names need. */
export async function describeMiss(
  args: ExecuteArgs,
  policy: TaskPolicy,
  env: NodeJS.ProcessEnv,
): Promise<{ inputs: MissInputs; secrets: TaskSecrets }> {
  const { node, upstream, cache, log } = args
  const cfg = node.config
  // A non-cacheable task folds nothing and ships no inputs. The HashCache
  // memos and the gitFilesCache OID map make this a fold, no I/O.
  const captured: TaskInputComponent[] = []
  const described = policy.cacheable
    ? await describeTaskInputs({
        node,
        upstream,
        workspaceRoot: args.workspaceRoot,
        cache,
        forwardArgs: args.forwardArgs,
        nestedProjectDirs: args.nestedProjectDirs,
        captureInto: captured,
        ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
        ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        ...(args.probesAfterWrites !== undefined
          ? { probesAfterWrites: args.probesAfterWrites }
          : {}),
      })
    : undefined
  const commandFrom = policy.cacheable
    ? fsClockNow(args.cacheDir ?? path.join(args.workspaceRoot, '.vx'))
    : 0

  // A committed file under the task's own outputs is keyed (`committedFiles`)
  // and the task may rewrite it (TanStack Router's `routeTree.gen.ts`): the
  // bytes it leaves are an output the entry saves and a restore writes, and
  // they follow from the key, so their change is no moved input.
  const ownOutput = policy.outputs.length === 0 ? undefined : outputMatcher(policy.outputs)
  const ownWsOutput = policy.wsOutputs.length === 0 ? undefined : outputMatcher(policy.wsOutputs)
  const keyed = (facts: readonly InputFact[]): readonly InputFact[] =>
    ownOutput === undefined && ownWsOutput === undefined
      ? facts
      : facts.filter(
          (f) =>
            ownOutput?.(relPosix(node.projectDir, f.path)) !== true &&
            ownWsOutput?.(relPosix(args.workspaceRoot, f.path)) !== true,
        )

  // A name only `exec.env.secret` makes secret is not one the name rule
  // sees later: its row carries the mark, so `vx why` hides its hash.
  const named = cfg.exec?.env?.secret
  if (named !== undefined)
    for (const c of captured)
      if (c.kind === 'env' && named.includes(c.name) && !secretNamed(c.name))
        c.hash = MASKED + c.hash
  const secrets = new TaskSecrets(env, policy.exec)
  // A runtime probe's row is named by its command, which a TS config may
  // build from `process.env`: the run history stored it and `vx why`
  // printed it.
  const nameSecrets = captured.length > 0 ? secrets.mask : null
  if (nameSecrets !== null) {
    // Two probes that differ only by a secret mask to one name, and a row
    // is stored once per name: numbered, the second's change still shows.
    const seen = new Set(captured.map((c) => `${c.kind}\0${c.name}`))
    for (const c of captured) {
      const masked = nameSecrets.mask(c.name)
      if (masked === c.name) continue
      let name = masked
      for (let n = 2; seen.has(`${c.kind}\0${name}`); n++) name = `${masked} (${n})`
      seen.add(`${c.kind}\0${name}`)
      c.name = name
    }
  }
  const inputs = described?.inputs
  const inputChanges = described !== undefined ? args.explainMiss?.(node.id, captured) : undefined
  // A plugin may keep the request past the run (the cache closed): it gets
  // the upstream outputs read now. Only the local floor leaves them unread.
  if (inputs !== undefined && !isLocalExecutor(args.executor)) await described!.readUpstream()
  // A declared input set that resolves to NOTHING is the quiet stale hit:
  // the key stops moving with this project's source and every later run
  // is a hit. Almost always a glob written against the wrong directory
  // (`lib/**` in a package that builds `src/`). Said once per miss; the
  // task itself succeeds.
  const declaredInputs = [...(cfg.inputs?.files ?? []), ...(cfg.inputs?.workspaceFiles ?? [])]
  const unmatched =
    inputs === undefined || declaredInputs.length === 0
      ? []
      : inputs.files.length === 0
        ? declaredInputs
        : deadSourceGlobs(
            cfg.inputs,
            inputs.files,
            args.workspaceRoot,
            relPosix(args.workspaceRoot, node.projectDir),
          )
  if (unmatched.length > 0) {
    warnOf(log)(
      `[vx] ${node.id}: inputs matched no files (${unmatched.join(', ')}) — ` +
        `the key will not change when this project's source does` +
        bracketLiteralHint([
          ...(cfg.inputs?.files ?? []).map((g) => [node.projectDir, g] as const),
          ...(cfg.inputs?.workspaceFiles ?? []).map((g) => [args.workspaceRoot, g] as const),
        ]),
    )
  }

  if (inputs !== undefined) {
    const isOwnOutput = (abs: string): boolean =>
      ownOutput?.(relPosix(node.projectDir, abs)) === true ||
      ownWsOutput?.(relPosix(args.workspaceRoot, abs)) === true
    const left = [
      ...ignoredByGlobs(cfg.inputs?.files, node.projectDir, args.workspaceRoot, inputs.files),
      ...ignoredByGlobs(
        cfg.inputs?.workspaceFiles,
        args.workspaceRoot,
        args.workspaceRoot,
        inputs.files,
      ),
    ].filter(([abs]) => !isOwnOutput(abs))
    for (const [, rel, glob] of left) warnOf(log)(`[vx] ${ignoredInputLine(node.id, rel, glob)}`)
  }

  return {
    inputs: { captured, described, inputs, inputChanges, commandFrom, keyed },
    secrets,
  }
}

/**
 * Whether `abs` leads to a directory. A link that leads nowhere is no
 * directory: under a file (ENOTDIR) or in a loop (ELOOP) as well as
 * dangling, where the stat's throw failed the run.
 */
function linksToDir(abs: string): boolean {
  try {
    return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

/**
 * The wildcard input globs, when not one of them matched a file: the
 * literal files beside them did. A lockfile plugin appends `package.json`
 * to every task's inputs, so `scr/**` for `src/**` kept a non-empty set
 * and its warning went unsaid: an edit to `src/` then replayed a stale hit.
 * On the miss path only; stops at the first matched file.
 */
function deadSourceGlobs(
  declared: InputsConfig | undefined,
  files: readonly { readonly path: string }[],
  root: string,
  projectRel: string,
): string[] {
  const wild = (globs: readonly string[] | undefined): string[] =>
    (globs ?? []).filter((g) => !g.startsWith('!') && !isLiteralPattern(g))
  const own = wild(declared?.files)
  const ws = wild(declared?.workspaceFiles)
  if (own.length === 0 && ws.length === 0) return []
  const ownMatch = anyTaskGlob(own)
  const wsMatch = anyTaskGlob(ws)
  const prefix = projectRel === '' ? '' : `${projectRel}/`
  for (const { path: p } of files) {
    if (wsMatch(p)) return []
    if (p.startsWith(prefix) && ownMatch(p.slice(prefix.length))) return []
  }
  // A link to a directory a glob reaches below is listed by its own name,
  // which the glob does not match: `src/**` over `src -> ../shared` was
  // called dead though an edit through it moved the key.
  for (const { path: p } of files) if (linksToDir(path.join(root, p))) return []
  return [...own, ...ws]
}
