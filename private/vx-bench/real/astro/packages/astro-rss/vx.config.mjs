import { build } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build('astro-scripts build "src/**/*.ts" && tsc -b'),
  },
}
