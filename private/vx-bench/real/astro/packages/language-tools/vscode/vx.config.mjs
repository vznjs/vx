import { build } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: build('tsc -b && node scripts/build.mjs -- --minify'),
  },
}
