// Chapter 5's pictures (guide/caching). What an edit reruns comes from the
// toy monorepo's model (the key calculator's), never typed, so a picture
// cannot disagree with the widget below it; tests/guide-caching.test.ts
// holds the model to sets written by hand.

import { TOY_PACKAGES, rerunBy } from '../../demos/model/toy-monorepo.js'
import type { Box, Picture } from '../diagram/diagram.js'

/** What an edit to app really needs; everything else ran again for nothing. */
const NEEDED = rerunBy('app')
const W = 130
const GAP = (592 - TOY_PACKAGES.length * W) / (TOY_PACKAGES.length - 1)
const ALL = TOY_PACKAGES.flatMap((p) => ['build', 'test'].map((task) => `${p.id}#${task}`))
const tone = (id: string) => (NEEDED.includes(id) ? ('accent' as const) : ('danger' as const))
/** On a phone, a package per row: app's row sits lower, under its edit. */
const rowY = (r: number) => 20 + r * 62 + (TOY_PACKAGES[r]!.id === 'app' ? 30 : 0)
const LAST = rowY(TOY_PACKAGES.length - 1)

export const rerun: Picture = {
  name: 'rerun',
  label: `You edit app. All eight tasks run again. Only ${NEEDED.join(' and ')} had to; the other six make the same result as last time.`,
  caption: 'One change in app. Every task ran, and six of them made the same result again.',
  height: 200,
  boxes: TOY_PACKAGES.flatMap((p, c) =>
    ['build', 'test'].map((task, r) => {
      const id = `${p.id}#${task}`
      return {
        id,
        x: 4 + c * (W + GAP),
        y: 30 + r * 62,
        w: W,
        label: id,
        tone: tone(id),
      }
    }),
  ),
  notes: [
    { x: 596, y: 16, text: 'edit in app ✎', anchor: 'end', tone: 'accent' },
    {
      x: 4,
      y: 176,
      text: `ran again for nothing: ${ALL.length - NEEDED.length} tasks`,
      anchor: 'start',
      tone: 'danger',
    },
    { x: 596, y: 176, text: `needed: ${NEEDED.length} tasks`, anchor: 'end', tone: 'ok' },
  ],
  narrow: {
    width: 340,
    height: LAST + 132,
    boxes: TOY_PACKAGES.flatMap((p, r) =>
      ['build', 'test'].map((task, c): Box => {
        const id = `${p.id}#${task}`
        return { id, x: 12 + c * 166, y: rowY(r), w: 150, label: id, tone: tone(id) }
      }),
    ),
    notes: [
      { x: 328, y: LAST - 10, text: 'edit in app ✎', anchor: 'end', tone: 'accent' },
      {
        x: 12,
        y: LAST + 84,
        text: `ran again for nothing: ${ALL.length - NEEDED.length} tasks`,
        anchor: 'start',
        tone: 'danger',
      },
      { x: 12, y: LAST + 108, text: `needed: ${NEEDED.length} tasks`, anchor: 'start', tone: 'ok' },
    ],
  },
}

const INPUTS = ['src/index.ts', 'tsconfig.json', 'tsc -b']
const INTO_BUILD = [
  ...INPUTS.map((input) => ({ from: input, to: 'utils#build' })),
  { from: 'utils#build', to: 'dist/', tone: 'ok' as const },
]

export const sameInputs: Picture = {
  name: 'same-inputs',
  label:
    'utils#build reads src/index.ts and tsconfig.json and runs tsc -b. It writes dist/. With the same three inputs it writes the same dist/ every time.',
  caption: 'Same inputs in, same output out. So the output can be kept and reused.',
  height: 210,
  boxes: [
    ...INPUTS.map((input, i) => ({
      id: input,
      x: 10,
      y: 20 + i * 60,
      w: 160,
      h: 40,
      label: input,
    })),
    { id: 'utils#build', x: 250, y: 74, w: 150, label: 'utils#build', tone: 'accent' },
    { id: 'dist/', x: 470, y: 74, w: 120, label: 'dist/', tone: 'ok' },
  ],
  arrows: INTO_BUILD,
  notes: [
    { x: 90, y: 200, text: 'inputs' },
    { x: 530, y: 150, text: 'output' },
  ],
  narrow: {
    width: 340,
    height: 270,
    boxes: [
      ...INPUTS.map((input, i) => ({
        id: input,
        x: 12,
        y: 20 + i * 60,
        w: 150,
        h: 40,
        label: input,
      })),
      { id: 'utils#build', x: 200, y: 74, w: 128, label: 'utils#build', tone: 'accent' },
      { id: 'dist/', x: 204, y: 166, w: 120, label: 'dist/', tone: 'ok' },
    ],
    arrows: INTO_BUILD,
    notes: [
      { x: 87, y: 204, text: 'inputs' },
      { x: 264, y: 242, text: 'output' },
    ],
  },
}

export const key: Picture = {
  name: 'key',
  label:
    'The inputs go through a hash and become a short key. vx looks the key up. Found: it restores the saved output and replays the log. Not found: the task runs and its output is saved under the key.',
  caption: 'The key is a short fingerprint of everything the task reads.',
  height: 220,
  boxes: [
    { id: 'inputs', x: 6, y: 84, w: 100, label: 'inputs' },
    { id: 'hash', x: 146, y: 84, w: 80, label: 'hash' },
    { id: 'key', x: 266, y: 84, w: 110, label: '7c1e04a', tone: 'accent' },
    {
      id: 'hit',
      x: 420,
      y: 20,
      w: 172,
      label: 'found: a hit',
      sub: "restore, don't run",
      tone: 'ok',
    },
    { id: 'miss', x: 420, y: 148, w: 172, label: 'not found', sub: 'run, then save', tone: 'warn' },
  ],
  arrows: [
    { from: 'inputs', to: 'hash' },
    { from: 'hash', to: 'key' },
    { from: 'key', to: 'hit', tone: 'ok' },
    { from: 'key', to: 'miss', tone: 'warn' },
  ],
  notes: [{ x: 321, y: 160, text: 'the key' }],
  narrow: {
    width: 340,
    height: 356,
    boxes: [
      { id: 'inputs', x: 120, y: 16, w: 100, label: 'inputs' },
      { id: 'hash', x: 130, y: 98, w: 80, label: 'hash' },
      { id: 'key', x: 115, y: 180, w: 110, label: '7c1e04a', tone: 'accent' },
      {
        id: 'hit',
        x: 14,
        y: 272,
        w: 150,
        label: 'found: a hit',
        sub: "restore, don't run",
        tone: 'ok',
      },
      {
        id: 'miss',
        x: 176,
        y: 272,
        w: 150,
        label: 'not found',
        sub: 'run, then save',
        tone: 'warn',
      },
    ],
    arrows: [
      { from: 'inputs', to: 'hash' },
      { from: 'hash', to: 'key' },
      { from: 'key', to: 'hit', tone: 'ok' },
      { from: 'key', to: 'miss', tone: 'warn' },
    ],
    notes: [{ x: 237, y: 211, text: 'the key', anchor: 'start' }],
  },
}

/** The builds whose keys an edit to utils moves: all of them. */
const MOVED = rerunBy('utils').filter((id) => id.endsWith('#build'))
const moved = (b: Box): Box => (MOVED.includes(b.id) ? { ...b, tone: 'accent' } : b)
const FOLDS: Picture['arrows'] = [
  { from: 'utils#build', to: 'ui#build', tone: 'accent' },
  { from: 'utils#build', to: 'api#build', tone: 'accent' },
  { from: 'ui#build', to: 'app#build', tone: 'accent' },
  { from: 'api#build', to: 'app#build', tone: 'accent' },
]

export const cascade: Picture = {
  name: 'cascade',
  label:
    "You edit utils. utils#build's key moves. ui#build and api#build fold it into their keys, so theirs move. app#build folds both, so its key moves too.",
  caption: 'Change utils, and every key above it changes too.',
  height: 240,
  boxes: [
    { id: 'utils#build', x: 6, y: 90, w: 150, label: 'utils#build' },
    { id: 'ui#build', x: 225, y: 26, w: 150, label: 'ui#build' },
    { id: 'api#build', x: 225, y: 154, w: 150, label: 'api#build' },
    { id: 'app#build', x: 444, y: 90, w: 150, label: 'app#build' },
  ].map(moved),
  arrows: FOLDS,
  notes: [
    { x: 81, y: 74, text: 'edited ✎', tone: 'accent' },
    { x: 300, y: 232, text: 'each key goes into the keys above it' },
  ],
  narrow: {
    width: 340,
    height: 344,
    boxes: [
      { id: 'app#build', x: 95, y: 20, w: 150, label: 'app#build' },
      { id: 'ui#build', x: 12, y: 124, w: 150, label: 'ui#build' },
      { id: 'api#build', x: 178, y: 124, w: 150, label: 'api#build' },
      { id: 'utils#build', x: 95, y: 228, w: 150, label: 'utils#build' },
    ].map(moved),
    // utils at the foot, so "above it" is where the picture draws them.
    arrows: FOLDS,
    notes: [
      { x: 170, y: 304, text: 'edited ✎', tone: 'accent' },
      { x: 170, y: 330, text: 'each key goes into the keys above it' },
    ],
  },
}
