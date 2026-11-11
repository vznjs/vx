import type { ProjectConfig } from '@vzn/vx/config'
import { format, topo, typecheck } from '../../vx-preset.ts'

export default {
  tasks: {
    topo,
    typecheck: typecheck('tsc --noEmit'),
    format,
  },
} satisfies ProjectConfig
