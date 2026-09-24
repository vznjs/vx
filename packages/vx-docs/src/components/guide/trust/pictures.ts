// Chapter 6's pictures (guide/trust): the stale hit, a list against a guess,
// and the sandbox. They draw the stale-hit demo's task (app#build joining
// src/index.ts and banner.txt), which tests/guide-trust.test.ts holds to
// the demo's model.

import type { Picture } from '../diagram/diagram.js'

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
      via: [
        [101, 60],
        [515, 60],
      ],
    },
  ],
  notes: [
    { x: 386, y: 65, text: '✕', tone: 'danger' },
    { x: 300, y: 214, text: 'task fails: denied banner.txt — nothing saved', tone: 'danger' },
  ],
}
