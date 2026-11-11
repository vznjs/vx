import type { ProjectConfig } from '@vzn/vx/config'
import { build } from '../../vx-preset.ts'

const DOCUMENTED = [
  'components',
  'core',
  'electron',
  'firebase',
  'integrations',
  'math',
  'nuxt',
  'router',
  'rxjs',
  'shared',
]

export default {
  tasks: {
    // packages/metadata/turbo.json: `index.json`, the function index read
    // from every documented package's sources.
    update: {
      exec: { command: 'tsx scripts/update.ts' },
      inputs: {
        files: ['**/*'],
        workspaceFiles: ['meta/**', ...DOCUMENTED.map((p) => `packages/${p}/**`)],
      },
      outputs: { files: ['index.json'] },
      cache: true,
    },
    build: build([]),
  },
} satisfies ProjectConfig
