// An Nx target's `dependsOn` as vx edges. Nx separates a specific
// project's target with a COLON (`ui:build`); vx's separator is `#`.
// Passed through, the string form read as a task named `ui:build` in the
// DEPENDENT's own project and the migrated workspace refused to run —
// "depends on web#ui:build but no such task is declared", from a config
// vx-migrate itself wrote (walked the Nx path, 2026-09-20). Extracted from
// `buildTask` in item 606; the rules are unchanged.

import type { ProjectMeta } from '@vzn/vx'

/** The vx task an Nx `project:target:configuration` reaches, or null when the target lacks it. */
export type TaskNameFor = (project: string, target: string, configuration: string) => string | null

export function mapNxDeps(
  entries: readonly unknown[],
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  taskNameFor: TaskNameFor,
  todos: string[],
): string[] {
  const deps: string[] = []
  for (const d of entries) {
    if (typeof d === 'string') {
      const colon = d.indexOf(':')
      if (colon <= 0) {
        deps.push(d)
        continue
      }
      const [project = '', targetPart, configuration] = d.split(':')
      const m = metaByNode.get(project)
      if (m === undefined || targetPart === undefined || targetPart === '') {
        todos.push(
          `dependsOn ${JSON.stringify(d)} names ${JSON.stringify(project)}, which is not a ` +
            'workspace package in this graph — edge dropped',
        )
        continue
      }
      // A configuration is a task of its own (`build:ci`) unless it is the
      // target's default, which the base task carries; an edge naming one
      // follows it there. A configuration the target does not declare has
      // no task to reach, so the edge falls back to the base with a todo.
      if (configuration !== undefined) {
        const named = taskNameFor(project, targetPart, configuration)
        if (named === null) {
          todos.push(
            `dependsOn ${JSON.stringify(d)}: ${project} declares no ${JSON.stringify(configuration)} ` +
              `configuration on ${targetPart} — depending on ${m.name}#${targetPart}`,
          )
        } else {
          deps.push(`${m.name}#${named}`)
          continue
        }
      }
      deps.push(`${m.name}#${targetPart}`)
      continue
    }
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>
      const t = typeof o.target === 'string' ? o.target : undefined
      if (t === undefined) {
        todos.push(`dependsOn ${JSON.stringify(d)} has no target — dropped`)
        continue
      }
      if (o.params !== undefined) {
        todos.push(
          `dependsOn ${JSON.stringify(t)}: params forwarding is not supported — forward args ` +
            'via `vx run … -- args` instead',
        )
      }
      const projects = o.projects ?? (o.dependencies === true ? 'dependencies' : undefined)
      if (projects === undefined || projects === 'self') deps.push(t)
      else if (projects === 'dependencies') deps.push(`^${t}`)
      else if (Array.isArray(projects)) {
        for (const p of projects) {
          const m = typeof p === 'string' ? metaByNode.get(p) : undefined
          if (m) deps.push(`${m.name}#${t}`)
          else {
            todos.push(
              `dependsOn project ${JSON.stringify(p)} is not a workspace package — edge dropped`,
            )
          }
        }
      } else todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
      continue
    }
    todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
  }
  return deps
}
