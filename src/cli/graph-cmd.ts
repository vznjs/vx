import { loadConfigs } from '../config/index.ts'
import { GraphError, buildGraph, formatGraph } from '../graph/index.ts'
import type { GraphFormat } from '../graph/format.ts'
import { discover, findWorkspaceRoot } from '../workspace/index.ts'

export interface GraphCommandArgs {
  cwd: string
  positional: readonly string[]
  flags: Readonly<Record<string, string | true>>
  write: (chunk: string) => void
  writeErr: (chunk: string) => void
}

export async function graphCommand(args: GraphCommandArgs): Promise<number> {
  try {
    const root = await findWorkspaceRoot(args.cwd)
    if (root === null) {
      args.writeErr(`vx: no workspace found from ${args.cwd}\n`)
      return 1
    }

    const workspace = await discover({ root })
    const configs = await loadConfigs({ workspace })
    const graph = buildGraph({ configs, requested: args.positional })
    const format = resolveFormat(args.flags)
    args.write(`${formatGraph(graph, format)}\n`)
    return 0
  } catch (e) {
    if (e instanceof GraphError) {
      args.writeErr(`vx: ${e.message}\n`)
      return 1
    }
    args.writeErr(`vx: ${(e as Error).message}\n`)
    return 1
  }
}

function resolveFormat(flags: Readonly<Record<string, string | true>>): GraphFormat {
  if (flags.json) return 'json'
  if (flags.dot) return 'dot'
  if (typeof flags.format === 'string') {
    if (flags.format === 'json' || flags.format === 'dot' || flags.format === 'text') {
      return flags.format
    }
  }
  return 'text'
}
