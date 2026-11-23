// The docs home's picture: the sidebar's chapters in order, one box each, each
// with what the reader gains there. Distributed task execution is the
// accent: the path leads to it.
import type { Picture } from '../../guide/diagram/diagram.js'

export const learningPath: Picture = {
  name: 'learning-path',
  label:
    'The docs chapters in order: Start here, Workspace, Tasks, Run tasks, Cache, CI, Distributed task execution, Extend vx.',
  caption: 'Each chapter builds on the one before it.',
  height: 190,
  boxes: [
    { id: 'qs', x: 10, y: 10, label: 'Start here', sub: 'one cached task' },
    { id: 'tasks', x: 160, y: 10, label: 'Workspace', sub: 'set it up' },
    { id: 'run', x: 310, y: 10, label: 'Tasks', sub: 'define them' },
    { id: 'cache', x: 460, y: 10, label: 'Run tasks', sub: 'order, filters' },
    { id: 'ci', x: 460, y: 120, label: 'Cache', sub: 'never twice' },
    { id: 'remote', x: 310, y: 120, label: 'CI', sub: 'share the cache' },
    { id: 'dte', x: 160, y: 120, label: 'Distributed', sub: 'task execution', tone: 'accent' },
    { id: 'plugins', x: 10, y: 120, label: 'Extend vx', sub: 'plugins' },
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
      { id: 'qs', x: 10, y: 10, w: 140, label: 'Start here', sub: 'one cached task' },
      { id: 'tasks', x: 190, y: 10, w: 140, label: 'Workspace', sub: 'set it up' },
      { id: 'run', x: 190, y: 90, w: 140, label: 'Tasks', sub: 'define them' },
      { id: 'cache', x: 10, y: 90, w: 140, label: 'Run tasks', sub: 'order, filters' },
      { id: 'ci', x: 10, y: 170, w: 140, label: 'Cache', sub: 'never twice' },
      { id: 'remote', x: 190, y: 170, w: 140, label: 'CI', sub: 'share the cache' },
      {
        id: 'dte',
        x: 190,
        y: 250,
        w: 140,
        label: 'Distributed',
        sub: 'task execution',
        tone: 'accent',
      },
      { id: 'plugins', x: 10, y: 250, w: 140, label: 'Extend vx', sub: 'plugins' },
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
