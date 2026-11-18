import { buildCode } from '../../../vx-preset.ts'

export default {
  tasks: {
    'build:code': buildCode('rollup -c'),
  },
}
