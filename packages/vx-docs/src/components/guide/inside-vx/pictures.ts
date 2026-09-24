// Chapter 9's pictures (guide/inside-vx). tests/guide-inside-vx.test.ts
// holds the pipeline picture to core's PLUGIN_HOOKS and the rendered SVGs
// to these values.
import type { Arrow, Box, Picture } from '../sketch.js'

/** The stages one run passes through, in core's order (PLUGIN_HOOKS). */
export const RUN_STAGES = [
  'config',
  'project',
  'graph',
  'key',
  'fingerprint',
  'schedule',
  'admit',
  'executor',
  'cache',
  'telemetry',
] as const

const stageBoxes: Box[] = RUN_STAGES.map((id, i) => ({
  id,
  x: 10 + (i % 5) * 120,
  y: i < 5 ? 50 : 150,
  w: 100,
  h: 44,
  label: id,
}))
const stageArrows: Arrow[] = RUN_STAGES.slice(1).map((to, i) => ({
  from: RUN_STAGES[i]!,
  to,
  ...(i === 4
    ? {
        via: [
          [540, 122],
          [60, 122],
        ],
      }
    : {}),
}))

export const pipeline: Picture = {
  name: 'pipeline',
  label: `Every run passes the same ten stages in order: ${RUN_STAGES.join(', ')}. Setup runs before them, teardown after, and commands adds command-line verbs.`,
  caption: 'Every run passes the same stages, in the same order.',
  boxes: stageBoxes,
  arrows: stageArrows,
  notes: [
    { x: 10, y: 30, text: 'setup runs first', anchor: 'start' },
    { x: 300, y: 236, text: 'then teardown · commands adds new vx verbs' },
  ],
}

const filled = [
  { stage: 'project', plugin: 'Old config', does: 'becomes tasks' },
  { stage: 'executor', plugin: 'Worker pool', does: 'runs tasks' },
  { stage: 'cache', plugin: 'Shared cache', does: 'keeps results' },
  { stage: 'telemetry', plugin: 'Tracing', does: 'watches runs' },
]

export const plugins: Picture = {
  name: 'plugins',
  label:
    'Four plugins, each filling one stage: an old config fills project, a worker pool fills executor, a shared cache fills cache, and tracing fills telemetry.',
  caption: 'Each plugin fills one stage. The rest of the run stays the same.',
  boxes: [
    ...filled.map((f, i) => ({
      id: `plugin-${f.stage}`,
      x: 15 + i * 145,
      y: 30,
      w: 135,
      label: f.plugin,
      sub: f.does,
      tone: 'accent' as const,
    })),
    ...filled.map((f, i) => ({ id: f.stage, x: 15 + i * 145, y: 170, w: 135, label: f.stage })),
  ],
  arrows: filled.map((f) => ({ from: `plugin-${f.stage}`, to: f.stage, tone: 'accent' as const })),
  notes: [{ x: 300, y: 138, text: 'plugs into', tone: 'accent' }],
}

export const floor: Picture = {
  name: 'floor',
  label:
    'A worker plugin that declines a task hands it to this machine. Without a shared cache, results still go to the local cache. Both are always there.',
  caption: 'This machine is always the last stop, so a run never needs a plugin.',
  boxes: [
    { id: 'workers', x: 30, y: 40, w: 190, label: 'Worker plugin', sub: 'may say no' },
    { id: 'here', x: 380, y: 40, w: 190, label: 'This machine', sub: 'always runs it', tone: 'ok' },
    { id: 'shared', x: 30, y: 170, w: 190, label: 'Shared cache', sub: 'may be missing' },
    { id: 'local', x: 380, y: 170, w: 190, label: 'Local cache', sub: 'always there', tone: 'ok' },
  ],
  arrows: [
    { from: 'workers', to: 'here', label: 'declines? here', tone: 'ok' },
    { from: 'shared', to: 'local', label: 'no server? still here', tone: 'ok' },
  ],
  notes: [{ x: 300, y: 138, text: 'the floor: under every plugin', tone: 'ok' }],
}
