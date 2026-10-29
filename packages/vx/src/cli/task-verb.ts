// `turbo build` runs the build; `nx build app` builds app. A Turbo or Nx
// user types the task where vx wants a verb, and `vx build` answered
// "unknown command" with no way on. The answer names the `vx run` that
// does it. It stays a refusal: a verb that runs whatever task shares its
// name would change meaning the day a plugin declares that verb.

import type { TaskConfig } from '../config.js'
import { isDefaultBuild } from '../graph/index.js'
import { nxProjectTarget, projectNamed } from '../orchestrator/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { nearest } from '../util/index.js'
import { findCwdProject } from './select.js'
import { discoverCliProjects, loadCliProjects } from './workspace-config.js'

/**
 * The `vx run` a task typed as a verb means, or null when no project
 * declares it. With `typo`, a word a few edits from a task (`vx biuld`)
 * names that task: the caller passes it only when no verb is closer.
 */
export async function taskVerbHint(
  command: string,
  rest: readonly string[],
  cwd: string,
  typo = false,
): Promise<string | null> {
  if (command.includes('#')) return `\`${command}\` is a task (did you mean vx run ${command}?)`
  const projects = await workspaceProjects(cwd)
  if (projects === null) return null
  const tasks = new Set<string>()
  // The default build is no task `vx run` takes by name (X-145).
  const declared = (task: TaskConfig | undefined): boolean =>
    task !== undefined && !isDefaultBuild(task)
  for (const p of projects.values())
    for (const [t, task] of Object.entries(p.config.tasks ?? {})) if (declared(task)) tasks.add(t)
  const task = tasks.has(command) ? command : typo ? nearest(command, tasks) : undefined
  if (task === undefined) return null
  // Nx's `nx build app`: the word after the target is its project.
  const project = rest[0] === undefined ? undefined : projectNamed(rest[0], projects)
  // A bare `vx run <task>` runs the cwd project's alone, and refuses where
  // that project does not declare it.
  const declaresHere = async (): Promise<boolean> => {
    const here = await findCwdProject(cwd)
    const own = here === null ? undefined : projects.get(here)?.config.tasks
    return own !== undefined && Object.hasOwn(own, task) && declared(own[task])
  }
  const run =
    project !== undefined
      ? `vx run ${task} --filter ${project}`
      : (await declaresHere())
        ? `vx run ${task}`
        : `vx run ${task} --all`
  return task === command
    ? `\`${command}\` is a task here, not a command (did you mean ${run}?)`
    : `unknown command: ${command}, a typo of the task \`${task}\` (did you mean ${run}?)`
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
  return `\`${tasks.join(' ')}\` is Nx's project:target (did you mean vx run ${specs.join(' ')}?)`
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
      for (const [t, task] of Object.entries(p.config.tasks ?? {}))
        if (!isDefaultBuild(task)) names.add(t)
  return [...names].sort()
}

/**
 * "no projects declare task(s): …" for the bare names no project in the
 * workspace declares, or undefined. A diff that matched nothing judged no
 * name, so `vx run tset --affected` exited 0 as "nothing affected"
 * (vercel/turborepo#12268). A workspace that does not load judges none.
 */
export async function undeclaredTasks(
  tasks: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  const projects = await workspaceProjects(cwd)
  if (projects === null) return undefined
  const declared = new Set<string>()
  for (const p of projects.values())
    for (const [t, task] of Object.entries(p.config.tasks ?? {}))
      if (!isDefaultBuild(task)) declared.add(t)
  const missing = tasks.filter((t) => !t.includes('#') && !declared.has(t))
  if (missing.length === 0) return undefined
  const near = [...new Set(missing.map((t) => nearest(t, declared)).filter((t) => t !== undefined))]
  return `no projects declare task(s): ${missing.join(', ')}.${near.length > 0 ? ` Did you mean ${near.join(', ')}?` : ''}`
}

async function workspaceProjects(
  cwd: string,
): Promise<Awaited<ReturnType<typeof loadCliProjects>> | null> {
  try {
    const root = await findWorkspaceRoot(cwd)
    return await loadCliProjects(root, await discoverCliProjects(root))
  } catch {
    // No workspace, or a config that does not load: the caller's plain line stands.
    return null
  }
}
