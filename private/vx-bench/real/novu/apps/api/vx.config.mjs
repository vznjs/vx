import { build } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(
      'pnpm exec rimraf dist && pnpm exec nest build',
      ['dist/**'],
      ['build-metadata', '^build'],
    ),
    'build-metadata': build('pnpm run build:metadata', ['src/metadata.ts']),
  },
}
