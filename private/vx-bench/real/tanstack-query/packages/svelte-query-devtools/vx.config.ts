import type { ProjectConfig } from '@vzn/vx/config'
import { build, SVELTE } from '../../vx-preset.ts'

export default { tasks: { build: build(SVELTE) } } satisfies ProjectConfig
