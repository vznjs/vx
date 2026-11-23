// Pictures of concepts/why-vx-is-fast.mdx.
import type { Picture } from '../../guide/diagram/diagram.js'

export const threeOutcomes: Picture = {
  name: 'three-outcomes',
  label:
    "git's index gives each task its key. A stored key with outputs kept in place is up to date and touches nothing; a stored key with outputs gone copies them back; a new key runs the task.",
  caption: 'Every task ends one of three ways. Two of them do no work.',
  height: 280,
  boxes: [
    { id: 'git', x: 10, y: 116, w: 150, label: 'git index', sub: 'one read' },
    { id: 'key', x: 220, y: 120, w: 90, label: 'key', tone: 'accent' },
    { id: 'up', x: 400, y: 40, w: 190, label: 'up to date', sub: 'no work', tone: 'ok' },
    { id: 'back', x: 400, y: 126, w: 190, label: 'restored', sub: 'copy back', tone: 'link' },
    { id: 'run', x: 400, y: 212, w: 190, label: 'run', sub: 'then store', tone: 'warn' },
  ],
  arrows: [
    { from: 'git', to: 'key' },
    { from: 'key', to: 'up', label: 'kept', via: [[330, 70]] },
    { from: 'key', to: 'back', label: 'gone' },
    { from: 'key', to: 'run', label: 'new', via: [[330, 242]] },
  ],
  narrow: {
    width: 340,
    height: 320,
    boxes: [
      { id: 'git', x: 95, y: 10, w: 150, label: 'git index', sub: 'one read' },
      { id: 'key', x: 125, y: 120, w: 90, label: 'key', tone: 'accent' },
      { id: 'up', x: 0, y: 250, w: 108, label: 'up to date', sub: 'no work', tone: 'ok' },
      { id: 'back', x: 116, y: 250, w: 108, label: 'restored', sub: 'copy back', tone: 'link' },
      { id: 'run', x: 232, y: 250, w: 108, label: 'run', sub: 'then store', tone: 'warn' },
    ],
    arrows: [
      { from: 'git', to: 'key' },
      { from: 'key', to: 'up', label: 'kept' },
      { from: 'key', to: 'back', label: 'gone' },
      { from: 'key', to: 'run', label: 'new' },
    ],
  },
}

export const readyFirst: Picture = {
  name: 'ready-first',
  label:
    'Two tasks are ready and one worker is free. ui build starts first, because web build, web test and docs build wait on it. lint waits, because nothing waits on lint.',
  caption: 'One free worker: the task three others wait on goes first.',
  height: 230,
  boxes: [
    { id: 'ui', x: 10, y: 30, w: 170, label: 'ui build', sub: 'starts first', tone: 'accent' },
    { id: 'lint', x: 10, y: 150, w: 170, label: 'lint', sub: 'starts next', tone: 'muted' },
    { id: 'a', x: 400, y: 10, w: 170, label: 'web build' },
    { id: 'b', x: 400, y: 85, w: 170, label: 'web test' },
    { id: 'c', x: 400, y: 160, w: 170, label: 'docs build' },
  ],
  arrows: [
    { from: 'ui', to: 'a', label: 'unblocks' },
    { from: 'ui', to: 'b' },
    { from: 'ui', to: 'c' },
  ],
  narrow: {
    width: 340,
    height: 240,
    boxes: [
      { id: 'ui', x: 0, y: 10, w: 160, label: 'ui build', sub: 'starts first', tone: 'accent' },
      { id: 'lint', x: 180, y: 10, w: 160, label: 'lint', sub: 'starts next', tone: 'muted' },
      { id: 'a', x: 0, y: 170, w: 108, label: 'web build' },
      { id: 'b', x: 116, y: 170, w: 108, label: 'web test' },
      { id: 'c', x: 232, y: 170, w: 108, label: 'docs build' },
    ],
    arrows: [
      { from: 'ui', to: 'a', label: 'unblocks' },
      { from: 'ui', to: 'b' },
      { from: 'ui', to: 'c' },
    ],
  },
}
