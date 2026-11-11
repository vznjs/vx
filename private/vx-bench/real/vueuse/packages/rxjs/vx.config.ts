import type { ProjectConfig } from '@vzn/vx/config'
import { build } from '../../vx-preset.ts'

export default { tasks: { build: build(['shared']) } } satisfies ProjectConfig
