import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { dte, github as githubAgents } from '@vzn/vx-dte'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { bun } from '@vzn/vx-lockfile'
import { turboCache } from '@vzn/vx-migrate'

const relay = process.env['VX_DTE_RELAY']

export default defineWorkspace({
  plugins: [
    bun(),
    github(),
    // Vercel's Remote Cache. On GitHub Actions the job's OIDC token buys a
    // short-lived one; elsewhere the token comes from the OS keychain.
    turboCache({ teamSlug: 'exelord', oidc: true }),
    scheduleHistoryPlugin(),
    // CI's shards over agents (ci.yml `shards-dte`, vx-agent.yml); a run
    // with no VX_DTE_RUN, as on a laptop, is not distributed.
    dte({
      ...(relay ? { relay } : {}),
      // ubuntu-latest on a public repo.
      agents: { small: { max: 6, cpu: 4, memory: '16GB' } },
      adapter: githubAgents(),
    }),
  ],
})
