import { buildCode, buildTypes } from '../../../vx-preset.ts'

export default {
  tasks: {
    'build:code': buildCode(
      'rollup -c',
      "copyfiles -u 1 -a 'src/templates/**/*' 'src/files/**/*' dist",
    ),
    'build:types': buildTypes('tsc -p tsconfig.build.json --emitDeclarationOnly'),
  },
}
