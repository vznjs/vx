// Chapter 4's pictures (guide/concurrency). The comparison and the chain are
// computed from the scheduler simulator's model (the one the chapter's
// widget runs), never typed, so a picture cannot disagree with it;
// tests/guide-concurrency.test.ts holds the model to a hand-traced schedule.

import { SIM_TASKS, criticalPath, schedule, secs } from '../../demos/model/scheduler-sim.js'
import { lanes, type Box, type Note, type Picture } from '../diagram/diagram.js'

export const together: Picture = {
  name: 'together',
  label:
    'utils#build runs first. When it is done, ui#build and api#build both start, at the same time.',
  caption: 'Neither build needs the other, so they run side by side.',
  height: 220,
  boxes: [
    { id: 'utils#build', x: 20, y: 84, w: 150, label: 'utils#build' },
    { id: 'ui#build', x: 300, y: 40, w: 150, label: 'ui#build', tone: 'accent' },
    { id: 'api#build', x: 300, y: 140, w: 150, label: 'api#build', tone: 'accent' },
  ],
  arrows: [
    { from: 'utils#build', to: 'ui#build' },
    { from: 'utils#build', to: 'api#build' },
  ],
  frames: [{ x: 280, y: 8, w: 190, h: 204, label: 'start together', tone: 'accent' }],
}

/** The eight build and test tasks of chapters 2 and 3. */
const EIGHT = SIM_TASKS.filter((t) => /#(build|test)$/.test(t.id))
const CHAIN = criticalPath(EIGHT).chain
/** The eight on one worker, then on two, as vx with no plugin orders them. */
export const RUNS = [1, 2].map((workers) => schedule(EIGHT, new Set(), 'count', workers))

const GUTTER = 96
const LANE = 52
const SPAN = RUNS[0]!.makespan
const SCALE = (600 - GUTTER - 50) / (SPAN / 1000)
const critical = new Set(CHAIN)
const panels = RUNS.map((run, i) => {
  const top = i === 0 ? 30 : 30 + LANE + 46
  const drawn = lanes(
    Array.from({ length: run.workers }, (_, l) => ({
      name: `worker ${l + 1}`,
      bars: run.bars
        .filter((b) => b.lane === l + 1)
        .map((b) => {
          const [pkg, task] = b.id.split('#') as [string, string]
          return {
            id: `${run.workers}/${b.id}`,
            start: b.start / 1000,
            end: b.end / 1000,
            label: pkg,
            sub: task,
            title: b.id,
            ...(critical.has(b.id) ? { tone: 'accent' as const } : {}),
          }
        }),
    })),
    { x: GUTTER, y: top + 4, scale: SCALE, row: LANE, h: LANE - 8 },
  )
  const notes: Note[] = [
    { x: 4, y: top - 10, text: run.workers === 1 ? 'One worker' : 'Two workers', anchor: 'start' },
    ...drawn.notes,
    {
      x: GUTTER + (run.makespan / 1000) * SCALE + 8,
      y: top + (run.workers * LANE) / 2 + 5,
      text: secs(run.makespan),
      anchor: 'start',
      tone: 'default',
    },
  ]
  return { boxes: drawn.boxes, notes }
})

export const workers: Picture = {
  name: 'workers',
  label: `${RUNS.map(
    (r) =>
      `${r.workers === 1 ? 'One worker' : 'Two workers'} finish at ${secs(r.makespan)}: ` +
      r.bars.map((b) => `${b.id} on worker ${b.lane}`).join(', '),
  ).join('. ')}.`,
  caption:
    'The same eight tasks. Highlighted: the longest chain, which still runs one task after another.',
  height: 260,
  boxes: panels.flatMap((p): Box[] => p.boxes),
  notes: panels.flatMap((p) => p.notes),
}

const CHAIN_W = 120
const CHAIN_GAP = (592 - CHAIN.length * CHAIN_W) / (CHAIN.length - 1)

export const chain: Picture = {
  name: 'chain',
  label: `The longest chain: ${CHAIN.join(', then ')}. Each waits for the one before.`,
  caption: 'The longest chain of tasks. Nothing finishes before it does.',
  height: 130,
  boxes: CHAIN.map((id, i) => ({
    id,
    x: 4 + i * (CHAIN_W + CHAIN_GAP),
    y: 16,
    w: CHAIN_W,
    label: id,
    tone: 'accent',
  })),
  arrows: CHAIN.slice(1).map((id, i) => ({ from: CHAIN[i]!, to: id })),
  notes: [
    { x: 300, y: 106, text: 'each one waits for the one before, however many workers you have' },
  ],
}
