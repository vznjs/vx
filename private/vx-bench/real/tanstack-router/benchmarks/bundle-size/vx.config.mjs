import { measure } from '../../vx-preset.ts'

export default {
  tasks: {
    build: measure(
      'node ../../scripts/benchmarks/bundle-size/measure.mjs --skip-package-builds --measurements-only',
    ),
  },
}
