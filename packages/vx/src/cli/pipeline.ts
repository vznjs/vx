// `vx pipeline <name>`: a run `.vx/workspace.ts` saved under `pipelines`
// (M, 2026-11-22), so each CI job names one and its file holds no flags.

import path from 'node:path'
import { parseCachePolicy } from '../cache/index.js'
import type { Pipeline } from '../config.js'
import { envName, parseSettingValue, SETTINGS, settingRefusal } from '../settings.js'
import { setVxOnlyEnv, nearest } from '../util/index.js'
import {
  findWorkspaceRoot,
  loadWorkspaceConfig,
  PIPELINE_FLAGS,
  pipelineRunArgs,
} from '../workspace/index.js'
import { refuse, seeHelp } from './help.js'
import { FORMAT_NEEDS_DRY, parseRunArgs, runCmd } from './run.js'

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
  // The saved keys join the typed flags later: a saved `dry` takes a typed
  // `--format`, and the run checks the joined line.
  if (parsed.error !== undefined && parsed.error !== FORMAT_NEEDS_DRY)
    return { rest, error: `${parsed.error}${see}` }
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

/**
 * Why a saved value the load could not check is refused, or undefined:
 * `cachePolicy`, whose grammar is the cache module's, and an `env` entry
 * that sets a setting's variable, unless a variable already set or the
 * setting's typed flag beats it (then nothing reads it).
 */
function savedRefusal(name: string, p: Pipeline, typed: readonly string[]): string | undefined {
  const where = (key: string) => `.vx/workspace: \`pipelines.${name}.${key}\``
  const policy = (key: string, spec: string): string | undefined => {
    try {
      parseCachePolicy(spec)
      return undefined
    } catch (err) {
      return `${where(key)} ${(err as Error).message}`
    }
  }
  if (p.cachePolicy !== undefined) {
    const why = policy('cachePolicy', p.cachePolicy)
    if (why !== undefined) return why
  }
  const given = (flag: string) => typed.some((a) => a === flag || a.startsWith(`${flag}=`))
  for (const [k, v] of Object.entries(p.env ?? {})) {
    if ((process.env[k] ?? '') !== '' || v === '') continue
    const s = SETTINGS.find((x) => x.env !== false && envName(x.path) === k)
    if (s === undefined || (s.flag !== undefined && given(s.flag.name))) continue
    if (s.path === 'cache.policy') {
      const why = policy(`env.${k}`, v)
      if (why !== undefined) return why
    } else if (parseSettingValue(s.kind, v) === null)
      return settingRefusal(s.path, where(`env.${k}`), v)
  }
  return undefined
}

export async function pipelineCmd(args: readonly string[]): Promise<number> {
  const { name, rest, error } = parsePipelineArgs(args)
  if (error !== undefined || name === undefined)
    return refuse('pipeline', args, error ?? '', 'VX_E_USAGE')

  const root = await findWorkspaceRoot(process.cwd())
  const pipelines = (await loadWorkspaceConfig(root))?.pipelines ?? {}
  const names = Object.keys(pipelines)
  const pipeline = Object.hasOwn(pipelines, name) ? pipelines[name] : undefined
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
  // The run's parser would refuse a bad saved value as a typed flag or a
  // variable the user never set: name the key that holds it.
  const refused = savedRefusal(name, pipeline, rest)
  if (refused !== undefined) return refuse('pipeline', args, refused, 'VX_E_CONFIG')
  // Its paths are the workspace file's, so they stand from the root, as
  // `cache.dir` there does: from a project's directory a relative
  // `cacheDir` put a second cache inside that project.
  const rooted = (p: string): string => path.resolve(root, p)
  const saved = {
    ...pipeline,
    ...(pipeline.cacheDir !== undefined ? { cacheDir: rooted(pipeline.cacheDir) } : {}),
    ...(pipeline.profile === true || typeof pipeline.profile === 'string'
      ? { profile: rooted(pipeline.profile === true ? 'profile.json' : pipeline.profile) }
      : {}),
  }
  // Read before its own `env` is set: that is saved as its keys are, so a
  // policy variable there dropped its `noCache` as a typed one does.
  const own = pipelineRunArgs(saved, rest)
  // A variable already set wins, as it beats every setting the file holds.
  for (const [k, v] of Object.entries(pipeline.env ?? {}))
    if ((process.env[k] ?? '') === '') setVxOnlyEnv(k, v)
  const keys = new Map<string, string>()
  for (const [key, { flag }] of Object.entries(PIPELINE_FLAGS))
    if (own.some((a) => a === flag || a.startsWith(`${flag}=`)))
      keys.set(flag, `\`pipelines.${name}.${key}\``)
  return runCmd([...own, ...rest], ['vx', 'pipeline', ...args], keys)
}
