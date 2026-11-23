// Pictures of glossary.mdx.
import type { Picture } from '../../guide/diagram/diagram.js'

export const wordMap: Picture = {
  name: 'word-map',
  label:
    'A workspace holds projects @demo/ui and @demo/web. Each has a build task. The web build depends on the ui build. Each task gets a key, and the key finds its outputs in the cache.',
  caption: 'The main words, on one workspace.',
  height: 250,
  frames: [{ x: 10, y: 10, w: 390, h: 230, label: 'workspace' }],
  boxes: [
    { id: 'ui', x: 30, y: 50, w: 130, label: '@demo/ui', sub: 'project' },
    { id: 'web', x: 240, y: 50, w: 130, label: '@demo/web', sub: 'project' },
    { id: 'uib', x: 30, y: 160, w: 130, label: 'build', sub: 'task' },
    { id: 'webb', x: 240, y: 160, w: 130, label: 'build', sub: 'task', tone: 'accent' },
    { id: 'key', x: 450, y: 50, w: 140, label: 'key', sub: 'from inputs' },
    { id: 'cache', x: 450, y: 160, w: 140, label: 'cache', sub: 'outputs', tone: 'ok' },
  ],
  arrows: [
    { from: 'ui', to: 'uib' },
    { from: 'web', to: 'webb' },
    { from: 'webb', to: 'uib', label: '^build' },
    {
      from: 'webb',
      to: 'key',
      via: [
        [425, 190],
        [425, 80],
      ],
    },
    { from: 'key', to: 'cache' },
  ],
  narrow: {
    width: 340,
    height: 420,
    frames: [{ x: 0, y: 10, w: 340, h: 230, label: 'workspace' }],
    boxes: [
      { id: 'ui', x: 10, y: 50, w: 125, label: '@demo/ui', sub: 'project' },
      { id: 'web', x: 205, y: 50, w: 125, label: '@demo/web', sub: 'project' },
      { id: 'uib', x: 10, y: 160, w: 125, label: 'build', sub: 'task' },
      { id: 'webb', x: 205, y: 160, w: 125, label: 'build', sub: 'task', tone: 'accent' },
      { id: 'key', x: 10, y: 300, w: 140, label: 'key', sub: 'from inputs' },
      { id: 'cache', x: 190, y: 300, w: 140, label: 'cache', sub: 'outputs', tone: 'ok' },
    ],
    arrows: [
      { from: 'ui', to: 'uib' },
      { from: 'web', to: 'webb' },
      { from: 'webb', to: 'uib', label: '^build' },
      { from: 'webb', to: 'key' },
      { from: 'key', to: 'cache' },
    ],
  },
}
