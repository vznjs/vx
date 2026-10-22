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
    // CI's two runs over agents (ci.yml `linux` and `macos`, vx-agent.yml);
    // a run with no VX_DTE_RUN, as on a laptop, is not distributed.
    dte({
      ...(relay ? { relay } : {}),
      // A run's agents are its runner's OS (2026-10-22): ubuntu-latest on a
      // public repo; macos-latest, whose account cap of 5 the run's own job
      // takes one of.
      agents:
        process.env['RUNNER_OS'] === 'macOS'
          ? { mac: { max: 4, cpu: 3, memory: '7GB' } }
          : { small: { max: 8, cpu: 4, memory: '16GB' } },
      adapter: githubAgents(),
    }),
  ],
})
