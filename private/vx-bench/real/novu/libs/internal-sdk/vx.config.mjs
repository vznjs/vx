import { build } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(undefined, [
      'funcs/**',
      'hooks/**',
      'lib/**',
      'models/**',
      'react-query/**',
      'sdk/**',
      'types/**',
      'utils/**',
      'docs/**',
      'speakeasyusagegen/**',
      'index.js',
      'index.js.map',
      'index.d.ts',
      'index.d.ts.map',
      'core.js',
      'core.js.map',
      'core.d.ts',
      'core.d.ts.map',
      '.tsbuildinfo',
    ]),
  },
}
