// Chapter 2's pictures (Guide, "Tasks"): a script that hides three jobs, a
// task's name, a task's inputs and outputs, and what splitting a script
// buys. The inputs picture is the playground workspace's `api#build`, and
// tests/guide-tasks.test.ts holds it to that config.

import type { Picture } from '../diagram/diagram.js'

export const script: Picture = {
  name: 'script',
  label: "ui's build script is one line that runs three jobs: tsc, vite build and a copy.",
  caption: 'One script, three jobs.',
  boxes: [
    { id: 'script', x: 20, y: 100, w: 190, label: 'npm run build', sub: 'in ui' },
    { id: 'tsc', x: 350, y: 16, w: 230, label: 'tsc', sub: 'check types' },
    { id: 'vite', x: 350, y: 100, w: 230, label: 'vite build', sub: 'bundle the code' },
    { id: 'copy', x: 350, y: 184, w: 230, label: 'cp -r assets dist/', sub: 'copy images' },
  ],
  arrows: [
    { from: 'script', to: 'tsc' },
    { from: 'script', to: 'vite' },
    { from: 'script', to: 'copy' },
  ],
}

export const taskName: Picture = {
  name: 'name',
  label: 'A task is a package and a command. The build of api is called api#build.',
  caption: 'Package plus command makes a task.',
  boxes: [
    { id: 'pkg', x: 20, y: 30, w: 150, label: 'api', sub: 'the package' },
    { id: 'cmd', x: 20, y: 150, w: 150, label: 'build', sub: 'the command' },
    {
      id: 'task',
      x: 270,
      y: 86,
      w: 310,
      label: 'api#build',
      sub: 'bun build src/server.ts --outdir dist',
      tone: 'accent',
    },
  ],
  arrows: [
    { from: 'pkg', to: 'task' },
    { from: 'cmd', to: 'task' },
  ],
}

export const INPUTS: string[] = ['src/**', 'package.json', 'API_URL']
export const OUTPUTS: string[] = ['dist/**']

export const readsWrites: Picture = {
  name: 'reads-writes',
  label: 'api#build reads src/**, package.json and API_URL, and writes dist/**.',
  caption: 'Inputs on the left, outputs on the right.',
  boxes: [
    ...INPUTS.map((input, i) => ({ id: input, x: 10, y: 30 + i * 76, w: 150, label: input })),
    { id: 'api#build', x: 230, y: 100, w: 150, label: 'api#build', tone: 'accent' as const },
    { id: 'dist/**', x: 450, y: 108, w: 140, label: 'dist/**', tone: 'ok' as const },
  ],
  arrows: [
    ...INPUTS.map((input) => ({ from: input, to: 'api#build' })),
    { from: 'api#build', to: 'dist/**', tone: 'ok' as const },
  ],
  notes: [
    { x: 85, y: 20, text: 'inputs' },
    { x: 520, y: 96, text: 'outputs' },
  ],
}

export const split: Picture = {
  name: 'split',
  label:
    'You change one image. As one task, all three jobs run again. As three tasks, only the copy runs.',
  caption: 'Split the script, and only the changed part runs.',
  boxes: [
    {
      id: 'one',
      x: 20,
      y: 40,
      w: 560,
      label: 'tsc && vite build && cp -r assets dist/',
      sub: 'one task: all three run again',
      tone: 'danger',
    },
    { id: 'tsc', x: 20, y: 170, w: 170, label: 'tsc', sub: 'skipped', tone: 'muted' },
    { id: 'vite', x: 215, y: 170, w: 170, label: 'vite build', sub: 'skipped', tone: 'muted' },
    { id: 'copy', x: 410, y: 170, w: 170, label: 'cp', sub: 'runs again', tone: 'ok' },
  ],
  notes: [
    { x: 300, y: 26, text: 'you change one image in assets/', tone: 'accent' },
    { x: 300, y: 150, text: 'three tasks: only the copy runs' },
  ],
}
