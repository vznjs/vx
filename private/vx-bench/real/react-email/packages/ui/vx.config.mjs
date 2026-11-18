import { build } from '../../vx-preset.ts'

// Plain .mjs: `next build` type-checks every .ts under the package, and
// the repo does not install `@vzn/vx`.
export default {
  tasks: {
    build: build(
      'cross-env NODE_OPTIONS="--experimental-vm-modules --disable-warning=ExperimentalWarning" tsx ./scripts/build.mts',
      ['.next/**', '!.next/cache/**'],
    ),
  },
}
