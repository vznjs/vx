// `turbo build` runs the build; `nx build app` builds app. A Turbo or Nx
// user types the task where vx wants a verb, and `vx build` answered
// "unknown command" with no way on. The answer names the `vx run` that
// does it. It stays a refusal: a verb that runs whatever task shares its
// name would change meaning the day a plugin declares that verb.

import { nxProjectTarget } from '../orchestrator/index.js'
import { findWorkspaceRoot, loadWorkspace } from '../workspace/index.js'
import { findCwdProject } from './select.js'
import { discoverCliProjects, loadCliProjects } from './workspace-config.js'

/** The `vx run` a task typed as a verb means, or null when no project declares it. */
export async function taskVerbHint(
  command: string,
  rest: readonly string[],
  cwd: string,
): Promise<string | null> {
  if (command.includes('#')) return `\`${command}\` is a task: vx run ${command}`
  const projects = await workspaceProjects(cwd)
  if (projects === null) return null
  if (![...projects.values()].some((p) => p.config.tasks?.[command] !== undefined)) return null
  // Nx's `nx build app`: the word after the target is its project.
  const project = rest[0] !== undefined && projects.has(rest[0]) ? rest[0] : undefined
  const run =
    project !== undefined
      ? `vx run ${command} --filter ${project}`
      : (await findCwdProject(cwd)) === null
        ? `vx run ${command} --all`
        : `vx run ${command}`
  return `\`${command}\` is a task here, not a command: ${run}`
}

/**
 * `vx run web:build` outside a project, as `nx run web:build` is typed:
 * the `vx run` of each name that is Nx's `project:target` here, or null.
 */
export async function nxTargetHint(tasks: readonly string[], cwd: string): Promise<string | null> {
  if (!tasks.some((t) => t.includes(':'))) return null
  const projects = await workspaceProjects(cwd)
  if (projects === null) return null
  const specs = tasks.map((t) => nxProjectTarget(t, projects))
  if (specs.some((s) => s === undefined)) return null
  return `\`${tasks.join(' ')}\` is Nx's project:target: vx run ${specs.join(' ')}`
}

/**
 * The task names `vx run <task>` can take here: the cwd project's, else
 * every project's, sorted; null when no workspace loads. What a run with
 * no task and no terminal for the picker names instead of a guess.
 */
export async function taskNamesHere(cwd: string): Promise<string[] | null> {
  const projects = await workspaceProjects(cwd)
  if (projects === null) return null
  const own = await findCwdProject(cwd)
  const names = new Set<string>()
  for (const p of projects.values())
    if (own === null || p.name === own)
      for (const t of Object.keys(p.config.tasks ?? {})) names.add(t)
  return [...names].sort()
}

async function workspaceProjects(
  cwd: string,
): Promise<Awaited<ReturnType<typeof loadCliProjects>> | null> {
  try {
    const root = await findWorkspaceRoot(cwd)
    return await loadCliProjects(
      root,
      await discoverCliProjects(await loadWorkspace(root)),
      'all',
      {
        noCreate: true,
      },
    )
  } catch {
    // No workspace, or a config that does not load: the caller's plain line stands.
    return null
  }
}
