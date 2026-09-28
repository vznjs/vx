// `turbo build` runs the build; `nx build app` builds app. A Turbo or Nx
// user types the task where vx wants a verb, and `vx build` answered
// "unknown command" with no way on. The answer names the `vx run` that
// does it. It stays a refusal: a verb that runs whatever task shares its
// name would change meaning the day a plugin declares that verb.

import { findWorkspaceRoot, listProjects, loadWorkspace } from '../workspace/index.js'
import { findCwdProject } from './select.js'
import { loadCliProjects } from './workspace-config.js'

/** The `vx run` a task typed as a verb means, or null when no project declares it. */
export async function taskVerbHint(
  command: string,
  rest: readonly string[],
  cwd: string,
): Promise<string | null> {
  if (command.includes('#')) return `\`${command}\` is a task: vx run ${command}`
  let projects: Awaited<ReturnType<typeof loadCliProjects>>
  try {
    const root = await findWorkspaceRoot(cwd)
    projects = await loadCliProjects(root, await listProjects(await loadWorkspace(root)), 'all', {
      noCreate: true,
    })
  } catch {
    // No workspace, or a config that does not load: the plain unknown-command line stands.
    return null
  }
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
