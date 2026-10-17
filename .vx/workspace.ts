import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { bun } from '@vzn/vx-lockfile'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    bun(),
    github(),
    // Vercel's Remote Cache, team from TURBO_TEAM; on GitHub Actions the
    // job's OIDC token buys a short-lived one. With no team, local only.
    turboCache({ oidc: true }),
    scheduleHistoryPlugin(),
  ],
})
