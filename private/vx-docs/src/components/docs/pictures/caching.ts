// The pictures of the Caching how-to pages (docs/caching/*). Every word in
// them is a word vx prints in the run the page shows.

import type { Picture } from '../../guide/diagram/diagram.js'

export const runEnds: Picture = {
  name: 'run-ends',
  label:
    'A new key runs the task and stores it: success. A stored key with dist/ as stored does nothing: up-to-date. A stored key with dist/ changed or gone copies it back: restored-local.',
  caption: 'The three words a cached task ends with, and what each one did.',
  height: 270,
  boxes: [
    { id: 'key', x: 10, y: 110, w: 140, label: 'key stored?', tone: 'accent' },
    { id: 'disk', x: 220, y: 20, w: 170, label: 'dist/ as stored?' },
    { id: 'run', x: 220, y: 200, w: 170, label: 'success', sub: 'run, then store', tone: 'warn' },
    { id: 'same', x: 450, y: 20, w: 140, label: 'up-to-date', sub: 'nothing runs', tone: 'ok' },
    {
      id: 'back',
      x: 450,
      y: 110,
      w: 140,
      label: 'restored-local',
      sub: 'copy it back',
      tone: 'ok',
    },
  ],
  arrows: [
    { from: 'key', to: 'disk', label: 'yes', via: [[80, 46]] },
    { from: 'key', to: 'run', label: 'no', via: [[80, 230]] },
    { from: 'disk', to: 'same', label: 'yes' },
    { from: 'disk', to: 'back', label: 'no', via: [[305, 140]] },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'key', x: 100, y: 10, w: 140, label: 'key stored?', tone: 'accent' },
      { id: 'disk', x: 0, y: 120, w: 170, label: 'dist/ as stored?' },
      { id: 'run', x: 190, y: 120, w: 150, label: 'success', sub: 'run, then store', tone: 'warn' },
      { id: 'same', x: 0, y: 235, w: 140, label: 'up-to-date', sub: 'nothing runs', tone: 'ok' },
      {
        id: 'back',
        x: 180,
        y: 235,
        w: 140,
        label: 'restored-local',
        sub: 'copy it back',
        tone: 'ok',
      },
    ],
    arrows: [
      { from: 'key', to: 'disk', label: 'yes' },
      { from: 'key', to: 'run', label: 'no' },
      { from: 'disk', to: 'same', label: 'yes' },
      { from: 'disk', to: 'back', label: 'no' },
    ],
  },
}

export const rootCause: Picture = {
  name: 'root-cause',
  label:
    'An edit to packages/ui/src/index.ts gives @demo/ui#build a new key, and @demo/web#build, which depends on it, a new key too.',
  caption: 'One edit, two re-runs: a new key travels to every task that depends on it.',
  height: 140,
  boxes: [
    { id: 'file', x: 10, y: 40, w: 160, label: 'src/index.ts', sub: '@demo/ui', tone: 'warn' },
    { id: 'ui', x: 215, y: 40, w: 170, label: '@demo/ui#build', sub: 'new key', tone: 'accent' },
    { id: 'web', x: 430, y: 40, w: 170, label: '@demo/web#build', sub: 'new key', tone: 'accent' },
  ],
  arrows: [
    { from: 'file', to: 'ui', label: 'edited' },
    { from: 'ui', to: 'web', label: 'upstream' },
  ],
  narrow: {
    width: 340,
    height: 290,
    boxes: [
      { id: 'file', x: 90, y: 10, w: 160, label: 'src/index.ts', sub: '@demo/ui', tone: 'warn' },
      { id: 'ui', x: 85, y: 115, w: 170, label: '@demo/ui#build', sub: 'new key', tone: 'accent' },
      {
        id: 'web',
        x: 85,
        y: 220,
        w: 170,
        label: '@demo/web#build',
        sub: 'new key',
        tone: 'accent',
      },
    ],
    arrows: [
      { from: 'file', to: 'ui', label: 'edited' },
      { from: 'ui', to: 'web', label: 'upstream' },
    ],
  },
}

export const cacheHome: Picture = {
  name: 'cache-home',
  label:
    'Each checkout keeps its own .vx/cache with the index and run history. The entries themselves live once in ~/.vx/<id>/cache, shared by every checkout of the workspace.',
  caption: 'Where the cache lives: an index per checkout, one store of entries in your home.',
  height: 230,
  boxes: [
    { id: 'a', x: 10, y: 20, w: 180, label: '.vx/cache', sub: 'this checkout' },
    { id: 'b', x: 10, y: 150, w: 180, label: '.vx/cache', sub: 'a second checkout' },
    {
      id: 'store',
      x: 380,
      y: 85,
      w: 200,
      label: '~/.vx/<id>/cache',
      sub: 'the entries',
      tone: 'accent',
    },
  ],
  arrows: [
    { from: 'a', to: 'store' },
    { from: 'b', to: 'store' },
  ],
  narrow: {
    width: 340,
    height: 220,
    boxes: [
      { id: 'a', x: 0, y: 10, w: 165, label: '.vx/cache', sub: 'this checkout' },
      { id: 'b', x: 175, y: 10, w: 165, label: '.vx/cache', sub: 'a second checkout' },
      {
        id: 'store',
        x: 70,
        y: 150,
        w: 200,
        label: '~/.vx/<id>/cache',
        sub: 'the entries',
        tone: 'accent',
      },
    ],
    arrows: [
      { from: 'a', to: 'store' },
      { from: 'b', to: 'store' },
    ],
  },
}
