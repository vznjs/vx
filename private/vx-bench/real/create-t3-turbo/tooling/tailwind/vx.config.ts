import type { ProjectConfig } from '@vzn/vx/config'
import { format, lint, topo, typecheck } from '../../vx-preset.ts'

export default {
  tasks: {
    topo,
    typecheck: typecheck('tsc --noEmit'),
    lint,
    format,
  },
} satisfies ProjectConfig
