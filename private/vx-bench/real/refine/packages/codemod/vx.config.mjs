import { build } from '../../vx-preset.ts'

// Plain .mjs: this build is `tsc -p tsconfig.json`, which compiles every
// .ts under the package, and the repo does not install `@vzn/vx`.
export default { tasks: { build: build('tsc -d -p tsconfig.json') } }
