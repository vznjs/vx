// Chapter 10's pictures (guide/try-it). tests/guide-try-it.test.ts holds
// the rendered SVGs to these values, and the ripple to the playground's
// own answer for the same edit.
import type { Picture } from '../diagram/diagram.js'

export const loop: Picture = {
  name: 'loop',
  label:
    'Edit a file, the environment or a config. Run the plan. Read which tasks hit and which keys moved. Repeat.',
  caption: 'Edit, run, read. Nothing is installed and no command runs.',
  boxes: [
    { id: 'edit', x: 20, y: 70, w: 160, label: 'Edit', sub: 'a file, env, config' },
    { id: 'run', x: 220, y: 70, w: 160, label: 'Run', sub: 'plan every task' },
    {
      id: 'read',
      x: 420,
      y: 70,
      w: 160,
      label: 'Read',
      sub: 'what moved, and why',
      tone: 'accent',
    },
  ],
  arrows: [
    { from: 'edit', to: 'run' },
    { from: 'run', to: 'read' },
    {
      from: 'read',
      to: 'edit',
      tone: 'muted',
      via: [
        [500, 200],
        [100, 200],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 292,
    boxes: [
      { id: 'edit', x: 50, y: 20, w: 160, label: 'Edit', sub: 'a file, env, config' },
      { id: 'run', x: 50, y: 116, w: 160, label: 'Run', sub: 'plan every task' },
      {
        id: 'read',
        x: 50,
        y: 212,
        w: 160,
        label: 'Read',
        sub: 'what moved, and why',
        tone: 'accent',
      },
    ],
    arrows: [
      { from: 'edit', to: 'run' },
      { from: 'run', to: 'read' },
      {
        from: 'read',
        to: 'edit',
        tone: 'muted',
        via: [
          [290, 242],
          [290, 50],
        ],
      },
    ],
  },
}

/** The tasks an edit to packages/ui/src/button.tsx reruns, in the order
 *  the picture draws them. */
export const RIPPLE = ['ui#build', 'ui#test', 'app#build', 'app#test']

export const ripple: Picture = {
  name: 'ripple',
  label:
    'Editing packages/ui/src/button.tsx moves the keys of ui#build and ui#test, then app#build, then app#test. The other tasks hit the cache.',
  caption: 'Edit one file in ui: four keys move. Every other task hits the cache.',
  boxes: [
    { id: 'file', x: 10, y: 104, w: 150, label: 'button.tsx', sub: 'packages/ui/src' },
    { id: 'ui#build', x: 195, y: 104, w: 110, label: 'ui#build', tone: 'accent' },
    { id: 'ui#test', x: 340, y: 30, w: 110, label: 'ui#test', tone: 'accent' },
    { id: 'app#build', x: 340, y: 178, w: 110, label: 'app#build', tone: 'accent' },
    { id: 'app#test', x: 480, y: 178, w: 110, label: 'app#test', tone: 'accent' },
  ],
  arrows: [
    { from: 'file', to: 'ui#build', tone: 'accent' },
    { from: 'ui#build', to: 'ui#test', tone: 'accent' },
    { from: 'ui#build', to: 'app#build', tone: 'accent' },
    { from: 'app#build', to: 'app#test', tone: 'accent' },
  ],
  narrow: {
    width: 340,
    height: 364,
    boxes: [
      { id: 'file', x: 95, y: 20, w: 150, label: 'button.tsx', sub: 'packages/ui/src' },
      { id: 'ui#build', x: 115, y: 116, w: 110, label: 'ui#build', tone: 'accent' },
      { id: 'ui#test', x: 30, y: 204, w: 110, label: 'ui#test', tone: 'accent' },
      { id: 'app#build', x: 200, y: 204, w: 110, label: 'app#build', tone: 'accent' },
      { id: 'app#test', x: 200, y: 292, w: 110, label: 'app#test', tone: 'accent' },
    ],
    arrows: [
      { from: 'file', to: 'ui#build', tone: 'accent' },
      { from: 'ui#build', to: 'ui#test', tone: 'accent' },
      { from: 'ui#build', to: 'app#build', tone: 'accent' },
      { from: 'app#build', to: 'app#test', tone: 'accent' },
    ],
  },
}

const LABS = [
  'A file no task names',
  'A read never declared',
  'Two tasks, one output',
  'A long task started late',
]

export const labs: Picture = {
  name: 'labs',
  label: `Four labs, each broken on purpose: ${LABS.join('; ')}.`,
  caption: 'Four labs, each with one thing broken on purpose.',
  boxes: LABS.map((lab, i) => ({
    id: `lab-${i + 1}`,
    x: 20 + (i % 2) * 290,
    y: i < 2 ? 40 : 150,
    w: 270,
    h: 64,
    label: lab,
    sub: `Lab ${i + 1}`,
  })),
  narrow: {
    width: 340,
    height: 344,
    boxes: LABS.map((lab, i) => ({
      id: `lab-${i + 1}`,
      x: 35,
      y: 20 + i * 80,
      w: 270,
      h: 64,
      label: lab,
      sub: `Lab ${i + 1}`,
    })),
  },
}
