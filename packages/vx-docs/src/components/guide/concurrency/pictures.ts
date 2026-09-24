// Chapter 4's pictures (guide/concurrency). The comparison and the chain are
// computed from the scheduler simulator's model (the one the chapter's
// widget runs), never typed, so a picture cannot disagree with it;
// tests/guide-concurrency.test.ts holds the model to a hand-traced schedule.

import {
  SIM_TASKS,
  criticalPath,
  schedule,
  secs,
  type Schedule,
} from '../../demos/model/scheduler-sim.js'
import {
  lanes,
  type Box,
  type Lane,
  type Layout,
  type Note,
  type Picture,
} from '../diagram/diagram.js'

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
  narrow: {
    width: 340,
    height: 224,
    boxes: [
      { id: 'utils#build', x: 12, y: 98, w: 120, label: 'utils#build' },
      { id: 'ui#build', x: 172, y: 56, w: 144, label: 'ui#build', tone: 'accent' },
      { id: 'api#build', x: 172, y: 140, w: 144, label: 'api#build', tone: 'accent' },
    ],
    arrows: [
      { from: 'utils#build', to: 'ui#build' },
      { from: 'utils#build', to: 'api#build' },
    ],
    frames: [{ x: 160, y: 20, w: 168, h: 184, label: 'start together', tone: 'accent' }],
  },
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
const workerTitle = (run: Schedule): string => (run.workers === 1 ? 'One worker' : 'Two workers')
function workerLanes(run: Schedule): Lane[] {
  return Array.from({ length: run.workers }, (_, l) => ({
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
  }))
}
const panels = RUNS.map((run, i) => {
  const top = i === 0 ? 30 : 30 + LANE + 46
  const drawn = lanes(workerLanes(run), {
    x: GUTTER,
    y: top + 4,
    scale: SCALE,
    row: LANE,
    h: LANE - 8,
  })
  const notes: Note[] = [
    { x: 4, y: top - 10, text: workerTitle(run), anchor: 'start' },
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
      `${workerTitle(r)} finish at ${secs(r.makespan)}: ` +
      r.bars.map((b) => `${b.id} on worker ${b.lane}`).join(', '),
  ).join('. ')}.`,
  caption:
    'The same eight tasks. Highlighted: the longest chain, which still runs one task after another.',
  height: 260,
  boxes: panels.flatMap((p): Box[] => p.boxes),
  notes: panels.flatMap((p) => p.notes),
  narrow: workersNarrow(),
}

/** The two runs side by side with time running down, on one clock, so the
 *  shorter run is the shorter column. A bar prints only what it prints
 *  wide: a phone column is wider than a short bar is wide, and would have
 *  room for labels the wide drawing drops. */
function workersNarrow(): Layout {
  const printed = new Map(panels.flatMap((p) => p.boxes).map((b) => [b.id, b]))
  const scale = 12.5
  const top = 70
  const col = 84
  const row = 94
  const drawn = RUNS.map((run, i) => {
    const x = i === 0 ? 20 : 142
    const across = (run.workers - 1) * row + col
    const cols = lanes(
      workerLanes(run).map((lane) => ({
        ...lane,
        bars: lane.bars.map((all) => {
          const { sub: _, ...bar } = all
          const wide = printed.get(bar.id!)!
          return { ...bar, label: wide.label, ...(wide.sub === undefined ? {} : { sub: wide.sub }) }
        }),
      })),
      { x, y: top, scale, row, h: col, down: true },
    )
    const notes: Note[] = [
      { x, y: top - 36, text: workerTitle(run), anchor: 'start' },
      ...cols.notes,
      {
        x: x + across / 2,
        y: top + (run.makespan / 1000) * scale + 20,
        text: secs(run.makespan),
        tone: 'default',
      },
    ]
    return { boxes: cols.boxes, notes }
  })
  return {
    width: 340,
    height: Math.ceil(top + (SPAN / 1000) * scale + 40),
    boxes: drawn.flatMap((d) => d.boxes),
    notes: drawn.flatMap((d) => d.notes),
  }
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
  narrow: {
    width: 340,
    height: 16 + CHAIN.length * 82 + 50,
    boxes: CHAIN.map((id, i) => ({
      id,
      x: 105,
      y: 16 + i * 82,
      w: 130,
      label: id,
      tone: 'accent',
    })),
    arrows: CHAIN.slice(1).map((id, i) => ({ from: CHAIN[i]!, to: id })),
    notes: [
      { x: 170, y: 16 + CHAIN.length * 82 + 12, text: 'each one waits for the one before,' },
      { x: 170, y: 16 + CHAIN.length * 82 + 32, text: 'however many workers you have' },
    ],
  },
}

/** The simulator's default graph on two workers, once under each rule: vx's
 *  own (the most tasks waiting first) and the history plugin's (the longest
 *  chain ahead first). Only app#docs, the long task nothing waits on, is
 *  named; every other bar keeps its id as its title. */
export const ORDERS = (['count', 'median'] as const).map((policy) =>
  schedule(SIM_TASKS, new Set(), policy, 2),
)
const LONG = 'app#docs'
const ORDER_SCALE = (600 - GUTTER - 50) / (Math.max(...ORDERS.map((o) => o.makespan)) / 1000)
const ORDER_LANE = 40
const ORDER_TITLE = ['vx: most tasks waiting first', 'plugin: longest chain first']
function orderLanes(run: Schedule): Lane[] {
  return [1, 2].map((l) => ({
    name: `worker ${l}`,
    bars: run.bars
      .filter((b) => b.lane === l)
      .map((b) => ({
        id: `${run.policy}/${b.id}`,
        start: b.start / 1000,
        end: b.end / 1000,
        label: b.id === LONG ? LONG : '',
        title: b.id,
        ...(b.id === LONG ? { tone: 'accent' as const } : {}),
      })),
  }))
}
const orderPanels = ORDERS.map((run, i) => {
  const top = 30 + i * (2 * ORDER_LANE + 40)
  const drawn = lanes(orderLanes(run), {
    x: GUTTER,
    y: top + 4,
    scale: ORDER_SCALE,
    row: ORDER_LANE,
    h: ORDER_LANE - 8,
  })
  const notes: Note[] = [
    { x: 4, y: top - 8, text: ORDER_TITLE[i]!, anchor: 'start' },
    ...drawn.notes,
    {
      x: GUTTER + (run.makespan / 1000) * ORDER_SCALE + 8,
      y: top + ORDER_LANE + 5,
      text: secs(run.makespan),
      anchor: 'start',
      tone: 'default',
    },
  ]
  return { boxes: drawn.boxes, notes }
})

export const order: Picture = {
  name: 'start-order',
  label: `${ORDERS.map((run, i) => {
    const docs = run.bars.find((b) => b.id === LONG)!
    return `${ORDER_TITLE[i]}: ${LONG} starts at ${secs(docs.start)}, and the run ends at ${secs(run.makespan)}`
  }).join('. ')}.`,
  caption: `Same tasks, same two workers. Starting the long ${LONG} first ends the run sooner.`,
  height: 250,
  boxes: orderPanels.flatMap((p): Box[] => p.boxes),
  notes: orderPanels.flatMap((p) => p.notes),
  narrow: orderNarrow(),
}

/** The two runs side by side with time running down, on one clock. Four
 *  columns must each hold the 8-character app#docs (78 units), so this
 *  layout runs a little past 340. */
function orderNarrow(): Layout {
  const scale = 12
  const top = 82
  const col = 78
  const row = 82
  const drawn = ORDERS.map((run, i) => {
    const x = 12 + i * 174
    // A whole title is wider than its two columns: it breaks at the space
    // nearest its middle.
    const title = ORDER_TITLE[i]!
    const spaces = [...title.matchAll(/ /g)].map((m) => m.index)
    const cut = spaces.reduce((a, b) =>
      Math.abs(b - title.length / 2) < Math.abs(a - title.length / 2) ? b : a,
    )
    const cols = lanes(orderLanes(run), { x, y: top, scale, row, h: col, down: true })
    const notes: Note[] = [
      { x, y: top - 58, text: title.slice(0, cut), anchor: 'start' },
      { x, y: top - 38, text: title.slice(cut + 1), anchor: 'start' },
      ...cols.notes,
      {
        x: x + (row + col) / 2,
        y: top + (run.makespan / 1000) * scale + 20,
        text: secs(run.makespan),
        tone: 'default',
      },
    ]
    return { boxes: cols.boxes, notes }
  })
  return {
    width: 358,
    height: Math.ceil(top + (Math.max(...ORDERS.map((o) => o.makespan)) / 1000) * scale + 40),
    boxes: drawn.flatMap((d) => d.boxes),
    notes: drawn.flatMap((d) => d.notes),
  }
}
