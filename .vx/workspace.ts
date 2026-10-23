import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { dte, github as githubWorkers } from '@vzn/vx-dte'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { bun } from '@vzn/vx-lockfile'
import { turboCache } from '@vzn/vx-migrate'

const relay = process.env['VX_DTE_RELAY']

export default defineWorkspace({
  plugins: [
    bun(),
    // The report is the job summary only, no check run beside the jobs
    // (owner, 2026-10-23).
    github({ checks: false }),
    // Vercel's Remote Cache. On GitHub Actions the job's OIDC token buys a
    // short-lived one; elsewhere the token comes from the OS keychain.
    turboCache({ teamSlug: 'exelord', oidc: true }),
    scheduleHistoryPlugin(),
    // CI's one run over workers (ci.yml `linux`, vx-worker.yml);
    // a run with no VX_DTE_RUN, as on a laptop, is not distributed.
    dte({
      ...(relay ? { relay } : {}),
      // One run, every platform (owner, 2026-10-23): ubuntu-latest on a
      // public repo for the Linux work; ubuntu-24.04-arm for the arm64
      // binary; macos-latest, whose account cap is 5, for the Mac tasks. A
      // platform's worker starts only when a task of it is in the graph.
      // A full Linux run asks ~46 cores of work at once: 8 workers ran it
      // in 157-196 s at 50% CPU (2026-10-23).
      workers: {
        small: { max: 12, cpu: 4, memory: '16GB', platform: 'linux-x64' },
        arm: { max: 1, cpu: 4, memory: '16GB', platform: 'linux-arm64' },
        mac: { max: 4, cpu: 3, memory: '7GB', platform: 'darwin-arm64' },
      },
      adapter: githubWorkers(),
    }),
  ],
})
