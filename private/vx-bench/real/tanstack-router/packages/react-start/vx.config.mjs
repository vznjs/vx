import { build, testBuild } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build('vite build && vite build -c vite.config.server-entry.ts'),
    'test:build': testBuild(),
  },
}
