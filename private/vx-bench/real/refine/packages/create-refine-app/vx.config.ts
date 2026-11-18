import type { ProjectConfig } from '@vzn/vx/config'
import { build } from '../../vx-preset.ts'

export default {
  tasks: { build: build('tsup && tsc --project tsconfig.declarations.json') },
} satisfies ProjectConfig
