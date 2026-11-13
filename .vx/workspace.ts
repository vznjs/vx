import { defineWorkspace } from '@vzn/vx'
import { github } from '@vzn/vx-ci'
import { vxCache } from '@vzn/vx-cache'
import { dte, github as githubWorkers } from '@vzn/vx-dte'
import { vxHistory } from '@vzn/vx-history'
import { bun } from '@vzn/vx-lockfile'

const relay = process.env['VX_DTE_RELAY']
// A PR that changes the cache server runs on its Preview (ci.yml), and
// hands it to the workers.
const cacheUrl = process.env['VX_CACHE_URL'] || 'https://vx-cache.exelord.workers.dev'
// What our servers' ALLOW names: every request names it, hashed.
const repo = { issuer: 'https://token.actions.githubusercontent.com', repository: 'vznjs/vx' }

export default defineWorkspace({
  plugins: [
    bun(),
    github(),
    // Our own servers (private/vx-cache-service, private/vx-history-service):
    // CI jobs sign in with their OIDC token; off CI they read only, where a
    // server opens reads (READ_ACCESS=public).
    vxCache({ url: cacheUrl, ...repo }),
    vxHistory({ url: 'https://vx-history.exelord.workers.dev', ...repo }),
    // CI's one run over workers (ci.yml `linux`, vx-worker.yml);
    // a run with no VX_DTE_RUN, as on a laptop, is not distributed.
    dte({
      ...(relay ? { relay } : {}),
      // One run, every platform (2026-10-23): ubuntu-latest on a
      // public repo for the Linux work; ubuntu-24.04-arm for the arm64
      // binary; macos-latest, whose account cap is 5, for the Mac tasks. A
      // platform's worker starts only when a task of it is in the graph.
      // A full Linux run asks ~46 cores of work at once: 8 workers ran it
      // in 157-196 s at 50% CPU (2026-10-23). GitHub runs 20 of the
      // account's jobs at once (2026-10-24: 20 ran, 12 queued). At 13
      // small one run filled it, and the next run's workers queued: a
      // quarter of 975 small jobs waited 78-384 s for a runner, while
      // each run's own advice wanted 6-9 small (60 runs, 2026-11-07).
      // Three Macs: at 4 a run, two runs at once passed the account's 5
      // and every Mac queued 320-340 s, three runs in a row (2026-11-12).
      // At 2 the Mac work was the run's end: 210 s, its ideal 122 s.
      // A Mac counts 2 of its 3 cores: macOS spends about one beside two
      // test shards, in work no process tree shows, and three shards at
      // once each ran 84-91 s for 61-71 s (main c12ffd4, 2026-11-13).
      workers: {
        hosted: {
          machines: {
            small: { max: 9, cpu: 4, memory: '16GB', platform: 'linux-x64' },
            arm: { max: 1, cpu: 4, memory: '16GB', platform: 'linux-arm64' },
            mac: { max: 3, cpu: 2, memory: '7GB', platform: 'darwin-arm64' },
          },
        },
      },
      adapter: githubWorkers({ env: { VX_CACHE_URL: cacheUrl } }),
    }),
  ],
})
