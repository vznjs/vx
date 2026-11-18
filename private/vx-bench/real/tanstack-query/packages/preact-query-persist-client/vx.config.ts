import type { ProjectConfig } from '@vzn/vx/config'
import { build, TSDOWN } from '../../vx-preset.ts'

export default { tasks: { build: build(TSDOWN, ['query-test-utils']) } } satisfies ProjectConfig
