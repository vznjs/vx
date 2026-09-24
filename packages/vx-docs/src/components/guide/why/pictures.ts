// Chapter 1's pictures (Guide, "Why orchestrate?"): the four packages, then
// the shell loop's three failures, then the same work orchestrated. The
// statuses and bars are typed here, not derived, so tests/guide-why.test.ts
// can hold them to the rules the chapter states.

import { laneBoxes, type Lane, type Picture } from '../diagram.js'

export const PACKAGES: Picture = {
  id: 'packages',
  label: 'Four packages. ui and api use utils. app uses ui and api.',
  boxes: [
    { id: 'utils', x: 30, y: 108, w: 110, label: 'utils' },
    { id: 'ui', x: 245, y: 40, w: 110, label: 'ui' },
    { id: 'api', x: 245, y: 176, w: 110, label: 'api' },
    { id: 'app', x: 460, y: 108, w: 110, label: 'app' },
  ],
  arrows: [
    { from: 'utils', to: 'ui' },
    { from: 'utils', to: 'api' },
    { from: 'ui', to: 'app' },
    { from: 'api', to: 'app' },
  ],
  notes: [{ x: 300, y: 250, text: 'an arrow means "is used by"' }],
}

/** The loop over `packages/*`, in the glob's order, on a fresh clone. */
export const WRONG_ORDER: Picture = {
  id: 'wrong-order',
  label:
    'The loop in alphabetical order: api fails, app fails, ui fails, utils builds. Each failure needs a package that is not built yet.',
  boxes: [
    { id: 'api', x: 20, y: 90, w: 120, label: '1. api', sub: 'fails', variant: 'danger' },
    { id: 'app', x: 165, y: 90, w: 120, label: '2. app', sub: 'fails', variant: 'danger' },
    { id: 'ui', x: 310, y: 90, w: 120, label: '3. ui', sub: 'fails', variant: 'danger' },
    { id: 'utils', x: 455, y: 90, w: 120, label: '4. utils', sub: 'builds', variant: 'ok' },
  ],
  arrows: [
    { from: 'api', to: 'app', variant: 'muted' },
    { from: 'app', to: 'ui', variant: 'muted' },
    { from: 'ui', to: 'utils', variant: 'muted' },
  ],
  notes: [
    { x: 300, y: 50, text: 'for p in packages/*  runs in alphabetical order' },
    { x: 300, y: 200, text: "Cannot find module 'utils'", variant: 'danger' },
  ],
}

/** The second run of the loop, after a one-line change to app. */
export const REBUILD_ALL: Picture = {
  id: 'rebuild-all',
  label:
    'After a one-line change to app, the loop rebuilds utils, ui and api for nothing, and app for real.',
  boxes: [
    { id: 'utils', x: 20, y: 90, w: 120, label: 'utils', sub: 'same again', variant: 'danger' },
    { id: 'ui', x: 165, y: 90, w: 120, label: 'ui', sub: 'same again', variant: 'danger' },
    { id: 'api', x: 310, y: 90, w: 120, label: 'api', sub: 'same again', variant: 'danger' },
    { id: 'app', x: 455, y: 90, w: 120, label: 'app', sub: 'new result', variant: 'ok' },
  ],
  arrows: [
    { from: 'utils', to: 'ui', variant: 'muted' },
    { from: 'ui', to: 'api', variant: 'muted' },
    { from: 'api', to: 'app', variant: 'muted' },
  ],
  notes: [
    { x: 515, y: 60, text: 'you changed app', variant: 'accent' },
    { x: 300, y: 200, text: '3 of 4 builds redo work you already have', variant: 'danger' },
  ],
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
  { name: 'core 2', bars: [{ start: 0, end: 16, label: 'idle', variant: 'muted' }] },
  { name: 'core 3', bars: [{ start: 0, end: 16, label: 'idle', variant: 'muted' }] },
  { name: 'core 4', bars: [{ start: 0, end: 16, label: 'idle', variant: 'muted' }] },
]

const idle = laneBoxes(LOOP_CORES, { x: 100, y: 20, scale: 29, row: 56 })
export const ONE_AT_A_TIME: Picture = {
  id: 'one-at-a-time',
  label:
    'The loop on four cores: core 1 builds utils, ui, api and app in a row for 16 seconds; the other three cores sit idle.',
  ...idle,
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
      { start: 16, end: 19, label: 'utils', variant: 'danger' },
      { start: 19, end: 23, label: 'ui', variant: 'danger' },
      { start: 23, end: 27, label: 'api', variant: 'danger' },
      { start: 27, end: 32, label: 'app' },
    ],
  },
  {
    name: 'core 1',
    bars: [
      { start: 0, end: 3, label: 'utils', variant: 'accent' },
      { start: 3, end: 7, label: 'ui', variant: 'accent' },
      { start: 7, end: 12, label: 'app', variant: 'accent' },
      { start: 12, end: 17, label: 'app', variant: 'accent' },
    ],
  },
  { name: 'core 2', bars: [{ start: 3, end: 7, label: 'api', variant: 'accent' }] },
]

const [loopLane, ...coreLanes] = COMPARE
const loopBars = laneBoxes([loopLane!], { x: 80, y: 40, scale: 19, row: 0 })
const coreBars = laneBoxes(coreLanes, { x: 80, y: 140, scale: 19, row: 50 })
export const ORCHESTRATED: Picture = {
  id: 'orchestrated',
  label:
    'Build, change app, build again. The loop takes 32 seconds. An orchestrator builds ui and api together, skips what did not change, and takes 17 seconds.',
  width: 700,
  boxes: [...loopBars.boxes, ...coreBars.boxes],
  notes: [
    { x: 80, y: 30, text: 'the loop: 32 s', anchor: 'start', variant: 'danger' },
    { x: 80, y: 130, text: 'an orchestrator: 17 s', anchor: 'start', variant: 'ok' },
    ...loopBars.notes,
    ...coreBars.notes,
    {
      x: 80 + 16 * 19,
      y: 102,
      text: '↑ change app, build again',
      anchor: 'start',
      variant: 'accent',
    },
    {
      x: 80 + 12 * 19,
      y: 212,
      text: '↑ change app, build again',
      anchor: 'start',
      variant: 'accent',
    },
  ],
}
