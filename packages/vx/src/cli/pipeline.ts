// `vx pipeline <name>`: a run `.vx/workspace.ts` saved under `pipelines`
// (M, 2026-11-22), so each CI job names one and its file holds no flags.

import { setVxOnlyEnv, nearest } from '../util/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, pipelineRunArgs } from '../workspace/index.js'
import { refuse, seeHelp } from './help.js'
import { parseRunArgs, runCmd } from './run.js'

/**
 * `vx pipeline <name> [flags]`, read by the run's own parser: the name is
 * its first word, and the flags are the run's but `--all`.
 */
export function parsePipelineArgs(args: readonly string[]): {
  name?: string
  rest: string[]
  error?: string
} {
  const parsed = parseRunArgs(args)
  const at = args.findIndex((a) => a === parsed.tasks[0])
  const rest = at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 1)]
  const see = seeHelp('pipeline')
  if (parsed.error !== undefined) return { rest, error: `${parsed.error}${see}` }
  const [name, ...extra] = parsed.tasks
  if (name === undefined)
    return {
      rest,
      error: `missing pipeline name: vx pipeline <name>, one of \`pipelines\` in .vx/workspace.ts${see}`,
    }
  if (extra.length > 0)
    return {
      name,
      rest,
      error: `vx pipeline runs one pipeline, whose tasks are its \`tasks\` (got ${extra.join(' ')}); narrow it with --filter${see}`,
    }
  if (parsed.all) return { name, rest, error: `--all: a pipeline runs every project already${see}` }
  return { name, rest }
}

export async function pipelineCmd(args: readonly string[]): Promise<number> {
  const { name, rest, error } = parsePipelineArgs(args)
  if (error !== undefined || name === undefined)
    return refuse('pipeline', args, error ?? '', 'VX_E_USAGE')

  const root = await findWorkspaceRoot(process.cwd())
  const pipelines = (await loadWorkspaceConfig(root))?.pipelines ?? {}
  const names = Object.keys(pipelines)
  const pipeline = pipelines[name]
  if (pipeline === undefined) {
    if (names.length === 0)
      return refuse(
        'pipeline',
        args,
        `no pipeline named ${name}: .vx/workspace.ts declares no \`pipelines\`, like pipelines: { ${name}: { tasks: ['lint', 'test'] } }`,
        'VX_E_USAGE',
      )
    const near = nearest(name, names)
    return refuse(
      'pipeline',
      args,
      `no pipeline named ${name}${near !== undefined ? ` (did you mean vx pipeline ${near}?)` : ''}; pipelines: ${names.join(', ')}`,
      'VX_E_USAGE',
    )
  }
  // A variable already set wins, as it beats every setting the file holds.
  for (const [k, v] of Object.entries(pipeline.env ?? {}))
    if ((process.env[k] ?? '') === '') setVxOnlyEnv(k, v)
  return runCmd([...pipelineRunArgs(pipeline, rest), ...rest], ['vx', 'pipeline', ...args])
}
