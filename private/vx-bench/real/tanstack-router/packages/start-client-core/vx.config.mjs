import { build, testBuild } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(),
    'test:build': testBuild(),
  },
}
