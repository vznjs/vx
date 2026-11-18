import { build, testBuild } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build('vite build && tsc -p tsconfig.build.json'),
    'test:build': testBuild(),
  },
}
