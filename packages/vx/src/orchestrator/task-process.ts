// What a task's process runs with (its env, its timeout) and what an
// undeclared write costs the run's memos. Shared by the one-shot path
// (execute-task.ts) and the server path (persistent-task.ts).

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ExecConfig } from '../config.js'
import type { GitFilesCache } from '../cache/index.js'
import {
  buildIsolatedEnv,
  packageManagerPath,
  PM_EXEC_ENV,
  VX_RUN_TASK_ENV,
  VX_RUN_WORKSPACE_ENV,
  type ServerSpec,
  toRealPath,
} from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import { parseDuration, UserError } from '../util/index.js'

/**
 * Drop the run's facts about files a task may have written without
 * declaring them (`undeclaredWriteReach`): the project's git snapshot and
 * its index OIDs. The next reader
 * re-enumerates the project (one `git ls-files`) and hashes its files by
 * content; the per-declaration file-list memos are keyed on the snapshot
 * array, so they miss with it (item 743).
 */
export function forgetUndeclaredWrites(
  args: { node: TaskNode; gitFilesCache?: GitFilesCache | undefined },
  reach: 'none' | 'project' | 'workspace',
): void {
  if (reach === 'none') return
  if (reach === 'workspace') {
    args.gitFilesCache?.clear()
    return
  }
  args.gitFilesCache?.delete(args.node.projectDir)
  args.gitFilesCache?.invalidateWorkspacePartition()
}

/** The two bin directories a task's PATH starts with: its own, then the root's (once when they coincide). */
export function taskBinDirs(
  node: TaskNode,
  workspaceRoot: string,
  /** The dependencies' `outputs.bin` directories (`dependencyBins`): first. */
  depBins: readonly string[] = [],
): string[] {
  const bins = [...depBins, path.join(node.projectDir, 'node_modules', '.bin')]
  const rootBin = path.join(workspaceRoot, 'node_modules', '.bin')
  // Identical when the root is itself a project — dedupe rather than list it
  // twice, so PATH reads the same either way.
  if (rootBin !== bins[depBins.length]) bins.push(rootBin)
  return bins
}

/**
 * Build the child-process env for one task. Same arguments at every call site
 * (persistent + cached). Two `node_modules/.bin` directories are prepended to
 * PATH: the project's own, then the WORKSPACE ROOT's. Never a sibling
 * project's, and never an arbitrary ancestor — that is the project-isolation
 * rule, and the root is not a sibling.
 *
 * The root entry is where a monorepo's shared tooling actually lives: declare
 * `oxlint` once as a root devDependency and every member's `.bin` is empty of
 * it. Without the root on PATH such a task exits 127, which is what this
 * repo's own gate did the moment core stopped BEING the root and the two
 * paths stopped coinciding. It also removes a divergence that mattered more:
 * the REAPI executor already rebuilds both entries in the action's command,
 * so a task that resolved on a worker failed on the machine that submitted
 * it. npm/pnpm/yarn all put the ancestor chain on PATH for the same reason.
 */
export function taskEnv(
  node: TaskNode,
  step: ExecConfig,
  workspaceRoot: string,
  depBins: readonly string[] = [],
): NodeJS.ProcessEnv {
  // Real paths: a hermetic macOS sandbox denies `/`, so the kernel cannot
  // walk a link on the way (`/var` -> `/private/var`) to the program.
  const bins = taskBinDirs(node, workspaceRoot, depBins.map(toRealPath))
  const env = buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: bins,
    workspaceRoot,
  })
  env[VX_RUN_WORKSPACE_ENV] = workspaceRoot
  env[VX_RUN_TASK_ENV] = node.id
  // A task's own passThrough or define wins.
  if (env[PM_EXEC_ENV] === undefined) {
    const manager = packageManagerPath(workspaceRoot)
    if (manager !== null) env[PM_EXEC_ENV] = manager
  }
  return env
}

/**
 * The `outputs.bin` directories of the tasks a task's key folds
 * (`readableDeps`), for the front of its PATH. Read when the task runs,
 * after they ran or were restored. Two holding one program name refuse the
 * task, naming both: PATH order would pick one silently. With no two
 * alike, their order on PATH decides nothing.
 */
export async function dependencyBins(deps: readonly TaskNode[]): Promise<string[]> {
  const dirs: string[] = []
  const owner = new Map<string, string>()
  for (const dep of deps) {
    const bin = dep.config.outputs?.bin
    if (bin === undefined) continue
    const dir = path.join(dep.projectDir, bin)
    dirs.push(dir)
    for (const name of await readdir(dir).catch(() => [])) {
      const first = owner.get(name)
      if (first !== undefined && first !== dep.id) {
        throw new UserError(
          `${first} and ${dep.id} both put '${name}' on this task's PATH (outputs.bin) — ` +
            `depend on one, or rename the program in one of them`,
        )
      }
      owner.set(name, dep.id)
    }
  }
  return dirs
}

/** A task's own `exec.timeout` in ms; the schema has checked its form. */
export function taskTimeoutMs(step: ExecConfig): number | undefined {
  return step.timeout === undefined ? undefined : parseDuration(step.timeout)!
}

/** Persistent task `node` as a `servers` executor starts it: no forwarded args, which a dependency never gets. */
export function serverSpec(
  node: TaskNode,
  workspaceRoot: string,
  nested: readonly string[],
): ServerSpec {
  const step = node.config.exec!
  const timeoutMs = taskTimeoutMs(step)
  const readyWhen = step.persistent?.readyWhen
  return {
    taskId: node.id,
    command: step.command,
    cwd: node.projectDir,
    env: taskEnv(node, step, workspaceRoot),
    ...(readyWhen === undefined ? {} : { readyWhen }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(step.sandbox === undefined ? {} : { sandbox: { config: step.sandbox, nested } }),
  }
}

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
