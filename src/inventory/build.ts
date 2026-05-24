import type { LoadedConfig } from '../config/types.ts'
import type { Workspace } from '../workspace/types.ts'
import type { Inventory, InventoryProject, InventoryTarget } from './types.ts'

export interface BuildInventoryOptions {
  workspace: Workspace
  configs: readonly LoadedConfig[]
}

export function buildInventory({ workspace, configs }: BuildInventoryOptions): Inventory {
  const byProject = new Map<string, LoadedConfig>()
  for (const c of configs) byProject.set(c.project.name, c)

  const projects: InventoryProject[] = workspace.projects.map((p) => {
    const cfg = byProject.get(p.name)
    const targets: InventoryTarget[] = []
    for (const [name, task] of Object.entries(cfg?.config.tasks ?? {})) {
      const target: InventoryTarget = { name }
      if (task.description !== undefined) target.description = task.description
      if (task.exec) target.command = task.exec.command
      if (task.dependsOn && task.dependsOn.length > 0) target.dependsOn = task.dependsOn
      targets.push(target)
    }
    return { name: p.name, dir: p.dir, targets }
  })

  return { workspace: { root: workspace.root }, projects }
}
