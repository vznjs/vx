import type { ProjectConfig } from '@vzn/vx/config'
import { build, WITH_CODEMODS } from '../../vx-preset.ts'

export default {
  tasks: { build: build(WITH_CODEMODS, ['query-test-utils', 'query-codemods']) },
} satisfies ProjectConfig
