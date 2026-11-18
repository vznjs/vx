import { buildCode, buildTypes } from '../../../vx-preset.ts'

export default {
  tasks: {
    'build:code': buildCode('rollup -c'),
    'build:types': buildTypes(
      'tsc -p server/tsconfig.build.json --emitDeclarationOnly',
      'tsc -p admin/tsconfig.build.json --emitDeclarationOnly',
      'tsc -p tsconfig.build.json --emitDeclarationOnly',
    ),
  },
}
