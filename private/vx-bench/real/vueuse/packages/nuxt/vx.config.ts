import type { ProjectConfig } from '@vzn/vx/config'
import { build } from '../../vx-preset.ts'

export default {
  tasks: { build: build(['core', 'metadata'], 'tsdown --config-loader unrun') },
} satisfies ProjectConfig
