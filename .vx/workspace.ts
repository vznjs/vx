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
// What our servers' TRUST names: every request names it, hashed.
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
      // account's jobs at once (2026-10-24: 20 ran, 12 queued): these 18
      // and ci.yml's linux and perf jobs fill it.
      workers: {
        small: { max: 13, cpu: 4, memory: '16GB', platform: 'linux-x64' },
        arm: { max: 1, cpu: 4, memory: '16GB', platform: 'linux-arm64' },
        mac: { max: 4, cpu: 3, memory: '7GB', platform: 'darwin-arm64' },
      },
      adapter: githubWorkers({ env: { VX_CACHE_URL: cacheUrl } }),
    }),
  ],
})
