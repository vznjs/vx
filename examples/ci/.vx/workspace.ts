import { defineWorkspace } from '@vzn/vx/config'
import { github } from '@vzn/vx-ci'
import { bun } from '@vzn/vx-lockfile'

export default defineWorkspace({
  plugins: [bun(), github()],
  pipelines: {
    pr: { tasks: ['lint', 'test', 'build'], affected: true },
    main: { tasks: ['lint', 'test', 'build'] },
  },
})
