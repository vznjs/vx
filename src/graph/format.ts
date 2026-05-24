import type { TaskGraph } from './types.ts'

export type GraphFormat = 'text' | 'json' | 'dot'

export function formatGraph(graph: TaskGraph, format: GraphFormat): string {
  switch (format) {
    case 'text':
      return formatText(graph)
    case 'json':
      return formatJson(graph)
    case 'dot':
      return formatDot(graph)
  }
}

function formatText(graph: TaskGraph): string {
  if (graph.nodes.length === 0) return 'no tasks'
  const lines: string[] = []
  for (const node of graph.nodes) {
    const group = node.config.exec ? '' : ' (group)'
    const deps = node.dependencies.length > 0 ? `  <- ${node.dependencies.join(', ')}` : ''
    const desc = node.config.description ? `  — ${node.config.description}` : ''
    lines.push(`${node.id}${group}${desc}${deps}`)
  }
  return lines.join('\n')
}

function formatJson(graph: TaskGraph): string {
  return JSON.stringify(
    {
      nodes: graph.nodes.map((n) => {
        const base: Record<string, unknown> = {
          id: n.id,
          project: n.project,
          task: n.task,
          dependencies: n.dependencies,
        }
        if (n.config.description !== undefined) base.description = n.config.description
        if (n.config.exec) base.command = n.config.exec.command
        else base.group = true
        return base
      }),
    },
    null,
    2,
  )
}

function formatDot(graph: TaskGraph): string {
  const lines: string[] = ['digraph vx {']
  lines.push('  rankdir=LR;')
  lines.push('  node [shape=box, style=rounded];')
  for (const node of graph.nodes) {
    lines.push(`  "${node.id}";`)
  }
  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      lines.push(`  "${dep}" -> "${node.id}";`)
    }
  }
  lines.push('}')
  return lines.join('\n')
}
