import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { bun } from '@vzn/vx-lockfile'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    bun(),
    github(),
    turboCache({
      apiUrl: 'https://remote.cachely.dev',
      teamSlug: 'cachely',
    }),
    scheduleHistoryPlugin(),
  ],
})
