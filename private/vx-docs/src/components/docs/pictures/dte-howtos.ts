// The Distributed task execution guides' pictures (docs/distributed-task-execution/*).

import type { Picture } from '../../guide/diagram/diagram.js'

export const dteLocal: Picture = {
  name: 'dte-local',
  label:
    'vx run in your shell sends tasks through a relay on this machine to two workers, each a process in its own git worktree.',
  caption: 'Everything stays on your machine: one relay, one worktree per worker.',
  height: 200,
  boxes: [
    { id: 'run', x: 10, y: 66, w: 140, label: 'vx run', sub: 'your shell' },
    { id: 'relay', x: 220, y: 66, w: 130, label: 'relay', sub: 'this machine', tone: 'accent' },
    { id: 'w1', x: 430, y: 10, w: 160, label: 'worker 1', sub: 'git worktree' },
    { id: 'w2', x: 430, y: 126, w: 160, label: 'worker 2', sub: 'git worktree' },
  ],
  arrows: [
    { from: 'run', to: 'relay', label: 'tasks' },
    { from: 'relay', to: 'w1', via: [[390, 40]] },
    { from: 'relay', to: 'w2', via: [[390, 156]] },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'run', x: 100, y: 10, w: 140, label: 'vx run', sub: 'your shell' },
      { id: 'relay', x: 105, y: 120, w: 130, label: 'relay', sub: 'this machine', tone: 'accent' },
      { id: 'w1', x: 0, y: 230, w: 160, label: 'worker 1', sub: 'git worktree' },
      { id: 'w2', x: 180, y: 230, w: 160, label: 'worker 2', sub: 'git worktree' },
    ],
    arrows: [
      { from: 'run', to: 'relay', label: 'tasks' },
      { from: 'relay', to: 'w1' },
      { from: 'relay', to: 'w2' },
    ],
  },
}

export const dteWorkerTypes: Picture = {
  name: 'dte-worker-types',
  label:
    'Both builds go to the linux workers. The e2e task names exec.worker e2e, so it goes only to the e2e workers.',
  caption: 'A task that names a worker type runs only there; the rest take the first type.',
  height: 250,
  boxes: [
    { id: 'ui', x: 10, y: 10, w: 160, label: '@demo/ui#build' },
    { id: 'web', x: 10, y: 96, w: 160, label: '@demo/web#build' },
    { id: 'e2e', x: 10, y: 182, w: 160, label: '@demo/web#e2e', tone: 'accent' },
    { id: 'linux', x: 420, y: 50, w: 170, label: 'linux.cpu4', sub: 'first type' },
    { id: 'tests', x: 420, y: 176, w: 170, label: 'e2e.cpu4', sub: 'its own type', tone: 'accent' },
  ],
  arrows: [
    {
      from: 'ui',
      to: 'linux',
      via: [
        [300, 36],
        [300, 80],
      ],
    },
    {
      from: 'web',
      to: 'linux',
      via: [
        [300, 122],
        [300, 80],
      ],
    },
    { from: 'e2e', to: 'tests', label: 'exec.worker', tone: 'accent' },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'ui', x: 0, y: 10, w: 160, label: '@demo/ui#build' },
      { id: 'web', x: 180, y: 10, w: 160, label: '@demo/web#build' },
      { id: 'e2e', x: 180, y: 160, w: 160, label: '@demo/web#e2e', tone: 'accent' },
      { id: 'linux', x: 0, y: 160, w: 160, label: 'linux.cpu4', sub: 'first type' },
      {
        id: 'tests',
        x: 180,
        y: 260,
        w: 160,
        label: 'e2e.cpu4',
        sub: 'its own type',
        tone: 'accent',
      },
    ],
    arrows: [
      { from: 'ui', to: 'linux' },
      {
        from: 'web',
        to: 'linux',
        via: [
          [260, 120],
          [80, 120],
        ],
      },
      { from: 'e2e', to: 'tests', label: 'exec.worker', tone: 'accent' },
    ],
  },
}

export const dteBiggerMachine: Picture = {
  name: 'dte-bigger-machine',
  label:
    'In run 1 the build used every core of a linux.cpu4 machine. vx remembers that, so in run 2 the same build goes to a linux.cpu16 machine.',
  caption: 'A task that filled its machine gets a bigger one next run.',
  height: 250,
  boxes: [
    { id: 'b1', x: 10, y: 20, w: 170, label: '@demo/web#build', sub: 'run 1' },
    { id: 'm1', x: 400, y: 20, w: 190, label: 'linux.cpu4', sub: 'every core busy', tone: 'warn' },
    { id: 'b2', x: 10, y: 170, w: 170, label: '@demo/web#build', sub: 'run 2' },
    { id: 'm2', x: 400, y: 170, w: 190, label: 'linux.cpu16', sub: 'room to spare', tone: 'ok' },
  ],
  arrows: [
    { from: 'b1', to: 'm1' },
    { from: 'm1', to: 'm2', label: 'vx remembers', dashed: true },
    { from: 'b2', to: 'm2', tone: 'accent' },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'b1', x: 180, y: 10, w: 160, label: '@demo/web#build', sub: 'run 1' },
      {
        id: 'm1',
        x: 0,
        y: 10,
        w: 160,
        label: 'linux.cpu4',
        sub: 'every core busy',
        tone: 'warn',
      },
      { id: 'b2', x: 180, y: 260, w: 160, label: '@demo/web#build', sub: 'run 2' },
      { id: 'm2', x: 0, y: 260, w: 160, label: 'linux.cpu16', sub: 'room to spare', tone: 'ok' },
    ],
    arrows: [
      { from: 'b1', to: 'm1' },
      { from: 'm1', to: 'm2', label: 'vx remembers', dashed: true },
      { from: 'b2', to: 'm2', tone: 'accent' },
    ],
  },
}
