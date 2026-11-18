import { build } from '../../vx-preset.ts'

const task = build('pnpm run update && tsdown')

export default {
  tasks: {
    // `update` (vscode-ext-gen) writes README.md again each build, the same
    // bytes: an input the task itself rewrites.
    build: { ...task, inputs: { ...task.inputs, stability: { strategy: 'mutable' } } },
  },
}
