import { build } from '../../../vx-preset.ts'

export default {
  tasks: {
    build: build(
      'astro-scripts build "src/**/*.ts" && astro-scripts build "src/editor.cts" --force-cjs --no-clean-dist && tsc -b',
    ),
  },
}
