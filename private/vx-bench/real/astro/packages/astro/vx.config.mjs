import { build, prebuild } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(
      'astro-scripts build "src/**/*.{ts,js}" --copy-wasm && tsc -b && astro-check -- -- --tsconfig ./tsconfig.components.json',
      ['^build', 'prebuild'],
    ),
    prebuild: prebuild(
      'astro-scripts prebuild --to-string "src/runtime/server/astro-island.ts" "src/runtime/client/{idle,load,media,only,visible}.ts"',
    ),
  },
}
