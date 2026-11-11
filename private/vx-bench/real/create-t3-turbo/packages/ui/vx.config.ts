import type { ProjectConfig } from '@vzn/vx/config'
import { format, lint, topo, typecheck } from '../../vx-preset.ts'

export default {
  tasks: {
    topo,
    typecheck: typecheck('tsc --noEmit --emitDeclarationOnly false'),
    lint,
    format,
  },
} satisfies ProjectConfig
