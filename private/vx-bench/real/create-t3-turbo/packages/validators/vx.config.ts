import type { ProjectConfig } from '@vzn/vx/config'
import { build, format, lint, topo, typecheck } from '../../vx-preset.ts'

export default {
  tasks: {
    topo,
    build,
    typecheck: typecheck('tsc --noEmit --emitDeclarationOnly false', true),
    lint,
    format,
  },
} satisfies ProjectConfig
