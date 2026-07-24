// Identity coloring — the dashboard speaks the terminal renderer's visual
// language: the PROJECT half of a task id gets a STABLE hue hashed from the
// project name (a cool 6-hue set, deliberately outside the status palette so
// an id can never read as an outcome) and the TASK half is fixed pink, with
// a dim separator. The name always accompanies the color — identity is never
// color-alone; the hue is the cross-view grouping accelerator (every `alpha`
// row/card/chip shares one color on every surface).

import type { ComponentProps, JSX } from 'react'
import { Text } from '@astryxdesign/core/Text'

type TextSize = ComponentProps<typeof Text>['size']

const IDENT_HUES = 6

/** Stable identity color for a project name (same hash → same hue, always). */
export function projectColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `var(--vx-ident-${h % IDENT_HUES})`
}

/** The fixed task-half color (the terminal's pink). */
export const TASK_COLOR = 'var(--vx-ident-task)'

/** Project name in its identity hue (code face). */
export function ProjectName(props: { name: string; size?: TextSize }): JSX.Element {
  return (
    <Text type="code" size={props.size ?? 'sm'} style={{ color: projectColor(props.name) }}>
      {props.name}
    </Text>
  )
}

/** Task name in the fixed task hue (code face). */
export function TaskName(props: { name: string; size?: TextSize }): JSX.Element {
  return (
    <Text type="code" size={props.size ?? 'sm'} style={{ color: TASK_COLOR }}>
      {props.name}
    </Text>
  )
}

/** 8px identity dot — a compact project marker for table rows and lists. */
export function ProjectDot(props: { name: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: projectColor(props.name),
        flexShrink: 0,
      }}
    />
  )
}

/**
 * A full `project#task` reference: hued project · dim `#` · pink task.
 * Accepts either the joined id or explicit parts.
 */
export function TaskRef(props: {
  id?: string
  project?: string
  task?: string
  size?: TextSize
  maxLines?: number
}): JSX.Element {
  let project = props.project ?? ''
  let task = props.task ?? ''
  if (props.id !== undefined) {
    const idx = props.id.indexOf('#')
    if (idx >= 0) {
      project = props.id.slice(0, idx)
      task = props.id.slice(idx + 1)
    } else {
      task = props.id
    }
  }
  return (
    <Text type="code" size={props.size ?? 'sm'} maxLines={props.maxLines}>
      {project !== '' && (
        <>
          <span style={{ color: projectColor(project) }}>{project}</span>
          <span style={{ opacity: 0.45 }}>#</span>
        </>
      )}
      <span style={{ color: TASK_COLOR }}>{task}</span>
    </Text>
  )
}
