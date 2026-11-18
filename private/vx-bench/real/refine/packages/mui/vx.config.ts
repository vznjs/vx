import type { ProjectConfig } from '@vzn/vx/config'
import { build, TSUP } from '../../vx-preset.ts'

export default { tasks: { build: build(TSUP) } } satisfies ProjectConfig
