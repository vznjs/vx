// Graph view — indented topo tree of all tasks, grouped by project.
// Not a 2D drawing; vertical-only. Cross-project edges are flagged
// inline with a `▶ pkg#task` suffix.

import type React from 'react'
import type { State, TaskRow } from '../state/store.js'

interface Props {
  state: State
  width: number
  height: number
}

function iconFor(row: TaskRow): string {
  switch (row.status) {
    case 'success':
    case 'cache-hit':
    case 'cache-hit-remote':
      return '✓'
    case 'running':
      return '▶'
    case 'failed':
      return '✗'
    case 'skipped':
      return '⊝'
    default:
      return '·'
  }
}

export function Graph({ state, width, height }: Props): React.ReactNode {
  void height
  // Group rows by project, preserve original (topo) ordering.
  const byProject = new Map<string, TaskRow[]>()
  for (const row of state.tasks.values()) {
    let bucket = byProject.get(row.projectName)
    if (!bucket) {
      bucket = []
      byProject.set(row.projectName, bucket)
    }
    bucket.push(row)
  }
  const children: React.ReactNode[] = []
  for (const [project, rows] of byProject) {
    children.push(
      <text key={`pkg-${project}`} content={`${project}`} fg="#a78bfa" attributes={1} />,
    )
    for (const row of rows) {
      const crossEdges = row.deps.filter((d) => !d.startsWith(`${row.projectName}#`))
      const tail = crossEdges.length > 0 ? `   ▶ ${crossEdges.join(', ')}` : ''
      children.push(
        <text
          key={row.id}
          content={`  ${iconFor(row)} ${row.taskName}${tail}`}
          fg={row.status === 'running' ? '#eab308' : '#d1d5db'}
        />,
      )
    }
  }
  return (
    <box flexDirection="column" width={width} border borderColor="#374151" title="Graph">
      {children}
    </box>
  )
}
