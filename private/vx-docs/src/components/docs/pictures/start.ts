// The docs home's picture: the learning path, one box per chapter, each
// with what the reader gains there. Distributed task execution is the
// accent: the path leads to it.
import type { Picture } from '../../guide/diagram/diagram.js'

export const learningPath: Picture = {
  name: 'learning-path',
  label:
    'The docs in order: Quickstart, Tasks, Running tasks, Caching, CI, Remote cache, Distributed task execution, Plugins.',
  caption: 'Each chapter builds on the one before it.',
  height: 190,
  boxes: [
    { id: 'qs', x: 10, y: 10, label: 'Quickstart', sub: 'one cached task' },
    { id: 'tasks', x: 160, y: 10, label: 'Tasks', sub: 'every package' },
    { id: 'run', x: 310, y: 10, label: 'Running tasks', sub: 'order, filters' },
    { id: 'cache', x: 460, y: 10, label: 'Caching', sub: 'never twice' },
    { id: 'ci', x: 460, y: 120, label: 'CI', sub: 'checks on push' },
    { id: 'remote', x: 310, y: 120, label: 'Remote cache', sub: 'share with CI' },
    { id: 'dte', x: 160, y: 120, label: 'Distributed', sub: 'task execution', tone: 'accent' },
    { id: 'plugins', x: 10, y: 120, label: 'Plugins', sub: 'make it yours' },
  ],
  arrows: [
    { from: 'qs', to: 'tasks' },
    { from: 'tasks', to: 'run' },
    { from: 'run', to: 'cache' },
    { from: 'cache', to: 'ci' },
    { from: 'ci', to: 'remote' },
    { from: 'remote', to: 'dte', tone: 'accent' },
    { from: 'dte', to: 'plugins' },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'qs', x: 10, y: 10, w: 140, label: 'Quickstart', sub: 'one cached task' },
      { id: 'tasks', x: 190, y: 10, w: 140, label: 'Tasks', sub: 'every package' },
      { id: 'run', x: 190, y: 90, w: 140, label: 'Running tasks', sub: 'order, filters' },
      { id: 'cache', x: 10, y: 90, w: 140, label: 'Caching', sub: 'never twice' },
      { id: 'ci', x: 10, y: 170, w: 140, label: 'CI', sub: 'checks on push' },
      { id: 'remote', x: 190, y: 170, w: 140, label: 'Remote cache', sub: 'share with CI' },
      {
        id: 'dte',
        x: 190,
        y: 250,
        w: 140,
        label: 'Distributed',
        sub: 'task execution',
        tone: 'accent',
      },
      { id: 'plugins', x: 10, y: 250, w: 140, label: 'Plugins', sub: 'make it yours' },
    ],
    arrows: [
      { from: 'qs', to: 'tasks' },
      { from: 'tasks', to: 'run' },
      { from: 'run', to: 'cache' },
      { from: 'cache', to: 'ci' },
      { from: 'ci', to: 'remote' },
      { from: 'remote', to: 'dte', tone: 'accent' },
      { from: 'dte', to: 'plugins' },
    ],
  },
}
