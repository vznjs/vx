// A migrator that is neither Turbo nor Nx: each project's Makefile
// targets become vx tasks. It only reads the source and returns a plan;
// core's migration seam (`applyMigration`) renders, guards, writes and
// reports, as it does for every migrator.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { applyMigration, type GeneratedProject, type GeneratedTask } from '@vzn/vx'

export async function migrateMakefiles(
  root: string,
  dirs: readonly string[],
  options: { readonly dry?: boolean; readonly force?: boolean } = {},
): Promise<number> {
  const projects = dirs.flatMap((dir): GeneratedProject[] => {
    const tasks = makeTasks(readFileSync(path.join(dir, 'Makefile'), 'utf8'))
    if (tasks.length === 0) return []
    return [{ name: path.basename(dir), dir, importLines: [], writeName: true, tasks }]
  })
  return applyMigration({
    root,
    metas: dirs.map((dir) => ({ name: path.basename(dir), dir, configPath: null })),
    plan: { headerNotes: [], projects, extraFiles: [], notes: [] },
    source: 'Makefile',
    verb: 'make-migrate',
    emptyReason: 'no Makefile targets in any project',
    dry: options.dry ?? false,
    force: options.force ?? false,
  })
}

const RULE = /^([A-Za-z0-9_-]+)\s*:(?![=:])\s*(.*)$/

/** Each rule a task: its recipe the command, its prerequisites the targets it waits for. */
function makeTasks(text: string): GeneratedTask[] {
  const rules: { name: string; prereqs: string[]; recipe: string[] }[] = []
  for (const line of text.split('\n')) {
    const last = rules.at(-1)
    if (line.startsWith('\t') && last !== undefined) {
      last.recipe.push(line.slice(1).replace(/^[@-]+/, ''))
      continue
    }
    const rule = RULE.exec(line)
    if (rule !== null)
      rules.push({ name: rule[1]!, prereqs: rule[2]!.split(/\s+/).filter(Boolean), recipe: [] })
  }
  const targets = new Set(rules.map((r) => r.name))
  return rules.map((r) => {
    const dependsOn = r.prereqs.filter((p) => targets.has(p))
    const task: Record<string, unknown> = {
      ...(r.recipe.length > 0 ? { exec: { command: r.recipe.join(' && ') } } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    }
    const todos = r.recipe.some((l) => l.includes('$('))
      ? ['the recipe uses make variables: write their values into the command']
      : []
    return { name: r.name, todos, task }
  })
}
