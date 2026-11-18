import { task } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: task({ command: 'tsc --build --force tsconfig.json' }),
  },
}
