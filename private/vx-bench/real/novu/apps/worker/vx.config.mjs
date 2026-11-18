import { build } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(undefined, ['dist/**', 'build/**', 'lib/**']),
  },
}
