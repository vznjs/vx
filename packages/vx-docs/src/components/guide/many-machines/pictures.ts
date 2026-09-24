// Chapter 8's pictures (guide/many-machines). tests/guide-many-machines.test.ts
// holds the rendered SVGs to these values.
import type { Picture } from '../sketch.js'

const machines = ['Your laptop', 'CI', 'A teammate']

export const threeBuilds: Picture = {
  name: 'three-builds',
  label:
    'Your laptop, CI and a teammate each build utils from scratch: the same work, three times.',
  caption: 'Three machines, the same inputs, the same work three times.',
  boxes: [
    ...machines.map((m, i) => ({ id: `m${i}`, x: 35 + i * 195, y: 40, w: 140, label: m })),
    ...machines.map((_, i) => ({
      id: `b${i}`,
      x: 35 + i * 195,
      y: 170,
      w: 140,
      label: 'build utils',
      sub: 'from scratch',
      tone: 'danger' as const,
    })),
  ],
  arrows: machines.map((_, i) => ({ from: `m${i}`, to: `b${i}`, tone: 'danger' as const })),
}

export const sameKey: Picture = {
  name: 'same-key',
  label:
    'Your laptop, CI and a teammate compute the same key for utils from the same inputs. One shared cache holds one result under that key for all three.',
  caption: 'Same inputs, same key, on any machine. One stored result can serve them all.',
  boxes: [
    ...machines.map((m, i) => ({ id: `m${i}`, x: 20, y: 20 + i * 84, w: 150, label: m })),
    { id: 'key', x: 240, y: 104, w: 130, label: 'key a41f…', sub: 'same everywhere' },
    {
      id: 'cache',
      x: 440,
      y: 104,
      w: 140,
      label: 'Shared cache',
      sub: 'a41f… → result',
      tone: 'accent',
    },
  ],
  arrows: [
    ...machines.map((_, i) => ({ from: `m${i}`, to: 'key' })),
    { from: 'key', to: 'cache', tone: 'accent' },
  ],
}

export const whoWrites: Picture = {
  name: 'who-writes',
  label: 'CI writes results to the shared cache. Your laptop reads from it and never writes to it.',
  caption: 'CI builds from a clean checkout, so CI writes. Laptops only read.',
  boxes: [
    { id: 'laptop', x: 20, y: 90, w: 140, label: 'Your laptop', sub: 'reads only' },
    { id: 'cache', x: 230, y: 90, w: 140, label: 'Shared cache', tone: 'accent' },
    { id: 'ci', x: 440, y: 90, w: 140, label: 'CI', sub: 'clean checkout' },
  ],
  arrows: [
    { from: 'ci', to: 'cache', label: 'writes', tone: 'accent' },
    { from: 'cache', to: 'laptop', label: 'reads', tone: 'link' },
    {
      from: 'laptop',
      to: 'cache',
      label: 'never writes',
      tone: 'danger',
      dashed: true,
      via: [
        [90, 210],
        [300, 210],
      ],
    },
  ],
}

export const worker: Picture = {
  name: 'worker',
  label:
    'CI sends api#build to a worker with the files the task declares, src. The tsconfig.json the task reads but never declared stays behind, so the build fails on the worker.',
  caption: 'A worker gets only what the task declares. An undeclared file is missing there.',
  boxes: [
    { id: 'src', x: 20, y: 40, w: 160, label: 'src/**', sub: 'declared', tone: 'ok' },
    {
      id: 'tsconfig',
      x: 20,
      y: 160,
      w: 160,
      label: 'tsconfig.json',
      sub: 'not declared',
      tone: 'muted',
    },
    { id: 'worker', x: 240, y: 90, w: 140, label: 'Worker', sub: 'runs api#build' },
    {
      id: 'result',
      x: 440,
      y: 90,
      w: 140,
      label: 'Fails',
      sub: 'no tsconfig.json',
      tone: 'danger',
    },
  ],
  arrows: [
    { from: 'src', to: 'worker', label: 'sent', tone: 'ok' },
    { from: 'worker', to: 'result', tone: 'danger' },
  ],
  notes: [{ x: 100, y: 240, text: 'stays behind', tone: 'danger' }],
}
