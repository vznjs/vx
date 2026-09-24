// Chapter 1's pictures (guide/why): the four packages, then the shell loop's
// three failures, then the same work orchestrated. The statuses and bars are
// typed here, not derived, so tests/guide-why.test.ts can hold them to the
// rules the chapter states.

import { lanes, type Lane, type Layout, type Picture } from '../diagram/diagram.js'

export const packages: Picture = {
  name: 'packages',
  label: 'Four packages. ui and api use utils. app uses ui and api.',
  caption: 'ui and api use utils. app uses ui and api.',
  boxes: [
    { id: 'utils', x: 30, y: 104, w: 110, label: 'utils' },
    { id: 'ui', x: 245, y: 36, w: 110, label: 'ui' },
    { id: 'api', x: 245, y: 172, w: 110, label: 'api' },
    { id: 'app', x: 460, y: 104, w: 110, label: 'app' },
  ],
  arrows: [
    { from: 'utils', to: 'ui' },
    { from: 'utils', to: 'api' },
    { from: 'ui', to: 'app' },
    { from: 'api', to: 'app' },
  ],
  notes: [{ x: 300, y: 250, text: 'an arrow means "is used by"' }],
  narrow: {
    width: 340,
    height: 320,
    boxes: [
      { id: 'utils', x: 115, y: 20, w: 110, label: 'utils' },
      { id: 'ui', x: 20, y: 124, w: 110, label: 'ui' },
      { id: 'api', x: 210, y: 124, w: 110, label: 'api' },
      { id: 'app', x: 115, y: 228, w: 110, label: 'app' },
    ],
    arrows: [
      { from: 'utils', to: 'ui' },
      { from: 'utils', to: 'api' },
      { from: 'ui', to: 'app' },
      { from: 'api', to: 'app' },
    ],
    notes: [{ x: 170, y: 306, text: 'an arrow means "is used by"' }],
  },
}

/** The loop over `packages/*`, in the glob's order, on a fresh clone. */
export const wrongOrder: Picture = {
  name: 'wrong-order',
  label:
    'The loop in alphabetical order: api fails, app fails, ui fails, utils builds. Each failure needs a package that is not built yet.',
  caption: 'In alphabetical order, three of the four builds fail.',
  height: 230,
  boxes: [
    { id: 'api', x: 20, y: 80, w: 120, label: '1. api', sub: 'fails', tone: 'danger' },
    { id: 'app', x: 165, y: 80, w: 120, label: '2. app', sub: 'fails', tone: 'danger' },
    { id: 'ui', x: 310, y: 80, w: 120, label: '3. ui', sub: 'fails', tone: 'danger' },
    { id: 'utils', x: 455, y: 80, w: 120, label: '4. utils', sub: 'builds', tone: 'ok' },
  ],
  arrows: [
    { from: 'api', to: 'app', tone: 'muted' },
    { from: 'app', to: 'ui', tone: 'muted' },
    { from: 'ui', to: 'utils', tone: 'muted' },
  ],
  notes: [
    { x: 300, y: 40, text: 'for p in packages/*  runs in alphabetical order' },
    { x: 300, y: 190, text: "Cannot find module 'utils'", tone: 'danger' },
  ],
  narrow: {
    width: 340,
    height: 444,
    boxes: [
      { id: 'api', x: 20, y: 70, w: 120, label: '1. api', sub: 'fails', tone: 'danger' },
      { id: 'app', x: 20, y: 160, w: 120, label: '2. app', sub: 'fails', tone: 'danger' },
      { id: 'ui', x: 20, y: 250, w: 120, label: '3. ui', sub: 'fails', tone: 'danger' },
      { id: 'utils', x: 20, y: 340, w: 120, label: '4. utils', sub: 'builds', tone: 'ok' },
    ],
    arrows: [
      { from: 'api', to: 'app', tone: 'muted' },
      { from: 'app', to: 'ui', tone: 'muted' },
      { from: 'ui', to: 'utils', tone: 'muted' },
    ],
    notes: [
      { x: 20, y: 26, text: 'for p in packages/*', anchor: 'start' },
      { x: 20, y: 48, text: 'runs in alphabetical order', anchor: 'start' },
      { x: 20, y: 428, text: "Cannot find module 'utils'", tone: 'danger', anchor: 'start' },
    ],
  },
}

/** The second run of the loop, after a one-line change to app. */
export const rebuildAll: Picture = {
  name: 'rebuild-all',
  label:
    'After a one-line change to app, the loop rebuilds utils, ui and api for nothing, and app for real.',
  caption: 'One line changed. Four builds ran.',
  height: 230,
  boxes: [
    { id: 'utils', x: 20, y: 80, w: 120, label: 'utils', sub: 'same again', tone: 'danger' },
    { id: 'ui', x: 165, y: 80, w: 120, label: 'ui', sub: 'same again', tone: 'danger' },
    { id: 'api', x: 310, y: 80, w: 120, label: 'api', sub: 'same again', tone: 'danger' },
    { id: 'app', x: 455, y: 80, w: 120, label: 'app', sub: 'new result', tone: 'ok' },
  ],
  arrows: [
    { from: 'utils', to: 'ui', tone: 'muted' },
    { from: 'ui', to: 'api', tone: 'muted' },
    { from: 'api', to: 'app', tone: 'muted' },
  ],
  notes: [
    { x: 515, y: 50, text: 'you changed app', tone: 'accent' },
    { x: 300, y: 190, text: '3 of 4 builds redo work you already have', tone: 'danger' },
  ],
  narrow: {
    width: 340,
    height: 420,
    boxes: [
      { id: 'utils', x: 20, y: 20, w: 120, label: 'utils', sub: 'same again', tone: 'danger' },
      { id: 'ui', x: 20, y: 110, w: 120, label: 'ui', sub: 'same again', tone: 'danger' },
      { id: 'api', x: 20, y: 200, w: 120, label: 'api', sub: 'same again', tone: 'danger' },
      { id: 'app', x: 20, y: 290, w: 120, label: 'app', sub: 'new result', tone: 'ok' },
    ],
    arrows: [
      { from: 'utils', to: 'ui', tone: 'muted' },
      { from: 'ui', to: 'api', tone: 'muted' },
      { from: 'api', to: 'app', tone: 'muted' },
    ],
    notes: [
      { x: 152, y: 325, text: 'you changed app', tone: 'accent', anchor: 'start' },
      { x: 20, y: 384, text: '3 of 4 builds redo', tone: 'danger', anchor: 'start' },
      { x: 20, y: 404, text: 'work you already have', tone: 'danger', anchor: 'start' },
    ],
  },
}

/** Seconds each build takes, as the chapter says. */
export const SECONDS: Record<string, number> = { utils: 3, ui: 4, api: 4, app: 5 }

/** One run of the loop on a four-core machine. */
export const LOOP_CORES: Lane[] = [
  {
    name: 'core 1',
    bars: [
      { start: 0, end: 3, label: 'utils' },
      { start: 3, end: 7, label: 'ui' },
      { start: 7, end: 11, label: 'api' },
      { start: 11, end: 16, label: 'app' },
    ],
  },
  { name: 'core 2', bars: [{ start: 0, end: 16, label: 'idle', tone: 'muted' }] },
  { name: 'core 3', bars: [{ start: 0, end: 16, label: 'idle', tone: 'muted' }] },
  { name: 'core 4', bars: [{ start: 0, end: 16, label: 'idle', tone: 'muted' }] },
]

export const oneAtATime: Picture = {
  name: 'one-at-a-time',
  label:
    'The loop on four cores: core 1 builds utils, ui, api and app in a row for 16 seconds; the other three cores sit idle.',
  caption: 'Four cores. The loop uses one.',
  height: 240,
  ...lanes(LOOP_CORES, { x: 100, y: 16, scale: 29, row: 56 }),
  narrow: {
    width: 340,
    height: 340,
    ...lanes(LOOP_CORES, { x: 30, y: 36, scale: 18, row: 76, h: 66, down: true }),
  },
}

/** Two builds with a one-line change to app between them: the loop, then an
 *  orchestrator on two cores. */
export const COMPARE: Lane[] = [
  {
    name: 'loop',
    bars: [
      { start: 0, end: 3, label: 'utils' },
      { start: 3, end: 7, label: 'ui' },
      { start: 7, end: 11, label: 'api' },
      { start: 11, end: 16, label: 'app' },
      { start: 16, end: 19, label: 'utils', tone: 'danger' },
      { start: 19, end: 23, label: 'ui', tone: 'danger' },
      { start: 23, end: 27, label: 'api', tone: 'danger' },
      { start: 27, end: 32, label: 'app' },
    ],
  },
  {
    name: 'core 1',
    bars: [
      { start: 0, end: 3, label: 'utils', tone: 'accent' },
      { start: 3, end: 7, label: 'ui', tone: 'accent' },
      { start: 7, end: 12, label: 'app', tone: 'accent' },
      { start: 12, end: 17, label: 'app', tone: 'accent' },
    ],
  },
  { name: 'core 2', bars: [{ start: 3, end: 7, label: 'api', tone: 'accent' }] },
]

const SCALE = 19
const [loopLane, ...coreLanes] = COMPARE
const loopBars = lanes([loopLane!], { x: 80, y: 40, scale: SCALE, row: 0 })
const coreBars = lanes(coreLanes, { x: 80, y: 140, scale: SCALE, row: 50 })
export const orchestrated: Picture = {
  name: 'orchestrated',
  label:
    'Build, change app, build again. The loop takes 32 seconds. An orchestrator builds ui and api together, skips what did not change, and takes 17 seconds.',
  caption: 'Same builds. Right order, two at once, and only what changed.',
  width: 700,
  boxes: [...loopBars.boxes, ...coreBars.boxes],
  notes: [
    { x: 80, y: 30, text: 'the loop: 32 s', anchor: 'start', tone: 'danger' },
    { x: 80, y: 130, text: 'an orchestrator: 17 s', anchor: 'start', tone: 'ok' },
    ...loopBars.notes,
    ...coreBars.notes,
    {
      x: 80 + 16 * SCALE,
      y: 102,
      text: '↑ change app, build again',
      anchor: 'start',
      tone: 'accent',
    },
    {
      x: 80 + 12 * SCALE,
      y: 212,
      text: '↑ change app, build again',
      anchor: 'start',
      tone: 'accent',
    },
  ],
  narrow: orchestratedNarrow(),
}

/** The same two builds with time running down: the loop's column, then
 *  the orchestrator's two, each change marked where it happens. */
function orchestratedNarrow(): Layout {
  const scale = 10
  const loop = lanes([loopLane!], { x: 14, y: 64, scale, row: 0, h: 60, down: true })
  const cores = lanes(coreLanes, { x: 196, y: 64, scale, row: 74, h: 60, down: true })
  return {
    width: 340,
    height: 400,
    boxes: [...loop.boxes, ...cores.boxes],
    notes: [
      { x: 14, y: 24, text: 'the loop: 32 s', anchor: 'start', tone: 'danger' },
      { x: 162, y: 24, text: 'an orchestrator: 17 s', anchor: 'start', tone: 'ok' },
      ...loop.notes,
      ...cores.notes,
      { x: 80, y: 64 + 16 * scale + 14, text: '← change app,', anchor: 'start', tone: 'accent' },
      { x: 80, y: 64 + 16 * scale + 32, text: 'build again', anchor: 'start', tone: 'accent' },
      { x: 190, y: 64 + 12 * scale + 14, text: 'change app, →', anchor: 'end', tone: 'accent' },
      { x: 190, y: 64 + 12 * scale + 32, text: 'build again', anchor: 'end', tone: 'accent' },
    ],
  }
}
