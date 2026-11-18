import { buildCode, buildTypes } from '../../../vx-preset.ts'

export default {
  tasks: {
    'build:code': buildCode('rollup -c'),
    'build:types': buildTypes('tsc -p tsconfig.build.json --emitDeclarationOnly'),
  },
}
