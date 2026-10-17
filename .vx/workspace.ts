import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { bun } from '@vzn/vx-lockfile'
import { turboCache } from '@vzn/vx-migrate'

export default defineWorkspace({
  plugins: [
    bun(),
    github(),
    // Vercel's Remote Cache. On GitHub Actions the job's OIDC token buys a
    // short-lived one; elsewhere the token comes from the OS keychain.
    turboCache({ teamSlug: 'exelord', oidc: true }),
    scheduleHistoryPlugin(),
  ],
})
