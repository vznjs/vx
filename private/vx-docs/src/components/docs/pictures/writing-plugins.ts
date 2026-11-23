// The Write a plugin page's pictures (docs/writing-plugins.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

export const executorChoice: Picture = {
  name: 'executor-choice',
  label:
    'vx offers each task to your executor. If it accepts, the task runs there. If it declines, vx runs the task on this machine.',
  caption: 'A task your executor declines runs on this machine.',
  height: 200,
  boxes: [
    { id: 'task', x: 10, y: 74, w: 130, label: 'a task' },
    {
      id: 'exec',
      x: 200,
      y: 70,
      w: 170,
      label: 'your executor',
      sub: 'accepts(task)?',
      tone: 'accent',
    },
    { id: 'there', x: 440, y: 10, w: 150, label: 'runs there', sub: 'a worker, a pod', tone: 'ok' },
    { id: 'here', x: 440, y: 130, w: 150, label: 'this machine', sub: 'vx runs it' },
  ],
  arrows: [
    { from: 'task', to: 'exec' },
    { from: 'exec', to: 'there', label: 'yes', via: [[405, 36]] },
    { from: 'exec', to: 'here', label: 'declines', via: [[405, 156]] },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'task', x: 105, y: 10, w: 130, label: 'a task' },
      {
        id: 'exec',
        x: 85,
        y: 110,
        w: 170,
        label: 'your executor',
        sub: 'accepts(task)?',
        tone: 'accent',
      },
      {
        id: 'there',
        x: 0,
        y: 230,
        w: 160,
        label: 'runs there',
        sub: 'a worker, a pod',
        tone: 'ok',
      },
      { id: 'here', x: 180, y: 230, w: 160, label: 'this machine', sub: 'vx runs it' },
    ],
    arrows: [
      { from: 'task', to: 'exec' },
      { from: 'exec', to: 'there', label: 'yes' },
      { from: 'exec', to: 'here', label: 'declines' },
    ],
  },
}

export const cacheOrder: Picture = {
  name: 'cache-order',
  label:
    'vx looks for a key in the local cache first, then in each remote in the order your plugins are listed. If none has it, the task runs and vx stores the result.',
  caption: 'Local cache first, then each remote in plugin order.',
  height: 120,
  boxes: [
    { id: 'local', x: 10, y: 34, w: 130, label: 'local cache', tone: 'accent' },
    { id: 'first', x: 165, y: 34, w: 130, label: 'remote 1', sub: 'first plugin' },
    { id: 'second', x: 320, y: 34, w: 130, label: 'remote 2', sub: 'next plugin' },
    { id: 'run', x: 475, y: 34, w: 120, label: 'run it', sub: 'then store', tone: 'warn' },
  ],
  arrows: [
    { from: 'local', to: 'first', label: 'miss' },
    { from: 'first', to: 'second', label: 'miss' },
    { from: 'second', to: 'run', label: 'miss' },
  ],
  narrow: {
    width: 340,
    height: 380,
    boxes: [
      { id: 'local', x: 105, y: 10, w: 130, label: 'local cache', tone: 'accent' },
      { id: 'first', x: 105, y: 105, w: 130, label: 'remote 1', sub: 'first plugin' },
      { id: 'second', x: 105, y: 210, w: 130, label: 'remote 2', sub: 'next plugin' },
      { id: 'run', x: 110, y: 315, w: 120, label: 'run it', sub: 'then store', tone: 'warn' },
    ],
    arrows: [
      { from: 'local', to: 'first', label: 'miss' },
      { from: 'first', to: 'second', label: 'miss' },
      { from: 'second', to: 'run', label: 'miss' },
    ],
  },
}
