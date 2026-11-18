import type { ProjectConfig } from '@vzn/vx/config'
import { build, TSUP } from '../../vx-preset.ts'

export default {
  tasks: {
    build: build(
      `cross-env NODE_ENV=production tsc && vite build --config src/client/vite.config.ts && ${TSUP}`,
    ),
  },
} satisfies ProjectConfig
