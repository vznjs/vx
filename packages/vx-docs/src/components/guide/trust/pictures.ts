// Chapter 6's pictures (guide/trust): the stale hit, a list against a guess,
// and the sandbox. They draw the stale-hit demo's task (app#build joining
// src/index.ts and banner.txt), which tests/guide-trust.test.ts holds to
// the demo's model.

import type { Layout, Picture } from '../diagram/diagram.js'

export const oldBanner: Picture = {
  name: 'old-banner',
  label:
    'app#build reads src/index.ts, which its inputs list, and banner.txt, which they do not, so banner.txt never reaches the key. You edit banner.txt. The key stays the same, so the run is a hit and restores the old banner. The run passes, and the output is wrong.',
  caption: 'The key never saw banner.txt, so editing it changed nothing the cache could notice.',
  height: 236,
  boxes: [
    { id: 'src', x: 6, y: 30, w: 150, label: 'src/index.ts' },
    { id: 'banner', x: 6, y: 150, w: 150, label: 'banner.txt ✎', tone: 'danger' },
    { id: 'key', x: 216, y: 90, w: 140, label: 'key', sub: 'same as before' },
    { id: 'hit', x: 410, y: 90, w: 184, label: 'hit: old banner', tone: 'danger' },
  ],
  arrows: [
    { from: 'src', to: 'key' },
    { from: 'banner', to: 'key', tone: 'danger', dashed: true, label: '✕' },
    { from: 'key', to: 'hit' },
  ],
  notes: [
    { x: 81, y: 18, text: 'listed' },
    { x: 81, y: 222, text: 'not listed, edited', tone: 'danger' },
    { x: 502, y: 170, text: 'run passes ✓', tone: 'ok' },
    { x: 502, y: 196, text: 'but the output is wrong', tone: 'danger' },
  ],
  narrow: {
    width: 340,
    height: 372,
    boxes: [
      { id: 'src', x: 12, y: 36, w: 150, label: 'src/index.ts' },
      { id: 'banner', x: 178, y: 36, w: 150, label: 'banner.txt ✎', tone: 'danger' },
      { id: 'key', x: 100, y: 150, w: 140, label: 'key', sub: 'same as before' },
      { id: 'hit', x: 78, y: 250, w: 184, label: 'hit: old banner', tone: 'danger' },
    ],
    arrows: [
      { from: 'src', to: 'key' },
      { from: 'banner', to: 'key', tone: 'danger', dashed: true, label: '✕' },
      { from: 'key', to: 'hit' },
    ],
    notes: [
      { x: 87, y: 24, text: 'listed' },
      { x: 253, y: 24, text: 'not listed, edited', tone: 'danger' },
      { x: 170, y: 328, text: 'run passes ✓', tone: 'ok' },
      { x: 170, y: 352, text: 'but the output is wrong', tone: 'danger' },
    ],
  },
}

export const listNotGuess: Picture = {
  name: 'list-not-guess',
  label:
    'Left: you list src and banner.txt; the list is known before the task runs, and vx can check it. Right: a guess made by watching one run sees only src/index.ts and misses banner.txt, which that run did not read.',
  caption: 'vx uses your list and never guesses.',
  height: 220,
  frames: [
    { x: 6, y: 6, w: 282, h: 206, label: 'you list', tone: 'ok' },
    { x: 312, y: 6, w: 282, h: 206, label: 'a guess' },
  ],
  boxes: [
    { id: 'list/src', x: 27, y: 42, w: 240, h: 40, label: 'src/**' },
    { id: 'list/banner', x: 27, y: 94, w: 240, h: 40, label: 'banner.txt' },
    { id: 'guess/src', x: 333, y: 42, w: 240, h: 40, label: 'src/index.ts' },
    { id: 'guess/banner', x: 333, y: 94, w: 240, h: 40, label: 'banner.txt ?', tone: 'muted' },
  ],
  notes: [
    { x: 147, y: 166, text: 'known before the run' },
    { x: 147, y: 190, text: 'vx can check it', tone: 'ok' },
    { x: 453, y: 166, text: 'only what one run read' },
    { x: 453, y: 190, text: 'misses the rest', tone: 'danger' },
  ],
  narrow: {
    width: 340,
    height: 420,
    frames: [
      { x: 12, y: 8, w: 316, h: 190, label: 'you list', tone: 'ok' },
      { x: 12, y: 218, w: 316, h: 190, label: 'a guess' },
    ],
    boxes: [
      { id: 'list/src', x: 50, y: 42, w: 240, h: 40, label: 'src/**' },
      { id: 'list/banner', x: 50, y: 94, w: 240, h: 40, label: 'banner.txt' },
      { id: 'guess/src', x: 50, y: 252, w: 240, h: 40, label: 'src/index.ts' },
      { id: 'guess/banner', x: 50, y: 304, w: 240, h: 40, label: 'banner.txt ?', tone: 'muted' },
    ],
    notes: [
      { x: 170, y: 162, text: 'known before the run' },
      { x: 170, y: 184, text: 'vx can check it', tone: 'ok' },
      { x: 170, y: 372, text: 'only what one run read' },
      { x: 170, y: 394, text: 'misses the rest', tone: 'danger' },
    ],
  },
}

export const sandbox: Picture = {
  name: 'sandbox',
  label:
    'Inside the sandbox, app#build can see only src/index.ts. banner.txt is outside the wall. Reading it fails, the task fails with the message: denied banner.txt, and nothing is saved.',
  caption: 'A forgotten file becomes an error that names it, not a wrong hit weeks later.',
  height: 228,
  frames: [
    { x: 6, y: 10, w: 380, h: 176, label: 'sandbox: only listed files exist', tone: 'link' },
  ],
  boxes: [
    { id: 'app#build', x: 26, y: 96, w: 150, label: 'app#build', tone: 'accent' },
    { id: 'src', x: 216, y: 96, w: 150, label: 'src/index.ts' },
    { id: 'banner', x: 440, y: 96, w: 150, label: 'banner.txt', tone: 'danger' },
  ],
  arrows: [
    { from: 'app#build', to: 'src' },
    {
      from: 'app#build',
      to: 'banner',
      tone: 'danger',
      dashed: true,
      label: '✕ denied',
      // Four corners, so the labelled middle stretch is centred on the wall.
      via: [
        [101, 60],
        [300, 60],
        [472, 60],
        [515, 60],
      ],
    },
  ],
  notes: [
    { x: 300, y: 214, text: 'task fails: denied banner.txt — nothing saved', tone: 'danger' },
  ],
  narrow: sandboxNarrow(),
}

/** The wall runs across a phone: banner.txt sits under it, and the denied
 *  read runs straight down, its label just past the wall. */
function sandboxNarrow(): Layout {
  const app = { x: 30, y: 50, h: 52 }
  const wall = 140
  // The label sits halfway between the arrow's ends (3 below app#build, 5
  // above banner.txt): put that halfway point a line below the wall, so the
  // wall's dashes do not run through the words.
  const banner = 2 * (wall + 12) - (app.y + app.h + 3) + 5
  return {
    width: 340,
    height: banner + 120,
    frames: [
      {
        x: 12,
        y: 10,
        w: 316,
        h: wall - 10,
        label: 'sandbox: only listed files exist',
        tone: 'link',
      },
    ],
    boxes: [
      { id: 'app#build', x: app.x, y: app.y, w: 124, label: 'app#build', tone: 'accent' },
      { id: 'src', x: 186, y: app.y, w: 124, label: 'src/index.ts' },
      { id: 'banner', x: app.x - 13, y: banner, w: 150, label: 'banner.txt', tone: 'danger' },
    ],
    arrows: [
      { from: 'app#build', to: 'src' },
      { from: 'app#build', to: 'banner', tone: 'danger', dashed: true, label: '✕ denied' },
    ],
    notes: [
      { x: 170, y: banner + 80, text: 'task fails: denied banner.txt —', tone: 'danger' },
      { x: 170, y: banner + 102, text: 'nothing saved', tone: 'danger' },
    ],
  }
}

/** What reaches a task that the sandbox does not check: each is a box
 *  outside the wall, with what to do about it. */
export const UNCHECKED: [label: string, sub: string][] = [
  ['env variables', 'list in inputs.env'],
  ['your tools', 'e.g. Node version'],
  ['node_modules', 'even a linked ui'],
  ['Windows', 'only under WSL'],
]

export const unchecked: Picture = {
  name: 'unchecked',
  label: `The sandbox checks the files app#build reads. Outside its wall, four things it does not check: ${UNCHECKED.map(
    ([l, s]) => `${l} (${s})`,
  ).join('; ')}.`,
  caption: 'The sandbox checks files. Keep an eye on these four yourself.',
  height: 196,
  frames: [
    { x: 6, y: 10, w: 190, h: 176, label: 'sandbox: files', tone: 'link' },
    { x: 216, y: 10, w: 378, h: 176, label: 'not checked', tone: 'warn' },
  ],
  boxes: [
    { id: 'app#build', x: 26, y: 50, w: 150, label: 'app#build', tone: 'accent' },
    { id: 'files', x: 26, y: 118, w: 150, label: 'listed files', tone: 'ok' },
    ...UNCHECKED.map(([label, sub], i) => ({
      id: `unchecked-${i + 1}`,
      x: 234 + (i % 2) * 180,
      y: i < 2 ? 46 : 114,
      w: 162,
      label,
      sub,
      tone: 'warn' as const,
    })),
  ],
  narrow: {
    width: 340,
    height: 470,
    frames: [
      { x: 12, y: 10, w: 316, h: 104, label: 'sandbox: files', tone: 'link' },
      { x: 12, y: 134, w: 316, h: 328, label: 'not checked', tone: 'warn' },
    ],
    boxes: [
      { id: 'app#build', x: 26, y: 44, w: 138, label: 'app#build', tone: 'accent' },
      { id: 'files', x: 176, y: 44, w: 138, label: 'listed files', tone: 'ok' },
      ...UNCHECKED.map(([label, sub], i) => ({
        id: `unchecked-${i + 1}`,
        x: 70,
        y: 170 + i * 72,
        w: 200,
        label,
        sub,
        tone: 'warn' as const,
      })),
    ],
  },
}
