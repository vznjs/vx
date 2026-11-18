import { build, testBuild } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build('vite build && tsc --noEmit'),
    'test:build': testBuild('publint --strict && attw --pack .'),
  },
}
