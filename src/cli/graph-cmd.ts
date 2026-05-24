import { loadConfigs } from '../config/index.ts'
import { buildInventory } from '../inventory/index.ts'
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
    if (args.positional.length > 0) {
      args.writeErr(
        `vx: \`vx graph\` takes no positional arguments — it prints the full ` +
          `workspace inventory as JSON.\n`,
      )
      return 1
    }

    const root = await findWorkspaceRoot(args.cwd)
    if (root === null) {
      args.writeErr(`vx: no workspace found from ${args.cwd}\n`)
      return 1
    }

    const workspace = await discover({ root })
    const configs = await loadConfigs({ workspace })
    const inventory = buildInventory({ workspace, configs })
    args.write(`${JSON.stringify(inventory, null, 2)}\n`)
    return 0
  } catch (e) {
    args.writeErr(`vx: ${(e as Error).message}\n`)
    return 1
  }
}
