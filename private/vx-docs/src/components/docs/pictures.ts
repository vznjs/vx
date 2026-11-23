// The Docs pages' pictures, drawn at build time by the diagram kit
// (components/guide/diagram). Each has a phone layout of the same boxes and
// arrows; tests/docs-pictures.test.ts holds that every label fits.

import type { Picture } from '../guide/diagram/diagram.js'

export const cacheKey: Picture = {
  name: 'cache-key',
  label:
    'The inputs, config and upstream keys make the key. A stored key is a hit that restores the outputs; a new key is a miss that runs and stores them.',
  caption: 'The key decides: a stored key restores, a new key runs and stores.',
  height: 240,
  boxes: [
    { id: 'in', x: 10, y: 86, w: 180, label: 'inputs', sub: 'files · env · deps' },
    { id: 'key', x: 260, y: 90, w: 90, label: 'key', tone: 'accent' },
    { id: 'hit', x: 420, y: 20, w: 170, label: 'hit', sub: 'restore outputs', tone: 'ok' },
    { id: 'miss', x: 420, y: 160, w: 170, label: 'miss', sub: 'run, then store', tone: 'warn' },
  ],
  arrows: [
    { from: 'in', to: 'key' },
    { from: 'key', to: 'hit', label: 'stored', via: [[305, 46]] },
    { from: 'key', to: 'miss', label: 'new', via: [[305, 186]] },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'in', x: 80, y: 10, w: 180, label: 'inputs', sub: 'files · env · deps' },
      { id: 'key', x: 125, y: 120, w: 90, label: 'key', tone: 'accent' },
      { id: 'hit', x: 0, y: 230, w: 160, label: 'hit', sub: 'restore outputs', tone: 'ok' },
      { id: 'miss', x: 180, y: 230, w: 160, label: 'miss', sub: 'run, then store', tone: 'warn' },
    ],
    arrows: [
      { from: 'in', to: 'key' },
      { from: 'key', to: 'hit', label: 'stored' },
      { from: 'key', to: 'miss', label: 'new' },
    ],
  },
}

const STAGES: [id: string, label: string, sub?: string][] = [
  ['config', 'config'],
  ['discover', 'discover'],
  ['project', 'project'],
  ['graph', 'graph'],
  ['key', 'key'],
  ['fingerprint', 'fingerprint'],
  ['measures', 'measures'],
  ['schedule', 'schedule'],
  ['admit', 'admit'],
  ['executor', 'executor', 'or cache'],
  ['telemetry', 'telemetry', 'and output'],
]
const chain = STAGES.slice(1).map(([to], i) => ({ from: STAGES[i]![0], to }))

export const pluginStages: Picture = {
  name: 'plugin-stages',
  label: `A run passes the stages in order: ${STAGES.map(([, l, s]) => (s === undefined ? l : `${l} ${s}`)).join(', ')}.`,
  caption: 'The stages a plugin can fill, in the order a run reaches them.',
  height: 290,
  boxes: STAGES.map(([id, label, sub], i) => ({
    id,
    x: 10 + (i % 4) * 150,
    y: 20 + Math.floor(i / 4) * 100,
    label,
    ...(sub === undefined ? {} : { sub }),
    ...(id === 'executor' ? { tone: 'accent' as const } : {}),
  })),
  // A row's last stage leads to the next row's first along the gap between rows.
  arrows: chain.map((a, i) =>
    i % 4 === 3
      ? {
          ...a,
          via: [
            [525, 90 + Math.floor(i / 4) * 100],
            [75, 90 + Math.floor(i / 4) * 100],
          ] as [number, number][],
        }
      : a,
  ),
  narrow: {
    width: 340,
    height: 500,
    // Two to a row, the path turning at each end, so every step is one
    // short arrow across or down.
    boxes: STAGES.map(([id, label, sub], i) => {
      const row = Math.floor((i + 1) / 2)
      const right = row % 2 === 0 ? i % 2 === 1 : i % 2 === 0
      return {
        id,
        x: right ? 200 : 10,
        y: 10 + row * 80,
        label,
        ...(sub === undefined ? {} : { sub }),
        ...(id === 'executor' ? { tone: 'accent' as const } : {}),
      }
    }),
    arrows: chain,
  },
}

export const dteRun: Picture = {
  name: 'dte-run',
  label:
    'Your CI job runs vx run, which sends tasks through the relay to the workers. The workers and the job share the remote cache, which brings outputs home.',
  caption: 'The relay passes tasks to the workers; outputs travel through the remote cache.',
  height: 300,
  boxes: [
    { id: 'run', x: 10, y: 96, w: 130, label: 'vx run', sub: 'your CI job' },
    { id: 'relay', x: 200, y: 100, w: 100, label: 'relay', tone: 'accent' },
    { id: 'w1', x: 320, y: 20, w: 120, label: 'worker 1' },
    { id: 'w2', x: 320, y: 180, w: 120, label: 'worker 2' },
    { id: 'cache', x: 470, y: 100, w: 130, label: 'remote cache', tone: 'link' },
  ],
  arrows: [
    { from: 'run', to: 'relay', label: 'tasks' },
    { from: 'relay', to: 'w1', via: [[250, 46]] },
    { from: 'relay', to: 'w2', via: [[250, 206]] },
    {
      from: 'w1',
      to: 'cache',
      dashed: true,
      via: [
        [455, 46],
        [455, 126],
      ],
    },
    {
      from: 'w2',
      to: 'cache',
      dashed: true,
      via: [
        [455, 206],
        [455, 126],
      ],
    },
    {
      from: 'cache',
      to: 'run',
      label: 'outputs',
      dashed: true,
      via: [
        [535, 270],
        [75, 270],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 380,
    boxes: [
      { id: 'run', x: 95, y: 10, w: 150, label: 'vx run', sub: 'your CI job' },
      { id: 'relay', x: 115, y: 120, w: 110, label: 'relay', tone: 'accent' },
      { id: 'w1', x: 20, y: 220, w: 130, label: 'worker 1' },
      { id: 'w2', x: 190, y: 220, w: 130, label: 'worker 2' },
      { id: 'cache', x: 100, y: 320, w: 140, label: 'remote cache', tone: 'link' },
    ],
    arrows: [
      { from: 'run', to: 'relay', label: 'tasks' },
      { from: 'relay', to: 'w1' },
      { from: 'relay', to: 'w2' },
      { from: 'w1', to: 'cache', dashed: true },
      { from: 'w2', to: 'cache', dashed: true },
      {
        from: 'cache',
        to: 'run',
        label: 'outputs',
        dashed: true,
        via: [
          [6, 346],
          [6, 40],
        ],
      },
    ],
  },
}

export const taskGraph: Picture = {
  name: 'task-graph',
  label:
    "web's tasks: codegen and ui#build (through ^build) before build; build and api#build before e2e; build and e2e before ci.",
  caption: 'Each arrow points from a task to one that waits for it.',
  height: 280,
  boxes: [
    { id: 'codegen', x: 10, y: 10, label: 'codegen' },
    { id: 'ui', x: 10, y: 110, label: 'ui#build' },
    { id: 'build', x: 210, y: 110, label: 'build', tone: 'accent' },
    { id: 'api', x: 210, y: 210, label: 'api#build' },
    { id: 'e2e', x: 370, y: 210, w: 100, label: 'e2e' },
    { id: 'ci', x: 500, y: 110, w: 100, label: 'ci' },
  ],
  arrows: [
    { from: 'codegen', to: 'build', via: [[275, 36]] },
    { from: 'ui', to: 'build', label: '^build' },
    { from: 'build', to: 'e2e' },
    { from: 'api', to: 'e2e' },
    { from: 'build', to: 'ci' },
    { from: 'e2e', to: 'ci', via: [[550, 236]] },
  ],
  narrow: {
    width: 340,
    height: 390,
    boxes: [
      { id: 'codegen', x: 10, y: 10, label: 'codegen' },
      { id: 'ui', x: 200, y: 10, label: 'ui#build' },
      { id: 'build', x: 105, y: 110, label: 'build', tone: 'accent' },
      { id: 'e2e', x: 10, y: 220, label: 'e2e' },
      { id: 'api', x: 200, y: 220, label: 'api#build' },
      { id: 'ci', x: 115, y: 320, w: 110, label: 'ci' },
    ],
    arrows: [
      { from: 'codegen', to: 'build' },
      { from: 'ui', to: 'build', label: '^build' },
      { from: 'build', to: 'e2e' },
      { from: 'api', to: 'e2e' },
      { from: 'build', to: 'ci' },
      { from: 'e2e', to: 'ci' },
    ],
  },
}

export const remoteCache: Picture = {
  name: 'remote-cache',
  label:
    'vx run asks the local cache first, then the remote cache; when both miss it runs the task and uploads the result to the remote cache.',
  caption: 'Local first, then remote; a task runs only when both miss.',
  height: 280,
  boxes: [
    { id: 'run', x: 10, y: 110, w: 120, label: 'vx run', tone: 'accent' },
    { id: 'local', x: 300, y: 20, w: 160, label: 'local cache', tone: 'link' },
    { id: 'remote', x: 300, y: 110, w: 160, label: 'remote cache', tone: 'link' },
    { id: 'task', x: 300, y: 210, w: 160, label: 'run the task' },
  ],
  arrows: [
    { from: 'run', to: 'local', label: '1. ask', via: [[70, 46]] },
    { from: 'run', to: 'remote', label: '2. ask' },
    { from: 'run', to: 'task', label: '3. both miss', via: [[70, 236]] },
    {
      from: 'task',
      to: 'remote',
      label: 'upload',
      via: [
        [520, 236],
        [520, 136],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'run', x: 0, y: 140, w: 110, label: 'vx run', tone: 'accent' },
      { id: 'local', x: 180, y: 20, w: 150, label: 'local cache', tone: 'link' },
      { id: 'remote', x: 180, y: 140, w: 150, label: 'remote cache', tone: 'link' },
      { id: 'task', x: 180, y: 260, w: 150, label: 'run the task' },
    ],
    arrows: [
      { from: 'run', to: 'local', label: '1. ask', via: [[55, 46]] },
      { from: 'run', to: 'remote', label: '2. ask' },
      { from: 'run', to: 'task', label: '3. both miss', via: [[55, 286]] },
      { from: 'task', to: 'remote', label: 'upload' },
    ],
  },
}
